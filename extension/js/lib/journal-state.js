// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Pure Journal transaction sealing and freshness checks. */
import { ARCHIVE_OVERLAY_KEY, STORE_KEYS } from "./types.js";

export const JOURNAL_KEY = "journal";
export const JOURNAL_CAP = 200;
export const JOURNAL_UNDO_CONTRACT_VERSION = 1;

/** @typedef {import("./types.js").JournalEntry} JournalEntry */
/** @typedef {import("./types.js").Meta & {deletedAt:number,deletionRevision:string}} JournalDeletionMarker */
/** @typedef {Record<string, Record<string, JournalDeletionMarker>>} JournalDeletionMaps */

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function fingerprint(value) {
  const text = JSON.stringify(stableValue(value)) ?? "undefined";
  const hashes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  const primes = [0x01000193, 0x27d4eb2d, 0x165667b1, 0x9e3779b1];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    for (let lane = 0; lane < hashes.length; lane++) {
      hashes[lane] = Math.imul(hashes[lane] ^ code, primes[lane]);
    }
  }
  return `hash128:${hashes.map((hash) =>
    (hash >>> 0).toString(16).padStart(8, "0")).join("")}`;
}

function recordAt(maps, sets, store, id) {
  if (Object.hasOwn(sets, store)) {
    const map = sets[store] ?? {};
    return { present: Object.hasOwn(map, id), value: map[id] };
  }
  // Small Archive writes use the physical overlay without reading the full
  // logical Archive. A newly written overlay record is still the authoritative
  // post-state for that logical id.
  if (store === STORE_KEYS.archive && Object.hasOwn(sets, ARCHIVE_OVERLAY_KEY)) {
    const overlay = sets[ARCHIVE_OVERLAY_KEY] ?? {};
    if (Object.hasOwn(overlay, id)) return { present: true, value: overlay[id] };
  }
  const map = maps[store] ?? (store === STORE_KEYS.archive ? maps[ARCHIVE_OVERLAY_KEY] : null) ?? {};
  return { present: Object.hasOwn(map, id), value: map[id] };
}

function targetPairs(entry) {
  const pairs = new Map();
  for (const target of [...(entry?.puts ?? []), ...(entry?.dels ?? [])]) {
    if (typeof target?.store !== "string" ||
        (typeof target?.id !== "string" && typeof target?.item?.id !== "string")) continue;
    const id = typeof target.id === "string" ? target.id : target.item.id;
    pairs.set(`${target.store}\u0000${id}`, { store: target.store, id });
  }
  return [...pairs.values()];
}

function postDescriptor(maps, sets, target) {
  const record = recordAt(maps, sets, target.store, target.id);
  if (!record.present) return { ...target, present: false };
  return {
    ...target,
    present: true,
    modifiedAt: Number.isFinite(record.value?.modifiedAt) ? record.value.modifiedAt : 0,
    ...(Number.isFinite(record.value?.deletedAt) ? { deletedAt: record.value.deletedAt } : {}),
    hash: fingerprint(record.value)
  };
}

/**
 * Replace only committed deletion descriptors in newly appended entries.
 * Live/read-only target descriptors were sealed by the Store and must survive
 * unchanged: the physical commit may not contain their record maps at all.
 * @param {JournalEntry[]} priorJournal
 * @param {JournalEntry[]} journal
 * @param {JournalDeletionMaps} deletionMaps final compact markers by store/id
 * @returns {JournalEntry[]}
 */
export function sealCommittedJournalDeletions(priorJournal, journal, deletionMaps) {
  const priorIds = new Set(priorJournal.map((entry) => entry?.id));
  return journal.map((entry) => {
    if (!entry?.id || priorIds.has(entry.id) || !hasValidUndoContract(entry)) return entry;
    const undoPostState = entry.undoPostState.map((target) =>
      Object.hasOwn(deletionMaps[target.store] ?? {}, target.id)
        ? postDescriptor({}, deletionMaps, target) : target);
    return { ...entry, undoPostState };
  });
}

/**
 * Seal every newly appended entry against the exact record post-state in the
 * same atomic commit. `mutateStores` calls this after the domain mutator and
 * before its one storage write, so callers cannot forget the stale guard.
 */
export function sealJournalCommit(maps, sets) {
  const nextJournal = sets?.[JOURNAL_KEY];
  if (!Array.isArray(nextJournal)) return sets;
  const priorIds = new Set((maps?.[JOURNAL_KEY] ?? []).map((entry) => entry?.id));
  let changed = false;
  const journal = nextJournal.map((entry) => {
    if (!entry?.id || priorIds.has(entry.id) || entry.undoContractVersion) return entry;
    changed = true;
    return {
      ...entry,
      undoContractVersion: JOURNAL_UNDO_CONTRACT_VERSION,
      undoPostState: targetPairs(entry).map((target) => postDescriptor(maps, sets, target))
    };
  });
  return changed ? { ...sets, [JOURNAL_KEY]: journal } : sets;
}

/** Stores touched by the inverse and therefore required for a fresh Undo read. */
export function journalTargetStores(entry) {
  return [...new Set(targetPairs(entry).map((target) => target.store))];
}

/** A sealed entry must describe every inverse record exactly once. */
export function hasValidUndoContract(entry) {
  if (entry?.undoContractVersion !== JOURNAL_UNDO_CONTRACT_VERSION ||
      !Array.isArray(entry.undoPostState)) return false;
  const targets = targetPairs(entry);
  if (targets.length !== entry.undoPostState.length) return false;
  const expected = new Map(entry.undoPostState.map((target) =>
    [`${target?.store}\u0000${target?.id}`, target]));
  if (expected.size !== targets.length) return false;
  return targets.every((target) => {
    const descriptor = expected.get(`${target.store}\u0000${target.id}`);
    return descriptor && typeof descriptor.present === "boolean" &&
      (!descriptor.present || typeof descriptor.hash === "string");
  });
}

/** Compare one sealed entry with the fresh maps read under the store lock. */
export function journalStaleStores(entry, maps) {
  const stale = new Set();
  for (const expected of entry?.undoPostState ?? []) {
    const current = postDescriptor(maps, {}, expected);
    if (current.present !== expected.present || current.hash !== expected.hash) {
      stale.add(expected.store);
    }
  }
  return [...stale];
}
