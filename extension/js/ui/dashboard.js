// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { animateDisclosure } from "./disclosure-motion.js";
import { STORE_KEYS, ARCHIVE_OVERLAY_KEY } from "../lib/types.js";
import { applyDocumentLocale, applyUiLanguage, formatNumber, msg as localeMessage } from "../lib/i18n.js";
import {
  listItems, inboxItemTabCount, getSettings,
  mutateStores, patchSettings
} from "../lib/store.js";
import { restoreSessionById, getSessionBindings } from "../lib/sessions.js";
import { deleteNamedSession } from "../lib/organization.js";
import {
  collectLabels, readLabelNavigationSnapshot, archiveTabsFromItems, labelTabsFromItems,
  removeSessionLabel,
  sortLabelGroups
} from "../lib/labels.js";
import { SECTION_TO_PAGE } from "../lib/onboarding-copy.js";
import { el, coalesce, coalesceLatest, settleAnchor } from "./dom.js";
import { createDisplayTabReads } from "./display-tab-reads.js";
import { initInputModality } from "./input-modality.js";
import { icon } from "./icons.js";
import { createSearchBox } from "./searchbox.js";
import { bindSearchReveal } from "./search-reveal.js";
import { createDashboardFocusBridge } from "./dashboard-focus-bridge.js";
import { createStartupArrival } from "./startup-arrival.js";
import {
  createDataHub, dataRoute, nextDataRouteState, ownDataRender
} from "./data-hub.js";
import { buildOpenListConfig } from "./list-configs.js";
import { createOpenSurface } from "./open-surface.js";
import { reconcileOpenTabUpdate } from "./open-surface.js";
import { anchoredPanelOpenWithin, subscribeAnchoredPanelChange } from "./tablist.js";
import { createCloseDaySurface } from "./close-day-surface.js";
import { createInboxSurface } from "./inbox-surface.js";
import { createSessionsSurface } from "./sessions-surface.js";
import { createLabelsSurface } from "./labels-surface.js";
import { mark, flashNote, confirmDelete, cardLabelPanel, sessionComboboxButton, createCopyHelpers, buildSnoozePanel } from "./list-helpers.js";
import { createUndoToast, bindUndoShortcut } from "./toast.js";
import {
  createFocusStrip, getFocusGuardStatus, startFocusGuard, endFocusGuard
} from "./focus-strip.js";
import { createPageUtilities } from "./command-box.js";
import { shouldTransitionStarredRail } from "./starred-transition.js";
import { openShortcutsOverlay } from "./shortcuts.js";
import { initTooltips } from "./tooltip.js";
import {
  TAB_REFRESH_TASKS,
  dashboardTasksForStorage,
  withoutSupersededLiveTasks,
  createForegroundTrailingRefresh,
  createForegroundTaskQueue,
  createFrameRefreshScheduler,
  createInteractionRefreshGate,
} from "./refresh-scheduler.js";
import { createAutomationAwareness } from "./automation-awareness.js";
import { showLoadingFeedback } from "./loading.js";
import {
  shellAllLink, shellNavLabel, shellNavName, shellNavToggleLabel,
  shellRestoreSessionAria, shellRestoreSessionTitle, shellSectionIntro,
  shellSectionTitle, shellSidebarToggleLabel, shellStatic
} from "./shell-copy.js";
import {
  settingsFavoriteAria, settingsModeChoiceLabel, settingsOptions, settingsRowCopy,
  settingsSchemeGroupLabel, settingsStatic
} from "./settings-copy.js";
import { initTheme, SCHEME_LABELS, SCHEME_ACCENTS, SCHEME_GROUPS } from "./theme.js";
import {
  availableSchemeIds,
  CUSTOM_SCHEME_NOTICE_KEY,
  customSchemeCatalogue,
  resolveCustomSchemeMode,
  resolveSchemeSelection
} from "../lib/custom-schemes.js";
import { resolveNavMode, NAV_COMPACT_MAX, NAV_HEADER_MAX } from "../lib/nav-mode.js";
import { hasHistoryAccess, onHistoryAccessChanged } from "../lib/history-access.js";
import { createHistoryAccessDisclosure } from "./history-access.js";
import { dashboardSearchIntent } from "../lib/newtab-focus.js";
import { setGroupRestoreNotifier } from "../lib/tab-groups.js";
// E3-0: dev-only perf instrumentation — self-activates on `?perf=1` or the
// hidden settings.perfHud; every call below is a guarded no-op otherwise.
import { perfActive, pspan, pmark, pcount, precord, preport } from "../lib/perf.js";
import {
  SESSION_IDENTITY_INDEX_KEY, NAMED_SESSION_RECORDS_KEY,
  SESSION_NAVIGATION_REVISION_KEY, sessionNavigationSnapshot
} from "../lib/session-identity-index.js";
import { readSessionIdentities } from "../lib/session-identity-store.js";
import { expandStorageChanges } from "../lib/storage/constants.js";

// Install the chosen interface language before any text renders. Through the
// New Tab entry this Settings read is already cached and the language already
// installed; direct dashboard.html pays one read here and reuses it below.
await applyUiLanguage((await getSettings()).uiLanguage);
initTheme();
applyDocumentLocale();
const app = document.getElementById("app");
const startupArrival = createStartupArrival();
window.addEventListener("pagehide", () => startupArrival.destroy(), { once: true });
document.title = localeMessage("manifest_name");
const automationAwareness = createAutomationAwareness({
  openSettings: (group) => go(`settings:${group}`)
});
window.addEventListener("pagehide", () => automationAwareness.close(), { once: true });

/* ================= helpers ================= */

