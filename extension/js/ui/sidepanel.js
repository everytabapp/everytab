/**
 * F14 — EveryTab side panel (Chrome global Side Panel API).
 *
 * This is "the dashboard minus its shell, one section at a time" — NOT a larger
 * popup and NOT an iframe of the dashboard. The five list sections are rendered
 * through the SAME shared `createTabList` configs the dashboard uses
 * (`js/ui/list-configs.js`), so there is one behavior source (see
 * `f14-side-panel-spec.md` §5.1).
 *
 * Build status: F14-2c section wiring. Open, Inbox, Sessions, Labels, and
 * Snoozed all render from their shared behavior sources in compact presentation.
 * It never imports the side-effectful `dashboard.js`.
 */
import { el } from "./dom.js";
import { initInputModality } from "./input-modality.js";
import { initTheme } from "./theme.js";
import { createSearchBox } from "./searchbox.js";
import { dashboardHref } from "../lib/newtab-focus.js";
import { createOpenSurface } from "./open-surface.js";
import { createInboxSurface } from "./inbox-surface.js";
import { createSessionsSurface } from "./sessions-surface.js";
import { createLabelsSurface } from "./labels-surface.js";
import { createFocusStrip } from "./focus-strip.js";
import { initTooltips } from "./tooltip.js";
import { createLeadingTrailingRefresh } from "./refresh-scheduler.js";
import { showLoadingFeedback } from "./loading.js";
import { createUndoToast, bindUndoShortcut } from "./toast.js";
import { createCopyHelpers, mark, flashNote, cardLabelPanel, sessionComboboxButton, confirmDelete, buildSnoozePanel } from "./list-helpers.js";
import { createTabList, fromSnoozes } from "./tablist.js";
import { buildSnoozedListConfig } from "./list-configs.js";
import { labelTabsFromItems } from "../lib/labels.js";
import { LABEL_META_KEY } from "../lib/label-meta.js";
import { listItems } from "../lib/store.js";
import { deleteSavedItem } from "../lib/saved-item-actions.js";
import { deleteNamedSession } from "../lib/organization.js";
import { STORE_KEYS, ARCHIVE_OVERLAY_KEY } from "../lib/types.js";
import { SESSION_IDENTITY_INDEX_KEY } from "../lib/session-identity-index.js";
import { applyDocumentLocale, msg as localeMessage } from "../lib/i18n.js";
import {
  shellLoadingSection, shellMoreSelected, shellNavLabel, shellPanelTabLabel, shellSectionCountTitle,
  shellSectionTitle, shellStatic
} from "./shell-copy.js";

initTheme(); // passive utility surface: paint current scheme, reserve the next New Tab draw
applyDocumentLocale();
document.title = localeMessage("shell_side_panel_title");
initInputModality(); // N42: the shared Labels surface gates its arrival cue on this
initTooltips(); // replace slow native title tips with the shared ~300ms themed tip

/* ---- panel-local state (document-local; defaults to Open on every open) ---- */

/** @type {{id: string, label: string}[]} the four direct switcher tabs, in order */
const TABS = [
  { id: "open", label: shellPanelTabLabel("open") },
  { id: "inbox", label: shellPanelTabLabel("inbox") },
  { id: "sessions", label: shellPanelTabLabel("sessions") },
  { id: "labels", label: shellPanelTabLabel("labels") }
];
const HEADINGS = Object.fromEntries(
  ["open", "inbox", "sessions", "labels", "snoozed"].map((id) => [id, shellSectionTitle(id)])
);
const SECTION_ACTION_HOSTS = Object.fromEntries(Object.keys(HEADINGS).map((id) =>
  [id, el("div", { class: "panel-section-actions", "data-panel-actions": id })]));
let activeSection = "open";

/* ---- open a dashboard route in a tab (More menu targets) ---- */
const openDash = (hash = "open") => chrome.tabs.create({ url: dashboardHref(hash) });
SECTION_ACTION_HOSTS.open.replaceChildren(el("button", {
  type: "button", "data-tip": shellStatic.closeDayTip(),
  onclick: () => openDash("#close-day")
}, shellStatic.closeDay()));

