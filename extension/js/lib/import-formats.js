// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * L2b — competitive import formats. A PURE module (no chrome.*): `detectFormat`
 * and `parseImport` turn a pasted/loaded export from another tab tool into one
 * uniform shape the dashboard Data page maps to Inbox bundles or a Session
 * (generalizing the OneTab flow). Everything here is synchronous and unit
 * testable; nothing touches chrome or storage.
 *
 * Formats: EveryTab Markdown, OneTab, Session Buddy (JSON), Tab Session Manager
 * (JSON), Toby (JSON), Raindrop (CSV), and universal Netscape bookmarks HTML.
 *
 * parseImport(text, format) → { name, groups, source }
 *   name    suggested Session name (top container title, else a per-format fallback)
 *   groups  [{ name, tabs: TabRef[] }] — each is one window/folder/list → one bundle
 *   source  the format id
 * Group / collection / folder / tag names ride on `TabRef.labels` (tab grain,
 * never item-level) so imports are searchable + filterable in either destination.
 */
import { unwrapSuspendedUrl } from "./tabs.js";
import { isEveryTabMarkdown, parseEveryTabMarkdown } from "./import-markdown.js";

/** Stable, language-neutral identifiers in the format picker's display order. */
export const IMPORT_FORMAT_IDS = Object.freeze([
  "everytab-markdown",
  "onetab",
  "session-buddy",
  "tab-session-manager",
  "toby",
  "raindrop-csv",
  "bookmarks-html"
]);

/* ------------------------------ shared helpers ------------------------------ */

/** Strip a leading BOM — real Session Buddy v3 exports have shipped with one. */
const stripBom = (s) => String(s ?? "").replace(/^﻿/, "");

const dedupe = (arr) => [...new Set((arr ?? []).map((x) => String(x ?? "").trim()).filter(Boolean))];

/** Keep only http(s) URLs, unwrapping foreign suspender links. → string | null */
function cleanUrl(u) {
  const url = unwrapSuspendedUrl(String(u ?? "").trim());
  return /^https?:/i.test(url) ? url : null;
}

/**
 * Build a TabRef, or null if the URL is unusable. Labels go on TabRef.labels
 * (tab grain). favIconUrl is kept only when it's an http(s) URL — base64/data:
 * favicons are dropped so we never store them in the vault.
 */
function toTab(url, title, labels = [], extra = {}) {
  const clean = cleanUrl(url);
  if (!clean) return null;
  /** @type {import("./types.js").TabRef} */
  const tab = { url: clean, title: String(title ?? "").trim() || clean };
  const ls = dedupe(labels);
  if (ls.length) tab.labels = ls;
  if (extra.favIconUrl && /^https?:/i.test(extra.favIconUrl)) tab.favIconUrl = String(extra.favIconUrl);
  if (extra.pinned) tab.pinned = true;
  return tab;
}

/** Try to JSON.parse (BOM-stripped); returns {val} on success, null on failure. */
function tryJson(t) {
  try {
    return { val: JSON.parse(stripBom(t)) };
  } catch {
    return null;
  }
}

function firstNonBlankLine(t) {
  for (const line of String(t ?? "").split(/\r?\n/)) if (line.trim()) return line;
  return "";
}

/* --------------------------------- CSV core -------------------------------- */

/**
 * Parse CSV text into rows of fields, honoring RFC-4180 quoting: quoted fields,
 * embedded commas, doubled "" escapes, and embedded newlines inside quotes.
 * Blank lines are dropped. Hand-written on purpose (no dependency).
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const s = stripBom(text);
  const rows = [];
  let row = [];
  let field = "";
  let inQ = false;
  let i = 0;
  const endField = () => { row.push(field); field = ""; };
  const endRow = () => { rows.push(row); row = []; };
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ",") { endField(); i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { endField(); endRow(); i++; continue; }
    field += c; i++;
  }
  if (field !== "" || row.length > 0) { endField(); endRow(); }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/** Raindrop CSV header: a `url` column + at least one of folder/tags/title. */
function isRaindropCsvHeader(line) {
  const cols = (parseCsv(line)[0] ?? []).map((c) => c.trim().toLowerCase());
  return cols.includes("url") && cols.some((c) => c === "folder" || c === "tags" || c === "title");
}

/* ----------------------------- HTML entity/attr ---------------------------- */

const stripTags = (s) => String(s ?? "").replace(/<[^>]*>/g, "");

function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'");
}

function attr(attrs, name) {
  const m = String(attrs ?? "").match(new RegExp(name + '\\s*=\\s*"([^"]*)"', "i"));
  return m ? m[1] : "";
}

/* ------------------------------- detection --------------------------------- */

function isTsm(v) {
  return (
    Array.isArray(v) && v.length > 0 && v[0] &&
    v[0].windows && typeof v[0].windows === "object" && !Array.isArray(v[0].windows) &&
    v[0].windowsInfo && typeof v[0].windowsInfo === "object"
  );
}

