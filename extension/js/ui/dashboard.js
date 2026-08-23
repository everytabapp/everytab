import { STORE_KEYS, ARCHIVE_OVERLAY_KEY } from "../lib/types.js";
import { applyDocumentLocale, msg as localeMessage } from "../lib/i18n.js";
import {
  listItems, countItems, getSettings,
  mutateStores, patchSettings
} from "../lib/store.js";
import { restoreSession, getSessionBindings } from "../lib/sessions.js";
import { deleteNamedSession } from "../lib/organization.js";
import {
  collectLabels, readLabelNavigationSnapshot, archiveTabsFromItems, labelTabsFromItems,
  removeSessionLabel,
  sortLabelGroups
} from "../lib/labels.js";
import { SECTION_TO_PAGE } from "../lib/onboarding-copy.js";
import { el, coalesce, settleAnchor } from "./dom.js";
import { initInputModality } from "./input-modality.js";
import { icon } from "./icons.js";
import { createSearchBox } from "./searchbox.js";
import { buildOpenListConfig } from "./list-configs.js";
import { createOpenSurface } from "./open-surface.js";
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
import { openShortcutsOverlay } from "./shortcuts.js";
import { initTooltips } from "./tooltip.js";
import {
  TAB_REFRESH_TASKS,
  dashboardTasksForStorage,
  createFrameRefreshScheduler,
  createLeadingTrailingRefresh
} from "./refresh-scheduler.js";
import { showLoadingFeedback } from "./loading.js";
import {
  shellAllLink, shellNavLabel, shellNavName, shellNavToggleLabel,
  shellRestoreSessionAria, shellRestoreSessionTitle, shellSectionIntro,
  shellSectionTitle, shellSidebarToggleLabel, shellStatic
} from "./shell-copy.js";
import {
  settingsFavoriteAria, settingsModeChoiceLabel, settingsSchemeGroupLabel, settingsStatic
} from "./settings-copy.js";
import { initTheme, SCHEMES, SCHEME_LABELS, SCHEME_ACCENTS, SCHEME_GROUPS } from "./theme.js";
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
import { findDuplicateGroups } from "../lib/dedup.js";
import { dashboardSearchIntent } from "../lib/newtab-focus.js";
import { setGroupRestoreNotifier } from "../lib/tab-groups.js";
// E3-0: dev-only perf instrumentation — self-activates on `?perf=1` or the
// hidden settings.perfHud; every call below is a guarded no-op otherwise.
import { perfActive, pspan, pmark, pcount, precord, preport } from "../lib/perf.js";
import {
  SESSION_IDENTITY_INDEX_KEY, readSessionIdentities
} from "../lib/session-identity-index.js";

initTheme();
applyDocumentLocale();
const app = document.getElementById("app");
document.title = localeMessage("manifest_name");

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
  return { wrap, inner, isOpen: () => wrap.classList.contains("open"),
           set: (v) => wrap.classList.toggle("open", v) };
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

// F8-R1: Workspace Focus (Focus this window / Focus this session, the active-run
// status strip, and their message/focus state machine) was retired with Focus v0.2.
// No dashboard Focus actions or status remain here; the site-guard status strip is
// Batch 2. The measured `--hero-h` geometry below is generic and stays.

// F19 copy-as-markdown + the shared leaf helpers (mark, flashNote, confirmDelete,
// cardLabelPanel, sessionComboboxButton, selectionRefs) all live in
// js/ui/list-helpers.js. copyRefs/copySession report through this surface's
// showNotice (above). Destructured so call sites are unchanged.
const { copyRefs, copySession } = createCopyHelpers(showNotice);

/* ================= sections ================= */