/** @param {string} name @param {string} content @param {string} mime */
function download(name, content, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * N15 — one-line section intros: what each section is, in the product's own
 * words. Display-only; hidden per settings.uiSectionIntros (Appearance) via a
 * body class, so toggling never re-renders anything. No em dashes (brand rule).
 */
/**
 * Section skeleton: a persistent identity line plus the rendered body.
 * Render functions write into `body` and set `h2.textContent`; neither the
 * sticky identity line nor its action lane is rebuilt with the list.
 */
function makeSec(id) {
  const h2 = el("h2", {}, shellSectionTitle(id));
  const body = el("div", { class: "sec-inner" });
  // N15 + U10: the one-line intro, with a trailing "Learn more" link when an
  // onboarding page teaches this section (opens it in help mode).
  const pageId = SECTION_TO_PAGE[id];
  const introCopy = shellSectionIntro(id);
  const intro = introCopy
    ? el("p", { class: "sec-tagline" },
        introCopy,
        pageId
          ? el("button", { class: "ob-learn", type: "button",
              onclick: async () => {
                const { openOnboardingPage } = await import("./onboarding.js");
                openOnboardingPage(pageId);
              } }, shellStatic.learnMore())
          : null)
    : null;
  const identity = el("div", { class: "section-identity" }, h2, intro);
  const actions = el("div", { class: "section-actions", "aria-label": shellStatic.sectionActions() });
  const lead = el("header", { class: "section-lead" }, identity, actions);
  const root = el("section", {}, lead,
    el("div", { class: "sec-wrap" }, el("div", { class: "sec-body" }, body)));
  root.dataset.sec = id;
  return { root, h2, body, lead, actions };
}

/** N15: reflect settings.uiSectionIntros as a body class (no re-render). */
async function applyIntroPref() {
  const s = await getSettings();
  document.body.classList.toggle("hide-taglines", s.uiSectionIntros === false);
}

/** Animated fold block (smart views, labels, per-window tab lists). */
function makeFold(open) {
  const inner = el("div");
  const wrap = el("div", { class: `fold-wrap${open ? " open" : ""}` }, el("div", {}, inner));
  inner.inert = !open;
  return { wrap, inner, isOpen: () => wrap.classList.contains("open"),
    set: (value) => animateDisclosure(wrap, () => {
      inner.inert = !value;
      wrap.classList.toggle("open", value);
    }) };
}

const msg = (m) => chrome.runtime.sendMessage(m);

// The undo/notice toast (js/ui/toast.js). Destructured into the same names so every
// showToast/showNotice/hideToast call site is unchanged; the element is appended to
// the shell below. Defined here (above its first use — copyRefs) so `showNotice` is
// available at module-eval time.
/* N42: an undo that rewrites a store fires storage.onChanged, and
 * `dashboardTasksForStorage` covers every section that reads a store. Open tabs
 * is the exception: its label chips are derived from Archive copies that match
 * a LIVE tab, and no storage key maps to a live-tab query, so undoing a label
 * left the chip on the row until the next refresh. Undo is a rare explicit
 * action, so asking Open to re-render there costs nothing and keeps the E3 task
 * graph for ordinary writes unchanged. */
const afterUndo = () => queueDashboardRefresh(["open"]);
const { element: toast, showToast, showNotice, hideToast } = createUndoToast({ afterUndo });
bindUndoShortcut(showToast, afterUndo); // Ctrl/⌘+Z → undo latest + toast
// Dashboard-only: the newest journal entry time already reflected in the toast, so
// the background-action poll doesn't re-toast an action the user just took here.
let lastToastAt = Date.now();

async function showLatestJournalToast(change) {
  const direct = (change?.newValue ?? [])[0];
  let head = direct;
  if (!head) {
    const { listActions } = await import("../lib/journal.js");
    [head] = await listActions();
  }
  if (head && !head.undone && head.at > lastToastAt) {
    lastToastAt = head.at;
    showToast(head);
  }
}

// F19 copy-as-markdown + the shared leaf helpers (mark, flashNote, confirmDelete,
// cardLabelPanel, sessionComboboxButton, selectionRefs) all live in
// js/ui/list-helpers.js. copyRefs/copySession report through this surface's
// showNotice (above). Destructured so call sites are unchanged.
const { copyRefs, copySession } = createCopyHelpers(showNotice);

/* ================= sections ================= */

const openSec = makeSec("open");
const openHeadingLabel = openSec.h2.textContent;
const openHeadingPattern = localeMessage("list_open_heading", [
  "{count}", localeMessage("unit_windows_other", ["{windows}"])
]);
const openHeadingCount = startupArrival.pendingSummary(
  openHeadingPattern.split(/\{(?:count|windows)\}/), "open-heading-count");
openSec.h2.replaceChildren(openHeadingCount);
openSec.h2.setAttribute("aria-label", openHeadingLabel);
const closeDaySec = makeSec("close-day");
openSec.actions.replaceChildren(el("button", {
  class: "mini2 section-primary-action", type: "button",
  "data-tip": shellStatic.closeDayTip(),
  onclick: () => go("close-day", { origin: "route" })
}, shellStatic.closeDay()));
const inboxSec = makeSec("inbox");
const snoozeSec = makeSec("snoozed");
const dupSec = makeSec("duplicates");
const sessionsSec = makeSec("sessions");
const snapshotsSec = makeSec("snapshots");
const labelsSec = makeSec("labels");
const archiveSec = makeSec("archive");
const dataSec = makeSec("data");
const statsSec = makeSec("stats");
const settingsSec = makeSec("settings");
const dataHub = createDataHub({
  onJump: (area) => go(`data:${area}`, { origin: "data-jump" })
});
dataSec.body.replaceChildren(dataHub.element);

/* ================= Open tabs (M6 — the current browser, first) ============ */

/** Is the Open-tabs section actually on-screen right now? */
/* ================= E3-2: a section renders when it is on screen =================
 * Every section used to build its DOM at boot and rebuild on any store change,
 * even while its page was hidden: editing the Inbox rebuilt Labels while you
 * were looking at Sessions. A hidden section now only records that it is stale,
 * and the route that reveals it renders once.
 *
 * The previous subtree is deliberately kept while a section is hidden, so
 * coming back to one never shows a blank frame. That is MH's P0 rule: no
 * perceived wait, and nothing shoves.
 */
const staleSections = new Set();
/** @type {Map<string, () => Promise<unknown>>} */
const sectionRenderers = new Map();

/** True when this is the one section selected by the current route. */
function sectionVisible(id) {
  const page = document.body.dataset.page;
  if (!(PAGES[page] ?? []).some((sec) => sec.root.dataset.sec === id)) return false;
  return true;
}
function openSectionVisible() { return sectionVisible("open"); }

/**
 * Wrap a section's renderer so it only builds while that section is visible.
 * @param {string} id the section id, matching `root.dataset.sec`
 * @param {() => Promise<unknown>} inner
 * @returns {() => Promise<unknown>}
 */
function lazySection(id, inner) {
  const run = coalesce(inner);
  const render = () => {
    if (!sectionVisible(id)) {
      staleSections.add(id);
      return Promise.resolve();
    }
    staleSections.delete(id);
    return run();
  };
  sectionRenderers.set(id, render);
  return render;
}

/** Render every section that went stale while hidden and is now visible. */
function flushStaleSections() {
  for (const id of [...staleSections]) {
    if (sectionVisible(id)) sectionRenderers.get(id)?.();
  }
}

// F18: the restore-time "Tab groups could not be recreated" notice is surfaced
// here (the background worker has no UI and leaves it unset).
setGroupRestoreNotifier(() => showNotice(localeMessage("session_tab_groups_failed")));

async function consumeCustomSchemeNotice() {
  const stored = await chrome.storage.local.get(CUSTOM_SCHEME_NOTICE_KEY);
  const notice = stored[CUSTOM_SCHEME_NOTICE_KEY];
  if (!notice?.at || typeof notice.message !== "string") return;
  showNotice(notice.message);
  await mutateStores([CUSTOM_SCHEME_NOTICE_KEY], (maps) =>
    maps[CUSTOM_SCHEME_NOTICE_KEY]?.at === notice.at
      ? { [CUSTOM_SCHEME_NOTICE_KEY]: null }
      : null);
}
void consumeCustomSchemeNotice();

// F14-2b: the Open section is built by the shared `createOpenSurface` (used by both
// the dashboard and the side panel — one behavior source). The dashboard injects its
// refresher, notice/flash sinks, and the cross-section helpers. Created lazily on
// first render so every injected dep (cardLabelPanel, renderArchive, …) is defined by
// call time; the surface owns the Open-only drag/nudge/drift state across renders.
let openSurface = null;
function getOpenSurface() {
  if (!openSurface) openSurface = createOpenSurface({
    canReconcilePlacement: () => !openRefreshGate.isHeld() && dashboardCanRefreshLiveTabs(),
    msg, rerender: () => renderOpen(),
    sectionActionHost: openSec.actions,
    shouldRenderBody: openSectionVisible,
    getFlashAnchor: () => openSec.h2,
    showNotice, flashNote, mark,
    cardLabelPanel, sessionComboboxButton, copyRefs,
    renderArchive, renderLabels, goToLabel, goToSession,
    // F23: Home's Workbench is the complete Open surface. The shared surface
    // retains its normal 50-row window cap and existing Show more control.
    rowCap: () => undefined,
    automationAwareness,
    openSettings: (group) => go(`settings:${group}`),
    takeInitialSnapshot: () => {
      const snapshot = globalThis.__everyTabOpenPrefetch ?? null;
      delete globalThis.__everyTabOpenPrefetch;
      return snapshot;
    }
  });
  return openSurface;
}
// `newtab-entry.js` owns tiny gap listeners while this module evaluates. Once
// the surface factory exists, let a gap event replace its pending snapshot too.
if (document.documentElement.dataset.newTabHost === "true") {
  globalThis.__everyTabWarmOpen = (snapshot) => getOpenSurface().warm(snapshot);
}
const openRefreshGate = createInteractionRefreshGate(coalesce(renderOpenInner), {
  isHeld: () => anchoredPanelOpenWithin(openSec.body),
  subscribe: subscribeAnchoredPanelChange
});
function renderOpen() { return openRefreshGate.request(); }
// Open gates inside its surface (it keeps the prior subtree to hold its height),
// so it is registered rather than wrapped.
sectionRenderers.set("open", renderOpen);
window.addEventListener("pagehide", () => openRefreshGate.dispose(), { once: true });

/** Start the primary Open identity snapshot without building its DOM. */
function freshOpenSnapshot() {
  return Promise.all([
    chrome.windows.getAll({ populate: true }),
    readSessionIdentities(),
    getSessionBindings()
  ]).catch(() => null);
}

/** Keep hidden Open warm so returning is a render, not a cold read. */
function warmHiddenOpen() {
  if (openSectionVisible()) return;
  getOpenSurface().warm(freshOpenSnapshot());
}

async function renderOpenInner() {
  if (!openSectionVisible()) {
    staleSections.add("open");
    return;
  }
  staleSections.delete("open");
  // The Dashboard/full new-tab cold boot is the other genuinely blank Open
  // owner. Stage Loading before the shared surface starts its saved-library
  // scan and large synchronous list build; any existing subtree stays visible.
  const loading = openSec.body.childNodes.length === 0
    ? showLoadingFeedback(openSec.body, { label: localeMessage("shell_loading_open") })
    : null;
  try {
    const { heading, node, placementUpdated = false } = await getOpenSurface().render();
    if (placementUpdated) return;
    const held = Boolean(node) && openRefreshGate.isHeld();
    // Read before connected heading writes can invalidate layout. Held/hidden
    // results keep their subtree, so they do not need a scroll snapshot.
    const y = node && !held ? window.scrollY : null;
    startupArrival.settleSummary(openHeadingCount, heading, "open-heading");
    openSec.h2.removeAttribute("aria-label");
    // node is null when the section is off-screen (openSectionVisible() === false):
    // keep the prior subtree so its height holds (no flash on return).
    if (node) {
      // A row workflow lives in a top-layer popover but remains anchored to the
      // current ledger node. Replacing that node mid-entry makes the next
      // suggestion mutation dismiss the picker. Keep this result pending and
      // reconcile once the workflow closes instead.
      if (held) {
        openRefreshGate.defer();
        return;
      }
      // Capture the current card geometry before enrichment replaces its DOM.
      // Stable window identities retain the first arrival's original deadline.
      startupArrival.revealGroups(openSec.body, "open-windows", () => {
        openSec.body.replaceChildren(node);
      });
      automationAwareness.sync();
      if (window.scrollY !== y) window.scrollTo(0, y);
    }
  } finally {
    loading?.stop();
  }
}

/* ================= Close the day ================= */

let closeDaySurface = null;
function getCloseDaySurface() {
  if (!closeDaySurface) closeDaySurface = createCloseDaySurface({
    msg,
    rerender: () => renderCloseDay(),
    showNotice,
    onNavigate: (page) => go(page, { origin: "route" }),
    onSessionOpen: goToSession,
    onLeave: () => go("open", { origin: "route" })
  });
  return closeDaySurface;
}
const renderCloseDay = lazySection("close-day", renderCloseDayInner);
async function renderCloseDayInner() {
  const loading = closeDaySec.body.childNodes.length === 0
    ? showLoadingFeedback(closeDaySec.body, { label: localeMessage("shell_loading_close_day") })
    : null;
  try {
    closeDaySec.h2.textContent = shellSectionTitle("close-day");
    const node = await getCloseDaySurface().render();
    const y = window.scrollY;
    closeDaySec.body.replaceChildren(node);
    measureSectionChrome();
    if (getCloseDaySurface().hasPlan() && window.scrollY !== y) window.scrollTo(0, y);
  } finally {
    loading?.stop();
  }
}

/* ================= Inbox — createTabList (P2e-3, ports U2) ================= */

const IN = STORE_KEYS.inbox;
/** All tab indexes of a normalized group (whole-card scope). */
const allIdx = (group) => group.refs.map((_, i) => i);

const renderInbox = lazySection("inbox", renderInboxInner);
// F14: Inbox is built by the shared createInboxSurface (used by both the dashboard
// and the side panel — one behavior source). The dashboard injects its refresher,
// notice/toast sinks, and the cross-section helpers (the shared snooze panel + the
// shared row-label panel). The surface owns the inbox drag state across renders.
let inboxSurface = null;
function getInboxSurface() {
  if (!inboxSurface) inboxSurface = createInboxSurface({
    rerender: () => renderInbox(),
    shouldRenderBody: () => true,
    sectionActionHost: inboxSec.actions,
    renderLabels, goToLabel, goToSession,
    showNotice, showToast, flashNote,
    copyRefs, sessionComboboxButton, cardLabelPanel, confirmDelete,
    buildSnoozePanel, openRowLabel, automationAwareness
  });
  return inboxSurface;
}
async function renderInboxInner() {
  const { heading, node } = await getInboxSurface().render();
  inboxSec.h2.textContent = heading;
  if (node) {
    inboxSec.body.replaceChildren(node);
    automationAwareness.sync();
  }
}

/* ==== Labels (M6 — the organizing concept; P2g-2: unified list, tab grain) ==== */

// F14: Labels is built by the shared surface in both the dashboard and side
// panel. It owns collect/sort, the filter/sort/jump index, and N29's instant
// single-card quick pass; this host injects only its route/body/sticky geometry.
let labelsSurface = null;
function getLabelsSurface() {
  if (!labelsSurface) labelsSurface = createLabelsSurface({
    getBody: () => labelsSec.body,
    setHeading: (text) => { labelsSec.h2.textContent = text; },
    shouldRenderBody: () => true,
    isActive: () => location.hash.replace(/^#/, "") === "labels",
    activate: () => go("labels", { origin: "jump" }),
    stickyOffset: () => dailyStickyOffset(),
    msg, refreshLabelViews, copyRefs, confirmDelete, cardLabelPanel, showNotice
  });
  return labelsSurface;
}
const renderLabelsLazy = lazySection("labels", () => getLabelsSurface().render());
// Kept as a hoisted function: surfaces created earlier in this module read it.
function renderLabels() { return renderLabelsLazy(); }
function goToLabel(label) { return getLabelsSurface().goToLabel(label); }
function positionLabelCard(label) { return getLabelsSurface().positionLabelCard(label); }

/** After any label mutation from the Labels section, every view that shows
 *  chips must refresh (rows/cards render label state in 4 sections). */
function refreshLabelViews() {
  queueDashboardRefresh(["labels", "inbox", "archive", "sessions"]);
}

/* ================= Archive ================= */

/** Inline "type a label then Add" panel for a single archived tab (row action). */
function openRowLabel(ctx, store, rerender) {
  ctx.panel.toggle(() => cardLabelPanel(async (labels) => {
    await labelTabsFromItems([{ item: ctx.group.data, indexes: [ctx.index] }], labels, store);
    rerender();
    renderLabels();
  }, localeMessage("list_add_labels"), ctx.panel), "label");
}

let archiveSurfacePromise = null;
function getArchiveSurface() {
  if (!archiveSurfacePromise) {
    archiveSurfacePromise = import("./archive-surface.js").then(({ createArchiveSurface }) =>
      createArchiveSurface({
        getBody: () => archiveSec.body,
        setHeading: (text) => { archiveSec.h2.textContent = text; },
        renderLabels, goToLabel, goToSession, copyRefs
      }));
  }
  return archiveSurfacePromise;
}
const renderArchive = lazySection("archive", async () => (await getArchiveSurface()).render());

async function delSession(s, rerender) {
  const result = await deleteNamedSession(s.id, s.modifiedAt);
  if (result?.ok === false) {
    showNotice(localeMessage(result.reason === "stale"
      ? "session_delete_stale"
      : "session_delete_failed"));
    return;
  }
  rerender();
}

const renderSessions = lazySection("sessions", renderSessionsInner);
let sessionsSurface = null;
function getSessionsSurface() {
  if (!sessionsSurface) sessionsSurface = createSessionsSurface({
    rerender: () => renderSessions(),
    shouldRenderBody: () => true,
    getBody: () => sessionsSec.body,
    setHeading: (text) => { sessionsSec.h2.textContent = text; },
    isActive: () => location.hash.replace(/^#/, "") === "sessions",
    activate: () => go("sessions", { origin: "jump" }),
    stickyOffset: () => dailyStickyOffset(),
    renderLabels, renderSnoozes, goToLabel, msg,
    showNotice, showToast, copyRefs,
    sessionComboboxButton, cardLabelPanel, confirmDelete, flashNote,
    sectionActionHost: sessionsSec.actions,
    buildSnoozePanel, copySession, delSession
  });
  return sessionsSurface;
}
function goToSession(id) { return getSessionsSurface().goToSession(id); }
function goToSessionGroup(id) { return getSessionsSurface().setGroupLens(id); }
function goToLabelGroup(id) { return getLabelsSurface().setGroupLens(id); }
async function renderSessionsInner() {
  await getSessionsSurface().render();
}

let snapshotsSurfacePromise = null;
function getSnapshotsSurface() {
  if (!snapshotsSurfacePromise) {
    snapshotsSurfacePromise = import("./snapshots-surface.js").then(({ createSnapshotsSurface }) =>
      createSnapshotsSurface({
        getBody: () => snapshotsSec.body,
        setHeading: (text) => { snapshotsSec.h2.textContent = text; },
        renderLabels, renderSnoozes, goToLabel, showNotice
      }));
  }
  return snapshotsSurfacePromise;
}
const renderSnapshots = lazySection("snapshots",
  async () => (await getSnapshotsSurface()).render());

/* ================= Snoozed ================= */

let snoozedSurfacePromise = null;
function getSnoozedSurface() {
  if (!snoozedSurfacePromise) {
    snoozedSurfacePromise = import("./snoozed-surface.js").then(({ createSnoozedSurface }) =>
      createSnoozedSurface({
        getBody: () => snoozeSec.body,
        setHeading: (text) => { snoozeSec.h2.textContent = text; },
        showNotice
      }));
  }
  return snoozedSurfacePromise;
}
const renderSnoozes = lazySection("snoozed",
  async () => (await getSnoozedSurface()).render());

/* ================= Duplicates ================= */

let duplicatesSurfacePromise = null;
function getDuplicatesSurface() {
  if (!duplicatesSurfacePromise) {
    duplicatesSurfacePromise = import("./duplicates-surface.js").then(({ createDuplicatesSurface }) =>
      createDuplicatesSurface({
        getBody: () => dupSec.body,
        setHeading: (text) => { dupSec.h2.textContent = text; },
        msg,
        showNotice
      }));
  }
  return duplicatesSurfacePromise;
}
const refreshDuplicates = coalesceLatest(async (reads) =>
  (await getDuplicatesSurface()).render(reads));
function renderDuplicates(reads) {
  if (!sectionVisible("duplicates")) {
    staleSections.add("duplicates");
    return Promise.resolve();
  }
  staleSections.delete("duplicates");
  return refreshDuplicates(reads);
}
sectionRenderers.set("duplicates", renderDuplicates);

/* ================= Export / Import ================= */

let dataSurfacePromise = null;
function getDataSurface() {
  if (!dataSurfacePromise) {
    dataSurfacePromise = import("./data-surface.js").then(({ createDataSurface }) =>
      createDataSurface({
        getBody: () => dataHub.coreHost,
        setHeading: (text) => { dataSec.h2.textContent = text; },
        onChanged: async ({ entry }) => {
          if (entry) showToast(entry);
          queueDashboardRefresh([
            "open", "inbox", "archive", "labels", "sessions", "snapshots",
            "snoozed", "activity", "navLibrary", "attention", "settings"
          ]);
        }
      }));
  }
  return dataSurfacePromise;
}
const renderData = lazySection("data", () => ownDataRender(
  getDataSurface().then((surface) => surface.render()), "Data"
));

/* ================= Vault sync (M5) ================= */

const reconnectBanner = el("div", { class: "banner hidden" });
let vaultSurfacePromise = null;
let vaultPrimaryReady = false;
let vaultSchedulePending = false;

function getVaultSurface() {
  if (!vaultSurfacePromise) {
    vaultSurfacePromise = import("./vault-surface.js").then(({ createVaultSurface }) =>
      createVaultSurface({
        getBody: () => dataHub.vaultBody,
        setHeading: (text) => { dataHub.vaultHeading.textContent = text; },
        getBanner: () => reconnectBanner,
        onStateChange: () => { void refreshVaultPill(); },
        showNotice,
        goToVault: async () => {
          go("vault", { origin: "route" });
          const routeGeneration = dataRouteState.generation;
          if (!await renderVault()) return;
          if (!dataAreaRouteIsCurrent("vault", routeGeneration)) return;
          settleAnchor(() => {
            if (!dataAreaRouteIsCurrent("vault", routeGeneration)) return;
            const details = document.getElementById("vault-sync-details");
            details?.scrollIntoView({ block: "center", behavior: "auto" });
            details?.focus({ preventScroll: true });
          });
        }
      }));
  }
  return vaultSurfacePromise;
}

function scheduleSync() {
  if (!vaultPrimaryReady || document.visibilityState === "hidden") {
    vaultSchedulePending = true;
    return;
  }
  void getVaultSurface().then((surface) => surface.schedule());
}

const renderVault = coalesce(async () => {
  if (currentPage !== "data") return false;
  return ownDataRender(
    getVaultSurface().then((surface) => surface.render()), "Vault"
  );
});

async function refreshVaultPill() {
  const pill = await (await getVaultSurface()).pillState();
  vaultPill.className = "vault-pill " + pill.cls;
  vaultPill.title = pill.cls === "warn" && pill.status.state === "connected"
    ? localeMessage("vault_pill_incomplete_title") : localeMessage("vault_pill_title", [pill.text]);
  vaultPill.setAttribute("aria-label", localeMessage("vault_pill_title", [pill.text]));
  vaultPill.replaceChildren(
    el("span", { class: "dot" }),
    el("span", { class: "vp-text" }, pill.text)
  );
}

/* ================= Stats page ================= */

let statsSurfacePromise = null;
function getStatsSurface() {
  if (!statsSurfacePromise) {
    statsSurfacePromise = import("./stats-surface.js").then(({ createStatsSurface }) =>
      createStatsSurface({
        getBody: () => statsSec.body,
        setHeading: (text) => { statsSec.h2.textContent = text; }
      }));
  }
  return statsSurfacePromise;
}
const renderStats = lazySection("stats", async () => (await getStatsSurface()).render());

/* ================= Activity (undo journal) ================= */

const activitySec = makeSec("activity");
let activitySurfacePromise = null;
function getActivitySurface() {
  if (!activitySurfacePromise) {
    activitySurfacePromise = import("./activity-surface.js").then(({ createActivitySurface }) =>
      createActivitySurface({
        getBody: () => activitySec.body,
        getHeading: () => activitySec.h2,
        setHeading: (text) => { activitySec.h2.textContent = text; },
        showNotice,
        queueRefresh: queueDashboardRefresh,
        download
      }));
  }
  return activitySurfacePromise;
}
const renderActivity = lazySection("activity",
  async () => (await getActivitySurface()).render());

/* ================= Settings page ================= */

// Keep the mount promise so the popup's #settings-focus deep link can wait for the
// async settings form to build before scrolling to the Focus settings group.
let settingsReady = null;
function ensureSettingsMounted() {
  if (settingsReady) return settingsReady;
  settingsSec.h2.textContent = shellSectionTitle("settings");
  const list = el("div", { class: "setlist" });
  settingsSec.body.append(list);
  settingsReady = import("./settings-form.js")
    .then(({ mountSettingsForm }) => mountSettingsForm(list, { listenStorage: false }));
  return settingsReady;
}

async function refreshMountedSettings() {
  if (!settingsReady) return;
  const controller = await settingsReady;
  await controller?.refresh();
}

/* ================= Shell: router + sidebar + hero ================= */

const ALL_SECS = [
  openSec, closeDaySec, inboxSec, snoozeSec, dupSec, sessionsSec, snapshotsSec,
  labelsSec, archiveSec, dataSec, statsSec, settingsSec,
  activitySec
];
/* F46r2: Activity joins the daily collections. It renders real cards now, so it
 * takes the same contract they do: the fluid axis that shares Search's left
 * edge, the sticky Canvas line, and the measured offsets a jump clears. */
const WORKBENCH_PAGES = ["open", "close-day", "inbox", "snoozed", "sessions", "labels", "duplicates", "activity"];
const DAILY_PAGES = new Set(WORKBENCH_PAGES);
const PAGES = {
  open: [openSec],
  "close-day": [closeDaySec],
  inbox: [inboxSec],
  snoozed: [snoozeSec],
  duplicates: [dupSec],
  sessions: [sessionsSec],
  snapshots: [snapshotsSec],
  labels: [labelsSec],
  archive: [archiveSec],
  data: [dataSec],
  stats: [statsSec],
  settings: [settingsSec],
  activity: [activitySec]
};

// F34-4/F37: Home and the Dashboard navigator are gone. Focus owns the first
// navigation slot, the left pane is the single navigation, and Open tabs is
// the landing. The side panel keeps its own switcher, which is the surviving
// instance of the navigator idea (spec §9).
const renderStarred = coalesce(() => pageUtilities.refreshStarred());

const sectionsWrap = el("div", { class: "sections" });
for (const s of ALL_SECS) sectionsWrap.append(s.root);

/* ---- sidebar ---- */
const navMain = el("nav", { class: "nav" });
const navLib = el("nav", { class: "nav" });
const navMore = el("nav", { class: "nav" });
const vaultPill = el("button", { class: "vault-pill unset", onclick: () => go("vault", { origin: "rail" }) },
  localeMessage("vault_pill_none"));

/* F44: Focus moved off the sidebar onto the top-right utility line, directly to
 * the right of Needs you, where it is present on every route and every width.
 *
 * It is deliberately NOT an edge tab like Starred. An edge tab is the
 * affordance for a surface that OPENS and takes space from the collection;
 * Focus is one action plus one jump, so it stays a plain control on the same
 * utility axis as the line it sits beside. The second part is a direct jump
 * into the Focus settings, so guarded sites and duration can be set from here
 * without hunting through Settings. While a run is active the primary takes the
 * solid accent pair and becomes the single End control — which is why the
 * status band no longer carries one of its own. */
function focusActionState(id, iconName, label, current = false) {
  return el("span", {
    class: `hero-focus-state is-${id}${current ? " is-current" : ""}`,
    "data-focus-state": id,
    "aria-hidden": String(!current)
  }, icon(iconName, 15), el("span", { class: "hero-focus-label" }, label));
}
const focusActionStates = {
  setup: focusActionState("setup", "settings", localeMessage("focus_action_setup")),
  ready: focusActionState("ready", "play", localeMessage("focus_action_ready"), true),
  active: focusActionState("active", "stop", localeMessage("focus_action_active"))
};
const focusPrimary = el("button", { class: "hero-focus-action", type: "button" },
  focusActionStates.setup, focusActionStates.ready, focusActionStates.active);
const focusSettingsButton = el("button", {
  class: "hero-focus-settings", type: "button",
  "aria-label": localeMessage("focus_settings"),
  "data-tip": localeMessage("focus_settings_tip"),
  onclick: () => go("settings-focus", { origin: "rail" })
}, icon("settings", 14));
const focusUtility = el("div", { class: "hero-focus" }, focusPrimary, focusSettingsButton);
focusUtility.classList.add("is-hydrating");
let focusNavStatus = null;
let focusNavPending = false;
let focusNavHydrated = false;
function setFocusActionPending(pending) {
  focusNavPending = pending;
  focusUtility.classList.toggle("is-pending", pending);
  focusPrimary.setAttribute("aria-busy", String(pending));
  focusPrimary.setAttribute("aria-disabled", String(pending));
}
focusPrimary.addEventListener("click", async () => {
  if (focusNavPending) return;
  if (focusNavStatus?.active) {
    setFocusActionPending(true);
    try {
      const result = await endFocusGuard();
      if (!result?.ok) showNotice(localeMessage("focus_end_failed"));
      await refreshFocusChrome();
    } finally {
      setFocusActionPending(false);
    }
    return;
  }
  const ready = Number(focusNavStatus?.duringCount) > 0;
  if (!ready) { go("settings-focus", { origin: "rail" }); return; }
  setFocusActionPending(true);
  try {
    const result = await startFocusGuard();
    if (!result?.ok) {
      showNotice(result?.reason === "no-during-rules"
        ? localeMessage("focus_start_needs_during")
        : localeMessage("focus_start_failed"));
    }
    await refreshFocusChrome();
  } finally {
    setFocusActionPending(false);
  }
});

async function refreshFocusNav() {
  focusNavStatus = await getFocusGuardStatus();
  const active = Boolean(focusNavStatus?.active);
  const duringCount = Number(focusNavStatus?.duringCount) || 0;
  const ready = duringCount > 0;
  const label = active ? localeMessage("focus_action_active")
    : ready ? localeMessage("focus_action_ready") : localeMessage("focus_action_setup");
  const actionTip = active ? localeMessage("focus_action_active_tip") : ready
    ? localeMessage("focus_action_ready_tip")
    : localeMessage("focus_action_setup_tip");
  const tip = duringCount === 1
    ? localeMessage("focus_action_summary_one", [label, formatNumber(duringCount), actionTip])
    : localeMessage("focus_action_summary_other", [label, formatNumber(duringCount), actionTip]);
  const state = active ? "active" : ready ? "ready" : "setup";
  focusUtility.dataset.focusState = state;
  focusUtility.classList.toggle("is-active", active);
  // With no guarded sites yet, "Set up Focus" IS the jump into the settings, so
  // the separate settings control would be the same action wearing the same
  // glyph twice. It returns as soon as there is something to adjust.
  focusUtility.classList.toggle("is-setup", !active && !ready);
  focusPrimary.setAttribute("aria-label", tip);
  focusPrimary.dataset.tip = tip;
  for (const [id, node] of Object.entries(focusActionStates)) {
    const current = id === state;
    node.classList.toggle("is-current", current);
    node.setAttribute("aria-hidden", String(!current));
  }
  if (!focusNavHydrated) {
    focusNavHydrated = true;
    requestAnimationFrame(() => focusUtility.classList.remove("is-hydrating"));
  }
}

/* Quick theme controls are a permanent part of the sidebar. */
const quickTheme = el("span", { class: "quick-theme" });
const themePop = el("div", {
  id: "sidebar-scheme-picker",
  class: "theme-pop hidden",
  role: "dialog",
  "aria-hidden": "true",
  "aria-label": settingsStatic.schemePickerTitle()
});
let themeTrigger = null;
let themeOpenTimer = 0;
let themeCloseTimer = 0;
let themeRestoreFocusAfterClose = false;
function finishThemePopClose() {
  if (!themePop.classList.contains("closing")) return;
  clearTimeout(themeCloseTimer);
  themeCloseTimer = 0;
  themePop.classList.remove("closing");
  themePop.classList.add("hidden");
  if (themeRestoreFocusAfterClose) {
    requestAnimationFrame(() => themeTrigger?.focus({ preventScroll: true }));
  }
  themeRestoreFocusAfterClose = false;
}
function closeThemePop({ restoreFocus = false } = {}) {
  if (themePop.classList.contains("hidden")) return;
  themeRestoreFocusAfterClose ||= restoreFocus;
  clearTimeout(themeOpenTimer);
  themeOpenTimer = 0;
  themePop.classList.remove("opening");
  themePop.classList.add("closing");
  themePop.setAttribute("aria-hidden", "true");
  themeTrigger?.setAttribute("aria-expanded", "false");
  clearTimeout(themeCloseTimer);
  themeCloseTimer = setTimeout(finishThemePopClose, 240);
}
themePop.addEventListener("animationend", (event) => {
  if (event.target !== themePop) return;
  if (themePop.classList.contains("closing")) finishThemePopClose();
  else {
    clearTimeout(themeOpenTimer);
    themeOpenTimer = 0;
    themePop.classList.remove("opening");
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !themePop.classList.contains("hidden")) {
    closeThemePop({ restoreFocus: true });
  }
});
document.addEventListener("pointerdown", (event) => {
  if (themePop.classList.contains("hidden") || themePop.classList.contains("closing")) return;
  // Quick light/dark/scheme-default previews belong to the palette workflow.
  // They update the live canvas without dismissing the catalogue beneath it.
  if (themePop.contains(event.target) || event.target.closest?.(".quick-theme")) return;
  closeThemePop();
}, true);
function renderQuickTheme(settings = {
  uiMode: document.documentElement.dataset.mode || "light",
  uiScheme: globalThis.__everyTabBootThemeSelection || "ink"
}, customRecords = []) {
  const scheme = resolveSchemeSelection(settings.uiScheme, customRecords);
  const resolved = resolveCustomSchemeMode(
    settings.uiMode, scheme, matchMedia("(prefers-color-scheme: dark)").matches
  );
  // The compact sidebar control exposes the three intentional appearance
  // choices. System remains in full Settings; while active, its currently
  // resolved light/dark appearance is shown truthfully here.
  const quickMode = settings.uiMode === "scheme" ? "scheme" : resolved;
  const modeChoices = [
    { id: "light", tip: settingsStatic.modeLightTip(), icon: "sun" },
    { id: "dark", tip: settingsStatic.modeDarkTip(), icon: "moon" },
    { id: "scheme", tip: settingsStatic.modeSchemeTip(), icon: "smartviews" }
  ];
  // Hydration updates the permanent controls in place, retaining pointer and
  // keyboard focus even when optional library data resolves later.
  if (quickTheme.children.length) {
    for (const [index, button] of [...quickTheme.querySelectorAll(".mode-choice")].entries()) {
      const choice = modeChoices[index];
      const followsSystem = settings.uiMode === "system" && choice.id === resolved;
      const title = followsSystem ? settingsStatic.followingSystem(choice.tip) : choice.tip;
      button.classList.toggle("on", quickMode === choice.id);
      button.title = title;
      button.dataset.tip = title;
      button.setAttribute("aria-label", `${settingsModeChoiceLabel(choice.id)}. ${title}`);
      button.setAttribute("aria-pressed", String(quickMode === choice.id));
    }
    return;
  }
  quickTheme.replaceChildren(
    el("span", { class: "mode-switch", role: "group", "aria-label": settingsStatic.appearanceModeAria() },
      ...modeChoices.map((choice) => {
        const followsSystem = settings.uiMode === "system" && choice.id === resolved;
        const title = followsSystem ? settingsStatic.followingSystem(choice.tip) : choice.tip;
        return el("button", {
          type: "button",
          class: `mode-choice tip${quickMode === choice.id ? " on" : ""}`,
          title,
          "aria-label": `${settingsModeChoiceLabel(choice.id)}. ${title}`,
          "aria-pressed": String(quickMode === choice.id),
          onclick: async () => { await patchSettings({ uiMode: choice.id }); }
        }, icon(choice.icon, 14));
      })),
    (() => {
      const trigger = el("button", { class: "gear", title: settingsStatic.colorSchemeTrigger(),
        "aria-label": settingsStatic.colorScheme(),
        "aria-haspopup": "dialog", "aria-controls": themePop.id,
        "aria-expanded": String(!themePop.classList.contains("hidden")), onclick: async () => {
        if (!themePop.classList.contains("hidden")) {
          closeThemePop({ restoreFocus: true });
          return;
        }
        // The button exists with the shell; fetch the current catalogue only
        // when opening it, rather than making its presence wait for the library.
        const data = await Promise.all([getSettings(), listItems(STORE_KEYS.customSchemes)])
          .catch(() => null);
        if (!data) { showNotice(localeMessage("settings_scheme_catalogue_failed")); return; }
        const [settings, customRecords] = data;
        const custom = customSchemeCatalogue(customRecords);
        const customById = new Map(custom.map((entry) => [entry.id, entry]));
        const schemeIds = availableSchemeIds(customRecords);
        const favorites = new Set(Array.isArray(settings.schemeFavorites) ? settings.schemeFavorites : []);
        let favoritesSection;
        let currentBlock;
        let catalogue;
        const optionRow = (s, list) => {
          const entry = customById.get(s);
          const label = entry?.label ?? SCHEME_LABELS[s] ?? s;
          const accent = entry?.accent ?? SCHEME_ACCENTS[s];
          const star = el("button", {
            class: `theme-star${favorites.has(s) ? " on" : ""}`,
            "data-scheme-id": s,
            type: "button",
            title: settingsFavoriteAria(favorites.has(s), label),
            "aria-label": settingsFavoriteAria(favorites.has(s), label),
            "aria-pressed": String(favorites.has(s)),
            onclick: async () => {
              const sourceWasFavorite = Boolean(star.closest(".theme-favorites"));
              if (favorites.has(s)) favorites.delete(s); else favorites.add(s);
              settings.schemeFavorites = schemeIds.filter((id) => favorites.has(id));
              renderFavorites();
              syncFavoriteButtons();
              if (sourceWasFavorite) {
                requestAnimationFrame(() => {
                  const matching = [...catalogue.querySelectorAll(".theme-star")]
                    .find((button) => button.dataset.schemeId === s);
                  matching?.focus({ preventScroll: true });
                });
              }
              await patchSettings({ schemeFavorites: settings.schemeFavorites });
            }
          }, icon("favorite", 17));
          const active = settings.uiScheme === s;
          return el("div", {
            class: `theme-opt-row${list === "favorites" ? " theme-favorite-row" : ""}`,
            "data-scheme-id": s
          },
            el("button", { class: `theme-opt${active ? " on" : ""}`,
              type: "button", "aria-pressed": String(active), title: label, onclick: async () => {
              settings.uiScheme = s;
              syncSelection();
              await patchSettings({ uiScheme: s });
            } },
            el("span", { class: "sw", style: `background:${accent}` }),
            el("span", { class: "theme-opt-label" }, label),
            ...(active
              ? [el("span", { class: "theme-current-mark" }, settingsStatic.schemePickerCurrent())]
              : [])),
            star);
        };
        const syncFavoriteButtons = () => {
          for (const button of themePop.querySelectorAll(".theme-star")) {
            const id = button.dataset.schemeId;
            const label = customById.get(id)?.label ?? SCHEME_LABELS[id] ?? id;
            const favorite = favorites.has(id);
            button.classList.toggle("on", favorite);
            button.setAttribute("aria-pressed", String(favorite));
            button.setAttribute("aria-label", settingsFavoriteAria(favorite, label));
            button.title = settingsFavoriteAria(favorite, label);
            button.replaceChildren(icon("favorite", 17));
          }
        };
        const renderFavorites = () => {
          const favoriteIds = schemeIds.filter((id) => favorites.has(id));
          favoritesSection.replaceChildren(
            el("h3", { class: "theme-section-title" }, settingsStatic.schemePickerFavorites()),
            ...(favoriteIds.length
              ? [el("div", { class: "theme-favorites-list" },
                  ...favoriteIds.map((id) => optionRow(id, "favorites")))]
              : [el("p", { class: "theme-empty-favorites" },
                  settingsStatic.schemePickerEmptyFavorites())])
          );
        };
        const currentView = () => {
          const current = resolveSchemeSelection(settings.uiScheme, customRecords);
          const currentGroup = current.kind === "custom"
            ? settingsStatic.yours()
            : (() => {
                const group = SCHEME_GROUPS.find(({ ids }) => ids.includes(current.id));
                return group
                  ? settingsSchemeGroupLabel(group.defaultMode, group.tone)
                  : settingsStatic.colorScheme();
              })();
          return { current, currentGroup };
        };
        const syncSelection = () => {
          const { current, currentGroup } = currentView();
          currentBlock.replaceChildren(
            el("span", { class: "theme-current-swatch", style: `background:${current.accent}` }),
            el("div", { class: "theme-current-copy" },
              el("strong", {}, current.label),
              el("span", {}, `${settingsStatic.schemePickerCurrent()} · ${currentGroup}`))
          );
          for (const option of themePop.querySelectorAll(".theme-opt")) {
            const active = option.closest(".theme-opt-row")?.dataset.schemeId === settings.uiScheme;
            option.classList.toggle("on", active);
            option.setAttribute("aria-pressed", String(active));
            option.querySelector(".theme-current-mark")?.remove();
            if (active) {
              option.append(el("span", { class: "theme-current-mark" },
                settingsStatic.schemePickerCurrent()));
            }
          }
        };
        const renderCatalogue = () => {
          favoritesSection = el("section", { class: "theme-section theme-favorites" });
          currentBlock = el("div", { class: "theme-current" });
          const groupColumns = SCHEME_GROUPS.map((group) => el("div", {
            class: "theme-group", role: "group",
            "aria-label": settingsSchemeGroupLabel(group.defaultMode, group.tone),
            "data-default-mode": group.defaultMode, "data-tone": group.tone
          },
          el("div", { class: "theme-group-label" },
            settingsSchemeGroupLabel(group.defaultMode, group.tone)),
          el("div", { class: "theme-group-options" },
            ...group.ids.map((id) => optionRow(id, "catalogue")))));
          catalogue = el("section", { class: "theme-section theme-catalogue" },
            el("h3", { class: "theme-section-title" }, settingsStatic.schemePickerAll()),
            el("div", { class: "theme-groups-grid" },
              ...groupColumns));
          const customSection = custom.length
            ? el("section", { class: "theme-section theme-custom-section" },
                el("h3", { class: "theme-section-title" }, settingsStatic.yours()),
                el("div", { class: "theme-group-options" },
                  ...custom.map(({ id }) => optionRow(id, "catalogue"))))
            : null;
          const sheetSetting = (rowId, key, optionKind) => {
            const copy = settingsRowCopy(rowId);
            const select = el("select", {
              class: "theme-sheet-select",
              "aria-label": copy.title,
              onchange: async (event) => {
                const value = event.currentTarget.value;
                settings[key] = value;
                await patchSettings({ [key]: value });
              }
            }, ...settingsOptions(optionKind).map(([value, label]) =>
              el("option", { value }, label)));
            select.value = settings[key];
            return el("label", { class: "theme-sheet-setting" },
              el("span", {}, copy.title), select);
          };
          themePop.replaceChildren(
            el("header", { class: "theme-sheet-head" },
              el("h2", {}, settingsStatic.schemePickerTitle()),
              currentBlock,
              el("div", { class: "theme-sheet-settings" },
                sheetSetting("interfaceStyle", "uiInterfaceStyle", "interfaceStyle"),
                sheetSetting("rotation", "schemeRotate", "rotation")),
              el("div", { class: "theme-sheet-actions" },
                el("button", { class: "theme-manage", type: "button", onclick: () => {
                  closeThemePop();
                  location.href = chrome.runtime.getURL("scheme-editor.html?return=dashboard");
                } }, settingsStatic.schemeEditorAction()),
                el("button", { class: "theme-close", type: "button",
                  "aria-label": settingsStatic.schemePickerBack(),
                  onclick: () => closeThemePop({ restoreFocus: true }) }, icon("close", 16)))),
            el("div", { class: "theme-takeover-scroll" },
              el("div", { class: "theme-first-column" },
                favoritesSection, ...(customSection ? [customSection] : [])),
              catalogue)
          );
          renderFavorites();
          syncFavoriteButtons();
          syncSelection();
        };
        renderCatalogue();
        clearTimeout(themeCloseTimer);
        themeCloseTimer = 0;
        themeRestoreFocusAfterClose = false;
        themePop.classList.remove("hidden", "closing");
        themePop.classList.add("opening");
        clearTimeout(themeOpenTimer);
        themeOpenTimer = setTimeout(() => {
          themeOpenTimer = 0;
          themePop.classList.remove("opening");
        }, 220);
        themePop.setAttribute("aria-hidden", "false");
        trigger.setAttribute("aria-expanded", "true");
      } }, icon("palette", 16));
      themeTrigger = trigger;
      return trigger;
    })()
  );
}

renderQuickTheme();

/* ---- D4-3a: one navigation model, three presentations ----
 * `settings.uiSidebarCollapsed` is the user's remembered WIDE-layout choice.
 * The viewport can force the icon rail (at or below NAV_COMPACT_MAX) or the
 * anchored header switcher (at or below NAV_HEADER_MAX) WITHOUT rewriting that
 * choice, so widening the window restores exactly what the user picked. The
 * effective presentation lives in one root attribute, `data-nav`; the remembered
 * choice stays visible separately as `data-sidebar` (also written by theme.js
 * from settings, and pre-painted by boot.js so a remembered rail never flashes
 * expanded). Every state renders the SAME nav DOM in the same order.
 */
const navCompactQuery = matchMedia(`(max-width: ${NAV_COMPACT_MAX}px)`);
const navHeaderQuery = matchMedia(`(max-width: ${NAV_HEADER_MAX}px)`);
let sidebarCollapsed = document.documentElement.dataset.sidebar === "collapsed";

// While the toggle's own write is in flight, a nav re-render triggered by some
// other event must not adopt the not-yet-written value and flicker the shell back.
let navWritePending = 0;

const navCollapse = el("button", {
  class: "nav-collapse tip",
  type: "button",
  "aria-controls": "sidenav",
  onclick: async (event) => {
    sidebarCollapsed = !sidebarCollapsed;
    applyNavMode({ animate: true });
    navWritePending += 1;
    try {
      await patchSettings({ uiSidebarCollapsed: sidebarCollapsed });
    } finally {
      navWritePending -= 1;
    }
  }
});

/** Publish the effective navigation mode + the collapse control's own state. */
let navMotion = null;

function clearNavMotion(motion = navMotion) {
  if (!motion) return;
  for (const animation of motion.animations) animation.cancel();
  motion.backdrop.remove();
  if (navMotion === motion) {
    navMotion = null;
    document.documentElement.classList.remove("nav-morphing");
  }
}

/**
 * Preserve one continuous pane edge without ever transforming the page paint.
 * The real grid publishes once at its final width. A flat material layer above
 * that complete page reveals or conceals it while the final sidebar crossfades
 * at native size. This keeps fixed gradient patches out of a transformed
 * containing block, while a second click can still reverse from the live edge.
 */
function morphNav(publish, nextMode) {
  const root = document.documentElement;
  const running = navMotion;
  const liveSidebarRect = running?.backdrop.isConnected
    ? running.backdrop.getBoundingClientRect()
    : sidebar.getBoundingClientRect();
  clearNavMotion(running);

  publish();
  const finalSidebarRect = sidebar.getBoundingClientRect();
  const startWidth = Math.max(1, liveSidebarRect.width);
  const endWidth = Math.max(1, finalSidebarRect.width);
  const backdrop = el("div", { class: "nav-resize-backdrop", "aria-hidden": "true" });
  Object.assign(backdrop.style, {
    left: `${liveSidebarRect.left}px`,
    top: `${Math.min(liveSidebarRect.top, finalSidebarRect.top)}px`,
    width: `${startWidth}px`,
    height: `${Math.max(liveSidebarRect.height, finalSidebarRect.height)}px`
  });
  sidebar.before(backdrop);
  root.classList.add("nav-morphing");

  /* Starred is the settled continuity reference. Reading the same tokens its
   * View Transition uses gives the pane-edge reveal and native-size crossfade
   * one duration, velocity, and interruption feel. */
  const motionStyle = getComputedStyle(root);
  const timing = {
    duration: parseFloat(motionStyle.getPropertyValue("--motion-continuity")) || 180,
    easing: motionStyle.getPropertyValue("--ease-out").trim() || "cubic-bezier(.2, .8, .2, 1)",
    fill: "both"
  };
  const animations = [
    backdrop.animate(
      [{ transform: "scaleX(1)" }, { transform: `scaleX(${endWidth / startWidth})` }],
      timing
    ),
    sidebar.animate([{ opacity: .16 }, { opacity: 1 }], timing)
  ];
  const motion = { animations, backdrop, targetMode: nextMode };
  navMotion = motion;
  Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
    if (navMotion === motion) clearNavMotion(motion);
  });
}

function applyNavMode({ animate = false } = {}) {
  const root = document.documentElement;
  const nextMode = resolveNavMode(
    sidebarCollapsed, navCompactQuery.matches, navHeaderQuery.matches
  );
  const publish = () => {
    root.dataset.sidebar = sidebarCollapsed ? "collapsed" : "expanded";
    root.dataset.nav = nextMode;
    const label = shellSidebarToggleLabel(sidebarCollapsed);
    navCollapse.setAttribute("aria-expanded", String(!sidebarCollapsed));
    navCollapse.setAttribute("aria-label", label);
    navCollapse.title = label;
    navCollapse.dataset.tip = label; // tooltip.js may already have adopted the title
    navCollapse.replaceChildren(icon(sidebarCollapsed ? "navexpand" : "navcollapse", 16));
    // The control offers a WIDE-layout choice. Once the viewport itself decides
    // the presentation, showing a control that changes nothing would be a lie, so
    // it leaves the layout and the tab order until the window is wide again.
    navCollapse.hidden = navCompactQuery.matches || navHeaderQuery.matches;
    measureHero();
  };

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canMorph = animate && !reduced && typeof Element.prototype.animate === "function" &&
    root.dataset.nav !== "header" && nextMode !== "header";
  if (!canMorph) {
    // The settings commit emits storage.onChanged while the manual morph is
    // still running. Its nav refresh republishes the SAME target; do not let
    // that bookkeeping event cut the user-triggered transition short.
    if (navMotion?.targetMode === nextMode) {
      publish();
      return;
    }
    clearNavMotion();
    publish();
    return;
  }

  morphNav(publish, nextMode);
}
// A width change never persists anything: it only re-resolves the presentation.
navCompactQuery.addEventListener("change", applyNavMode);
navHeaderQuery.addEventListener("change", applyNavMode);

const sidebar = el(
  "aside",
  { class: "sidebar", id: "sidenav" },
  el("div", { class: "brand" },
    el("span", { class: "mark" }, icon("mark", 20)),
    el("span", { class: "brandname" }, shellStatic.brand()),
    navCollapse),
  // The navigation scrolls on its own so the footer below can stay reachable
  // no matter how many labels, views, or sessions the library holds.
  el("div", { class: "side-scroll" },
    el("div", { class: "navlabel" }, shellStatic.now()),
    navMain,
    el("div", { class: "navlabel" }, shellStatic.saved()),
    navLib,
    el("div", { class: "navlabel" }, shellStatic.more()),
    navMore),
  el(
    "div",
    { class: "side-foot" },
    el("div", { class: "side-vault-row" }, el("div", { class: "vault-slot" }, vaultPill)),
    el("div", { class: "appearance-row" },
      quickTheme,
      el("button", { class: "gear navitem", title: shellStatic.settings(),
        "aria-label": shellStatic.settings(), "data-tip": shellStatic.settings(),
        "data-page": "settings", onclick: () => go("settings", { origin: "rail" }) },
        icon("settings", 16)))
  )
);

let libOpen = new Set(JSON.parse(localStorage.getItem("tvNavOpen") ?? '["labels"]'));
/**
 * D4-3a: every nav item carries its full name and count as an accessible name
 * plus a tooltip, so the icon rail loses only the VISIBLE text, never the
 * meaning. The visible label is contained in the accessible name in every mode.
 */
function navName(label, count) {
  return shellNavName(label, count);
}
function navBtn(iconName, label, page, count) {
  const name = navName(label, count);
  return el(
    "button",
    // `data-tip`, not `title`: the themed tooltip reads it while the rail is
    // showing, and no native tooltip repeats a label that is already visible.
    { class: `navitem${currentPage === page ? " active" : ""}`,
      "aria-label": name, "data-tip": name,
      "data-page": page,
      "aria-current": currentPage === page ? "page" : null,
      onclick: () => go(page, { origin: "rail" }) },
    icon(iconName, 16),
    el("span", { class: "navtext" }, label),
    count !== undefined ? el("span", { class: "n" }, String(count))
      : ["open", "snoozed", "duplicates", "inbox", "sessions", "labels", "archive", "snapshots"]
          .includes(page) ? startupArrival.pendingCount() : null
  );
}

function updateNavCount(container, page, count) {
  if (count === undefined) return;
  const button = container.querySelector(`.navitem[data-page="${page}"]`);
  if (!button) return;
  const label = shellNavLabel(page);
  const name = navName(label, count);
  button.setAttribute("aria-label", name);
  button.dataset.tip = name;
  let counter = button.querySelector(".n");
  if (!counter) {
    counter = startupArrival.pendingCount();
    button.append(counter);
  }
  startupArrival.settleCount(counter, count, `nav:${page}`);
}
/**
 * Nav group: the twist arrow ONLY folds/unfolds (stopPropagation); clicking
 * the label navigates. Sub-item click opens the page with only that entry
 * expanded (user feedback).
 */
function navGroup(id, iconName, label, page, count, subItems) {
  const twist = el("span", { class: "twist", role: "button", tabindex: "0",
    "aria-label": shellNavToggleLabel(label), "aria-expanded": String(libOpen.has(id)) }, "▶");
  const toggleGroup = () => {
    if (libOpen.has(id)) libOpen.delete(id);
    else libOpen.add(id);
    localStorage.setItem("tvNavOpen", JSON.stringify([...libOpen]));
    const open = libOpen.has(id);
    if (!open && subnav.contains(document.activeElement)) twist.focus({ preventScroll: true });
    animateDisclosure(subnav, () => {
      subnav.inert = !open;
      group.classList.toggle("open", open);
      twist.setAttribute("aria-expanded", String(open));
    });
  };
  twist.addEventListener("click", (e) => { e.stopPropagation(); toggleGroup(); });
  twist.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggleGroup(); }
  });
  const head = el(
    "button",
    { class: `navitem${currentPage === page ? " active" : ""}`,
      "aria-label": navName(label, count), "data-tip": navName(label, count),
      "data-page": page,
      "aria-current": currentPage === page ? "page" : null,
      onclick: () => go(page, { origin: "rail" }) },
    icon(iconName, 16),
    el("span", { class: "navtext" }, label),
    el("span", { class: "n" }, String(count)),
    twist
  );
  const subnav = el("div", { class: "subnav", id: `nav-branch-${id}` }, el("div", {}, ...subItems));
  subnav.inert = !libOpen.has(id);
  twist.setAttribute("aria-controls", subnav.id);
  const group = el(
    "div",
    { class: `navgroup${libOpen.has(id) ? " open" : ""}` }, head, subnav
  );
  return group;
}