/* ---- global search (shared component, unchanged behavior) ---- */
const searchBox = createSearchBox({
  enterFallback: true,
  // ↓ from the empty search box enters the first visible list row (once lists render)
  exitToList: () => {
    const first = panelBody.querySelector(".trow, .item");
    if (first) first.focus?.();
  }
});
const searchInput = searchBox.querySelector("input");

/* ---- section switcher (role=tablist for the four tabs + a More menu button) ---- */

const heading = el("h2", { class: "panel-heading" }, HEADINGS[activeSection]);
const sectionLead = el("header", { class: "panel-section-lead" },
  heading, SECTION_ACTION_HOSTS[activeSection]);
const panelBody = el("div", { class: "panel-body", id: "panel-body", role: "region", "aria-live": "off" });
const focusSlot = el("div", { class: "panel-focus" }); // shared Focus strip mounts here

/** Fractional heights keep the sticky stack seam-free at zoomed CSS scales. */
const panelBoxHeight = (node) => node?.getBoundingClientRect().height ?? 0;

/** Complete clearance for programmatic card jumps inside the panel. */
function panelStickyOffset() {
  return panelBoxHeight(chrome_) + panelBoxHeight(sectionLead) +
    panelBoxHeight(panelBody.querySelector(".section-local-sticky"));
}

/** Publish the dynamic Search/Focus/nav + section + local-index sticky stack. */
function measurePanelChrome() {
  document.documentElement.style.setProperty("--panel-chrome-h", `${panelBoxHeight(chrome_)}px`);
  document.documentElement.style.setProperty("--panel-section-lead-h", `${panelBoxHeight(sectionLead)}px`);
  document.documentElement.style.setProperty("--panel-local-h",
    `${panelBoxHeight(panelBody.querySelector(".section-local-sticky"))}px`);
}

let panelLocalChromeObserver = null;
function watchPanelChrome() {
  panelLocalChromeObserver?.disconnect();
  const local = panelBody.querySelector(".section-local-sticky");
  if (local) {
    panelLocalChromeObserver = new ResizeObserver(() => measurePanelChrome());
    panelLocalChromeObserver.observe(local);
  } else {
    panelLocalChromeObserver = null;
  }
  measurePanelChrome();
}

/**
 * One document-local lifecycle record per section. Hosts stay stable when detached,
 * so a clean return is a synchronous mount with no data read or loading flash.
 * @type {Record<string, {host: HTMLElement, rendered: boolean, dirty: boolean,
 *   scrollTop: number, generation: number, refreshing: Promise<void>|null, heading: string}>}
 */
const SECTION_LIFECYCLE = Object.fromEntries(Object.keys(HEADINGS).map((id) => [id, {
  host: el("div", { class: "panel-section-host", "data-panel-section": id }),
  rendered: false,
  dirty: true,
  scrollTop: 0,
  generation: 0,
  refreshing: null,
  heading: HEADINGS[id]
}]));

function sectionCanCommit(id, generation) {
  return activeSection === id && SECTION_LIFECYCLE[id].generation === generation;
}

function setSectionHeading(id, text) {
  SECTION_LIFECYCLE[id].heading = text;
  if (activeSection === id) heading.textContent = text;
}

function currentScrollTop() {
  return document.scrollingElement?.scrollTop ?? window.scrollY ?? 0;
}

/** Restore the document scroller instantly; the guarded RAF covers late layout. */
function restoreSectionScroll(id, generation = SECTION_LIFECYCLE[id].generation) {
  const state = SECTION_LIFECYCLE[id];
  if (!sectionCanCommit(id, generation)) return;
  window.scrollTo({ top: state.scrollTop, left: 0, behavior: "auto" });
  requestAnimationFrame(() => {
    if (sectionCanCommit(id, generation)) {
      window.scrollTo({ top: state.scrollTop, left: 0, behavior: "auto" });
    }
  });
}

/* ---- shared machinery: one behavior source with the dashboard ---- */

// Undo/notice toast + Ctrl/Cmd+Z; copy-as-markdown reports through the notice sink.
const { element: toast, showToast, showNotice } = createUndoToast();
bindUndoShortcut(showToast);
const { copyRefs, copySession } = createCopyHelpers(showNotice);