const openSec = makeSec("open");
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
const vaultSec = makeSec("vault");
const statsSec = makeSec("stats");
const settingsSec = makeSec("settings");

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
setGroupRestoreNotifier((m) => showNotice(m));

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
    msg, rerender: () => renderOpen(),
    sectionActionHost: openSec.actions,
    shouldRenderBody: openSectionVisible,
    getFlashAnchor: () => openSec.h2,
    showNotice, flashNote, mark,
    cardLabelPanel, sessionComboboxButton, copyRefs,
    renderArchive, renderLabels, goToLabel,
    // F23: Home's Workbench is the complete Open surface. The shared surface
    // retains its normal 20-row window cap and existing Show more control.
    rowCap: () => undefined,
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
const renderOpen = coalesce(renderOpenInner);
// Open gates inside its surface (it keeps the prior subtree to hold its height),
// so it is registered rather than wrapped.
sectionRenderers.set("open", renderOpen);

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
    ? showLoadingFeedback(openSec.body, { label: "Loading open tabs…" })
    : null;
  try {
    const { heading, node } = await getOpenSurface().render();
    openSec.h2.textContent = heading;
    // node is null when the section is off-screen (openSectionVisible() === false):
    // keep the prior subtree so its height holds (no flash on return).
    if (node) {
      const y = window.scrollY;
      openSec.body.replaceChildren(node);
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
    onLeave: () => go("open", { origin: "route" })
  });
  return closeDaySurface;
}
const renderCloseDay = lazySection("close-day", renderCloseDayInner);
async function renderCloseDayInner() {
  const loading = closeDaySec.body.childNodes.length === 0
    ? showLoadingFeedback(closeDaySec.body, { label: "Preparing the review…" })
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
    renderLabels, goToLabel,
    showNotice, showToast, flashNote,
    copyRefs, sessionComboboxButton, cardLabelPanel, confirmDelete,
    buildSnoozePanel, openRowLabel
  });
  return inboxSurface;
}
async function renderInboxInner() {
  const { heading, node } = await getInboxSurface().render();
  inboxSec.h2.textContent = heading;
  if (node) inboxSec.body.replaceChildren(node);
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
        renderLabels, goToLabel, copyRefs
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
        msg
      }));
  }
  return duplicatesSurfacePromise;
}
const renderDuplicates = lazySection("duplicates",
  async () => (await getDuplicatesSurface()).render());

/* ================= Export / Import ================= */