/** Selected-route feedback is a synchronous DOM state, independent of counts. */
function syncNavSelection() {
  for (const item of sidebar.querySelectorAll(".navitem[data-page]")) {
    const active = item.dataset.page === currentPage;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
}

/** First-paint navigation needs no reads; counts and subnav fill after Open. */
function renderNavShell() {
  navMain.replaceChildren(
    navBtn("open", shellNavLabel("open"), "open"),
    navBtn("snooze", shellNavLabel("snoozed"), "snoozed"),
    navBtn("duplicates", shellNavLabel("duplicates"), "duplicates")
  );
  navLib.replaceChildren(
    navBtn("inbox", shellNavLabel("inbox"), "inbox"),
    navBtn("sessions", shellNavLabel("sessions"), "sessions"),
    navBtn("labels", shellNavLabel("labels"), "labels")
  );
  navMore.replaceChildren(
    navBtn("activity", shellNavLabel("activity"), "activity"),
    navBtn("archive", shellNavLabel("archive"), "archive"),
    navBtn("snapshots", shellNavLabel("snapshots"), "snapshots"),
    navBtn("data", shellNavLabel("data"), "data"),
    navBtn("stats", shellNavLabel("stats"), "stats")
  );
}

async function readNavLibraryData() {
  return readLabelNavigationSnapshot();
}

let navLibrarySnapshot = null;
let pendingSessionNavigation = null;

function replaceNavLibrary({ archiveCount, inboxCount = navLibrarySnapshot?.inboxCount,
  labelGroups, namedSessions, snapshotCount }) {
  navLibrarySnapshot = { archiveCount, inboxCount, labelGroups, namedSessions, snapshotCount };
  const nextSessionBranch = navGroup(
    "sessions", "sessions", shellNavLabel("sessions"), "sessions", namedSessions.length, [
      ...namedSessions.slice(0, 7).map((session) => {
        const tabCount = Number.isFinite(session.tabCount)
          ? session.tabCount
          : (session.windows ?? []).reduce((total, refs) => total + refs.length, 0);
        return el("div", { class: "subrow" },
          el("button", { class: "navitem sub", title: session.name,
            "aria-label": navName(session.name, tabCount), onclick: () => goToSession(session.id) },
            el("span", { class: "navtext" }, session.name),
            el("span", { class: "n" }, String(tabCount))),
          el("button", { class: "subact", title: shellRestoreSessionTitle(session.name),
            "aria-label": shellRestoreSessionAria(session.name),
            onclick: (event) => {
              event.stopPropagation();
              void restoreSessionById(session.id);
            } },
            icon("switch", 13)));
      }),
      namedSessions.length > 7
        ? el("button", { class: "navitem sub", onclick: () => go("sessions", { origin: "rail" }) },
            el("span", { class: "navtext" }, shellAllLink("sessions")))
        : null
    ].filter(Boolean));
  // Longer label lists remain available through the full Labels page.
  const nextLabelBranch = navGroup(
    "labels", "labels", shellNavLabel("labels"), "labels", labelGroups.length, [
      // Sidebar shows the most recently used labels first (matches the Labels
      // page's default "recent" sort) — quick access to what you just touched.
      ...sortLabelGroups(labelGroups, "recent").slice(0, 14).map((g) =>
        el("button", { class: "navitem sub", onclick: () => goToLabel(g.label) },
          el("span", { class: "navtext" }, g.label), el("span", { class: "n" }, String(g.tabs)))),
      labelGroups.length > 14
        ? el("button", { class: "navitem sub", onclick: () => go("labels", { origin: "rail" }) },
            el("span", { class: "navtext" }, shellAllLink("labels")))
        : null
    ].filter(Boolean));
  // Keep Inbox and utility buttons mounted so a background Snapshot refresh
  // can update counts without taking keyboard focus away from those routes.
  const oldSessionHead = navLib.querySelector('.navitem[data-page="sessions"]');
  const oldLabelHead = navLib.querySelector('.navitem[data-page="labels"]');
  const oldSessionBranch = oldSessionHead?.closest(".navgroup") ?? oldSessionHead;
  const oldLabelBranch = oldLabelHead?.closest(".navgroup") ?? oldLabelHead;
  oldSessionBranch?.replaceWith(nextSessionBranch);
  oldLabelBranch?.replaceWith(nextLabelBranch);
  updateNavCount(navLib, "sessions", namedSessions.length);
  updateNavCount(navLib, "labels", labelGroups.length);
  updateNavCount(navLib, "inbox", inboxCount);
  updateNavCount(navMore, "archive", archiveCount);
  updateNavCount(navMore, "snapshots", snapshotCount);
}

const renderNavLibrary = coalesce(async () => {
  replaceNavLibrary(await readNavLibraryData());
  syncNavSelection();
});

/**
 * Session writes already deliver their fresh map in storage.onChanged. Patch
 * only the Session branch + Snapshot count from that event payload, retaining
 * the existing Label/Archive navigation snapshot. This avoids a second full
 * saved-library read and its mature-profile main-thread stall.
 */
const renderNavSessions = coalesce(async () => {
  const sessionNavigation = pendingSessionNavigation;
  pendingSessionNavigation = null;
  // The ordinary post-Open navigation hydration will read the fresh state. Do
  // not start a second complete library scan if a user saves unusually early.
  if (!navLibrarySnapshot) return;
  if (!sessionNavigation) return;
  replaceNavLibrary({ ...navLibrarySnapshot, ...sessionNavigation });
  syncNavSelection();
});

const renderNav = coalesceLatest(renderNavInner);
async function renderNavInner(reads = createRefreshReads()) {
  const [settings, customRecords] = await Promise.all([
    getSettings(), listItems(STORE_KEYS.customSchemes)
  ]);
  // D4-3a: renderNav already re-runs on every settings change, so this is also
  // the live reconciliation path when another surface flips the preference.
  if (!navWritePending) sidebarCollapsed = settings.uiSidebarCollapsed === true;
  applyNavMode();
  renderQuickTheme(settings, customRecords);
  // The Inbox and Snoozed lists come from this refresh's shared saved reads, so
  // Needs you and the Label navigation snapshot reuse the same clones instead
  // of cloning each map again for a count. Inbox counts saved tabs inside
  // bundles; Snoozed keeps its record count.
  const [tabs, inboxItems, snoozes, library] =
    await Promise.all([
      reads.tabs(),
      reads.inboxItems(),
      reads.snoozeItems(),
      readLabelNavigationSnapshot(reads)
    ]);
  const inboxCount = inboxItems.reduce((total, item) => total + inboxItemTabCount(item), 0);
  const groups = await reads.groups();
  const dupCount = groups.reduce((n, g) => n + g.close.length, 0);
  updateNavCount(navMain, "open", tabs.length);
  updateNavCount(navMain, "snoozed", snoozes.length);
  updateNavCount(navMain, "duplicates", dupCount);
  replaceNavLibrary({ ...library, inboxCount });
  // A route may have changed while counts/Vault state were being read.
  syncNavSelection();

  await refreshFocusNav();

}

/**
 * Tab and window signals change only the Open and Duplicates counts here. The
 * Inbox, Snoozed, Session and Label branches depend on saved data alone and
 * keep refreshing through storage changes, so a tab burst no longer clones and
 * scans the complete saved library.
 */
const renderNavOpen = coalesceLatest(async (reads = createRefreshReads()) => {
  const [tabs, groups] = await Promise.all([reads.tabs(), reads.groups()]);
  updateNavCount(navMain, "open", tabs.length);
  updateNavCount(navMain, "duplicates", groups.reduce((n, g) => n + g.close.length, 0));
});

/* ---- hero + page utilities (F37) ----
 * Search stays one sticky row. Starred is an edge rail that yields real space
 * wherever the primary column remains useful; Needs you shares the top utility line. */
function transitionStarredRail(update) {
  const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const scrollTop = globalThis.scrollY ?? document.scrollingElement?.scrollTop ?? 0;
  if (!shouldTransitionStarredRail({
    reduced, scrollTop, hasApi: typeof document.startViewTransition === "function"
  })) {
    update();
    return;
  }
  try { document.startViewTransition(update); }
  catch { update(); }
}
const pageUtilities = createPageUtilities({
  go, showNotice, onRailTransition: transitionStarredRail
});
// Status keeps the `attention` scheduler task because its duplicate count
// follows live tabs. Starred is separate and follows only the Starred store.
const renderAttention = coalesceLatest((reads) => pageUtilities.refreshAttention(reads));
// Tab signals reuse the saved-store inputs of the last complete Needs-you
// refresh and re-read only live tabs, duplicates and Session drift.
const renderAttentionLive = coalesceLatest((reads) =>
  pageUtilities.refreshAttention(reads, { liveOnly: true }));

const historyBtn = el("button", { type: "button", class: "search-history-invite linklike" },
  localeMessage("history_access_invite"));
let historyDisclosure = null;
function dismissHistoryInvite() {
  historyDisclosure?.remove();
  historyDisclosure = null;
  historyBtn.closest(".search-footer")?.classList.remove("has-history-invite");
  historyBtn.remove();
}
historyBtn.addEventListener("click", async () => {
  if (historyDisclosure) return;
  historyBtn.hidden = true;
  historyDisclosure = createHistoryAccessDisclosure({
    purpose: localeMessage("history_access_search_purpose"),
    onGranted: dismissHistoryInvite,
    onDismiss: () => {
      historyDisclosure?.remove();
      historyDisclosure = null;
      historyBtn.hidden = false;
      historyBtn.focus();
    }
  });
  historyBtn.closest(".search-footer")?.append(historyDisclosure);
});
const searchBox = createSearchBox({
  preloadEmptySuggestions: "after-paint",
  enterFallback: true, // F2: Enter with no result → open the typed URL / web-search it
  footer: true,
  // N23: ↓ in the EMPTY box jumps straight to the first visible row
  exitToList: () => {
    const units = [...document.querySelectorAll(".sections .trow, .sections .item")]
      .filter((r) => r.offsetParent !== null);
    if (units[0]) focusRow(units[0]);
  }
});
const searchInput = searchBox.querySelector("input");
/* Search owns one fixed-height sticky field. Its result region is moved into a
 * connected absolute overlay: searchbox.js keeps the same live node reference,
 * while the overlay can grow without changing hero height or sticky offsets. */
const searchResults = searchBox.querySelector(".search-results");
const searchFooter = searchBox.querySelector(".search-footer");
searchFooter.classList.add("has-history-invite");
searchFooter.append(historyBtn);
hasHistoryAccess().then((has) => {
  if (has) dismissHistoryInvite();
});
onHistoryAccessChanged((enabled) => {
  if (enabled) dismissHistoryInvite();
  else if (!historyBtn.isConnected) {
    historyBtn.hidden = false;
    searchFooter.classList.add("has-history-invite");
    searchFooter.append(historyBtn);
  }
});
const searchOverlay = el("div", { class: "hero-search-overlay" },
  el("div", { class: "hero-search-content" }, searchResults, searchFooter));
const heroPanel = el("div", { class: "hero-panel" }, searchBox, searchOverlay);
bindSearchReveal(searchResults, searchOverlay);

/** True only when dashboard.js is mounted inside Chrome's static New Tab host. */
const isNewTabHost = () => document.documentElement.dataset.newTabHost === "true";

/* F8-R2: the global site-only Focus strip, shared via createFocusStrip (see
 * focus-strip.js). measureHero is injected because the strip changes the
 * sticky-hero height; focus returns to search when the strip is about to lose it. */
const { element: focusStrip, announcer: focusAnnouncer, refresh: refreshFocusStrip } =
  createFocusStrip({
    getSearchInput: () => searchInput,
    onMeasure: measureHero,
    getLayoutFollower: () => dailyStage,
    // F48: the guarded count jumps to the Blocked sites editor.
    openBlockedSites: () => {
      go("settings-focus", { origin: "rail" });
      void scrollToFocusSettings({ focusSites: true });
    },
    showNotice
  });

/* Starred is positioned by the hero, so neither form contributes to measured
 * sticky geometry. F38 lets the daily stage yield horizontal space on wide
 * panes while Search keeps its fixed left edge and height. */
/* F44: one utility cluster owns the top-right axis, so Needs you and Focus
 * share a single measured line instead of each positioning itself against the
 * viewport. Order is the read order MH asked for: the counts, then the action.
 * Needs you still withdraws when the line cannot hold it; Focus never does. */
const heroUtility = el("div", { class: "hero-utility" },
  pageUtilities.attention, focusUtility);
const hero = el(
  "div",
  { class: "hero" },
  el("h1", { class: "sr-only" }, shellStatic.brand()),
  el("div", { class: "hero-top" }, heroPanel),
  heroUtility,
  pageUtilities.starred,
  reconnectBanner,
  focusStrip
);
document.body.append(focusAnnouncer);

async function refreshFocusChrome() {
  await Promise.all([refreshFocusStrip(), refreshFocusNav()]);
}

/* Dynamic sticky-hero geometry: the section intros and wrapping make the old fixed
 * ~120px assumption wrong. Publish the measured hero height as `--hero-h`; every
 * dashboard scroll offset (settings/label/session jumps, keyboard row entry,
 * `#settings-focus`) reads it via scroll-margin-top or heroOffset(). */
function heroOffset() {
  return hero.getBoundingClientRect().height || 120;
}
function measureHero() {
  const h = hero.getBoundingClientRect().height;
  if (h <= 0) return;
  const focusHeight = focusStrip.getBoundingClientRect().height;
  const baseHeight = Math.max(0, h - focusHeight);
  document.documentElement.style.setProperty("--hero-base-h", `${baseHeight}px`);
  document.documentElement.style.setProperty(
    "--hero-h",
    "calc(var(--hero-base-h) + var(--focus-layout-h, 0px))"
  );
}
let sectionChromeObserver = null;
function measureSectionChrome() {
  const active = PAGES[currentPage]?.[0];
  // Preserve fractional CSS-pixel heights. `offsetHeight` rounds 73.5px to 74px,
  // which can leave a half-pixel corridor between an index and its sticky cap
  // at scaled/zoomed layouts and make the passing row shimmer through it.
  const heightOf = (node) => node?.getBoundingClientRect().height ?? 0;
  const lead = DAILY_PAGES.has(currentPage) ? heightOf(active?.lead) : 0;
  const local = DAILY_PAGES.has(currentPage)
    ? heightOf(active?.body?.querySelector(".section-local-sticky"))
    : 0;
  document.documentElement.style.setProperty("--section-lead-h", `${lead}px`);
  document.documentElement.style.setProperty("--section-local-h", `${local}px`);
}
function watchSectionChrome() {
  const active = PAGES[currentPage]?.[0];
  sectionChromeObserver?.disconnect();
  if (active?.root) sectionChromeObserver?.observe(active.root);
  measureSectionChrome();
}
// Programmatic card jumps clear the complete measured Canvas-line stack.
function dailyStickyOffset() {
  const rootStyle = getComputedStyle(document.documentElement);
  const lead = Number.parseFloat(rootStyle.getPropertyValue("--section-lead-h")) || 0;
  const local = Number.parseFloat(rootStyle.getPropertyValue("--section-local-h")) || 0;
  const breath = Number.parseFloat(rootStyle.getPropertyValue("--sp-10")) || 20;
  return heroOffset() + breath + lead + local;
}
// Hands on keyboard, straight into search — except when this dashboard IS the
// new tab and the user picked the omnibox focus model (F2): then leave focus in
// Chrome's address bar. A manual dashboard open always autofocuses.
(async () => {
  const { newTabFocus } = await getSettings();
  const initialSearchIntent = dashboardSearchIntent(location.hash);
  if (initialSearchIntent.autofocus && !(isNewTabHost() && newTabFocus === "omnibox")) {
    requestAnimationFrame(() => searchInput?.focus());
  }
})();

// "/" focuses search from anywhere — the category's most-expected keystroke,
// and the product's stated keyboard-first identity. Ignore it while typing.
function isTyping(t) {
  // N19: a focused CHECKBOX is not "typing" — after arrow-navigating rows,
  // focus sits on a row checkbox and "?"/"/" must still work.
  if (!t) return false;
  if (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return true;
  if (t.tagName !== "INPUT") return false;
  return !["checkbox", "radio", "button", "submit", "reset"].includes((t.type || "text").toLowerCase());
}
// Capture the vertical walk before row controls or inline action surfaces can
// consume the event. Search fields and popover controls return before any
// list logic, so their native arrow behavior remains untouched.
document.addEventListener("keydown", (e) => {
  if (currentPage === "open" && openSurface?.handleFilterShortcut(e)) return;
  if (currentPage === "inbox" && inboxSurface?.handleFilterShortcut(e)) return;
  if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target)) {
    e.preventDefault();
    searchInput?.focus();
    searchInput?.select();
  }
  // "?" opens the keyboard-shortcuts reference (F4). Shift is inherent to "?".
  if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target)) {
    e.preventDefault();
    openShortcutsOverlay();
  }
  // N19: Esc inside a row/card drops focus back to the page — the symmetric
  // exit of N17's "arrows enter the list". (The shortcuts overlay and the
  // comboboxes handle their own Esc with stopPropagation, so they win.)
  if (e.key === "Escape" && !isTyping(e.target) && e.target.closest?.(".trow, .item")) {
    e.preventDefault();
    e.target.blur();
  }
});