function isToby(v) {
  return Boolean(v && !Array.isArray(v) && Array.isArray(v.lists) && v.lists.length > 0 && Array.isArray(v.lists[0]?.cards));
}

function sbHasContainer(o) {
  return Boolean(
    o && (Array.isArray(o.collections) || Array.isArray(o.sessions) ||
      Array.isArray(o.folders) || Array.isArray(o.windows) ||
      Array.isArray(o.links) || Array.isArray(o.tabs))
  );
}

function isSessionBuddy(v) {
  if (!v) return false;
  if (Array.isArray(v)) return v.length > 0 && (sbHasContainer(v[0]) || typeof v[0]?.url === "string");
  return sbHasContainer(v);
}

/**
 * Sniff the format of an export blob. Returns the format id or null (garbage /
 * unrecognized). JSON shapes are checked most-specific first.
 * @param {string} text
 * @returns {("everytab-markdown"|"onetab"|"session-buddy"|"tab-session-manager"|"toby"|"raindrop-csv"|"bookmarks-html"|null)}
 */
export function detectFormat(text) {
  const t = stripBom(text);
  if (!t.trim()) return null;
  if (/NETSCAPE-Bookmark-file-1/i.test(t)) return "bookmarks-html";
  const json = tryJson(t);
  if (json) {
    if (isTsm(json.val)) return "tab-session-manager";
    if (isToby(json.val)) return "toby";
    if (isSessionBuddy(json.val)) return "session-buddy";
    return null; // valid JSON, but not a shape we know
  }
  if (isRaindropCsvHeader(firstNonBlankLine(t))) return "raindrop-csv";
  if (isEveryTabMarkdown(t)) return "everytab-markdown";
  if (/^\s*https?:\/\//im.test(t)) return "onetab";
  return null;
}

/* -------------------------------- parsers ---------------------------------- */

/** OneTab: blank-line-separated groups of `url | title` lines. No labels. */
function parseOneTab(text) {
  const groups = stripBom(text)
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const sep = line.indexOf(" | ");
          const url = sep === -1 ? line : line.slice(0, sep);
          const title = sep === -1 ? "" : line.slice(sep + 3);
          return toTab(url, title);
        })
        .filter(Boolean)
    )
    .filter((tabs) => tabs.length > 0)
    .map((tabs) => ({ name: "", tabs }));
  return { name: "OneTab import", groups, source: "onetab" };
}

/** Normalize any Session Buddy shape → [{title, folders:[{title, links[]}]}]. */
function sbContainers(v) {
  const asFolders = (o) => o.folders ?? o.windows ?? null;
  const asLinks = (o) => o.links ?? o.tabs ?? null;
  const collFrom = (c) => {
    const title = c.name || c.title || "";
    const folders = asFolders(c);
    if (Array.isArray(folders)) {
      return {
        title,
        folders: folders.map((f) => ({ title: f.name || f.title || "", links: asLinks(f) ?? [] }))
      };
    }
    const links = asLinks(c);
    if (Array.isArray(links)) return { title, folders: [{ title: "", links }] };
    return { title, folders: [] };
  };
  let collections;
  if (Array.isArray(v)) collections = v;
  else if (Array.isArray(v.collections)) collections = v.collections;
  else if (Array.isArray(v.sessions)) collections = v.sessions;
  else if (sbHasContainer(v)) collections = [v]; // bare {folders|windows|links|tabs:…}
  else collections = [];
  return collections.map(collFrom);
}

function parseSessionBuddy(text) {
  const v = JSON.parse(stripBom(text));
  const groups = [];
  let topName = "";
  for (const coll of sbContainers(v)) {
    if (!topName && coll.title) topName = coll.title;
    for (const folder of coll.folders) {
      const labels = dedupe([coll.title, folder.title]);
      const tabs = (folder.links || [])
        .map((l) => toTab(l.url, l.title, labels, { favIconUrl: l.favIconUrl, pinned: l.pinned }))
        .filter(Boolean);
      if (tabs.length) groups.push({ name: folder.title || coll.title || "", tabs });
    }
  }
  return { name: topName || "Session Buddy import", groups, source: "session-buddy" };
}

/** Tab Session Manager: array of sessions; windows/tabs are objects keyed by id. */
function parseTsm(text) {
  const arr = JSON.parse(stripBom(text));
  const groups = [];
  let topName = "";
  for (const session of Array.isArray(arr) ? arr : []) {
    const sname = session.name || "";
    if (!topName && sname) topName = sname;
    const tags = Array.isArray(session.tag) ? session.tag : [];
    const labels = dedupe([sname, ...tags]);
    const windowsObj = session.windows || {};
    for (const wid of Object.keys(windowsObj)) {
      const tabsObj = windowsObj[wid] || {};
      const tabs = Object.values(tabsObj)
        .slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) // object key order is NOT reliable
        .map((t) => toTab(t.url, t.title, labels, { favIconUrl: t.favIconUrl, pinned: t.pinned }))
        .filter(Boolean);
      if (tabs.length) groups.push({ name: sname, tabs });
    }
  }
  return { name: topName || "Tab Session Manager import", groups, source: "tab-session-manager" };
}