// Shared site-guard Focus strip. Its optional access rows change the compact sticky
// stack height, so the same measured-offset rule as Dashboard applies here too. It
// never steals focus; ending a run while the strip is focused returns to Search.
const { element: focusStripEl, announcer: focusAnnouncer, refresh: refreshFocusStrip } =
  createFocusStrip({ getSearchInput: () => searchInput, onMeasure: measurePanelChrome,
    // F48: the panel has no settings route of its own, so it opens the page.
    openBlockedSites: () => openDash("#settings-focus"), showNotice });
focusSlot.append(focusStripEl);

/* ---- Open section: rendered through the SAME createOpenSurface the dashboard uses
   (one behavior source, spec §5.1) in the compact presentation. Label chips
   navigate through the shared in-panel Labels surface. ---- */
const panelMsg = (m) => chrome.runtime.sendMessage(m);
let openSurface = null;
function getOpenSurface() {
  if (!openSurface) openSurface = createOpenSurface({
    msg: panelMsg,
    rerender: () => renderOpen(),
    sectionActionHost: SECTION_ACTION_HOSTS.open,
    shouldRenderBody: () => activeSection === "open",
    getFlashAnchor: () => heading,
    showNotice, flashNote, mark,
    cardLabelPanel, sessionComboboxButton, copyRefs,
    renderArchive: () => {},   // no Archive section in the panel
    renderLabels, goToLabel,
    presentation: "compact"
  });
  return openSurface;
}
async function buildOpenSection(state, generation) {
  const { heading: h, node } = await getOpenSurface().render();
  if (!sectionCanCommit("open", generation)) return false;
  setSectionHeading("open", h);
  if (node) state.host.replaceChildren(node);
  return true;
}
function renderOpen() { return markSectionDirty("open"); }

/* ---- Inbox section: rendered through the SAME createInboxSurface the dashboard
   uses. openRowLabel is thin surface glue (open the shared cardLabelPanel, apply
   labels via the shared domain op) bound to the panel's Labels refresh. ---- */
const openRowLabel = (rowCtx, store, rerender) => {
  rowCtx.panel.toggle(() => cardLabelPanel(async (labels) => {
    await labelTabsFromItems([{ item: rowCtx.group.data, indexes: [rowCtx.index] }], labels, store);
    rerender();
    renderLabels();
  }, "Add labels", rowCtx.panel), "label");
};
let inboxSurface = null;
function getInboxSurface() {
  if (!inboxSurface) inboxSurface = createInboxSurface({
    rerender: () => renderInbox(),
    shouldRenderBody: () => activeSection === "inbox",
    renderLabels, goToLabel,
    showNotice, showToast, flashNote,
    copyRefs, sessionComboboxButton, cardLabelPanel, confirmDelete,
    buildSnoozePanel, openRowLabel,
    presentation: "compact"
  });
  return inboxSurface;
}
async function buildInboxSection(state, generation) {
  const { heading: h, node } = await getInboxSurface().render();
  if (!sectionCanCommit("inbox", generation)) return false;
  setSectionHeading("inbox", h);
  if (node) state.host.replaceChildren(node);
  return true;
}
function renderInbox() { return markSectionDirty("inbox"); }

/* ---- Snoozed section (reached from the More menu). Its config is fully
   self-contained (the reschedule panel + subset wake/cancel + split-aware ops all
   live in buildSnoozedListConfig), so it needs no surface: gather + build directly.
   Session snoozes render their session's tabs live (via fromSnoozes). ---- */
async function buildSnoozedSection(state, generation) {
  const snoozes = (await listItems(STORE_KEYS.snoozes)).sort((a, b) => a.dueAt - b.dueAt);
  const sessionsById = new Map((await listItems(STORE_KEYS.sessions)).map((s) => [s.id, s]));
  if (!sectionCanCommit("snoozed", generation)) return false;
  setSectionHeading("snoozed", shellSectionCountTitle("snoozed", snoozes.length));
  state.host.replaceChildren(createTabList(buildSnoozedListConfig({
    presentation: "compact",
    data: { groups: fromSnoozes(snoozes, sessionsById) },
    renderSnoozes: () => renderSnoozed(),
    renderSessions: () => renderSessions(), // a wake into a session refreshes Sessions
    msg: panelMsg, copyRefs
  })));
  return true;
}
function renderSnoozed() { return markSectionDirty("snoozed"); }