// Roving arrow-key navigation across row lists: ↑/↓ move focus between sibling
// rows/cards (and reveal their hover actions via :focus-within), so the whole
// triage surface is reachable without a mouse. Covers both `.trow` lists (Open
// tabs, Labels, Activity) and `.item` cards (Inbox, Archive, Sessions, …).
/**
 * N39: the row that is ABOUT to receive focus must be able to accept it.
 * A resting row hides its action lane with `visibility: hidden`, and a
 * visibility-hidden control is not focusable, so `target.focus()` was a silent
 * no-op and ↑/↓ from an action button appeared to do nothing. `:focus-within`
 * cannot break that circle by itself, so the destination row is marked
 * `kbd-reveal` BEFORE the focus call; `:focus-within` then holds the lane open
 * and the class is dropped as soon as focus leaves the row.
 */
let kbdRevealRow = null;
function revealRowForKeyboard(row) {
  if (kbdRevealRow && kbdRevealRow !== row) kbdRevealRow.classList.remove("kbd-reveal");
  kbdRevealRow = row?.classList ? row : null;
  kbdRevealRow?.classList.add("kbd-reveal");
}
document.addEventListener("focusout", () => {
  if (!kbdRevealRow) return;
  // activeElement is still the OLD node during focusout; settle first.
  queueMicrotask(() => {
    if (!kbdRevealRow) return;
    if (kbdRevealRow.contains(document.activeElement)) return;
    kbdRevealRow.classList.remove("kbd-reveal");
    kbdRevealRow = null;
  });
});

