// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Pure stale-input guards shared by saved-record exit operations. */
import { canonicalJson } from "./storage/canonical.js";

/** @typedef {import("./types.js").InboxItem} InboxItem */
/** @typedef {import("./types.js").Meta} Meta */
/** @typedef {{item:InboxItem,indexes:number[]}} SavedTabSelection */
/** @typedef {{expected:InboxItem,indexes:number[]}} GroupedSavedTabSelection */
/** @typedef {{indexed?:boolean}} SavedCarrierOptions */

const refIdentity = (ref) => {
  const copy = { ...(ref ?? {}) };
  delete copy.labels;
  return canonicalJson(copy);
};

const occurrenceLayout = (record) => Array.isArray(record?.tabs)
  ? record.tabs.map(refIdentity)
  : null;

function hasAmbiguousOccurrences(record) {
  const identities = (record?.tabs ?? []).map(refIdentity);
  return new Set(identities).size !== identities.length;
}

/**
 * Exact JSON-shaped equality independent of object key insertion order.
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function sameSavedRecord(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Check that a live carrier is the same saved identity and still has the same
 * ordered occurrence layout as the caller snapshot. Label-only and unrelated
 * metadata changes can rebase because the caller never supplies written data.
 * @param {InboxItem} expected
 * @param {InboxItem|Meta|null|undefined} current
 * @param {SavedCarrierOptions} [options]
 * @returns {boolean}
 */
export function canUseCurrentSavedCarrier(expected, current, { indexed = false } = {}) {
  if (!Array.isArray(expected?.tabs) || !Array.isArray(current?.tabs) || current.deletedAt ||
      expected?.id !== current.id ||
      expected?.createdAt !== current.createdAt ||
      expected?.deviceId !== current.deviceId ||
      canonicalJson(occurrenceLayout(expected)) !== canonicalJson(occurrenceLayout(current))) {
    return false;
  }
  if (!indexed || !hasAmbiguousOccurrences(current)) return true;
  return sameSavedRecord(expected.tabs, current.tabs);
}

/**
 * Collapse repeated whole-carrier inputs. Two different snapshots for one id
 * are conflicting user intents, so that carrier is omitted conservatively.
 * @param {InboxItem[]} [items]
 * @returns {InboxItem[]}
 */
export function groupSavedItems(items) {
  const grouped = new Map();
  for (const item of items ?? []) {
    if (!item?.id || !Array.isArray(item.tabs)) continue;
    const existing = grouped.get(item.id);
    if (existing) {
      if (!sameSavedRecord(existing.expected, item)) existing.conflicting = true;
      continue;
    }
    grouped.set(item.id, { expected: item, conflicting: false });
  }
  return [...grouped.values()]
    .filter((group) => !group.conflicting)
    .map((group) => group.expected);
}

/**
 * Collapse repeated tab selections per carrier and dedupe valid indexes.
 * Conflicting snapshots for one id invalidate only that carrier.
 * @param {SavedTabSelection[]} [sources]
 * @returns {GroupedSavedTabSelection[]}
 */
export function groupSavedTabSelections(sources) {
  const grouped = new Map();
  for (const { item, indexes } of sources ?? []) {
    if (!item?.id || !Array.isArray(item.tabs)) continue;
    const existing = grouped.get(item.id);
    if (existing && !sameSavedRecord(existing.expected, item)) {
      existing.conflicting = true;
      continue;
    }
    const group = existing ?? { expected: item, indexes: new Set(), conflicting: false };
    for (const index of indexes ?? []) {
      if (Number.isInteger(index) && index >= 0 && item.tabs[index]) group.indexes.add(index);
    }
    grouped.set(item.id, group);
  }
  return [...grouped.values()]
    .filter((group) => !group.conflicting && group.indexes.size > 0)
    .map((group) => ({
      expected: group.expected,
      indexes: [...group.indexes].sort((left, right) => left - right)
    }));
}
