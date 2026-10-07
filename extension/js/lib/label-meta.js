// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * F21 — per-label "last used" recency register. A small ambient map
 * (label → lastUsedAt epoch ms), bumped ONLY when a label is applied to a tab or
 * renamed to, so the Labels "recent" order reflects real use rather than any
 * unrelated edit to a carrier bundle (the old L-nav-5 proxy inflated a label's
 * recency whenever anything touched a bundle it lived on). Grow-only: entries
 * only ever move forward in time. Label EXISTENCE is never read from here —
 * collectLabels derives it from live carriers — so an orphaned entry (a label
 * whose last carrier was removed) is harmless and never surfaces.
 *
 * Mirrors counters.js: a pure seam (touchedLabelMeta / renamedLabelMeta) to fold
 * a bump into an existing mutateStores commit atomically, plus a standalone
 * locked writer (touchLabels) for the few apply sites that write via upsertItem
 * or run in the background. Synced whole-map by per-key max (merge.js
 * mergeLabelMeta). Stored under chrome.storage.local key "labelMeta".
 */
import { mutateStores, readStoreMap } from "./store.js";

const KEY = "labelMeta";

/** Storage key, exported so domain ops can ride a label-recency bump in the same
 * atomic mutateStores commit as the label write it records (F21, counters pattern). */
export const LABEL_META_KEY = KEY;

/** Trim + dedup a label list down to non-empty names.
 * @param {string|string[]|undefined} labels */
function cleanLabels(labels) {
  const arr = Array.isArray(labels) ? labels : labels ? [labels] : [];
  return [...new Set(arr.map((l) => String(l).trim()).filter(Boolean))];
}

/**
 * Pure: a new label-meta map with each of `labels` bumped to `now` — grow-only,
 * so an entry never moves backward (clock skew / out-of-order merges are safe).
 * For use inside a mutateStores mutator.
 * @param {Record<string, number>|undefined} map
 * @param {string|string[]} labels @param {number} now
 * @returns {Record<string, number>}
 */
export function touchedLabelMeta(map, labels, now) {
  const next = { ...(map ?? {}) };
  for (const l of cleanLabels(labels)) next[l] = Math.max(next[l] ?? 0, now);
  return next;
}

/**
 * Pure: on a rename, move recency from `from` to `to` — the target inherits
 * max(to, from, now) (a rename is a deliberate use of the target name) and the
 * `from` orphan is dropped. No-op-safe when either side is absent.
 * @param {Record<string, number>|undefined} map
 * @param {string} from @param {string} to @param {number} now
 * @returns {Record<string, number>}
 */
export function renamedLabelMeta(map, from, to, now) {
  const next = { ...(map ?? {}) };
  const merged = Math.max(next[to] ?? 0, next[from] ?? 0, now);
  delete next[from];
  next[to] = merged;
  return next;
}

/**
 * Standalone: bump `labels` to `now` under the store lock. For apply sites that
 * write the labeled record via upsertItem or run in the background (not already
 * inside a mutateStores commit). Non-atomic w.r.t. the label write by design — a
 * missed bump degrades to the proxy recency until the label's next use. No-op for
 * an empty label set. NOT reentrant: never call from inside another lock section.
 * @param {string|string[]} labels @param {number} [now]
 */
export async function touchLabels(labels, now = Date.now()) {
  const clean = cleanLabels(labels);
  if (clean.length === 0) return;
  await mutateStores([KEY], (maps) => ({
    [KEY]: touchedLabelMeta(maps[KEY], clean, now)
  }));
}

/** @returns {Promise<Record<string, number>>} the label → lastUsedAt map */
export async function getLabelMeta() {
  return await readStoreMap(KEY) ?? {};
}