/**
 * The control a unit is entered on. The lane preferences are scoped to `.trow`
 * on purpose: a CARD contains its rows, so an unscoped `.row-select-slot`
 * lookup would reach past the card's own select-all checkbox and land on the
 * first tab instead (the N39 regression MH reported). A card keeps its
 * document-order first control, which is its header checkbox.
 */
function rowEntryControl(row) {
  if (row.matches?.(".trow")) {
    return row.querySelector(".row-select-slot input:not([disabled])")
      ?? row.querySelector(".row-copy a[href]")
      ?? row.querySelector("input:not([disabled]),button,a");
  }
  return row.querySelector("input:not([disabled]),button,a");
}

function focusRow(row, lane = null) {
  revealRowForKeyboard(row);
  const target = rowFocusTarget(row, lane) ?? rowEntryControl(row) ?? row;
  if (target === row) row.tabIndex = -1;
  target.focus();
  if (document.activeElement === target) return;
  // The lane target refused focus (hidden/detached). A move must never end
  // nowhere, so fall back to the row's normal entry point, then the row itself.
  const entry = rowEntryControl(row);
  if (entry && entry !== target) entry.focus();
  if (document.activeElement === entry) return;
  row.tabIndex = -1;
  row.focus();
}

/**
 * N37: preserve the user's horizontal lane while ↑/↓ moves through rows.
 * The fallback order stays deliberately conservative: a missing label/action
 * falls back to the nearest same-row control, then the row's normal checkbox
 * entry point. Cards keep their existing first-control behavior.
 */