/* ---- Sessions section: rendered through the shared createSessionsSurface. ---- */
const delSession = async (s, rerender) => {
  if (!s.auto) {
    const result = await deleteNamedSession(s.id, s.modifiedAt);
    if (result?.ok === false) {
      showNotice(localeMessage(result.reason === "stale"
        ? "session_delete_stale"
        : "session_delete_failed"));
      return;
    }
  } else {
    await deleteSavedItem(
      STORE_KEYS.sessions, s, localeMessage("snapshot_deleted", [s.name]),
      { actionKind: "deleted-snapshot", actionParams: { name: s.name } }
    );
  }
  rerender();
};
let sessionsSurface = null;
function getSessionsSurface() {
  if (!sessionsSurface) sessionsSurface = createSessionsSurface({
    rerender: () => renderSessions(),
    shouldRenderBody: () => activeSection === "sessions",
    getBody: () => SECTION_LIFECYCLE.sessions.host,
    setHeading: (text) => setSectionHeading("sessions", text),
    isActive: () => activeSection === "sessions",
    activate: () => { if (activeSection !== "sessions") selectSection("sessions", false); },
    stickyOffset: panelStickyOffset,
    renderLabels,
    renderSnoozes: () => renderSnoozed(),  // snooze-session refreshes the Snoozed list
    goToLabel,
    msg: panelMsg,
    showNotice, showToast, copyRefs,
    sessionComboboxButton, cardLabelPanel, confirmDelete, flashNote,
    buildSnoozePanel, copySession, delSession,
    sectionActionHost: SECTION_ACTION_HOSTS.sessions,
    presentation: "compact"
  });
  return sessionsSurface;
}
async function buildSessionsSection(state, generation) {
  const { heading: h } = await getSessionsSurface().render();
  if (!sectionCanCommit("sessions", generation)) return false;
  setSectionHeading("sessions", h);
  return true;
}
function renderSessions() { return markSectionDirty("sessions"); }

/* ---- Labels section: the shared surface owns collect/sort, the compact
   filter/sort/jump index, card filtering, and N29's instant cold-jump quick
   pass. Host injection is limited to the panel body, section switch, and sticky
   chrome offset; list actions remain in buildLabelsListConfig. ---- */
function refreshLabelViews() {
  markSectionsDirty(["labels", "open", "inbox", "sessions"]);
}
let labelsSurface = null;
let labelsRenderGeneration = 0;
function getLabelsSurface() {
  if (!labelsSurface) labelsSurface = createLabelsSurface({
    getBody: () => SECTION_LIFECYCLE.labels.host,
    setHeading: (text) => setSectionHeading("labels", text),
    shouldRenderBody: () => activeSection === "labels" &&
      SECTION_LIFECYCLE.labels.generation === labelsRenderGeneration,
    isActive: () => activeSection === "labels",
    activate: () => { if (activeSection !== "labels") selectSection("labels", false); },
    stickyOffset: panelStickyOffset,
    msg: panelMsg, refreshLabelViews, copyRefs, confirmDelete, cardLabelPanel, showNotice,
    presentation: "compact"
  });
  return labelsSurface;
}
function renderLabels() {
  return markSectionDirty("labels");
}
async function goToLabel(label) {
  const state = SECTION_LIFECYCLE.labels;
  state.dirty = false;
  const generation = ++state.generation;
  labelsRenderGeneration = generation;
  await getLabelsSurface().goToLabel(label);
  if (!sectionCanCommit("labels", generation)) {
    state.dirty = true;
    return;
  }
  state.rendered = true;
  watchPanelChrome();
  // The deliberate label-card anchor becomes Labels' new remembered position.
  state.scrollTop = currentScrollTop();
}