let dataSurfacePromise = null;
function getDataSurface() {
  if (!dataSurfacePromise) {
    dataSurfacePromise = import("./data-surface.js").then(({ createDataSurface }) =>
      createDataSurface({
        getBody: () => dataSec.body,
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
const renderData = lazySection("data",
  async () => (await getDataSurface()).render());

/* ================= Vault sync (M5) ================= */

const reconnectBanner = el("div", { class: "banner hidden" });
let vaultSurfacePromise = null;
let vaultPrimaryReady = false;
let vaultSchedulePending = false;

function getVaultSurface() {
  if (!vaultSurfacePromise) {
    vaultSurfacePromise = import("./vault-surface.js").then(({ createVaultSurface }) =>
      createVaultSurface({
        getBody: () => vaultSec.body,
        setHeading: (text) => { vaultSec.h2.textContent = text; },
        getBanner: () => reconnectBanner,
        onStateChange: () => { void refreshVaultPill(); },
        showNotice,
        goToVault: () => go("vault", { origin: "route" })
      }));
  }
  return vaultSurfacePromise;
}

function scheduleSync() {
  if (!vaultPrimaryReady) {
    vaultSchedulePending = true;
    return;
  }
  void getVaultSurface().then((surface) => surface.schedule());
}

const renderVault = lazySection("vault",
  async () => (await getVaultSurface()).render());

async function refreshVaultPill() {
  const pill = await (await getVaultSurface()).pillState();
  vaultPill.className = "vault-pill " + pill.cls;
  vaultPill.title = pill.cls === "warn" && pill.status.state === "connected"
    ? "The last sync didn't complete. Open Vault for details." : `Vault: ${pill.text}`;
  vaultPill.setAttribute("aria-label", `Vault: ${pill.text}`);
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
  labelsSec, archiveSec, dataSec, vaultSec, statsSec, settingsSec,
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
  vault: [vaultSec],
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
const vaultPill = el("button", { class: "vault-pill unset", onclick: () => go("vault", { origin: "rail" }) }, "vault");

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
  setup: focusActionState("setup", "settings", "Set up Focus"),
  ready: focusActionState("ready", "play", "Start Focus", true),
  active: focusActionState("active", "stop", "End Focus")
};
const focusPrimary = el("button", { class: "hero-focus-action", type: "button" },
  focusActionStates.setup, focusActionStates.ready, focusActionStates.active);
const focusSettingsButton = el("button", {
  class: "hero-focus-settings", type: "button",
  "aria-label": "Focus settings",
  "data-tip": "Choose the guarded sites and duration",
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
      if (!result?.ok) showNotice("Couldn't end Focus.");
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
        ? "Add a During Focus site first."
        : "Couldn't start Focus.");
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
  const label = active ? "End Focus" : ready ? "Start Focus" : "Set up Focus";
  const actionTip = active ? "End the active Focus run" : ready
    ? "Start Focus with your saved duration and guarded sites"
    : "Choose the sites and duration that work for you";
  const tip = `${label}, ${duringCount} guarded site${duringCount === 1 ? "" : "s"}. ${actionTip}`;
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
  class: "theme-pop hidden", role: "menu", "aria-label": settingsStatic.colorScheme()
});
let themeTrigger = null;
function closeThemePop() {
  themePop.classList.add("hidden");
  themeTrigger?.setAttribute("aria-expanded", "false");
}
function positionThemePop(trigger) {
  const r = trigger.getBoundingClientRect();
  const gap = 8;
  const edge = 6;
  const width = Math.min(408, window.innerWidth - edge * 2);
  const left = Math.max(edge, Math.min(r.right - width, window.innerWidth - width - edge));
  const availableAbove = Math.max(0, r.top - gap - edge);
  themePop.style.width = `${Math.round(width)}px`;
  themePop.style.left = `${Math.round(left)}px`;
  themePop.style.right = "auto";
  themePop.style.top = "auto";
  themePop.style.bottom = `${Math.round(window.innerHeight - r.top + gap)}px`;
  themePop.style.maxHeight = `${Math.round(availableAbove)}px`;
}
document.addEventListener("click", (e) => {
  if (!themePop.classList.contains("hidden") &&
      !themePop.contains(e.target) && !quickTheme.contains(e.target)) {
    closeThemePop();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !themePop.classList.contains("hidden")) {
    closeThemePop();
    themeTrigger?.focus();
  }
});
function renderQuickTheme(settings, customRecords = []) {
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
        "aria-haspopup": "menu", "aria-expanded": "false", onclick: () => {
        const custom = customSchemeCatalogue(customRecords);
        const customById = new Map(custom.map((entry) => [entry.id, entry]));
        const schemeIds = availableSchemeIds(customRecords);
        const favorites = new Set(Array.isArray(settings.schemeFavorites) ? settings.schemeFavorites : []);
        const optionRow = (s) => {
          const entry = customById.get(s);
          const label = entry?.label ?? SCHEME_LABELS[s] ?? s;
          const accent = entry?.accent ?? SCHEME_ACCENTS[s];
          const star = el("button", {
            class: `theme-star${favorites.has(s) ? " on" : ""}`,
            type: "button",
            title: settingsFavoriteAria(favorites.has(s), label),
            "aria-label": settingsFavoriteAria(favorites.has(s), label),
            role: "menuitemcheckbox",
            "aria-checked": String(favorites.has(s)),
            "aria-pressed": String(favorites.has(s)),
            onclick: async () => {
              if (favorites.has(s)) favorites.delete(s); else favorites.add(s);
              settings.schemeFavorites = schemeIds.filter((id) => favorites.has(id));
              await patchSettings({ schemeFavorites: settings.schemeFavorites });
              const on = favorites.has(s);
              star.classList.toggle("on", on);
              star.textContent = on ? "★" : "☆";
              star.setAttribute("aria-checked", String(on));
              star.setAttribute("aria-pressed", String(on));
              star.title = settingsFavoriteAria(on, label);
              star.setAttribute("aria-label", star.title);
            }
          }, favorites.has(s) ? "★" : "☆");
          return el("div", { class: "theme-opt-row", role: "none" },
            el("button", { class: `theme-opt${settings.uiScheme === s ? " on" : ""}`, role: "menuitemradio",
              "aria-checked": String(settings.uiScheme === s), title: label, onclick: async () => {
              await patchSettings({ uiScheme: s });
              closeThemePop();
            } },
            el("span", { class: "sw", style: `background:${accent}` }),
            el("span", { class: "theme-opt-label" }, label)),
            star);
        };
        const quadrants = el("div", { class: "theme-quadrants", role: "presentation" },
          ...SCHEME_GROUPS.map((group) => el("div", {
            class: "theme-quadrant", role: "group",
            "aria-label": settingsSchemeGroupLabel(group.defaultMode, group.tone),
            "data-default-mode": group.defaultMode, "data-tone": group.tone
          },
          el("div", { class: "theme-group-label", role: "presentation" },
            settingsSchemeGroupLabel(group.defaultMode, group.tone)),
          el("div", { class: "theme-quadrant-options", role: "presentation" },
            ...group.ids.map(optionRow)))));
        const yours = custom.length
          ? el("div", { class: "theme-custom-group", role: "group", "aria-label": settingsStatic.yours() },
            el("div", { class: "theme-group-label", role: "presentation" }, settingsStatic.yours()),
            el("div", { class: "theme-custom-options", role: "presentation" },
              ...custom.map(({ id }) => optionRow(id))))
          : null;
        themePop.replaceChildren(
          quadrants,
          ...(yours ? [yours] : []),
          el("button", { class: "theme-manage", role: "menuitem", onclick: () => {
            closeThemePop();
            location.href = chrome.runtime.getURL("scheme-editor.html?return=dashboard");
          } }, settingsStatic.schemeEditorAction())
        );
        positionThemePop(trigger);
        const open = themePop.classList.toggle("hidden") === false;
        trigger.setAttribute("aria-expanded", String(open));
      } }, icon("palette", 16));
      themeTrigger = trigger;
      return trigger;
    })()
  );
}

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
      el("button", { class: "gear", title: shellStatic.settings(), "aria-label": shellStatic.settings(),
        onclick: () => go("settings") }, icon("settings", 16)))
  )
);