/** Toby: {lists:[{title, cards:[{url, title, customTitle}]}]}. customTitle wins. */
function parseToby(text) {
  const v = JSON.parse(stripBom(text));
  const lists = Array.isArray(v?.lists) ? v.lists : [];
  const groups = [];
  for (const list of lists) {
    const title = list.title || "";
    const labels = dedupe([title]);
    const tabs = (Array.isArray(list.cards) ? list.cards : [])
      .map((c) => {
        const ct = String(c.customTitle ?? "").trim();
        return toTab(c.url, ct || c.title, labels);
      })
      .filter(Boolean);
    if (tabs.length) groups.push({ name: title, tabs });
  }
  return { name: "Toby import", groups, source: "toby" };
}

/** Raindrop CSV: header row, `folder` (/-nested), quoted `tags`. RFC-4180 quoting. */
function parseRaindropCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { name: "Raindrop import", groups: [], source: "raindrop-csv" };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const iUrl = col("url");
  const iFolder = col("folder");
  const iTitle = col("title");
  const iTags = col("tags");
  const byFolder = new Map();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const url = iUrl >= 0 ? row[iUrl] : "";
    const folder = iFolder >= 0 ? row[iFolder] ?? "" : "";
    const title = iTitle >= 0 ? row[iTitle] ?? "" : "";
    const tags = (iTags >= 0 ? row[iTags] ?? "" : "").split(",").map((s) => s.trim()).filter(Boolean);
    const segments = folder.split("/").map((s) => s.trim()).filter(Boolean);
    const tab = toTab(url, title, [...segments, ...tags]);
    if (!tab) continue;
    const key = folder || "";
    const g = byFolder.get(key) ?? { name: segments.join("/") || "Imported", tabs: [] };
    g.tabs.push(tab);
    byFolder.set(key, g);
  }
  return { name: "Raindrop import", groups: [...byFolder.values()].filter((g) => g.tabs.length), source: "raindrop-csv" };
}

/** Netscape bookmarks HTML: parsed tolerantly by lines/regex, folder-path stack. */
function parseBookmarksHtml(text) {
  const lines = stripBom(text).split(/\r?\n/);
  const stack = []; // folder path segments
  const byPath = new Map();
  const ROOT = "\u0000root";
  for (const line of lines) {
    const h3 = line.match(/<H3[^>]*>([\s\S]*?)<\/H3>/i);
    if (h3) {
      stack.push(decodeEntities(stripTags(h3[1])).trim());
      continue;
    }
    if (/<\/DL>/i.test(line)) {
      if (stack.length) stack.pop();
      continue;
    }
    const aRe = /<A\s+([^>]*?)>([\s\S]*?)<\/A>/gi;
    let m;
    while ((m = aRe.exec(line))) {
      const href = attr(m[1], "href");
      const title = decodeEntities(stripTags(m[2])).trim();
      const tags = String(attr(m[1], "tags")).split(",").map((s) => s.trim()).filter(Boolean);
      const tab = toTab(href, title, [...stack, ...tags]); // ICON="data:…" is not read → dropped
      if (!tab) continue;
      const key = stack.length ? stack.join("/") : ROOT;
      const g = byPath.get(key) ?? { name: stack.length ? stack.join("/") : "Imported bookmarks", tabs: [] };
      g.tabs.push(tab);
      byPath.set(key, g);
    }
  }
  return { name: "Bookmarks import", groups: [...byPath.values()].filter((g) => g.tabs.length), source: "bookmarks-html" };
}

/**
 * Parse an export blob of a known format into the uniform import shape.
 * @param {string} text @param {string} format one of the IMPORT_FORMAT_IDS
 * @returns {{name: string, groups: {name: string, tabs: import("./types.js").TabRef[]}[], source: string}}
 */
/**
 * L2c — aggregate counts for the import preview. Pure.
 * @param {{tabs: {labels?: string[]}[]}[]} groups
 * @returns {{groups: number, tabs: number, labels: number}} groups, links (tabs),
 *   and distinct labels across all tabs.
 */
export function importCounts(groups) {
  const g = groups ?? [];
  const tabs = g.reduce((n, x) => n + (x.tabs?.length ?? 0), 0);
  const labels = new Set(g.flatMap((x) => (x.tabs ?? []).flatMap((t) => t.labels ?? []))).size;
  return { groups: g.length, tabs, labels };
}

export function parseImport(text, format) {
  switch (format) {
    case "everytab-markdown": return parseEveryTabMarkdown(text);
    case "onetab": return parseOneTab(text);
    case "session-buddy": return parseSessionBuddy(text);
    case "tab-session-manager": return parseTsm(text);
    case "toby": return parseToby(text);
    case "raindrop-csv": return parseRaindropCsv(text);
    case "bookmarks-html": return parseBookmarksHtml(text);
    default: throw new Error(`Unknown import format: ${format}`);
  }
}
