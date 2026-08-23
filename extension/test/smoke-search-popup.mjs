import {
  SEARCH_POPUP_MODE_KEY,
  SEARCH_POPUP_MODE_TTL_MS,
  RECENT_TAB_LIMIT,
  isFreshSearchPopupMode,
  armSearchPopupMode,
  consumeSearchPopupMode,
  recentOpenTabResults
} from "../js/lib/search-popup.js";

/** Keyboard Search handoff and recent-tab projection contracts. */
export async function runSmokeSearchPopup({ check, session }) {
  check(
    isFreshSearchPopupMode({ requestedAt: 10_000 }, 10_500) &&
      !isFreshSearchPopupMode({ requestedAt: 10_000 }, 10_000 + SEARCH_POPUP_MODE_TTL_MS + 1) &&
      !isFreshSearchPopupMode({ requestedAt: 10_001 }, 10_000),
    "P11-05: keyboard Search mode accepts only a fresh, non-future one-shot request"
  );
  check(
    await armSearchPopupMode(20_000) && session[SEARCH_POPUP_MODE_KEY]?.requestedAt === 20_000,
    "P11-05: the command arms Search mode without storing browsing data"
  );
  check(
    await consumeSearchPopupMode(20_100) === true && !(SEARCH_POPUP_MODE_KEY in session) &&
      await consumeSearchPopupMode(20_100) === false,
    "P11-05: popup consumption is one-shot and removes the handoff"
  );

  const suspendedUrl = "chrome-extension://test-ext-id/suspend.html?originalUrl=" +
    encodeURIComponent("https://sleep.example/read") +
    "&title=" + encodeURIComponent("Sleeping article");
  const recent = recentOpenTabResults([
    { id: 1, type: "normal", incognito: false, tabs: [
      { id: 10, windowId: 1, active: true, title: "Current", url: "https://current.example", lastAccessed: 900 },
      { id: 11, windowId: 1, pinned: true, title: "Pinned", url: "https://www.pinned.example/a", lastAccessed: 500 },
      { id: 12, windowId: 1, title: "parked", url: suspendedUrl, lastAccessed: 800 }
    ] },
    { id: 2, type: "normal", incognito: false, tabs: [
      { id: 20, windowId: 2, discarded: true, title: "Discarded", url: "https://discarded.example", lastAccessed: 700 },
      { id: 21, windowId: 2, title: "Settings", url: "chrome://settings", lastAccessed: 600 }
    ] },
    { id: 3, type: "normal", incognito: true, tabs: [
      { id: 30, windowId: 3, incognito: true, title: "Private", url: "https://private.example", lastAccessed: 1_000 }
    ] },
    { id: 4, type: "popup", incognito: false, tabs: [
      { id: 40, windowId: 4, title: "Popup", url: "https://popup.example", lastAccessed: 1_100 }
    ] }
  ], { activeTabId: 10, currentWindowId: 1 });
  check(
    RECENT_TAB_LIMIT === 6 &&
      JSON.stringify(recent.map((result) => result.tabId)) === JSON.stringify([12, 20, 21, 11]),
    "P11-05: recents are capped at six, ordered by lastAccessed, and exclude current/incognito/non-normal tabs"
  );

  const capped = recentOpenTabResults([{
    id: 9,
    type: "normal",
    incognito: false,
    tabs: Array.from({ length: 8 }, (_, index) => ({
      id: 100 + index,
      windowId: 9,
      title: `Tab ${index}`,
      url: `https://tab${index}.example`,
      lastAccessed: index
    }))
  }]);
  check(
    capped.length === 6 && capped[0]?.tabId === 107 && capped[5]?.tabId === 102,
    "P11-05: the default recent state renders exactly the six newest eligible tabs"
  );
  check(
    recent[0]?.title === "Sleeping article" && recent[0]?.url === "https://sleep.example/read" &&
      recent[0]?.sourceName === "sleep.example · This window",
    "P11-05: suspended tabs show their underlying page and current-window context"
  );
  check(
    recent[1]?.tabId === 20 && recent[3]?.tabId === 11 &&
      recent[1]?.sourceName.endsWith("Another window") &&
      recent[2]?.sourceName.startsWith("Internal page"),
    "P11-05: discarded and pinned tabs remain switchable with domain/window context"
  );
}