window.addEventListener("resize", closeThemePop);
// The scroll that can move the palette trigger now belongs to the nav region,
// and to the sidebar itself in the horizontal header presentation.
sidebar.addEventListener("scroll", closeThemePop);
sidebar.querySelector(".side-scroll")?.addEventListener("scroll", closeThemePop);

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
    count !== undefined ? el("span", { class: "n" }, String(count)) : null
  );
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
    group.classList.toggle("open", libOpen.has(id));
    twist.setAttribute("aria-expanded", String(libOpen.has(id)));
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
  const group = el(
    "div",
    { class: `navgroup${libOpen.has(id) ? " open" : ""}` },
    head,
    el("div", { class: "subnav" }, el("div", {}, ...subItems))
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
    navBtn("inbox", shellNavLabel("inbox"), "inbox"),
    navBtn("snooze", shellNavLabel("snoozed"), "snoozed"),
    navBtn("duplicates", shellNavLabel("duplicates"), "duplicates")
  );
  navLib.replaceChildren(
    navBtn("sessions", shellNavLabel("sessions"), "sessions"),
    navBtn("labels", shellNavLabel("labels"), "labels"),
    navBtn("archive", shellNavLabel("archive"), "archive"),
    navBtn("snapshots", shellNavLabel("snapshots"), "snapshots")
  );
  navMore.replaceChildren(
    navBtn("stats", shellNavLabel("stats"), "stats"),
    navBtn("activity", shellNavLabel("activity"), "activity"),
    navBtn("data", shellNavLabel("data"), "data"),
    navBtn("vault", shellNavLabel("vault"), "vault"),
    navBtn("settings", shellNavLabel("settings"), "settings")
  );
}

async function readNavLibraryData() {
  return readLabelNavigationSnapshot();
}

function replaceNavLibrary({ archiveCount, labelGroups, namedSessions, snapshotCount }) {
  navLib.replaceChildren(
    navGroup("sessions", "sessions", shellNavLabel("sessions"), "sessions", namedSessions.length, [
      ...namedSessions.slice(0, 7).map((session) => {
        const tabCount = session.windows.reduce((total, refs) => total + refs.length, 0);
        return el("div", { class: "subrow" },
          el("button", { class: "navitem sub", title: session.name,
            "aria-label": navName(session.name, tabCount), onclick: () => goToSession(session.id) },
            el("span", { class: "navtext" }, session.name),
            el("span", { class: "n" }, String(tabCount))),
          el("button", { class: "subact", title: shellRestoreSessionTitle(session.name),
            "aria-label": shellRestoreSessionAria(session.name),
            onclick: (event) => { event.stopPropagation(); restoreSession(session); } },
            icon("switch", 13)));
      }),
      namedSessions.length > 7
        ? el("button", { class: "navitem sub", onclick: () => go("sessions", { origin: "rail" }) },
            el("span", { class: "navtext" }, shellAllLink("sessions")))
        : null
    ].filter(Boolean)),
    // Subnav caps: 14 labels / 14 views / 7 sessions; past the cap an
    // "All … →" tail links to the full page (user question 2026-07-12).
    navGroup("labels", "labels", shellNavLabel("labels"), "labels", labelGroups.length, [
      // Sidebar shows the most recently used labels first (matches the Labels
      // page's default "recent" sort) — quick access to what you just touched.
      ...sortLabelGroups(labelGroups, "recent").slice(0, 14).map((g) =>
        el("button", { class: "navitem sub", onclick: () => goToLabel(g.label) },
          el("span", { class: "navtext" }, g.label), el("span", { class: "n" }, String(g.tabs)))),
      labelGroups.length > 14
        ? el("button", { class: "navitem sub", onclick: () => go("labels", { origin: "rail" }) },
            el("span", { class: "navtext" }, shellAllLink("labels")))
        : null
    ].filter(Boolean)),
    navBtn("archive", shellNavLabel("archive"), "archive", archiveCount),
    navBtn("snapshots", shellNavLabel("snapshots"), "snapshots", snapshotCount)
  );
}

