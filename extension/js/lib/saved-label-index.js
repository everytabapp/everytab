import { tabLabels } from "./labels.js";
import { normalizeUrl } from "./dedup.js";

/**
 * Build the read-only URL → labels projection used by Open tabs.
 *
 * This deliberately accepts already-live item arrays: storage owns cloning,
 * tombstone filtering, and invalidation; this helper owns only the linear
 * projection. Keeping it pure makes the mature-profile enrichment measurable
 * without a browser and prevents the Open surface from duplicating label rules.
 *
 * @param {Array<object>} inboxItems
 * @param {Array<object>} archiveItems
 * @returns {Map<string, string[]>}
 */
export function buildSavedLabelsByUrl(inboxItems = [], archiveItems = []) {
  const byUrl = new Map();
  for (const items of [inboxItems, archiveItems]) {
    for (const item of items) {
      for (const tab of item.tabs ?? []) {
        const labels = tabLabels(item, tab);
        if (labels.length === 0) continue;
        const key = normalizeUrl(tab.url);
        if (!key) continue;
        byUrl.set(key, [...new Set([...(byUrl.get(key) ?? []), ...labels])]);
      }
    }
  }
  return byUrl;
}
