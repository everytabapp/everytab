// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Content-address embedded favicons without changing the public TabRef shape. */
import { sha256Bytes } from "./canonical.js";

const ASSET_MARKER = "everytabAsset";
const LOCAL_ASSET_READ_CONCURRENCY = 8;

function decodeBase64(value) {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function decodePercentEncoded(value) {
  const bytes = [];
  for (let index = 0; index < value.length;) {
    if (value[index] === "%" && /^[0-9a-f]{2}$/i.test(value.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 3;
      continue;
    }
    bytes.push(...new TextEncoder().encode(value[index]));
    index += 1;
  }
  return new Uint8Array(bytes);
}

function parseDataUrl(value) {
  if (typeof value !== "string" || !value.startsWith("data:")) return null;
  const comma = value.indexOf(",");
  if (comma < 5) return null;
  const header = value.slice(5, comma);
  const payload = value.slice(comma + 1);
  const parts = header.split(";");
  const base64 = parts.at(-1)?.toLowerCase() === "base64";
  const mimeType = (parts[0] || "text/plain").toLowerCase();
  try {
    return {
      mimeType,
      bytes: base64 ? decodeBase64(payload) : decodePercentEncoded(payload),
      dataUrl: value
    };
  } catch {
    return null;
  }
}

function concat(left, right) {
  const output = new Uint8Array(left.length + right.length);
  output.set(left);
  output.set(right, left.length);
  return output;
}

async function assetFromDataUrl(dataUrl, cryptoProvider) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;
  // The hydrated public value must be byte-for-byte identical to its source.
  // Two data URLs can decode to the same image while differing in MIME casing,
  // encoding, or metadata. Hash the complete representation so those values do
  // not collapse into one asset and exact Restore remains possible.
  const prefix = new TextEncoder().encode("data-url\0");
  const digest = await sha256Bytes(
    concat(prefix, new TextEncoder().encode(parsed.dataUrl)), cryptoProvider
  );
  return {
    digest,
    mimeType: parsed.mimeType,
    byteLength: parsed.bytes.length,
    dataUrl: parsed.dataUrl
  };
}

/**
 * Replace data favicon strings with private references and return unique assets.
 * Callers only receive the hydrated shape again through Library or Recovery.
 */
export async function externalizeEmbeddedFavicons(value, cryptoProvider = globalThis.crypto) {
  const assets = new Map();
  const byDataUrl = new Map();
  const ancestors = new WeakSet();

  const visit = async (input) => {
    if (!input || typeof input !== "object") return input;
    if (ancestors.has(input)) throw new Error("Storage values cannot contain cycles");
    ancestors.add(input);
    if (Array.isArray(input)) {
      const output = [];
      for (const child of input) output.push(await visit(child));
      ancestors.delete(input);
      return output;
    }
    const output = {};
    for (const [key, child] of Object.entries(input)) {
      if (key === "favIconUrl") {
        let asset = byDataUrl.get(child);
        if (asset === undefined) {
          asset = await assetFromDataUrl(child, cryptoProvider);
          byDataUrl.set(child, asset);
        }
        if (asset) {
          assets.set(asset.digest, asset);
          output[ASSET_MARKER] = asset.digest;
          continue;
        }
      }
      output[key] = await visit(child);
    }
    ancestors.delete(input);
    return output;
  };

  return { value: await visit(value), assets: [...assets.values()] };
}

export function assetDigestsIn(value) {
  const digests = new Set();
  const visit = (input) => {
    if (Array.isArray(input)) {
      input.forEach(visit);
      return;
    }
    if (!input || typeof input !== "object") return;
    if (typeof input[ASSET_MARKER] === "string") digests.add(input[ASSET_MARKER]);
    Object.values(input).forEach(visit);
  };
  visit(value);
  return digests;
}

/** Read unique local assets without flooding one IndexedDB transaction. */
export async function readAssetsByDigest(transaction, storeName, digests) {
  const unique = [...new Set(digests)];
  if (unique.length === 0) return new Map();
  const assets = new Array(unique.length);
  let cursor = 0;
  let failed = false;

  const readNext = async () => {
    while (!failed) {
      const index = cursor;
      cursor += 1;
      if (index >= unique.length) return;
      try {
        assets[index] = await transaction.get(storeName, unique[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(LOCAL_ASSET_READ_CONCURRENCY, unique.length) }, readNext)
  );
  return new Map(assets.filter(Boolean).map((asset) => [asset.digest, asset]));
}

/** A favicon-free projection removes both public icons and private asset markers. */
export function hydrateEmbeddedFavicons(value, assetsByDigest, { includeFavicons = true } = {}) {
  const visit = (input) => {
    if (Array.isArray(input)) return input.map(visit);
    if (!input || typeof input !== "object") return input;
    const output = {};
    for (const [key, child] of Object.entries(input)) {
      if (key === ASSET_MARKER || (!includeFavicons && key === "favIconUrl")) continue;
      output[key] = visit(child);
    }
    const digest = input[ASSET_MARKER];
    const asset = includeFavicons && typeof digest === "string" ? assetsByDigest.get(digest) : null;
    if (asset?.dataUrl) output.favIconUrl = asset.dataUrl;
    return output;
  };
  return visit(value);
}
