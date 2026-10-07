// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { newMeta } from "./store.js";
import { buildPortableExport, restorePortableState } from "./portable-state.js";
import { unwrapSuspendedUrl } from "./tabs.js";

/** Full v2 portable export; the historical name remains a stable call seam. */
export async function buildJsonExport() {
  return buildPortableExport();
}

/**
 * Import a JSON export, merging by item id: an incoming item wins only if the
 * local copy is absent or older (modifiedAt). Importing the same file twice
 * is a no-op. This is the precursor of the M5 vault merge.
 * @param {string} text
 * Legacy adapter for existing callers. New Restore UI uses the preview and
 * checkpoint-aware interface in portable-state.js directly.
 * @returns {Promise<{imported: number, skipped: number, status: string,
 *   checkpointId: string|null, journalEntry: object|null, summary: object}>}
 */
export async function importJson(text) {
  const result = await restorePortableState(text, { restoreSettings: true });
  return {
    ...result,
    imported: result.summary.records.added + result.summary.records.updated,
    skipped: result.summary.records.keptIncoming
  };
}

/* ------------------------- F19: copy as markdown ------------------------- */

/** Whitespace-collapse a link title and escape `[`/`]` so the markdown link
 * can't break; an empty title falls back to the URL. @param {string} title @param {string} url */
function markdownLinkText(title, url) {
  const collapsed = String(title ?? "").replace(/\s+/g, " ").trim();
  return (collapsed || url).replace(/[[\]]/g, "\\$&");
}

/**
 * F19 — a Markdown bullet list of `- [Title](URL)` for the http(s) tabs in `tabs`.
 * Non-http tabs are skipped (nothing to link). Returns "" when none qualify.
 * @param {import("./types.js").TabRef[]} tabs
 * @returns {string}
 */
export function linksToMarkdown(tabs) {
  return (tabs ?? [])
    .filter((t) => /^https?:/.test(t?.url ?? ""))
    .map((t) => `- [${markdownLinkText(t.title, t.url)}](${t.url})`)
    .join("\n");
}

/**
 * F19 — a session or snapshot as Markdown: `# {name}`, then the window bullets.
 * A multi-window session gets a `## Window k` subheading per (non-empty) window;
 * a single window is just the name heading + bullets.
 * @param {import("./types.js").Session} session
 * @returns {string}
 */
export function sessionToMarkdown(session) {
  const name = String(session?.name ?? "Session").trim() || "Session";
  const windows = (session?.windows ?? []).map((w) => linksToMarkdown(w)).filter(Boolean);
  if (windows.length === 0) return `# ${name}`;
  if (windows.length === 1) return `# ${name}\n\n${windows[0]}`;
  return `# ${name}\n\n${windows.map((w, i) => `## Window ${i + 1}\n${w}`).join("\n\n")}`;
}

/**
 * OneTab-format export of Inbox items: "url | title" lines,
 * blank line between groups.
 * @param {import("./types.js").InboxItem[]} items
 */
export function buildOneTabExport(items) {
  return items
    .map((item) => item.tabs.map((t) => `${t.url} | ${t.title}`).join("\n"))
    .join("\n\n");
}

/**
 * Parse OneTab-format text into Inbox items (one per group).
 * Tolerates lines without " | title". Unwraps suspender URLs.
 * @param {string} text
 * @returns {Promise<import("./types.js").InboxItem[]>}
 */
export async function parseOneTabImport(text) {
  const groups = text
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const sep = line.indexOf(" | ");
          const url = unwrapSuspendedUrl(sep === -1 ? line : line.slice(0, sep));
          const title = sep === -1 ? url : line.slice(sep + 3);
          return { url, title };
        })
        .filter((t) => /^https?:/.test(t.url))
    )
    .filter((tabs) => tabs.length > 0);

  /** @type {import("./types.js").InboxItem[]} */
  const items = [];
  for (const tabs of groups) {
    items.push({
      ...(await newMeta()),
      kind: tabs.length > 1 ? "window" : "tab",
      tabs,
      source: "manual",
      labels: []
    });
  }
  return items;
}