async function buildLabelsSection(_state, generation) {
  labelsRenderGeneration = generation;
  const result = await getLabelsSurface().render();
  if (!sectionCanCommit("labels", generation)) return false;
  if (result?.heading) setSectionHeading("labels", result.heading);
  return true;
}

// Low-level renderers write only to their stable section host. The lifecycle below
// is the sole caller, so hidden sections are dirtied rather than rendered eagerly.
const SECTION_RENDERERS = {
  open: buildOpenSection, inbox: buildInboxSection, sessions: buildSessionsSection,
  labels: buildLabelsSection, snoozed: buildSnoozedSection
};

/**
 * Refresh one visible section. A second invalidation while a read is in flight
 * queues exactly one follow-up pass; changing sections invalidates the generation.
 */
function refreshSection(id) {
  const state = SECTION_LIFECYCLE[id];
  if (!state || activeSection !== id) return Promise.resolve();
  if (state.refreshing) {
    state.dirty = true;
    return state.refreshing;
  }

  state.scrollTop = currentScrollTop();
  state.dirty = false;
  const generation = ++state.generation;
  const renderer = SECTION_RENDERERS[id];
  // Only a cold, empty section earns shared Loading feedback. Cached content
  // remains visible during every ordinary background refresh.
  const loading = !state.rendered && state.host.childNodes.length === 0
    ? showLoadingFeedback(state.host, { label: shellLoadingSection(id) })
    : null;
  let run;
  run = (async () => {
    const committed = await renderer(state, generation);
    if (!committed || !sectionCanCommit(id, generation)) {
      state.dirty = true;
      return;
    }
    state.rendered = true;
    watchPanelChrome();
    restoreSectionScroll(id, generation);
  })().finally(() => {
    loading?.stop();
    if (state.refreshing === run) state.refreshing = null;
    if (state.dirty && activeSection === id) queueMicrotask(() => refreshSection(id));
  });
  state.refreshing = run;
  return run;
}

/** Mark hidden sections stale; an affected visible section refreshes immediately. */
function markSectionDirty(id) {
  const state = SECTION_LIFECYCLE[id];
  if (!state) return Promise.resolve();
  state.dirty = true;
  return activeSection === id ? refreshSection(id) : Promise.resolve();
}

function markSectionsDirty(ids) {
  return Promise.all([...new Set(ids)].map((id) => markSectionDirty(id)));
}

/**
 * A detached host may retain ordinary list state, but never an open workflow panel.
 * These are the concrete transient shapes rendered by tablist/list-helpers today.
 * Invalidate the host rather than reaching into shared component closures or letting
 * a close callback move focus back into the section being left.
 */
function discardSectionTransients(id) {
  const state = SECTION_LIFECYCLE[id];
  if (!state?.rendered) return;
  const openTransient = state.host.querySelector(
    ".snoozebar, .organizebar, .row-labelbar, .cbx, details.overflow[open], " +
    ".confirm-inline > .mini2");
  if (!openTransient) return;
  state.host.replaceChildren();
  state.rendered = false;
  state.dirty = true;
  state.heading = HEADINGS[id];
  state.generation++;
}

function mountSection(id) {
  const state = SECTION_LIFECYCLE[id];
  panelBody.replaceChildren(state.host);
  heading.textContent = state.heading;
  sectionLead.replaceChildren(heading, SECTION_ACTION_HOSTS[id]);
  watchPanelChrome();
  restoreSectionScroll(id);
}

const tabButtons = TABS.map((t) =>
  el("button", {
    class: "switch-tab", role: "tab", id: `switch-${t.id}`,
    "aria-selected": String(t.id === activeSection),
    "aria-controls": "panel-body",
    tabindex: t.id === activeSection ? "0" : "-1",
    onclick: () => selectSection(t.id)
  }, t.label));

const moreBtn = el("button", {
  class: "switch-more", "aria-haspopup": "menu", "aria-expanded": "false",
  "aria-label": shellStatic.moreSections(),
  onclick: (e) => { e.stopPropagation(); toggleMoreMenu(); }
}, shellStatic.more());