const renderNavLibrary = coalesce(async () => {
  replaceNavLibrary(await readNavLibraryData());
  syncNavSelection();
});

const renderNav = coalesce(renderNavInner);
async function renderNavInner() {
  const [settings, customRecords] = await Promise.all([
    getSettings(), listItems(STORE_KEYS.customSchemes)
  ]);
  // D4-3a: renderNav already re-runs on every settings change, so this is also
  // the live reconciliation path when another surface flips the preference.
  if (!navWritePending) sidebarCollapsed = settings.uiSidebarCollapsed === true;
  applyNavMode();
  // E3-2: Inbox, Snoozed, and Archive contribute only a NUMBER to the sidebar,
  // so they are counted rather than listed and sorted. Sessions and Labels
  // still need their records, because each renders a subnav.
  const [tabs, inboxCount, snoozeCount, library] =
    await Promise.all([
      chrome.tabs.query({}),
      countItems(STORE_KEYS.inbox),
      countItems(STORE_KEYS.snoozes),
      readNavLibraryData()
    ]);
  const groups = await findDuplicateGroups();
  const dupCount = groups.reduce((n, g) => n + g.close.length, 0);
  navMain.replaceChildren(
    navBtn("open", shellNavLabel("open"), "open", tabs.length),
    navBtn("inbox", shellNavLabel("inbox"), "inbox", inboxCount),
    navBtn("snooze", shellNavLabel("snoozed"), "snoozed", snoozeCount),
    navBtn("duplicates", shellNavLabel("duplicates"), "duplicates", dupCount)
  );
  replaceNavLibrary(library);
  navMore.replaceChildren(
    navBtn("stats", shellNavLabel("stats"), "stats"),
    navBtn("activity", shellNavLabel("activity"), "activity"),
    navBtn("data", shellNavLabel("data"), "data"),
    navBtn("vault", shellNavLabel("vault"), "vault"),
    navBtn("settings", shellNavLabel("settings"), "settings")
  );
  // A route may have changed while counts/Vault state were being read.
  syncNavSelection();

  renderQuickTheme(settings, customRecords);
  await refreshFocusNav();

}

/* ---- hero + page utilities (F37) ----
 * Search stays one sticky row. Starred is a top-right overlay rail that never
 * changes page geometry; Needs you is ordinary flow immediately below Search. */
function transitionStarredRail(update) {
  const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduced || typeof document.startViewTransition !== "function") {
    update();
    return;
  }
  try { document.startViewTransition(update); }
  catch { update(); }
}
const pageUtilities = createPageUtilities({
  go, showNotice, onRailTransition: transitionStarredRail
});
// Needs you keeps the `attention` scheduler task because its duplicate count
// follows live tabs. Starred is separate and follows only the Starred store.
const renderAttention = coalesce(() => pageUtilities.refreshAttention());

const historyBtn = el("button", { type: "button", class: "search-history-invite linklike" },
  "Use browser History");
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
    purpose: "Allow Browser History to include pages you visited recently after EveryTab's local results.",
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
const searchOverlay = el("div", { class: "hero-search-overlay" }, searchResults, searchFooter);
const heroPanel = el("div", { class: "hero-panel" }, searchBox, searchOverlay);

/** True only when dashboard.js is mounted inside Chrome's static New Tab host. */
const isNewTabHost = () => document.documentElement.dataset.newTabHost === "true";

/* F8-R2: the global site-only Focus strip, shared via createFocusStrip (see
 * focus-strip.js). measureHero is injected because the strip changes the
 * sticky-hero height; focus returns to search when the strip is about to lose it. */
