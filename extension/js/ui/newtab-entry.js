/**
 * N1 — the single static New Tab host.
 *
 * Dashboard mode imports the same dashboard.js used by dashboard.html; Minimal and
 * Blank import newtab.js. No iframe and no copied behavior. Address-bar mode mounts
 * inside Chrome's override document. Search mode makes one full, marked navigation
 * first so Chrome transfers browser focus into the page.
 */
import { getSettings, readStoreMap } from "../lib/store.js";
import { STORE_KEYS } from "../lib/types.js";
import { newTabEntryPlan } from "../lib/newtab-focus.js";
import { msg } from "../lib/i18n.js";
import {
  SESSION_IDENTITY_INDEX_KEY, readSessionIdentities
} from "../lib/session-identity-index.js";

const settings = await getSettings();
const plan = newTabEntryPlan(settings, location.search);

document.documentElement.dataset.newTabHost = "true";
document.documentElement.dataset.newTabSurface = plan.mode;

if (plan.needsFocusNavigation) {
  location.replace(chrome.runtime.getURL("newtab.html") + "?focus=search");
} else {
  const minimalCss = document.getElementById("newtab-minimal-css");
  const dashboardCss = document.getElementById("newtab-dashboard-css");
  if (minimalCss) minimalCss.disabled = plan.stylesheet !== "minimal";
  if (dashboardCss) dashboardCss.disabled = plan.stylesheet !== "dashboard";
  document.title = plan.mode === "dashboard" ? msg("manifest_name") : msg("newtab_title");

  // Start singleton retirement as soon as the override entry document is
  // ready. Waiting for Dashboard data, Vault-backed surfaces, or the Minimal
  // launcher made several native New Tabs remain visible on slower profiles
  // even though the worker policy itself was correct. This claim does not
  // block first paint; the settled result is checked after the surface mounts
  // so a cold/restarting worker gets one bounded retry.
  const sendNewTabRetirementClaim = () => chrome.runtime
    .sendMessage({ type: "everytab-new-tab-mounted" })
    .catch(() => null);
  const newTabRetirementClaim = sendNewTabRetirementClaim();

  if (plan.module === "dashboard") {
    // `boot.js` started the first live query before CSS. The small Session and
    // binding maps stay behind E3-3's invalidated funnel; full Inbox/Archive
    // label enrichment is intentionally after first paint. During the dashboard
    // module's evaluation gap these listeners replace the primary promise if
    // its live/identity state changes; dashboard.js then takes over.
    let firstWindows = globalThis.__everyTabEarlyOpenWindows ?? null;
    const startOpenPrefetch = () => {
      const windows = firstWindows ??
        chrome.windows.getAll({ populate: true }).catch(() => null);
      firstWindows = null;
      const snapshot = Promise.all([
        windows,
        readSessionIdentities(),
        readStoreMap("sessionWindows")
      ]).then(([liveWindows, sessions, bindings]) => {
        if (!liveWindows) return null;
        return [
          liveWindows,
          sessions,
          bindings
        ];
      }).catch(() => null);
      globalThis.__everyTabOpenPrefetch = snapshot;
      globalThis.__everyTabWarmOpen?.(snapshot);
    };
    startOpenPrefetch();

    const earlyTabsChanged = () => startOpenPrefetch();
    const earlyStorageChanged = (changes, area) => {
      if (area === "local" &&
          [STORE_KEYS.sessions, SESSION_IDENTITY_INDEX_KEY, "sessionWindows"]
            .some((key) => key in changes)) {
        startOpenPrefetch();
      }
    };
    chrome.tabs.onCreated.addListener(earlyTabsChanged);
    chrome.tabs.onRemoved.addListener(earlyTabsChanged);
    chrome.tabs.onUpdated.addListener(earlyTabsChanged);
    chrome.tabs.onMoved.addListener(earlyTabsChanged);
    chrome.tabs.onAttached.addListener(earlyTabsChanged);
    chrome.tabs.onDetached?.addListener(earlyTabsChanged);
    chrome.windows.onFocusChanged.addListener(earlyTabsChanged);
    chrome.storage.onChanged.addListener(earlyStorageChanged);
    try {
      await import("./dashboard.js");
    } finally {
      chrome.tabs.onCreated.removeListener(earlyTabsChanged);
      chrome.tabs.onRemoved.removeListener(earlyTabsChanged);
      chrome.tabs.onUpdated.removeListener(earlyTabsChanged);
      chrome.tabs.onMoved.removeListener(earlyTabsChanged);
      chrome.tabs.onAttached.removeListener(earlyTabsChanged);
      chrome.tabs.onDetached?.removeListener(earlyTabsChanged);
      chrome.windows.onFocusChanged.removeListener(earlyTabsChanged);
      chrome.storage.onChanged.removeListener(earlyStorageChanged);
      delete globalThis.__everyTabWarmOpen;
    }
  }
  else {
    // The entry already paid for authoritative Settings to choose the surface.
    // Hand that immutable snapshot to Minimal/Blank so their first useful paint
    // does not repeat the same storage read on a mature profile.
    globalThis.__everyTabNewTabSettings = settings;
    try {
      await import("./newtab.js");
    } finally {
      delete globalThis.__everyTabNewTabSettings;
    }
  }

  // The worker may retire only older override tabs in this same window. Theme
  // rotation remains independent and earlier for synchronous first paint and
  // exactly one On-open draw.
  if (!(await newTabRetirementClaim)?.ok) {
    await sendNewTabRetirementClaim();
  }
}
