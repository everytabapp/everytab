/**
 * F13 — open-tab organization. One-shot, user-invoked tidying of live tabs;
 * never automatic reshuffling. This module owns both the DOM-free planning
 * helpers (Node-testable in isolation) and the two chrome-touching orchestrators
 * that journal ONE best-effort undo entry and perform the live moves.
 *
 * Split of responsibility:
 *   · pure planners (registrableDomain, domainKeyOf, sortOrderFor, gatherPlanFor,
 *     gatherOptionsFor) operate on plain {@link OrganizeTab} objects and know
 *     nothing about Chrome — the dashboard also calls gatherOptionsFor to fill
 *     its dropdown.
 *   · sortWindowById / gatherDomainToNewWindow read live Chrome state, plan via
 *     the pure helpers, capture pre-state, journal, then move. They run in the
 *     background service worker (mutations to live tabs are a worker-only rule,
 *     and the popup must never own a multi-step live-tab op), so the dashboard
 *     and popup both just send `sort-window` / `gather-domain` messages.
 *
 * Undo is BEST-EFFORT (drag contract, interaction-model.md [AP]): the entry
 * label says so and undo re-moves each tab to its captured pre-op position.
 */
import { organizeTabOf } from "./tabs.js";
import { recordAction } from "./journal.js";

/**
 * @typedef {Object} OrganizeTab
 * @property {number} id live Chrome tab id
 * @property {string} url canonical http(s) URL (suspended tabs resolved)
 * @property {string} title canonical title
 * @property {boolean} pinned Chrome keeps pinned tabs leftmost; sorts skip them
 * @property {number} index current position in its window
 * @property {number} [lastAccessed] Chrome recency (Recent sort)
 * @property {boolean} [active] the focused tab in its window (Recent sort ordering)
 */

/** The three sort orders offered on a window. */
export const SORT_MODES = ["domain", "title", "recent"];
/** Human labels for the sort orders (UI + journal sentence). */
export const SORT_LABELS = { domain: "Domain", title: "Title", recent: "Recent" };

/**
 * Second-level public suffixes we special-case so "bbc.co.uk" groups as
 * "bbc.co.uk", not the useless "co.uk". This is a pragmatic, documented set —
 * NOT the full Public Suffix List (ENGINEERING §2: no new dependency for a
 * one-shot tidy). An uncovered exotic suffix just groups slightly coarsely,
 * which is harmless here.
 */
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "com.br", "net.br", "org.br", "gov.br",
  "co.za", "org.za", "co.in", "net.in", "org.in", "firm.in", "gen.in",
  "com.cn", "net.cn", "org.cn", "gov.cn",
  "com.mx", "com.sg", "com.hk", "com.tr", "com.tw", "co.kr", "or.kr",
  "co.il", "com.ar", "com.co", "com.ua", "co.id"
]);

/**
 * Lowercased hostname of an HTTP(S)-style URL, trailing dot stripped, or "".
 * @param {string} url
 */
