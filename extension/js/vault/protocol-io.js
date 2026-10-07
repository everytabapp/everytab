// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Shared, DOM-free File System Access primitives for the Vault protocol. */
import { contentHash } from "../lib/storage/canonical.js";
import { VAULT_FAILURE_CODES, VaultSyncError } from "./failure-codes.js";

export const VAULT_FORMAT_VERSION = 1;
export const DIGEST = /^sha256:([0-9a-f]{64})$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// macOS presents an evicted iCloud Drive file as `.name.icloud` until it is
// downloaded again. Sync services write conflict copies beside the original.
const CLOUD_PLACEHOLDER = /^\..+\.icloud$/;
const CONFLICT_COPY = /conflicted copy|sync-conflict|\.conflicted\b| \(\d+\)(\.[^.]+)?$| \d+(\.[^.]+)?$/i;

/**
 * Classify an entry that is not one of the protocol's own names.
 * @returns {"placeholder"|"conflict-copy"|null}
 */
export function classifyForeignEntry(name) {
  if (typeof name !== "string") return null;
  if (CLOUD_PLACEHOLDER.test(name)) return "placeholder";
  if (CONFLICT_COPY.test(name)) return "conflict-copy";
  return null;
}

export function isSafeName(value) {
  return typeof value === "string" && SAFE_NAME.test(value);
}

export function placeholderNameFor(name) {
  return `.${name}.icloud`;
}

/**
 * A required file is missing. When its cloud placeholder is present the cause
 * is eviction, which the user can fix by downloading the folder; report that
 * instead of a bare "missing" failure. Authoritative files still fail closed.
 */
export async function missingFileError(directory, name, kind = "file") {
  let placeholder = null;
  try {
    placeholder = await optionalFileHandle(directory, placeholderNameFor(name));
  } catch {
    placeholder = null;
  }
  if (placeholder) {
    return new VaultSyncError(`${name} is not downloaded on this device`, {
      code: VAULT_FAILURE_CODES.placeholderFile, kind
    });
  }
  return new Error(`${name} is missing from the Vault`);
}