function rowFocusDescriptor(target, row) {
  if (!target || !row?.matches?.(".trow")) return null;
  if (target.matches(".row-select-slot input")) return { kind: "select" };
  if (target.matches(".row-copy a[href]")) return { kind: "open" };
  const chips = [...row.querySelectorAll(".row-chip-slot button:not([disabled]), .row-chip-slot a[href]")]
    .filter((node) => node.offsetParent !== null);
  const chipIndex = chips.indexOf(target);
  if (chipIndex >= 0) return { kind: "chip", index: chipIndex };
  const actions = [...row.querySelectorAll(".tacts button:not([disabled])")]
    .filter((node) => node.offsetParent !== null);
  const actionIndex = actions.indexOf(target);
  if (actionIndex >= 0) return { kind: "action", index: actionIndex };
  return null;
}

function rowFocusTarget(row, lane) {
  if (!lane || !row?.matches?.(".trow")) return null;
  const first = (selector) => row.querySelector(selector);
  if (lane.kind === "select") return first(".row-select-slot input:not([disabled])");
  if (lane.kind === "open") return first(".row-copy a[href]");
  if (lane.kind === "chip") {
    const chips = [...row.querySelectorAll(".row-chip-slot button:not([disabled]), .row-chip-slot a[href]")]
      .filter((node) => node.offsetParent !== null);
    return chips[Math.min(lane.index, chips.length - 1)] ?? null;
  }
  if (lane.kind === "action") {
    const actions = [...row.querySelectorAll(".tacts button:not([disabled])")]
      .filter((node) => node.offsetParent !== null);
    return actions[Math.min(lane.index, actions.length - 1)] ?? null;
  }
  return null;
}
/* N40: surfaces that own their own arrow keys and must never be interrupted by
 * the list walk. Text fields and selects are excluded separately by tag, so
 * this covers the layered ones: the anchored action palettes, combobox and
 * label menus, and the shortcuts dialog. */
const ARROW_OWNERS = '[popover], .action-popover, .tagmenu, [role="listbox"], [role="dialog"], ' +
  '.close-day-review';

let lastListPosition = null;
document.addEventListener("focusin", (event) => {
  const unit = event.target.closest?.(".trow, .item");
  if (!unit || !unit.closest(".sections") || unit.offsetParent === null) return;
  const units = [...document.querySelectorAll(".sections .trow, .sections .item")]
    .filter((node) => node.offsetParent !== null);
  const ordinal = units.indexOf(unit);
  if (ordinal < 0) return;
  lastListPosition = {
    page: currentPage,
    ordinal,
    kind: unit.matches(".trow") ? "row" : "card",
    key: unit.dataset.tablistRow ?? unit.dataset.tablistCard ?? "",
    lane: rowFocusDescriptor(event.target, unit)
  };
}, true);

