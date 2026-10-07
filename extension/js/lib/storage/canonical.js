// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Stable serialization and cryptographic content identities. */

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalValue(value, ancestors = new WeakSet(), path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Storage values must contain finite numbers");
    return value;
  }
  if (!value || typeof value !== "object") {
    throw new Error(`Storage value at ${path} must be JSON-compatible`);
  }
  if (ancestors.has(value)) throw new Error("Storage values cannot contain cycles");
  ancestors.add(value);
  let output;
  if (Array.isArray(value)) {
    output = value.map((item, index) => canonicalValue(item, ancestors, `${path}[${index}]`));
  } else {
    if (!plainObject(value)) throw new Error("Storage values must use plain objects");
    output = Object.fromEntries(
      Object.keys(value).sort().map((key) => [
        key,
        canonicalValue(value[key], ancestors, `${path}.${key}`)
      ])
    );
  }
  ancestors.delete(value);
  return output;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Bytes(bytes, cryptoProvider = globalThis.crypto) {
  if (!cryptoProvider?.subtle) throw new Error("Web Crypto is required for Storage");
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return `sha256:${hex(new Uint8Array(await cryptoProvider.subtle.digest("SHA-256", input)))}`;
}

export async function contentHash(value, cryptoProvider = globalThis.crypto) {
  return sha256Bytes(new TextEncoder().encode(canonicalJson(value)), cryptoProvider);
}