export function requiredName(value, label) {
  if (typeof value !== "string" || !SAFE_NAME.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function requiredCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

export function parseJson(text, label) {
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} is not valid JSON`); }
}

/**
 * Report only completed enumeration work, never entry names or handles. A
 * stalled iterator produces no callback, so its caller's inactivity deadline
 * remains meaningful even while a large healthy scan exceeds that deadline.
 * @param {FileSystemDirectoryHandle} directory
 * @param {(progress:{completed:number})=>void} [onProgress]
 */
export async function entries(directory, onProgress = () => {}) {
  const found = [];
  for await (const [name, handle] of directory.entries()) {
    found.push({ name, handle });
    onProgress({ completed: found.length });
  }
  return found;
}

export async function readFileHandle(handle, label) {
  if (!handle || handle.kind !== "file") throw new Error(`${label} is missing`);
  return (await handle.getFile()).text();
}

export async function optionalFileHandle(directory, name) {
  try { return await directory.getFileHandle(name); }
  catch (error) {
    if (error?.name === "NotFoundError" || /not found/i.test(String(error?.message ?? ""))) {
      return null;
    }
    throw error;
  }
}

export async function readNamedFile(directory, name, { optional = false, kind = "file" } = {}) {
  const handle = await optionalFileHandle(directory, name);
  if (!handle) {
    if (optional) return null;
    throw await missingFileError(directory, name, kind);
  }
  return readFileHandle(handle, name);
}

export async function writeText(directory, name, text) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

export async function writeJson(directory, name, value) {
  await writeText(directory, name, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeImmutable(directory, name, text) {
  const existing = await optionalFileHandle(directory, name);
  if (existing) {
    const current = await readFileHandle(existing, name);
    if (current !== text) throw new Error(`Immutable Vault file ${name} has conflicting content`);
    return false;
  }
  await writeText(directory, name, text);
  return true;
}

export async function seal(body, cryptoProvider) {
  return { ...body, contentHash: await contentHash(body, cryptoProvider) };
}

export async function verifySeal(value, label, cryptoProvider) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  const { contentHash: supplied, ...body } = value;
  if (typeof supplied !== "string" || supplied !== await contentHash(body, cryptoProvider)) {
    throw new Error(`${label} content hash does not match`);
  }
  return value;
}

export function digestFileName(digest) {
  const match = DIGEST.exec(digest);
  if (!match) throw new Error("Vault asset digest is invalid");
  return `${match[1]}.bin`;
}

const ASSET_IO_CONCURRENCY = 8;

async function forEachBounded(items, concurrency, visit) {
  let nextIndex = 0;
  let firstError = null;
  const worker = async () => {
    while (!firstError) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        await visit(items[index], index);
      } catch (error) {
        firstError ??= error;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  ));
  if (firstError) throw firstError;
}

export function createAssetWriter(
  assetDirectory,
  { directoryStartsEmpty = false, knownDigests = [] } = {}
) {
  const known = new Set();
  const pending = new Map();

  const remember = (digests) => {
    for (const digest of digests) {
      digestFileName(digest);
      known.add(digest);
    }
  };
  remember(knownDigests);

  const ensure = async (asset, report) => {
    digestFileName(asset.digest);
    if (known.has(asset.digest)) return;
    const active = pending.get(asset.digest);
    if (active) return active;
    const operation = (async () => {
      const name = digestFileName(asset.digest);
      const expected = `${asset.dataUrl}\n`;
      if (!directoryStartsEmpty) {
        const existing = await optionalFileHandle(assetDirectory, name);
        if (existing) {
          if (await readFileHandle(existing, name) !== expected) {
            throw new Error(`Vault asset ${name} has conflicting content`);
          }
          known.add(asset.digest);
          return;
        }
      }
      await writeText(assetDirectory, name, expected);
      report.assetsWritten += 1;
      known.add(asset.digest);
    })();
    pending.set(asset.digest, operation);
    try {
      await operation;
    } finally {
      pending.delete(asset.digest);
    }
  };

  return Object.freeze({
    remember,
    async write(assets, report, onProgress = () => {}) {
      let completed = 0;
      // Asset files are independent. One bounded writer owns the complete sync,
      // so Library and Recovery can share successful work without another folder
      // round trip while publication still waits for every asset.
      await forEachBounded(assets, ASSET_IO_CONCURRENCY, async (asset) => {
        await ensure(asset, report);
        completed += 1;
        onProgress({ stage: "writing", target: "assets", completed, total: assets.length });
      });
    }
  });
}

export async function writeAssets(assetDirectory, assets, report, onProgress = () => {}) {
  return createAssetWriter(assetDirectory).write(assets, report, onProgress);
}

export async function readAssets(assetDirectory, digests, report, onProgress = () => {}) {
  const assets = new Array(digests.length);
  let completed = 0;
  await forEachBounded(digests, ASSET_IO_CONCURRENCY, async (digest, index) => {
    const name = digestFileName(digest);
    const handle = await optionalFileHandle(assetDirectory, name);
    if (!handle) throw await missingFileError(assetDirectory, name, "asset");
    const text = await readFileHandle(handle, `Vault asset ${name}`);
    assets[index] = { digest, dataUrl: text.replace(/\n$/, "") };
    report.assetsRead += 1;
    completed += 1;
    onProgress({
      stage: "reading", target: "assets", completed, total: digests.length
    });
  });
  return assets;
}

export async function hydrateAssetManifest(
  assetDirectory,
  manifest,
  report,
  onProgress = () => {},
  { cachedAssets = [] } = {}
) {
  const cachedByDigest = new Map(cachedAssets.map((asset) => [asset.digest, asset.dataUrl]));
  const missing = manifest.filter(({ digest }) => !cachedByDigest.has(digest));
  const cachedCount = manifest.length - missing.length;
  if (cachedCount > 0 || manifest.length === 0) {
    onProgress({
      stage: "reading", target: "assets", completed: cachedCount, total: manifest.length
    });
  }
  const payloads = await readAssets(
    assetDirectory,
    missing.map(({ digest }) => digest),
    report,
    ({ completed }) => onProgress({
      stage: "reading",
      target: "assets",
      completed: cachedCount + completed,
      total: manifest.length
    })
  );
  const payloadByDigest = new Map([
    ...cachedByDigest,
    ...payloads.map((asset) => [asset.digest, asset.dataUrl])
  ]);
  return manifest.map((asset) => ({ ...asset, dataUrl: payloadByDigest.get(asset.digest) }));
}