const { element: focusStrip, announcer: focusAnnouncer, refresh: refreshFocusStrip } =
  createFocusStrip({
    getSearchInput: () => searchInput,
    onMeasure: measureHero,
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
  el("h1", { class: "sr-only" }, "EveryTab"),
  el("div", { class: "hero-top" }, heroPanel),
  heroUtility,
  pageUtilities.starred,
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
    // N40: ANY arrow pressed while the list is not already being walked enters
    // it at the first unit's checkbox — from a nav item, a section control, or
    // nowhere at all. Previously only ↑/↓ from a bare <body> did anything, so
    // the keys read as dead everywhere else. The search field is an input and
    // returned above, so its own handler still owns its arrows (an empty box
    // hands ArrowDown to the list through exitToList).
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
  // P11-05 fallback for Chromium versions without action.openPopup(): open the
  // dashboard and land directly in its existing Search field.
  const searchDeepLink = routeSearchIntent.searchDeepLink;
  // The popup's "Focus settings" deep link → the Settings page, then a scroll to
  // the Focus group below the measured hero once the async form mounts.
  const focusDeepLink = raw === "settings-focus";
  const settingsDeepLink = /^settings:(appearance|newtab|focus|autosave|suspension|sessions|duplicates|privacy|intro|keyboard)$/.exec(raw);
  const deepSettingsGroup = settingsDeepLink?.[1] ?? null;
  // F16 (item): the popup's tab-label chips deep-link to a specific label card —
  // `#label:<encoded name>` → the Labels page, positioned on that card.
  const labelDeepLink = raw.startsWith("label:");
  const deepLabel = labelDeepLink ? safeDecode(raw.slice("label:".length)) : null;
  const groupDeepLink = /^(label|session)-group:(.+)$/.exec(raw);
  const deepGroupKind = groupDeepLink?.[1] ?? null;
  const deepGroupId = groupDeepLink ? safeDecode(groupDeepLink[2]) : null;
  // `#home` and `#overview` are kept as aliases so old links and pinned tabs
  // still resolve, now to the Open tabs landing.
  const requested = searchDeepLink || raw === "overview" || raw === "home" ? "open" : (raw || "open");
  const want = focusDeepLink || deepSettingsGroup ? "settings"
    : labelDeepLink ? "labels"
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
  watchSectionChrome();
  renderStats();
  renderOpen(); // self-gates: builds only if the open section is now on-screen
  if (currentPage === "close-day") renderCloseDay();
  // E3-2: whatever changed while it was hidden catches up now, once.
  flushStaleSections();
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

/** Legacy Focus-only route used by popup and Focus surfaces. */
async function scrollToFocusSettings({ focusSites = false } = {}) {
  return scrollToSettingsGroup("focus", {
    focusSelector: focusSites ? ".focus-site-input" : null
  });
}

const dailyStage = el("div", { class: "daily-stage" },
  reconnectBanner, sectionsWrap);
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
  onclick: () => searchInput.focus() }, "Skip to search");
skipLink.addEventListener("focus", (e) => {
  // `relatedTarget` is the element that LOST focus. A real in-page Shift+Tab
  // names one, so the visible control stays. Arriving from browser chrome or
  // from a bare `body` names nothing useful, and that is focus on its way into
  // the page: hand it to the command box.
  if (e.relatedTarget && e.relatedTarget !== document.body) return;
  searchInput.focus();
});
// The palette is a viewport popover, not sidebar content. Keeping it inside the
// sticky, overflow-hidden sidebar trapped its z-index and made the part drawn
// over the content column visible but unclickable. Portal it beside the shell.
app.append(el("div", { class: "app" }, skipLink, sidebar, main), themePop, toast);

