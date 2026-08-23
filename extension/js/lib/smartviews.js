import { STORE_KEYS } from "./types.js";
import { listItems, upsertItem, newMeta, mutateStores } from "./store.js";
import { canonicalRef } from "./tabs.js";

const SEEDED_FLAG = "smartviewsSeeded";

/**
 * Seed built-in views exactly once. Deleting a built-in never re-seeds it
 * (the flag, not the list, gates seeding).
 */
export async function seedBuiltinViews() {
  const r = await chrome.storage.local.get(SEEDED_FLAG);
  if (r[SEEDED_FLAG]) return;
  const builtins = [
    { name: "Videos", field: "url", pattern: "youtube\\.com/watch|youtu\\.be/|vimeo\\.com/", scope: "all" },
    { name: "Docs", field: "url", pattern: "docs\\.google\\.com|notion\\.so|coda\\.io", scope: "all" },
    { name: "GitHub PRs", field: "url", pattern: "github\\.com/.+/pull/", scope: "all" }
  ];
  for (const b of builtins) {
    await upsertItem(STORE_KEYS.smartviews, { ...(await newMeta()), ...b, builtin: true });
  }
  // E2-0e: commit the seeded flag through the store lock (boot single-writer).
  await mutateStores([SEEDED_FLAG], () => ({ [SEEDED_FLAG]: true }));
}

/** @param {import("./types.js").SmartView} view @returns {RegExp|null} */
function compile(view) {
  try {
    return new RegExp(view.pattern, "i");
  } catch {
    return null;
  }
}

/** @param {string} url */
function domainOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * @param {import("./types.js").SmartView} view
 * @param {{url: string, title: string}} cand
 * @param {RegExp} re
 */
function ruleMatches(view, cand, re) {
  const value =
    view.field === "domain" ? domainOf(cand.url) : view.field === "title" ? cand.title : cand.url;
  return re.test(value ?? "");
}

/**
 * E3-5 pure matcher: apply one Smart-view rule to an already-normalized search
 * snapshot. The candidate order is the historical Smart-view precedence:
 * Open, Inbox, Archive, legacy Collections, named Sessions. Auto-snapshots are
 * intentionally absent from `saved`, matching `matchesForView`.
 * @param {import("./types.js").SmartView} view
 * @param {{open: import("./search.js").SearchResult[],
 *   saved: import("./search.js").SearchResult[]}} candidates
 * @param {("open"|"saved"|"all")} [scopeOverride]
 * @returns {import("./search.js").SearchResult[]}
 */
export function matchesForViewSnapshot(view, candidates, scopeOverride) {
  const scope = scopeOverride ?? view.scope ?? "all";
  const re = compile(view);
  if (!re) return [];
  /** @type {import("./search.js").SearchResult[]} */
  const out = [];
  const seen = new Set();
  const push = (r) => {
    if (!r.url || seen.has(r.url)) return;
    seen.add(r.url);
    out.push(r);
  };
  if (scope === "open" || scope === "all") {
    for (const r of candidates.open ?? []) if (ruleMatches(view, r, re)) push(r);
  }
  if (scope === "saved" || scope === "all") {
    for (const r of candidates.saved ?? []) if (ruleMatches(view, r, re)) push(r);
  }
  return out;
}

/**
 * Compute matches for a view.
 * "saved" = Inbox + archive + named sessions (auto-snapshots excluded — noise;
 * they stay reachable via universal search).
 * M6: scope is a DISPLAY-time choice, not a creation-time property — pass
 * `scopeOverride` ("open" | "saved" | "all") to filter; defaults to the
 * view's stored scope for back-compat.
 * @param {import("./types.js").SmartView} view
 * @param {("open"|"saved"|"all")} [scopeOverride]
 * @returns {Promise<import("./search.js").SearchResult[]>}
 */
export async function matchesForView(view, scopeOverride) {
  const scope = scopeOverride ?? view.scope ?? "all";
  if (!compile(view)) return [];
  /** @type {import("./search.js").SearchResult[]} */
  const open = [];
  /** @type {import("./search.js").SearchResult[]} */
  const saved = [];

  if (scope === "open" || scope === "all") {
    for (const t of await chrome.tabs.query({})) {
      if (t.incognito) continue; // never surface incognito tabs
      const ref = canonicalRef(t);
      if (!ref) continue;
      const cand = { url: ref.url, title: ref.title || ref.url };
      open.push({ type: "open", title: cand.title, url: ref.url, tabId: t.id, windowId: t.windowId });
    }
  }

  if (scope === "saved" || scope === "all") {
    for (const item of await listItems(STORE_KEYS.inbox)) {
      for (const t of item.tabs) {
        saved.push({ type: "inbox", title: t.title, url: t.url });
      }
    }
    for (const item of await listItems(STORE_KEYS.archive)) {
      for (const t of item.tabs) {
        saved.push({ type: "archive", title: t.title, url: t.url });
      }
    }
    // legacy: pre-M6 collections (now migrated to labeled archive items)
    for (const c of await listItems(STORE_KEYS.collections)) {
      for (const t of c.tabs) {
        saved.push({ type: "collection", title: t.title, url: t.url, sourceName: c.name });
      }
    }
    /** @type {import("./types.js").Session[]} */
    const sessions = await listItems(STORE_KEYS.sessions);
    for (const s of sessions.filter((x) => !x.auto)) {
      for (const w of s.windows) {
        for (const t of w) {
          saved.push({ type: "session", title: t.title, url: t.url, sourceName: s.name });
        }
      }
    }
  }

  return matchesForViewSnapshot(view, { open, saved }, scopeOverride);
}