const tablist = el("div", { class: "switcher-tabs", role: "tablist", "aria-label": shellStatic.panelSections() },
  ...tabButtons);
const switcher = el("div", { class: "switcher" }, tablist, moreBtn);

/** Roving tab focus: Left/Right/Home/End move between the four tabs; Enter/Space
 *  selects; the arrow keys wrap. The More button is reached by Tab, per §4.2. */
tablist.addEventListener("keydown", (e) => {
  const i = tabButtons.findIndex((b) => b === document.activeElement);
  if (i === -1) return;
  let next = -1;
  if (e.key === "ArrowRight") next = (i + 1) % tabButtons.length;
  else if (e.key === "ArrowLeft") next = (i - 1 + tabButtons.length) % tabButtons.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = tabButtons.length - 1;
  else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectSection(TABS[i].id); return; }
  else return;
  e.preventDefault();
  tabButtons[next].focus();
});

/* ---- More menu (Snoozed switches in-panel; the rest open the dashboard) ---- */
let moreMenu = null;
function closeMoreMenu() {
  if (!moreMenu) return;
  moreMenu.remove();
  moreMenu = null;
  moreBtn.setAttribute("aria-expanded", "false");
  document.removeEventListener("click", onOutside, true);
}
function onOutside(e) { if (moreMenu && !moreMenu.contains(e.target) && e.target !== moreBtn) closeMoreMenu(); }
function toggleMoreMenu() {
  if (moreMenu) { closeMoreMenu(); return; }
  const item = (label, run) => el("button", { class: "menu-item", role: "menuitem",
    onclick: () => { closeMoreMenu(); run(); } }, label);
  moreMenu = el("div", { class: "panel-menu", role: "menu", "aria-label": shellStatic.moreSections() },
    item(shellNavLabel("snoozed"), () => { selectSection("snoozed"); moreBtn.focus({ preventScroll: true }); }),
    item(shellNavLabel("archive"), () => openDash("#archive")),
    item(shellStatic.openDashboard(), () => openDash(dashRouteFor(activeSection))),
    item(shellStatic.settings(), () => openDash("#settings")));
  moreBtn.setAttribute("aria-expanded", "true");
  moreBtn.after(moreMenu);
  document.addEventListener("click", onOutside, true);
  moreMenu.querySelector(".menu-item")?.focus();
}

/** The dashboard route matching a panel section, else Overview. */
function dashRouteFor(section) {
  const map = { open: "open", inbox: "inbox", sessions: "sessions", labels: "labels", snoozed: "snoozed" };
  return map[section] ?? "open";
}

/**
 * Switch the active section. Updates the tab roving/selected state, the More
 * button's selected style when Snoozed, the heading, and the cached body host.
 * `renderNow = false` is used only by an in-panel label jump so the Labels
 * surface can set its N29 quick-pass target before rendering starts.
 * @param {string} id
 * @param {boolean} renderNow
 */
function selectSection(id, renderNow = true) {
  const next = SECTION_LIFECYCLE[id];
  if (!next) return;
  const previousId = activeSection;
  const previous = SECTION_LIFECYCLE[previousId];
  const changed = previousId !== id;
  const focusWasInPrevious = changed && previous.host.contains(document.activeElement);

  if (changed) {
    previous.scrollTop = currentScrollTop();
    if (previous.refreshing) {
      previous.generation++;
      previous.dirty = true;
    }
    closeMoreMenu();
    discardSectionTransients(previousId);
  }

  activeSection = id;
  const isMoreSection = !TABS.some((t) => t.id === id);
  tabButtons.forEach((b, i) => {
    const on = TABS[i].id === id;
    b.setAttribute("aria-selected", String(on));
    b.setAttribute("tabindex", on ? "0" : "-1");
  });
  moreBtn.classList.toggle("on", isMoreSection);
  moreBtn.setAttribute("aria-label", isMoreSection ? shellMoreSelected(id) : shellStatic.moreSections());
  if (!next.rendered && next.host.childNodes.length === 0) next.scrollTop = 0;
  mountSection(id);

  if (focusWasInPrevious) {
    const selectedControl = tabButtons.find((b, i) => TABS[i].id === id) ?? moreBtn;
    selectedControl.focus({ preventScroll: true });
    restoreSectionScroll(id);
  }

  if (renderNow && (!next.rendered || next.dirty)) refreshSection(id);
}

