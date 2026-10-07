// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Pure compatibility projections for portable Snooze records. */
import { sameSavedRecord } from "./saved-selection-safety.js";

/**
 * A Snooze's tabs at tab grain. Saved single-tab transfers retain a full
 * one-element `tabs` payload; scalar single-tab Snoozes retain url/title.
 * @param {import("./types.js").Snooze} snooze
 * @returns {import("./types.js").TabRef[]}
 */
export function snoozeRefs(snooze) {
  return Array.isArray(snooze?.tabs) && snooze.tabs.length > 0
    ? snooze.tabs
    : [{
        url: snooze?.url ?? "",
        title: snooze?.title || snooze?.url || "",
        ...(snooze?.favIconUrl ? { favIconUrl: snooze.favIconUrl } : {})
      }];
}

/**
 * True only when `tabs` represents a window bundle. A metadata-carrying saved
 * single has one full ref plus its non-empty scalar URL view.
 * One-tab window Snoozes (including a split bundle) retain an empty scalar URL.
 * @param {import("./types.js").Snooze} snooze
 */
export function isWindowSnooze(snooze) {
  const refs = Array.isArray(snooze?.tabs) ? snooze.tabs : [];
  return refs.length > 1 || (refs.length === 1 && !snooze?.url);
}

/**
 * Exact persisted-record equality, including same-millisecond edits and the
 * ordered tab layout.
 * @param {import("./types.js").Snooze|null|undefined} left
 * @param {import("./types.js").Snooze|null|undefined} right
 * @returns {boolean}
 */
export function sameSnoozeRecord(left, right) {
  return sameSavedRecord(left, right);
}

/**
 * Snapshot, validate, and de-duplicate tab-grain selections by Snooze id.
 * @param {{snooze:import("./types.js").Snooze,indexes:number[]}[]} selections
 * @returns {{snooze:import("./types.js").Snooze,indexes:number[]}[]|null}
 */
export function normalizedSnoozeSelections(selections) {
  if (!Array.isArray(selections)) return null;
  const byId = new Map();
  for (const selection of selections) {
    const snooze = selection?.snooze;
    if (!snooze || typeof snooze.id !== "string" || !Array.isArray(selection.indexes)) {
      return null;
    }
    const refs = snoozeRefs(snooze);
    const indexes = [...new Set(selection.indexes)];
    if (indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= refs.length)) {
      return null;
    }
    const existing = byId.get(snooze.id);
    if (existing && !sameSnoozeRecord(existing.snooze, snooze)) return null;
    if (existing) existing.indexes.push(...indexes);
    else byId.set(snooze.id, { snooze: structuredClone(snooze), indexes });
  }
  return [...byId.values()]
    .map((selection) => ({
      ...selection,
      indexes: [...new Set(selection.indexes)].sort((a, b) => a - b)
    }))
    .filter((selection) => selection.indexes.length > 0);
}

/**
 * Remove exact indexes from a fresh current Snooze without losing metadata.
 * @param {import("./types.js").Snooze} snooze
 * @param {number[]} indexes
 * @param {number} now
 * @returns {{snooze:import("./types.js").Snooze,emptied:boolean}}
 */
export function snoozeWithoutIndexes(snooze, indexes, now) {
  const drop = new Set(indexes);
  const keep = snoozeRefs(snooze).filter((_, index) => !drop.has(index));
  if (keep.length === 0) {
    return { snooze: { ...snooze, deletedAt: now, modifiedAt: now }, emptied: true };
  }
  return {
    snooze: {
      ...snooze,
      tabs: keep,
      title: keep.length > 1 ? `Window (${keep.length} tabs)` : keep[0].title || keep[0].url,
      modifiedAt: now
    },
    emptied: false
  };
}
