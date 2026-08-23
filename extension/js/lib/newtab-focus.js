/**
 * N1 — decide how the one static Chrome New Tab override mounts EveryTab.
 *
 * Chrome gives the real override document to the address bar. A full navigation
 * away from that document transfers focus to page content. Therefore address-bar
 * mode mounts the selected surface in place, while EveryTab-search mode performs
 * one marked navigation before mounting the exact same surface.
 */

const MODES = new Set(["dashboard", "minimal", "blank"]);

/**
 * One Dashboard destination policy for links and browser-owned navigation.
 * Ordinary destinations name the Open route so Dashboard Search does not take
 * focus. The explicit `search` route remains the sole navigation request that
 * focuses Search.
 * @param {string} [hash]
 * @param {{getURL: (path:string) => string}} [runtime]
 */
export function dashboardHref(hash = "open", runtime = chrome.runtime) {
  const route = String(hash || "open").replace(/^#/, "");
  return `${runtime.getURL("dashboard.html")}#${route}`;
}

/**
 * @param {Partial<import("./types.js").Settings>} settings
 * @param {string} search location.search
 */
export function newTabEntryPlan(settings, search = "") {
  const mode = MODES.has(settings?.newTabMode) ? settings.newTabMode : "dashboard";
  const focus = settings?.newTabFocus === "search" ? "search" : "omnibox";
  const routedForSearch = new URLSearchParams(search).get("focus") === "search";
  const needsFocusNavigation = mode !== "blank" && focus === "search" && !routedForSearch;
  return {
    mode,
    focus,
    routedForSearch,
    needsFocusNavigation,
    stylesheet: mode === "dashboard" ? "dashboard" : "minimal",
    module: mode === "dashboard" ? "dashboard" : "newtab"
  };
}

/**
 * Decide whether a Dashboard route should own Search focus. A plain manual
 * Dashboard open keeps the established keyboard-first focus, and `#search` is
 * the explicit Search handoff. Every content deep link is an orientation
 * request: it must reveal its destination without leaving Search active above
 * it, whether the Dashboard is newly opened or already alive in another tab.
 * @param {string} hash location.hash
 */
export function dashboardSearchIntent(hash = "") {
  const raw = String(hash).replace(/^#/, "");
  const searchDeepLink = raw === "search";
  return {
    raw,
    searchDeepLink,
    autofocus: raw === "" || searchDeepLink,
    dismiss: raw !== "" && !searchDeepLink
  };
}