// Publish the real hero height as `--hero-h` and keep it current as the section
// intros / wrapping change it. One observer, no polling. (F8-R1: the retired Focus
// strip no longer contributes to the hero; Batch 2's site-guard status will reuse this.)
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
setInterval(renderAttention, 30_000);
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
    el("span", {}, "EveryTab is now your new-tab page."),
    el("button", { onclick: dismiss }, "Keep it"),
    el("button", { onclick: async () => {
      await patchSettings({ newTabMode: "minimal" });
      dismiss();
    } }, "Show a minimal page instead")
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
  activity: renderActivity,
  stats: renderStats,
  nav: renderNav,
  navLibrary: renderNavLibrary,
  attention: renderAttention,
  focus: refreshFocusChrome,
  settings: refreshMountedSettings
};
const REFRESH_SECTION = {
  open: "open", closeDay: "close-day", inbox: "inbox", labels: "labels", archive: "archive",
  sessions: "sessions", snapshots: "snapshots",
  snoozes: "snoozed", duplicates: "duplicates", vault: "vault",
  activity: "activity", stats: "stats", settings: "settings"
};
function refreshPriority(task) {
  const section = REFRESH_SECTION[task];
  if (!section) return 2; // global counts/status, after visible content
  if (section === currentPage) return 0;
  return sectionVisible(section) ? 1 : 3;
}
async function runDashboardRefresh(tasks) {
  // Scheme rotation and other early events can fire while cold Open is still
  // reading. They must not sneak global counts back onto the B3 critical path.
  await primaryOpenReady.catch(() => {});
  const started = perfActive() ? performance.now() : 0;
  for (let priority = 0; priority <= 3; priority++) {
    const band = tasks.filter((task) => refreshPriority(task) === priority);
    if (!band.length) continue;
    await Promise.allSettled(band.map((task) => DASHBOARD_REFRESH_RUNNERS[task]?.()));
  }
  if (perfActive()) {
    const ms = performance.now() - started;
    precord("refresh:flush", ms, `${tasks.join(",")} → ${tasks.length} unique tasks`);
    pcount("refresh tasks (total)", tasks.length, ms);
  }
}
const dashboardRefreshScheduler = createFrameRefreshScheduler(runDashboardRefresh);
function queueDashboardRefresh(tasks) {
  dashboardRefreshScheduler.request(tasks);
}

// First event reaches the next frame immediately; one 120ms quiet-tail pass
// reconciles Chrome's multi-event drag/create/remove storms.
const tabRefreshBurst = createLeadingTrailingRefresh(
  () => queueDashboardRefresh(TAB_REFRESH_TASKS),
  { delay: 120 }
);
function tabsSoon() {
  if (currentPage === "close-day") getCloseDaySurface().checkFreshnessSoon();
  warmHiddenOpen();
  tabRefreshBurst();
}
chrome.tabs.onCreated.addListener(tabsSoon);
chrome.tabs.onRemoved.addListener(tabsSoon);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.title || info.status === "complete" || info.pinned !== undefined) tabsSoon();
});
chrome.tabs.onMoved.addListener(tabsSoon);
chrome.tabs.onAttached.addListener(tabsSoon);
chrome.windows.onFocusChanged.addListener(tabsSoon);

// storage events (M0 lesson: live refresh on every store key this page renders)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[CUSTOM_SCHEME_NOTICE_KEY]?.newValue) void consumeCustomSchemeNotice();
  if (["inbox", "archive", ARCHIVE_OVERLAY_KEY].some((key) => key in changes)) {
    getOpenSurface().invalidateSavedLabels();
  }
  if (SESSION_IDENTITY_INDEX_KEY in changes) {
    // A pre-index profile may have painted generic Window names while the
    // delayed additive backfill ran. Apply the names immediately when Open is
    // visible; otherwise retain the existing hidden prewarm behavior.
    if (openSectionVisible()) renderOpen();
    else warmHiddenOpen();
  } else if ([STORE_KEYS.sessions, "sessionWindows"].some((key) => key in changes)) {
    warmHiddenOpen();
  }
  if (currentPage === "close-day" &&
      [STORE_KEYS.inbox, STORE_KEYS.archive, ARCHIVE_OVERLAY_KEY, STORE_KEYS.sessions]
        .some((key) => key in changes)) {
    getCloseDaySurface().checkFreshnessSoon();
  }
  queueDashboardRefresh(dashboardTasksForStorage(changes, {
    statsVisible: document.body.dataset.page === "stats"
  }));

  if (changes.journal) {
    const head = (changes.journal.newValue ?? [])[0];
    if (head && !head.undone && head.at > lastToastAt) {
      lastToastAt = head.at;
      showToast(head);
    }
  }

  if (changes.settings) applyIntroPref(); // N15
  const dataKeys = [...Object.values(STORE_KEYS), ARCHIVE_OVERLAY_KEY, "settings"];

  // M5 write-through: any data change while the dashboard is open syncs the
  // vault after a 3s debounce. Sync's own storage writes re-enter here, but
  // the follow-up sync finds nothing changed and writes nothing (idempotent).
  if (dataKeys.some((k) => changes[k])) scheduleSync();
});