export function hostnameOf(url) {
  try {
    const u = new URL(String(url));
    // Only web pages have a registrable domain; chrome://, file://, data:, etc.
    // parse but carry no groupable host (chrome://settings → host "settings").
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/**
 * Registrable domain (≈ eTLD+1) of a hostname, using the pragmatic
 * {@link MULTI_PART_SUFFIXES} table. Leading `www.` is dropped so
 * "www.github.com" and "gist.github.com" both group under "github.com". A single
 * label ("localhost") or an IPv4 literal is returned whole; "" stays "".
 * @param {string} hostname
 * @returns {string}
 */
export function registrableDomain(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!host || !host.includes(".")) return host;             // localhost / single label
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;        // IPv4 → the whole address
  const parts = host.split(".");
  const lastTwo = parts.slice(-2).join(".");
  if (parts.length >= 3 && MULTI_PART_SUFFIXES.has(lastTwo)) return parts.slice(-3).join(".");
  return lastTwo;
}

/**
 * Registrable-domain key of a tab (empty string for chrome://, files, etc.).
 * @param {OrganizeTab} tab
 */
export function domainKeyOf(tab) {
  return registrableDomain(hostnameOf(tab?.url));
}

function titleKey(t) {
  return String(t?.title ?? "").trim().toLowerCase();
}

/** @param {"domain"|"title"|"recent"} mode → comparator over OrganizeTab pairs. */
function comparatorFor(mode) {
  if (mode === "title") {
    return (a, b) => titleKey(a).localeCompare(titleKey(b));
  }
  if (mode === "recent") {
    return (a, b) => {
      if (!!a.active !== !!b.active) return a.active ? -1 : 1; // the active tab leads
      return (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0);   // most-recent first
    };
  }
  // domain (default): registrable domain A-Z (empty domains last), subsort title A-Z.
  return (a, b) => {
    const da = domainKeyOf(a);
    const db = domainKeyOf(b);
    if (da !== db) {
      if (!da) return 1;
      if (!db) return -1;
      return da.localeCompare(db);
    }
    return titleKey(a).localeCompare(titleKey(b));
  };
}

/**
 * The desired order of a window's NON-PINNED tab ids under `mode`. Pinned tabs
 * are excluded (Chrome keeps them leftmost). Stable: ties keep the tabs' current
 * relative order. A bad mode falls back to the original non-pinned order.
 * @param {OrganizeTab[]} tabs every tab of one window (pinned included)
 * @param {"domain"|"title"|"recent"} mode
 * @returns {number[]} non-pinned tab ids in target order
 */
export function sortOrderFor(tabs, mode) {
  const list = (tabs ?? []).filter((t) => t && !t.pinned && t.id != null);
  if (!SORT_MODES.includes(mode)) return list.map((t) => t.id);
  const cmp = comparatorFor(mode);
  // Decorate with original position so the sort is stable across environments.
  return list
    .map((t, i) => ({ t, i }))
    .sort((a, b) => cmp(a.t, b.t) || a.i - b.i)
    .map((x) => x.t.id);
}

/**
 * Every tab id (across all given windows) whose registrable domain matches
 * `domain`, in window-then-index order. The first id becomes the gather window's
 * initial tab.
 * @param {string} domain a registrable domain (or anything registrableDomain-able)
 * @param {{id:number, tabs:OrganizeTab[]}[]} windows
 * @returns {number[]}
 */
export function gatherPlanFor(domain, windows) {
  const target = registrableDomain(hostnameOf(domain) || domain);
  if (!target) return [];
  const ids = [];
  for (const w of windows ?? []) {
    for (const t of w?.tabs ?? []) {
      if (t && t.id != null && domainKeyOf(t) === target) ids.push(t.id);
    }
  }
  return ids;
}

/**
 * The "Gather a domain…" dropdown options for one window: every registrable
 * domain present in THIS window, annotated with its total tab count across ALL
 * windows, most-numerous first (ties A-Z). Domains with a single tab everywhere
 * are omitted — there is nothing to gather.
 * @param {OrganizeTab[]} windowTabs this window's tabs
 * @param {{id:number, tabs:OrganizeTab[]}[]} windows all normal windows
 * @returns {{domain:string, count:number}[]}
 */
export function gatherOptionsFor(windowTabs, windows) {
  const present = new Set();
  for (const t of windowTabs ?? []) {
    const d = domainKeyOf(t);
    if (d) present.add(d);
  }
  const totals = new Map();
  for (const w of windows ?? []) {
    for (const t of w?.tabs ?? []) {
      const d = domainKeyOf(t);
      if (d) totals.set(d, (totals.get(d) ?? 0) + 1);
    }
  }
  const opts = [];
  for (const d of present) {
    const count = totals.get(d) ?? 0;
    if (count >= 2) opts.push({ domain: d, count }); // single tab everywhere = nothing to gather
  }
  opts.sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
  return opts;
}

function sameOrder(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * @typedef {Object} OrganizeResult
 * @property {boolean} ok
 * @property {string} [reason] "gone" | "noop" | "bad-mode" | "bad-domain" | "empty" | "create-failed"
 * @property {number} moved count of tabs moved
 * @property {number} [windowId] the gather window id (gather only)
 * @property {string|null} [undoId] journal id of the one best-effort undo entry
 */

/**
 * Sort one window's non-pinned tabs by `mode`. Re-reads the live window first
 * (stale guard: a closed window returns `{ok:false, reason:"gone"}`; a changed
 * tab set simply re-plans — a sort has no positional intent to go stale), skips
 * a no-op, journals one best-effort undo entry with the pre-sort positions, then
 * moves the non-pinned block. Pinned tabs stay leftmost, untouched.
 * @param {number} windowId
 * @param {"domain"|"title"|"recent"} mode
 * @returns {Promise<OrganizeResult>}
 */
export async function sortWindowById(windowId, mode) {
  if (!SORT_MODES.includes(mode)) return { ok: false, reason: "bad-mode", moved: 0 };
  let win;
  try {
    win = await chrome.windows.get(windowId, { populate: true });
  } catch {
    return { ok: false, reason: "gone", moved: 0 };
  }
  const tabs = win.tabs ?? [];
  const order = sortOrderFor(tabs.map(organizeTabOf), mode);
  const nonPinned = tabs.filter((t) => !t.pinned);
  const current = nonPinned.map((t) => t.id);
  if (order.length < 2 || sameOrder(current, order)) return { ok: true, reason: "noop", moved: 0 };

  // Best-effort undo: restore each non-pinned tab's old index. Sorted ascending
  // so replaying left-to-right reconstructs the pre-sort arrangement.
  const moves = nonPinned
    .map((t) => ({ tabId: t.id, windowId, index: t.index }))
    .sort((a, b) => a.index - b.index);
  const entry = await recordAction(
    `Sorted window by ${SORT_LABELS[mode]} (undo is best-effort)`, { moves });

  // Pinned tabs occupy the leftmost indexes; drop the whole non-pinned block in
  // sorted order right after them. A tab vanishing mid-move is a tolerated race.
  const firstNonPinnedIndex = tabs.filter((t) => t.pinned).length;
  try {
    await chrome.tabs.move(order, { index: firstNonPinnedIndex });
  } catch {
    /* a tab closed mid-sort — Chrome moved what it could; the entry still stands */
  }
  return { ok: true, moved: order.length, undoId: entry?.id ?? null };
}

/**
 * Move every tab of `domain` from all normal windows into one new window.
 * Reads live state, plans, journals one best-effort undo entry (each tab back to
 * its home window+index; the emptied gather window closes itself when its last
 * tab leaves on undo), then creates the window and moves the rest in.
 * @param {string} domain a registrable domain
 * @returns {Promise<OrganizeResult>}
 */
export async function gatherDomainToNewWindow(domain) {
  const target = registrableDomain(hostnameOf(domain) || domain);
  if (!target) return { ok: false, reason: "bad-domain", moved: 0 };
  const all = await chrome.windows.getAll({ populate: true });
  const normal = all.filter((w) => (!w.type || w.type === "normal") && !w.incognito);
  const simple = normal.map((w) => ({ id: w.id, tabs: (w.tabs ?? []).map(organizeTabOf) }));
  const tabIds = gatherPlanFor(target, simple);
  if (tabIds.length === 0) return { ok: false, reason: "empty", moved: 0 };

  const pos = new Map();
  for (const w of normal) for (const t of w.tabs ?? []) pos.set(t.id, { windowId: w.id, index: t.index });
  const moves = tabIds
    .map((id) => ({ tabId: id, ...(pos.get(id) ?? {}) }))
    .filter((m) => m.windowId !== undefined)
    .sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  const entry = await recordAction(
    `Gathered ${target} into a new window (undo is best-effort)`, { moves });

  const [first, ...rest] = tabIds;
  let newWin;
  try {
    newWin = await chrome.windows.create({ tabId: first, focused: false });
  } catch {
    return { ok: false, reason: "create-failed", moved: 0, undoId: entry?.id ?? null };
  }
  if (rest.length) {
    try {
      await chrome.tabs.move(rest, { windowId: newWin.id, index: -1 });
    } catch {
      /* best-effort: a tab vanished; the undo entry still covers every planned id */
    }
  }
  return { ok: true, moved: tabIds.length, windowId: newWin.id, undoId: entry?.id ?? null };
}
