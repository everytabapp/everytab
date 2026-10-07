// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { listItems } from "../lib/store.js";
import { STORE_KEYS } from "../lib/types.js";
import { tabLabels } from "../lib/labels.js";
import { canonicalRef } from "../lib/tabs.js";
import { normalizeUrl } from "../lib/url-key.js";

/**
 * Read the active page's Inbox/Archive labels. Initial popup hydration supplies
 * its existing snapshots; later refreshes read both families concurrently.
 * Snapshots are used only for this call, so edits never reuse a cached label set.
 */
export async function readPopupTabLabels(tab, { inbox, archive, readItems = listItems } = {}) {
  const ref = tab ? canonicalRef(tab) : null;
  if (!ref) return [];
  const families = await Promise.all([
    inbox ?? readItems(STORE_KEYS.inbox),
    archive ?? readItems(STORE_KEYS.archive)
  ]);
  const key = normalizeUrl(ref.url);
  const labels = new Set();
  for (const items of families) {
    for (const item of items) {
      for (const saved of item.tabs ?? []) {
        if (normalizeUrl(saved.url) !== key) continue;
        for (const label of tabLabels(item, saved)) labels.add(label);
      }
    }
  }
  return [...labels];
}