document.addEventListener("keydown", (e) => {
  const vertical = e.key === "ArrowDown" || e.key === "ArrowUp";
  if (!vertical && e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  if (e.metaKey || e.ctrlKey || e.altKey) return; // browser shortcuts keep their keys
  const t = e.target;
  if (t.tagName === "INPUT" && t.type !== "checkbox") return; // let text/date fields work
  if (t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;
  if (t.isContentEditable) return;
  if (t.closest?.(ARROW_OWNERS)) return;
  if (currentPage === "close-day" && vertical) {
    const checks = [...document.querySelectorAll(".close-day-row-select:not(:disabled)")]
      .filter((node) => node.offsetParent !== null);
    if (checks.length) {
      e.preventDefault();
      (e.key === "ArrowDown" ? checks[0] : checks[checks.length - 1])
        ?.focus({ preventScroll: true });
      return;
    }
  }
  // N17b (user feedback round 2): ONE flat walk in document order over every
  // visible card and row — a card header steps INTO its rows, the last row of
  // a card steps to the next card. (The old walk was sibling-scoped, so from
  // a card it only ever reached other cards: "window to window, not tabs".)
  const units = [...document.querySelectorAll(".sections .trow, .sections .item")]
    .filter((r) => r.offsetParent !== null);
  if (units.length === 0) return;
  const node = t.closest?.(".trow, .item");
  if (!node) {
    if (!vertical) return;
    // When an action or Escape left focus on the document body, resume from
    // the exact row/card this route last owned. Navigation controls still
    // enter at the first unit; an unrelated route never inherits an old index.
    if (t === document.body && lastListPosition?.page === currentPage) {
      const remembered = lastListPosition;
      const same = units.findIndex((unit) =>
        (remembered.kind === "row" ? unit.dataset.tablistRow : unit.dataset.tablistCard) === remembered.key &&
        Boolean(remembered.key));
      if (same === 0 && e.key === "ArrowUp") {
        e.preventDefault();
        searchInput?.focus({ preventScroll: true });
        return;
      }
      const targetIndex = same >= 0
        ? e.key === "ArrowDown" ? (same + 1) % units.length : same - 1
        : e.key === "ArrowDown"
          ? Math.min(remembered.ordinal, units.length - 1)
          : Math.max(0, Math.min(remembered.ordinal - 1, units.length - 1));
      if (targetIndex >= 0) {
        e.preventDefault();
        focusRow(units[targetIndex], remembered.lane);
        return;
      }
    }
    // An arrow from a navigation or section control starts a fresh list walk.
    // Search inputs and active palettes keep ownership of their own arrows.
    e.preventDefault();
    focusRow(units[0]);
    return;
  }
  if (!vertical) return; // ←/→ inside a unit belong to the row's own lanes
  const i = units.indexOf(node);
  if (i < 0) return;
  // N40: the walk wraps downward — ↓ past the last unit returns to the first,
  // so a long list has no dead end. ↑ from the first unit deliberately keeps
  // N24's exit to the search box instead of wrapping to the bottom.
  const next = e.key === "ArrowDown" ? (units[i + 1] ?? units[0]) : units[i - 1];
  if (!next) {
    // N24: ↑ from the FIRST row/card returns focus to the search box — the
    // symmetric close of N23's "↓ from the empty search box enters the list".
    if (e.key === "ArrowUp" && i === 0) {
      e.preventDefault();
      searchInput?.focus();
    }
    return;
  }
  e.preventDefault();
  const lane = rowFocusDescriptor(t, node);
  focusRow(next, lane);
}, true);

// P2d-3 → P2e-3: single-key triage (x select · r restore · l label · s snooze ·
// a archive · d/Delete delete, two-step) now lives inside createTabList's own
// global keyboard listener (js/ui/tablist.js), scoped to any `[data-tablist-row]`
// / `[data-tablist-card]` — so it works for every migrated section, not just the
// Inbox. The roving ↑/↓ above stays here (shared across .trow/.item lists).

/* ---- router ---- */
let currentPage = "open";
let pendingRouteOrigin = "hash";
let pendingScrollY = null;
let dataRouteState = { hash: null, generation: 0 };
function go(page, { origin = "route" } = {}) {
  pendingRouteOrigin = origin;
  // F34-4: the inline navigator is gone, so no navigation preserves a scroll
  // position any more. The field is kept so a future caller can opt in.
  pendingScrollY = null;
  location.hash = page;
  // N33: ALWAYS route synchronously (not just when the hash was unchanged).
  // Waiting for the async hashchange event let the browser paint the target
  // section once (stale content, scrolled to top) BEFORE a jump could anchor
  // its card — the visible "two motions" MH reported. route() is idempotent,
  // so the trailing hashchange re-run is a cheap no-op (renders are coalesced,
  // scrollTo(0,0) only fires on a page CHANGE).
  route();
}
function route() {
  const routeSpan = pspan("route"); // E3-0: B5 section-switch (sync work; paint follows)
  const prev = currentPage;
  const origin = pendingRouteOrigin;
  const preservedY = pendingScrollY;
  pendingRouteOrigin = "hash";
  pendingScrollY = null;
  const routeSearchIntent = dashboardSearchIntent(location.hash);
  const raw = routeSearchIntent.raw;
  // go() routes synchronously and Chrome follows with one hashchange pass. A
  // generation represents a real hash identity, not those two passes, so an
  // explicit Vault-details action survives its own trailing route while any
  // later destination still invalidates its pending anchor.
  dataRouteState = nextDataRouteState(dataRouteState, location.hash);
  const routeGeneration = dataRouteState.generation;
  // P11-05 fallback for Chromium versions without action.openPopup(): open the
  // dashboard and land directly in its existing Search field.
  const searchDeepLink = routeSearchIntent.searchDeepLink;
  // The popup's "Focus settings" deep link → the Settings page, then a scroll to
  // the Focus group below the measured hero once the async form mounts.
  const focusDeepLink = raw === "settings-focus";
  const settingsDeepLink = /^settings:(appearance|newtab|focus|autosave|suspension|protection|sessions|duplicates|privacy|intro|keyboard)$/.exec(raw);
  const deepSettingsGroup = settingsDeepLink?.[1] ?? null;
  // F16 (item): the popup's tab-label chips deep-link to a specific label card —
  // `#label:<encoded name>` → the Labels page, positioned on that card.
  const labelDeepLink = raw.startsWith("label:");
  const deepLabel = labelDeepLink ? safeDecode(raw.slice("label:".length)) : null;
  const activityDeepLink = raw.startsWith("activity:");
  const deepActivityId = activityDeepLink ? safeDecode(raw.slice("activity:".length)) : null;
  const groupDeepLink = /^(label|session)-group:(.+)$/.exec(raw);
  const deepGroupKind = groupDeepLink?.[1] ?? null;
  const deepGroupId = groupDeepLink ? safeDecode(groupDeepLink[2]) : null;
  // `#home` and `#overview` are kept as aliases so old links and pinned tabs
  // still resolve, now to the Open tabs landing.
  const requestedData = dataRoute(raw);
  const requested = searchDeepLink || raw === "overview" || raw === "home" ? "open"
    : requestedData?.page ?? (raw || "open");
  const want = focusDeepLink || deepSettingsGroup ? "settings"
    : labelDeepLink ? "labels"
      : activityDeepLink ? "activity"
      : deepGroupKind === "label" ? "labels"
        : deepGroupKind === "session" ? "sessions" : requested;
  if (routeSearchIntent.dismiss) searchBox.dismissSearch({ blur: true });
  currentPage = PAGES[want] ? want : "open";
  document.body.dataset.page = currentPage;
  refreshFocusChrome();
  const daily = DAILY_PAGES.has(currentPage);
  document.body.dataset.workbench = String(daily);
  if (currentPage === "settings") void ensureSettingsMounted();
  syncNavSelection();
  const visible = new Set(PAGES[currentPage]);
  for (const s of ALL_SECS) s.root.style.display = visible.has(s) ? "" : "none";
  automationAwareness.sync();
  watchSectionChrome();
  renderStats();
  renderOpen(); // self-gates: builds only if the open section is now on-screen
  if (currentPage === "close-day") renderCloseDay();
  // E3-2: whatever changed while it was hidden catches up now, once.
  flushStaleSections();
  // Data is one retained continuous workspace. Vault renders independently of
  // a jump target, while an explicit area route anchors only after its target
  // exists. Background Vault refreshes never enter this scrolling path.
  if (currentPage === "data") {
    void renderDataArea(requestedData?.area ?? null, routeGeneration);
  }
  // F27: rail/default routes are orientation actions; they always reset to a
  // clear entrance. The inline collection tabs are content swaps, so they keep
  // the viewport pinned while only the mounted collection below changes.
  // F34-4: with no inline navigator every route is orienting, so a real route
  // change starts at the top and an inert hash replay scrolls nothing.
  const orienting = prev !== currentPage || origin === "rail" || origin === "route";
  if (orienting) window.scrollTo(0, Number.isFinite(preservedY) ? Math.max(0, preservedY) : 0);
  if (focusDeepLink) scrollToFocusSettings();
  if (deepSettingsGroup) scrollToSettingsGroup(deepSettingsGroup);
  if (labelDeepLink && deepLabel) openLabelDeepLink(deepLabel);
  if (activityDeepLink && deepActivityId) openActivityDeepLink(deepActivityId);
  if (deepGroupKind && deepGroupId) openOrganizationGroupDeepLink(deepGroupKind, deepGroupId);
  if (searchDeepLink) requestAnimationFrame(() => searchInput.focus({ preventScroll: true }));
  routeSpan(`${prev} → ${currentPage}`);
}

/** decodeURIComponent that never throws (malformed hash → the raw string). */
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** F16 (item): land on one label's card from the popup deep link. Settle the
 *  hash to plain #labels (no re-trigger, no hashchange), refresh the list so the
 *  card exists, then anchor it instantly (no travel — same rule as goToLabel). */
async function openLabelDeepLink(label) {
  history.replaceState(null, "", "#labels");
  await renderLabels();
  positionLabelCard(label);
  settleAnchor(() => positionLabelCard(label));
}

/** Needs you opens the exact durable Activity record, then settles its route. */
async function openActivityDeepLink(entryId) {
  history.replaceState(null, "", "#activity");
  const surface = await getActivitySurface();
  await surface.goToEntry(entryId);
}

/** P11-14: Search navigates to one Label/Session group lens; it never opens
 * the group's members. Settle the transient hash before the shared surface
 * resolves the live id, so a missing/deleted group safely falls back to All. */
async function openOrganizationGroupDeepLink(kind, groupId) {
  history.replaceState(null, "", kind === "label" ? "#labels" : "#sessions");
  if (kind === "label") await goToLabelGroup(groupId);
  else await goToSessionGroup(groupId);
}
window.addEventListener("hashchange", route);

/** Open one exact Settings group after the async form has mounted. The
 * transient deep link settles to plain #settings so later refreshes do not
 * keep pulling the viewport back to the same row. */
async function scrollToSettingsGroup(groupId, { focusSelector = null } = {}) {
  history.replaceState(null, "", "#settings");
  await ensureSettingsMounted();
  requestAnimationFrame(() => {
    const g = document.getElementById(`setg-${groupId}`);
    if (!g) return;
    // N32: programmatic jumps land instantly everywhere (no travel), same rule
    // as label/session cards.
    g.scrollIntoView({ block: "start", behavior: "auto" });
    if (focusSelector) g.querySelector(focusSelector)?.focus({ preventScroll: true });
  });
}

/** Open one Data destination after its retained core and, for Vault, its async
 * surface have mounted. Plain #data deliberately stays at the page entrance. */
async function renderDataArea(area, routeGeneration) {
  const coreReady = renderData();
  const vaultReady = renderVault();
  if (!area) {
    await coreReady;
    return;
  }
  const ready = area === "vault"
    ? (await Promise.all([coreReady, vaultReady])).every(Boolean)
    : await coreReady;
  if (!ready) return;
  if (!dataAreaRouteIsCurrent(area, routeGeneration)) return;
  settleAnchor(() => {
    if (!dataAreaRouteIsCurrent(area, routeGeneration)) return;
    document.getElementById(`data-area-${area}`)
      ?.scrollIntoView({ block: "start", behavior: "auto" });
  });
}

function dataAreaRouteIsCurrent(area, routeGeneration) {
  return currentPage === "data" && routeGeneration === dataRouteState.generation &&
    dataRoute(dashboardSearchIntent(location.hash).raw)?.area === area;
}

/** Legacy Focus-only route used by popup and Focus surfaces. */
async function scrollToFocusSettings({ focusSites = false } = {}) {
  return scrollToSettingsGroup("focus", {
    focusSelector: focusSites ? ".focus-site-input" : null
  });
}

const dailyStage = el("div", { class: "daily-stage" }, sectionsWrap);
const main = el("main", { class: "content", id: "main", tabindex: "-1" },
  hero, dailyStage);
/* D4-3a: a keyboard user meets fifteen-plus navigation items before the first
 * row, so the shell offers the standard skip. It is a button rather than an
 * `href="#main"` link on purpose: this page's router owns `location.hash`, and
 * a fragment link would route the user instead of moving focus.
 * N40: it now skips to SEARCH rather than to the inert `main` container, and it
 * forwards automatically when focus arrives from outside the document
 * (`relatedTarget === null`, i.e. Tab out of the address bar). The sidebar
 * precedes the content column in the DOM, so without this the first tab stop
 * could never be the command box. Landing on search already bypasses the
 * navigation, which is the only job the skip control ever had. Focus arriving
 * from INSIDE the page (a real Shift+Tab) still gets the visible control. */
const skipLink = el("button", { class: "skip-link", type: "button",
  onclick: () => searchInput.focus() }, localeMessage("shell_skip_to_search"));
skipLink.addEventListener("focus", (e) => {
  // `relatedTarget` is the element that LOST focus. A real in-page Shift+Tab
  // names one, so the visible control stays. Arriving from browser chrome or
  // from a bare `body` names nothing useful, and that is focus on its way into
  // the page: hand it to the command box.
  if (e.relatedTarget && e.relatedTarget !== document.body) return;
  searchInput.focus();
});
// The catalogue belongs to the shell so it inherits the resolved navigation
// width, but it overlays only the Dashboard content column. The sidebar and its
// original trigger stay visible and stationary while the sheet is open.
app.append(el("div", { class: "app" }, skipLink, sidebar, main, themePop), toast);

function focusFirstCurrentSectionPosition() {
  const focusFirst = () => {
    const unit = [...sectionsWrap.querySelectorAll(".trow, .item")]
      .find((node) => node.offsetParent !== null);
    if (unit) {
      focusRow(unit);
      return true;
    }
    const section = PAGES[currentPage]?.find((candidate) => candidate.root.style.display !== "none");
    const control = section?.root.querySelector("button:not([disabled]), input:not([disabled]), a[href]");
    if (!control || control.offsetParent === null) return false;
    control.focus({ preventScroll: true });
    return true;
  };
  if (focusFirst()) return;
  const observer = new MutationObserver(() => {
    if (!focusFirst()) return;
    observer.disconnect();
    clearTimeout(expiry);
  });
  observer.observe(sectionsWrap, { childList: true, subtree: true });
  const expiry = setTimeout(() => observer.disconnect(), 1500);
}

const dashboardFocusBridge = createDashboardFocusBridge({
  sidebar,
  content: main,
  getCurrentPage: () => currentPage,
  activatePage: (page) => go(page, { origin: "rail" }),
  enterContent: focusFirstCurrentSectionPosition,
  isContentLeftEdge: (target) => {
    const row = target.closest?.(".trow, .item");
    return !row || target === row || target === rowEntryControl(row);
  }
});
window.addEventListener("pagehide", () => dashboardFocusBridge.destroy(), { once: true });

// Publish the real hero height as `--hero-h` and keep it current as the section
// intros / wrapping change it. One observer, no polling.
measureHero();
new ResizeObserver(() => measureHero()).observe(hero);
sectionChromeObserver = new ResizeObserver(() => measureSectionChrome());
watchSectionChrome();
// D4-3a: paint the collapse control's glyph, label, and state in the first frame,
// from the pre-painted attribute, rather than waiting for the first nav render.
applyNavMode();
// F8-R2: paint the site-guard strip if a run is already active on load.
refreshFocusChrome();

/* ---- boot ---- */
initInputModality(); // N42: pointer vs keyboard, the arrival-cue gate
initTooltips(); // themed tooltips for row actions + nav glyphs (B5)
// N12: the boot renders land asynchronously in arbitrary order, and .sec-wrap's
// grid transition animates every height change — so cards visibly travelled while
// sections filled. Suppress layout animation until the initial pass has painted.
document.body.classList.add("booting");
applyIntroPref(); // N15: hide section intros if the user turned them off
// E3-0: boot-phase spans (B3 = renderOpen painted, B4 = booting class removed).
// `bootTimed` is a pure timing wrapper — the render promises and their order
// are byte-identical to before; everything is a no-op unless perf is active.
const bootSpan = pspan("boot:total(B4)");
const bootTimed = (name, p) => {
  const end = pspan(`boot:${name}`);
  return Promise.resolve(p).finally(() => end());
};
renderNavShell(); // synchronous route targets; no storage/tab reads
route(); // kicks off renderOpen() (coalesced with the call below)
const primaryStarredReady = bootTimed("starred", renderStarred().catch(() => {}));
// Paint the primary Open-tabs section FIRST, then fill the rest below it. Open
// tabs is the slowest render (windows.getAll populate), so it used to lose the
// race to the Inbox and then shove it down when it landed above. Rendering it
// first keeps the default Workbench ready before secondary sections.
const primaryOpenReady = bootTimed("renderOpen(B3)", renderOpen().catch(() => {}));
// Resolving renderOpen means the ledger DOM exists, not that Chrome has painted
// it. Dynamic imports and Vault filesystem work queued in the same microtask can
// still hold that first useful frame hostage. Give the compositor one complete
// frame and a short task boundary; background tabs retain a bounded fallback.
const primaryPaintReady = primaryOpenReady.then(() => new Promise((resolve) => {
  let settled = false;
  const afterFrame = () => {
    if (settled) return;
    settled = true;
    setTimeout(resolve, 24);
  };
  requestAnimationFrame(afterFrame);
  setTimeout(afterFrame, 250);
}));
primaryPaintReady.then(() => {
  const bootRenders = [
    // E3-4: counts/subnav/Vault state are secondary to the first Open paint.
    // Route selection already updated synchronously against the existing DOM.
    bootTimed("nav", renderNav()),
    bootTimed("inbox", renderInbox()),
    bootTimed("labels", renderLabels()),
    bootTimed("sessions", renderSessions()),
    bootTimed("snapshots", renderSnapshots()),
    bootTimed("archive", renderArchive()),
    bootTimed("snoozes", renderSnoozes()),
    bootTimed("duplicates", renderDuplicates()),
    bootTimed("data", renderData()),
    bootTimed("vault", renderVault()),
    bootTimed("activity", renderActivity()),
    bootTimed("attention", renderAttention())
  ];
  Promise.allSettled([...bootRenders, primaryStarredReady]).then(() => {
    // double rAF: the last fill must PAINT un-animated before transitions return
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        document.body.classList.remove("booting");
        bootSpan("booting class removed");
        if (perfActive()) preport();
      }));
  });
});
setInterval(() => dashboardStorageRefresh.request(["attention"]), 30_000);
// A connected Vault can spend meaningful time reading its folder and merging a
// mature library. It is important, but it is not part of the Open-tabs answer.
// Give the primary ledger a real paint before starting file and storage work so
// Vault-connected profiles retain the same first-useful-paint path as local-only
// profiles.
primaryPaintReady.then(() => {
  // A burst of New Tabs should not make each finished page parse the Vault
  // filesystem stack while the next page is mounting Open. The normal Vault
  // debounce is already three seconds, so use the same quiet period here.
  setTimeout(() => {
    vaultPrimaryReady = true;
    if (document.visibilityState === "hidden") {
      vaultSchedulePending = true;
      return;
    }
    void getVaultSurface().then((surface) => {
      surface.start();
      if (vaultSchedulePending) {
        vaultSchedulePending = false;
        surface.schedule();
      }
    });
  }, 3000);
});
// Onboarding is secondary to the primary Open paint. Its module and copy no
// longer sit in every cold Dashboard's static dependency graph.
primaryPaintReady.then(() =>
  import("./onboarding.js").then(({ maybeShowOnboarding }) => maybeShowOnboarding())
); // first run only; Settings opens an explicit replay in place

