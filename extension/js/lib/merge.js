/**
 * M5 — pure merge logic (PRD §4). No chrome APIs: Node-testable.
 *
 * Semantics: item-level union by id; whole-record last-write-wins by
 * modifiedAt; ties → local wins (avoids pointless writes). Tombstones are
 * records like any other — the newest version wins, so deletions propagate.
 * Per-field LWW deferred to a future schema version; the losing record is
 * retained in the daily vault backups, so any merge can be undone.
 */

import { SCHEMA_VERSION } from "./types.js";

/** A record we can merge: needs id + modifiedAt (all EveryTab records qualify). */
function usable(r) {
  return r && typeof r === "object" && typeof r.id === "string" && Number.isFinite(r.modifiedAt);
}

/**
 * Records from a schema newer than ours are opaque — never merge or rewrite
 * them (we must not write formats we can't read back). Older versions pass
 * through the migration hook (a no-op while SCHEMA_VERSION === 1).
 * @param {object} r
 */
export function acceptableSchema(r) {
  return (r.schemaVersion ?? 1) <= SCHEMA_VERSION;
}

/** Migration hook for records from older schema versions. No-op at v1. */
export function migrateRecord(r) {
  return r;
}

/**
 * Pick the winner between a local and a remote copy of the same record.
 * @template T
 * @param {T|undefined} local @param {T|undefined} remote
 * @returns {T}
 */
export function mergeRecord(local, remote) {
  if (!usable(remote)) return local;
  if (!usable(local)) return remote;
  return remote.modifiedAt > local.modifiedAt ? remote : local;
}

/**
 * Union-merge two record maps (id → record).
 * @param {Record<string, object>} local
 * @param {Record<string, object>} remote
 * @returns {{merged: Record<string, object>, pulled: string[], pushed: string[]}}
 *   pulled: ids where the remote copy won (local store must be updated)
 *   pushed: ids where the local copy is absent remotely or newer (file must be written)
 */
export function mergeMaps(local, remote) {
  /** @type {Record<string, object>} */
  const merged = {};
  const pulled = [];
  const pushed = [];
  const ids = new Set([...Object.keys(local), ...Object.keys(remote)]);

  for (const id of ids) {
    const l = usable(local[id]) ? local[id] : undefined;
    let r = usable(remote[id]) ? remote[id] : undefined;
    if (r && !acceptableSchema(r)) {
      // Future-schema record: keep whatever we have locally, never rewrite theirs.
      console.warn(`EveryTab: skipping record ${id} with newer schemaVersion ${r.schemaVersion}`);
      if (l) merged[id] = l;
      continue;
    }
    if (r) r = migrateRecord(r);

    if (l && r) {
      if (r.modifiedAt > l.modifiedAt) {
        merged[id] = r;
        pulled.push(id);
      } else {
        merged[id] = l; // ties → local wins, no write either way
        if (l.modifiedAt > r.modifiedAt) pushed.push(id);
      }
    } else if (r) {
      merged[id] = r;
      pulled.push(id);
    } else if (l) {
      merged[id] = l;
      pushed.push(id);
    }
  }
  return { merged, pulled, pushed };
}

/**
 * F21 — merge two label-recency registers (`label → lastUsedAt` epoch ms) by
 * per-key MAX. The register is grow-only, so the union with each key at its
 * highest timestamp is the correct CRDT: a label used more recently on either
 * device wins, and no key is ever lost. Never fabricates a newer time than either
 * input holds. Non-finite values are ignored. Deletion is not represented here —
 * label existence is authoritative from carriers (whose tombstones propagate via
 * mergeMaps), so an orphan recency key is harmless and simply never surfaces.
 * @param {Record<string, number>|undefined} local
 * @param {Record<string, number>|undefined} remote
 * @returns {Record<string, number>} the per-key max union
 */
export function mergeLabelMeta(local, remote) {
  // Label text is user-controlled and may legitimately equal names such as
  // "__proto__". A null-prototype dictionary keeps those names as ordinary
  // own properties instead of invoking Object.prototype setters.
  const merged = Object.assign(Object.create(null), local ?? {});
  for (const [k, v] of Object.entries(remote ?? {})) {
    if (Number.isFinite(v)) merged[k] = Math.max(merged[k] ?? 0, v);
  }
  return merged;
}