/* ---- mount ---- */
const chrome_ = el("div", { class: "panel-chrome" }, searchBox, focusSlot, switcher);
const panel = document.getElementById("panel");
panel.append(el("div", { class: "sidepanel-shell" }, chrome_, sectionLead, panelBody), toast);
document.body.append(focusAnnouncer);
selectSection("open");
const panelChromeObserver = new ResizeObserver(() => measurePanelChrome());
panelChromeObserver.observe(chrome_);
panelChromeObserver.observe(sectionLead);
refreshFocusStrip(); // paint the strip if a site-guard run is already active

// Keep the visible section's document-scroll memory current between switches.
window.addEventListener("scroll", () => {
  SECTION_LIFECYCLE[activeSection].scrollTop = currentScrollTop();
}, { passive: true });

// Measure after first paint, but leave focus where Chrome/the user put it.
// Search remains one explicit click or the shared `/` shortcut away; opening
// the panel or changing sections must never turn it into an active overlay.
requestAnimationFrame(() => {
  measurePanelChrome();
});

/* ---- live refresh: leading visible feedback plus the same bounded trailing
   reconciliation as the dashboard. Storage events refresh the Focus strip and
   surface the undo toast; none of this steals focus (§8). ---- */
const tabRefreshBurst = createLeadingTrailingRefresh(
  () => renderOpen(),
  { delay: 120 }
);
function tabsSoon() { tabRefreshBurst(); }
chrome.tabs.onCreated.addListener(tabsSoon);
chrome.tabs.onRemoved.addListener(tabsSoon);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.title || info.status === "complete" || info.pinned !== undefined) tabsSoon();
});
chrome.tabs.onMoved.addListener(tabsSoon);
chrome.tabs.onAttached.addListener(tabsSoon);
chrome.windows.onFocusChanged.addListener(tabsSoon);

// Explicit store dependency matrix. Open reads saved-copy labels from Inbox/Archive
// and named session bindings, so those stores legitimately dirty its cached host.
const STORAGE_DIRTY_MATRIX = [
  { keys: [STORE_KEYS.inbox], sections: ["inbox", "labels", "open"] },
  { keys: [STORE_KEYS.archive, ARCHIVE_OVERLAY_KEY], sections: ["labels", "open"] },
  { keys: [STORE_KEYS.sessions, SESSION_IDENTITY_INDEX_KEY], sections: ["sessions", "snoozed", "labels", "open"] },
  { keys: [STORE_KEYS.snoozes], sections: ["snoozed", "inbox", "sessions"] },
  { keys: [STORE_KEYS.organizationGroups, STORE_KEYS.organizationMemberships], sections: ["labels", "sessions"] },
  { keys: [LABEL_META_KEY], sections: ["labels"] }
];

let lastToastAt = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.focusGuardState || changes.focusTemporaryAccess || changes.settings) refreshFocusStrip();
  if ([STORE_KEYS.inbox, STORE_KEYS.archive, ARCHIVE_OVERLAY_KEY]
    .some((key) => changes[key])) {
    getOpenSurface().invalidateSavedLabels();
  }
  const affected = [];
  for (const entry of STORAGE_DIRTY_MATRIX) {
    if (entry.keys.some((key) => changes[key])) affected.push(...entry.sections);
  }
  if (affected.length) markSectionsDirty(affected);
  if (changes.journal) {
    const head = (changes.journal.newValue ?? [])[0];
    if (head && !head.undone && head.at > lastToastAt) {
      lastToastAt = head.at;
      showToast(head);
    }
  }
});

// "/" focuses search from anywhere unless the user is typing (dashboard parity).
function isTyping(t) {
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" ||
    t.tagName === "SELECT" || t.isContentEditable);
}
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target)) {
    e.preventDefault();
    searchInput?.focus();
  }
  if (e.key === "Escape" && moreMenu) { e.preventDefault(); closeMoreMenu(); moreBtn.focus(); }
});