// M6: one-time notice when the dashboard appears as the new-tab page.
(async () => {
  if (!isNewTabHost()) return;
  const { newTabNoticeDismissed } = await chrome.storage.local.get("newTabNoticeDismissed");
  if (newTabNoticeDismissed) return;
  const dismiss = () => {
    chrome.storage.local.set({ newTabNoticeDismissed: true });
    notice.remove();
  };
  const notice = el(
    "div",
    { class: "banner" },
    el("span", {}, localeMessage("new_tab_notice_text")),
    el("button", { onclick: dismiss }, localeMessage("new_tab_notice_keep")),
    el("button", { onclick: async () => {
      await patchSettings({ newTabMode: "minimal" });
      dismiss();
    } }, localeMessage("new_tab_notice_minimal"))
  );
  hero.after(notice);
})();

/* ---- live refresh ---- */

/**
 * E3-4: execute dirty work in priority bands. The current section (Open first
 * on Home) settles before other visible sections, global counts, and the
 * lazy hidden-section gates. Existing renderers/coalesce remain the seam.
 */
const DASHBOARD_REFRESH_RUNNERS = {
  starred: renderStarred,
  open: renderOpen,
  closeDay: renderCloseDay,
  inbox: renderInbox,
  labels: renderLabels,
  archive: renderArchive,
  sessions: renderSessions,
  snapshots: renderSnapshots,
  snoozes: renderSnoozes,
  duplicates: renderDuplicates,
  vault: renderVault,
  vaultPill: refreshVaultPill,
  activity: renderActivity,
  stats: renderStats,
  nav: renderNav,
  navOpen: renderNavOpen,
  navLibrary: renderNavLibrary,
  navSessions: renderNavSessions,
  attention: renderAttention,
  attentionLive: renderAttentionLive,
  openWarm: warmHiddenOpen,
  focus: refreshFocusChrome,
  settings: refreshMountedSettings
};
const REFRESH_SECTION = {
  open: "open", closeDay: "close-day", inbox: "inbox", labels: "labels", archive: "archive",
  sessions: "sessions", snapshots: "snapshots",
  snoozes: "snoozed", duplicates: "duplicates", vault: "data",
  activity: "activity", stats: "stats", settings: "settings"
};
/** Tasks that read this refresh's shared live-tab and saved-store snapshot. */
const SHARED_READ_TASKS = new Set(["nav", "navOpen", "attention", "attentionLive", "duplicates"]);
function refreshPriority(task) {
  const section = REFRESH_SECTION[task];
  if (!section) return 2; // global counts/status, after visible content
  if (section === currentPage) return 0;
  return sectionVisible(section) ? 1 : 3;
}
/**
 * One refresh's lazy reads. Live tabs, duplicate rules and groups come from the
 * display snapshot; the Inbox and Snoozed lists are read at most once so the
 * navigation counts, Label navigation and Needs you share one clone each.
 */
function createRefreshReads() {
  const reads = createDisplayTabReads();
  let inboxRead;
  let snoozeRead;
  return {
    ...reads,
    inboxItems: () => inboxRead ??= listItems(STORE_KEYS.inbox),
    snoozeItems: () => snoozeRead ??= listItems(STORE_KEYS.snoozes)
  };
}
async function runDashboardRefresh(requested) {
  // Scheme rotation and other early events can fire while cold Open is still
  // reading. They must not sneak global counts back onto the B3 critical path.
  await primaryOpenReady.catch(() => {});
  const tasks = withoutSupersededLiveTasks(requested);
  const started = perfActive() ? performance.now() : 0;
  const reads = createRefreshReads();
  for (let priority = 0; priority <= 3; priority++) {
    // A focus/visibility change during startup or a preceding render must not
    // start another band of reads. Running work may finish; untouched tasks wait.
    if (!dashboardCanRefreshLiveTabs()) {
      dashboardStorageRefresh.request(tasks.filter((task) => refreshPriority(task) >= priority));
      return;
    }
    const band = tasks.filter((task) => refreshPriority(task) === priority);
    if (!band.length) continue;
    await Promise.allSettled(band.map((task) =>
      SHARED_READ_TASKS.has(task)
        ? DASHBOARD_REFRESH_RUNNERS[task]?.(reads)
        : DASHBOARD_REFRESH_RUNNERS[task]?.()));
  }
  if (perfActive()) {
    const ms = performance.now() - started;
    precord("refresh:flush", ms, `${tasks.join(",")} → ${tasks.length} unique tasks`);
    pcount("refresh tasks (total)", tasks.length, ms);
  }
}
const dashboardRefreshScheduler = createFrameRefreshScheduler(runDashboardRefresh, {
  canRun: () => dashboardCanRefreshLiveTabs()
});
// Placement feedback must not queue behind an earlier saved-library/count read.
// All Open requests share this lane so foreground replay rebuilds only once.
const dashboardOpenRefresh = createFrameRefreshScheduler(runDashboardRefresh, {
  canRun: () => dashboardCanRefreshLiveTabs()
});
function queueDashboardRefresh(tasks) {
  if (tasks.includes("open")) dashboardOpenRefresh.request(["open"]);
  dashboardRefreshScheduler.request(tasks.filter((task) => task !== "open"));
}

let dashboardWindowId = null;
let dashboardWindowFocused = false;
const dashboardCanRefreshLiveTabs = () =>
  dashboardWindowFocused && document.visibilityState !== "hidden";
const dashboardStorageRefresh = createForegroundTaskQueue(
  queueDashboardRefresh,
  { isForeground: dashboardCanRefreshLiveTabs }
);

// A newly opening Dashboard must not compete with every older EveryTab page.
// Inactive documents retain one dirty bit; the focused document reconciles the
// complete Chrome event burst once, after the new surface has had its first
// useful paint.
const tabRefreshBurst = createForegroundTrailingRefresh(
  () => {
    if (currentPage === "close-day") getCloseDaySurface().checkFreshnessSoon();
    warmHiddenOpen();
    queueDashboardRefresh(TAB_REFRESH_TASKS);
  },
  { delay: 180, isForeground: dashboardCanRefreshLiveTabs }
);
function tabsSoon() {
  tabRefreshBurst.request();
}
function tabsMoved() {
  // Placement is already visible in Chrome. Reconcile Open at the next frame;
  // its scheduler and interaction gate retain hidden or held work. Counts and
  // other tab-dependent surfaces still use the normal quiet-window refresh.
  queueDashboardRefresh(["open"]);
  tabsSoon();
}
function resumeDashboardRefreshes() {
  if (!dashboardCanRefreshLiveTabs()) return;
  tabRefreshBurst.foreground();
  dashboardStorageRefresh.foreground();
  dashboardRefreshScheduler.foreground();
  dashboardOpenRefresh.foreground();
}
chrome.tabs.onCreated.addListener(tabsSoon);
chrome.tabs.onRemoved.addListener(tabsSoon);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!reconcileOpenTabUpdate(openSec.body, tabId, info)) tabsSoon();
});
chrome.tabs.onMoved.addListener(tabsMoved);
chrome.tabs.onAttached.addListener(tabsMoved);
chrome.tabs.onDetached.addListener(tabsMoved);
chrome.tabGroups?.onUpdated?.addListener(tabsSoon);
chrome.windows.onFocusChanged.addListener((windowId) => {
  dashboardWindowFocused = windowId === dashboardWindowId;
  resumeDashboardRefreshes();
});
window.addEventListener("focus", resumeDashboardRefreshes);
document.addEventListener("visibilitychange", () => {
  resumeDashboardRefreshes();
  if (document.visibilityState !== "hidden" && vaultPrimaryReady && vaultSchedulePending) {
    vaultSchedulePending = false;
    void getVaultSurface().then((surface) => surface.schedule());
  }
});
void Promise.all([
  chrome.windows.getCurrent().catch(() => null),
  chrome.windows.getLastFocused().catch(() => null)
]).then(([ownWindow, focusedWindow]) => {
  dashboardWindowId = ownWindow?.id ?? null;
  dashboardWindowFocused = dashboardWindowId !== null && focusedWindow?.id === dashboardWindowId;
  resumeDashboardRefreshes();
});

// storage events (M0 lesson: live refresh on every store key this page renders)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  changes = expandStorageChanges(changes);
  if (changes[SESSION_NAVIGATION_REVISION_KEY]?.newValue) {
    pendingSessionNavigation = changes[SESSION_NAVIGATION_REVISION_KEY].newValue;
  } else if (changes[STORE_KEYS.sessions]?.newValue) {
    pendingSessionNavigation = sessionNavigationSnapshot(
      changes[STORE_KEYS.sessions].newValue
    );
  } else if (changes[NAMED_SESSION_RECORDS_KEY]?.newValue) {
    // The small physical named-record map intentionally carries no automatic
    // Snapshots. Patch only the named branch and retain the existing Snapshot
    // count from the hydrated navigation snapshot.
    pendingSessionNavigation = {
      namedSessions: sessionNavigationSnapshot(
        changes[NAMED_SESSION_RECORDS_KEY].newValue
      ).namedSessions
    };
  }
  if (changes[CUSTOM_SCHEME_NOTICE_KEY]?.newValue) void consumeCustomSchemeNotice();
  if (["inbox", "archive", ARCHIVE_OVERLAY_KEY].some((key) => key in changes)) {
    getOpenSurface().invalidateSavedLabels();
  }
  // Session identity refresh/prewarm is part of dashboardTasksForStorage below,
  // so background documents retain dirty work instead of reading full windows.
  if (currentPage === "close-day" &&
      [STORE_KEYS.inbox, STORE_KEYS.archive, ARCHIVE_OVERLAY_KEY,
        STORE_KEYS.sessions, NAMED_SESSION_RECORDS_KEY]
        .some((key) => key in changes)) {
    getCloseDaySurface().checkFreshnessSoon();
  }
  dashboardStorageRefresh.request(dashboardTasksForStorage(changes, {
    statsVisible: document.body.dataset.page === "stats"
  }));

  if (changes.journal) {
    void showLatestJournalToast(changes.journal);
  }

  if (changes.settings) applyIntroPref(); // N15
  const dataKeys = [
    ...Object.values(STORE_KEYS), ARCHIVE_OVERLAY_KEY, NAMED_SESSION_RECORDS_KEY, "settings"
  ];

  // M5 write-through: any data change while the dashboard is open syncs the
  // vault after a 3s debounce. Sync's own storage writes re-enter here, but
  // the follow-up sync finds nothing changed and writes nothing (idempotent).
  if (dataKeys.some((k) => changes[k])) scheduleSync();
});
