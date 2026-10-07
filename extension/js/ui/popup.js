// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "../lib/failure-diagnostic.js";
/**
 * Popup — the triage surface (spec: popup-journeys.md).
 * Layout top→bottom: search · [dup hint] · [vault warn] · status strip ·
 * THIS TAB group · THIS WINDOW group · [close-N dups] · msg · footer links.
 *
 * Hard rules honored:
 *  - M0: never mutate tabs here; message the background worker.
 *  - Criterion 2: no action fails *after* a click for a reason knowable before —
 *    controls are disabled + given a reason instead.
 *  - Criterion 5: the shell is appended synchronously (fast first paint); async
 *    data fills in without resizing the shell (reserved heights, in-place text).
 */
import { faviconSource } from "./favicon-source.js";
import { openDashboard } from "../lib/actions.js";
import { findDuplicateGroupsFromTabs } from "../lib/dedup.js";
import { duplicateUrlKey, readDuplicateDomainRules } from "../lib/duplicate-domain-rules.js";
import { getSettings, listItems, readStoreValue } from "../lib/store.js";
import { saveLabeledCopies } from "../lib/labels.js";
import { readPopupTabLabels as computeTabLabels } from "./popup-label-data.js";
import { STORE_KEYS } from "../lib/types.js";
import { isStarredUrl, starTab, unstarUrl } from "../lib/starred.js";
import { listActions } from "../lib/journal.js";
import {
  isHttpTab, ownSuspendedRef, urlOf, canonicalRef, isSaveableTab, saveableTabRef
} from "../lib/tabs.js";
import { isSuspendExempt } from "../lib/suspend.js";
import { readProtectionStatus } from "../lib/automation-protection.js";
import { buildProtectionPanel, protectionStatusText } from "./automation-protection.js";
import { linksToMarkdown } from "../lib/export.js";
import {
  nextWallClockInfo, siteRuleCounts
} from "../lib/focus.js";
import {
  formatRemaining, blockedSitesSummary, focusPopupDurationInfo
} from "../lib/focus-copy.js";
import { applyDocumentLocale, applyUiLanguage, msg as localeMessage } from "../lib/i18n.js";
import { withPending } from "./pending.js";
import { expandStorageChanges } from "../lib/storage/constants.js";
// E3-0: dev-only perf instrumentation. The real toolbar popup can't carry
// `?perf=1`, so activation ALSO happens from the hidden settings.perfHud the
// moment hydrate's own settings read lands; all calls are no-ops otherwise.
import { activateFromSettings, perfActive, precord, preport } from "../lib/perf.js";
import { getVaultStatus, getVaultSyncMeta } from "../vault/vault.js";
import { el, eventOwnsTextEntry, isComposingKey } from "./dom.js";
import { icon } from "./icons.js";
import { createSearchBox } from "./searchbox.js";
import { createFocusAccessPanel, getFocusAccessStatus } from "./focus-access.js";
import { createLabelInput } from "./labelinput.js";
import { createInlineOrganizationEditor } from "./organization-controls.js";
import { applyOrganizationMemberPlan } from "../lib/organization.js";
import {
  buildSnoozePanel as buildSharedSnoozePanel, buildSortChoices, sessionComboboxButton
} from "./list-helpers.js";
import { listSortLabel } from "./list-copy.js";
import { initTooltips } from "./tooltip.js";
import { initTheme } from "./theme.js";
import { createAnchoredPanel, dismissAnchoredPanel } from "./tablist.js";
import { createSpatialArrowNavigator } from "./arrow-navigation.js";
import { consumeSearchPopupMode } from "../lib/search-popup.js";
import {
  popupCloseDuplicates, popupClosedDuplicates, popupCopiedLinks, popupDefaultDuration,
  popupDueToday, popupDuplicateHint, popupDuplicateWhere, popupGuardedSites,
  popupFocusSummary,
  popupInboxCount, popupLabeledWith, popupMoreLabelsTitle, popupOpenAllLabels,
  popupOpenLabel, popupRenamed, popupRenameFailed, popupSavedSession, popupSavedTabs,
  popupSnoozedUntil, popupSortedBy, popupStatic, popupStatusSummary,
  popupSuspendedTabs, popupUntilTime, popupUntilTomorrow
} from "./popup-copy.js";

// The chosen interface language must be in place before the shell paints.
// hydrate() reads the same cached Settings snapshot, so this adds no storage read.
await applyUiLanguage((await getSettings()).uiLanguage);
initTheme();
applyDocumentLocale();
document.title = localeMessage("manifest_name");
initTooltips(); // themed tooltips, shared with the dashboard (parity)

// E3-0 (B1/B2): script start ≈ shell-paint time (the shell is appended
// synchronously below). One number, captured unconditionally — it costs a
// single performance.now() and lets B2 measure from before perf activation.
const perfScriptStart = performance.now();

const send = (m) => chrome.runtime.sendMessage(m);
const app = document.getElementById("app");
let popupFitPending = false;

/** Use ordinary density when it fits, then reclaim only whitespace before any scroll. */
function fitPopupHeight() {
  popupFitPending = false;
  document.body.classList.remove("popup-fit-compact");
  if (app.scrollHeight > app.clientHeight + 1 ||
      document.documentElement.scrollHeight > document.documentElement.clientHeight + 1) {
    document.body.classList.add("popup-fit-compact");
  }
}

function schedulePopupFit() {
  if (popupFitPending) return;
  popupFitPending = true;
  queueMicrotask(fitPopupHeight);
}

/* ---------- message area: confirmation + Undo / Rename ---------- */
const msgArea = el("div", { class: "msg popup-msg", role: "status", "aria-live": "polite" });
let msgTimer = 0;

/** Show a confirmation; any trailing controls (Undo/Rename) auto-clear after 10s. */
function setMsg(text, ...controls) {
  clearTimeout(msgTimer);
  const kids = [text ? el("span", {}, text) : null, ...controls].filter(Boolean);
  msgArea.replaceChildren(...kids);
  if (controls.some(Boolean)) {
    msgTimer = setTimeout(() => msgArea.replaceChildren(text ? el("span", {}, text) : ""), 10_000);
  }
}

/** Journal-backed Undo control (criterion 3). Undoes the exact entry handed back. */
function undoControl(undoId) {
  if (!undoId) return null;
  return el("button", { class: "linkbtn", onclick: async () => {
    await send({ type: "undo-last", id: undoId });
    setMsg(popupStatic.undone());
  } }, popupStatic.undo());
}

/** Rename control for the "Saved: {name}" confirmation (J3). */
function renameControl(id, name) {
  if (!id) return null;
  return el("button", { class: "linkbtn", onclick: () => {
    const input = el("input", { type: "text", value: name, "aria-label": localeMessage("list_session_name") });
    const doRename = async () => {
      const res = await send({ type: "rename-session", id, name: input.value });
      setMsg(res?.name ? popupRenamed(res.name) : popupRenameFailed());
    };
    // Enter validates. Handle it explicitly (preventDefault stops the implicit
    // form submission from firing doRename a second time).
    input.addEventListener("keydown", (e) => {
      if (isComposingKey(e)) return;
      if (e.key === "Enter") { e.preventDefault(); doRename(); }
    });
    const form = el("form", { class: "rename-form", onsubmit: (e) => {
      e.preventDefault();
      doRename();
    } }, input, el("button", { type: "submit", class: "primary" }, popupStatic.save()));
    msgArea.replaceChildren(form);
    input.focus();
    input.select();
  } }, popupStatic.rename());
}

/* ---------- skeleton (synchronous — first paint) ---------- */

const dupHintSlot = el("div", {});   // J6 (P2a-3)
const vaultWarnSlot = el("div", {}); // J5 (P2a-2)
let focusPopupActions = () => {};
const search = createSearchBox({
  placeholder: localeMessage("search_popup_placeholder"),
  historyPlaceholder: localeMessage("search_popup_history_placeholder"),
  enterFallback: true,
  // P11-05/P11-05r: only the named command autofocuses. Once focused, this
  // popup gets the same chips-then-recents state as every other Search host.
  autofocusWhen: consumeSearchPopupMode,
  escapeToList: () => focusPopupActions()
});
const statusStrip = el("div", { class: "statusstrip" }, "…");

// THIS TAB group
const tabFav = el("span", { class: "fav" });
const tabTitle = el("span", { class: "th-title" }, "…");
// F16 (nit): read-only chips showing the labels this page already carries (from
// any saved Inbox/Archive copy of the same URL) — parity with the dashboard's
// open-tab row chips. Hidden while empty.
const tabLabelsSlot = el("div", { class: "tablabels" });
const tabSuspendStatusSlot = el("div", { class: "tab-suspend-status" });
/**
 * D4-3d: one action row. The label lives in its own span so a dynamic relabel
 * (Suspend becomes Wake) cannot wipe the icon, and the key hint is rendered only
 * where the popup actually binds that key.
 * @param {string} iconName @param {string} label @param {string} [key]
 */
function actionRow(iconName, label, key) {
  return el("button", { disabled: "", title: label, "aria-label": label },
    icon(iconName, 15),
    el("span", { class: "lbl" }, label),
    key ? el("span", { class: "k", "aria-hidden": "true" }, key) : null);
}
/** Relabel an action row without touching its icon or key hint. */
function setLabel(btn, text) {
  const lbl = btn.querySelector(".lbl");
  if (lbl) lbl.textContent = text;
  btn.title = text;
  btn.setAttribute("aria-label", text);
}
let popupSessionTabId = null;
let popupSessionWindowId = null;
let tabSessionPending = false;
let windowSessionPending = false;

async function commitPopupSession(scope, value) {
  const isTab = scope === "tab";
  if ((isTab && tabSessionPending) || (!isTab && windowSessionPending)) return false;
  if (isTab) tabSessionPending = true;
  else windowSessionPending = true;
  try {
    setMsg(popupStatic.saving());
    const message = isTab
      ? { type: "save-tabs-session", tabIds: [popupSessionTabId] }
      : { type: "save-window-session", windowId: popupSessionWindowId };
    if (value.isNew) {
      message.name = value.name || undefined;
      message.organization = value.organization;
    }
    else message.sessionId = value.id;
    const result = await send(message);
    if (result?.name) {
      setMsg(popupSavedSession(result.name),
        value.isNew ? renameControl(result.id, result.name) : null);
    } else {
      setMsg(popupStatic.nothingSave());
    }
    return Boolean(result?.id);
  } finally {
    if (isTab) tabSessionPending = false;
    else windowSessionPending = false;
  }
}
const dumpTabBtn = actionRow("inbox", popupStatic.saveTabInbox(), "I");
const snoozeBtn = actionRow("snooze", popupStatic.snooze(), "S");
const suspendBtn = actionRow("suspend", popupStatic.suspend(), "Z");
suspendBtn.classList.add("head-utility");
const keepAwakeBtn = actionRow("shield", popupStatic.keepAwake(), "P");
keepAwakeBtn.classList.add("head-utility");
// F16: quick-label — save a labeled copy to Archive and keep the tab open.
const labelTabBtn = actionRow("labels", popupStatic.label(), "L");
const tabSessionBtn = sessionComboboxButton(localeMessage("popup_save_in_session"), {
  iconName: "sessions",
  title: localeMessage("list_save_tab_session_title"),
  onOpen: () => closePanelsExcept(),
  onPick: (value) => commitPopupSession("tab", value)
});
tabSessionBtn.setAttribute("data-shortcut-key", "t");
tabSessionBtn.setAttribute("aria-keyshortcuts", "T");
tabSessionBtn.append(el("span", { class: "k", "aria-hidden": "true" }, "T"));
tabSessionBtn.disabled = true;
// P11-12: Star is state on the named current page, so it lives with the page
// identity rather than consuming a fifth workflow row.
const starTabBtn = el("button", {
  class: "tab-star", type: "button", disabled: "",
  title: popupStatic.starTab(), "aria-label": popupStatic.starTab(), "aria-pressed": "false"
}, icon("star", 15));
const tabUtilities = el("span", { class: "head-utilities" }, suspendBtn, keepAwakeBtn, starTabBtn);
const tabReason = el("div", { class: "reason" });
const tabActions = el("div", { class: "actgrid tab-actions" },
  dumpTabBtn, tabSessionBtn, snoozeBtn, labelTabBtn);
const snoozePanelTab = el("div", { class: "panel snooze-panel" });
const snoozePopoverTab = createAnchoredPanel(snoozePanelTab);
const keepAwakePanelTab = el("div", { class: "panel keep-awake-panel" });
const keepAwakePopoverTab = createAnchoredPanel(keepAwakePanelTab);
const labelPanelTab = el("div", { class: "panel label-panel" });
labelPanelTab.style.display = "none";
// F16: the label confirmation belongs under THIS TAB, not the shared msg area
// (which sits below This window). Hidden while empty.
const labelMsg = el("div", { class: "msg tabmsg", role: "status", "aria-live": "polite" });

// THIS WINDOW group — parallel to THIS TAB (same order/labels/styles)
const dumpWinBtn = actionRow("inbox", popupStatic.saveWindowInbox());
dumpWinBtn.classList.add("window-save");
const winSnoozeBtn = actionRow("snooze", popupStatic.snooze());
const suspendOthersBtn = actionRow("suspend", popupStatic.suspendOthers());
suspendOthersBtn.classList.add("head-utility");
const protectWindowBtn = actionRow("shield", popupStatic.keepAwake());
protectWindowBtn.classList.add("head-utility");
const saveBtn = sessionComboboxButton(popupStatic.saveSession(), {
  iconName: "sessions",
  title: localeMessage("list_save_window_session_title"),
  onOpen: () => closePanelsExcept(),
  onPick: (value) => commitPopupSession("window", value)
});
saveBtn.disabled = true;
// F13: one-shot sort of the current window (same three orders as the dashboard).
const sortWinBtn = actionRow("organize", popupStatic.sort());
// F19: copy this window's web pages to the clipboard as a Markdown link list.
const copyWinBtn = el("button", { class: "group-utility", type: "button", disabled: "" },
  icon("copy", 14), el("span", { class: "lbl" }, popupStatic.copyLinks()));
const windowUtilities = el("span", { class: "head-utilities" }, suspendOthersBtn, protectWindowBtn, copyWinBtn);
const winReason = el("div", { class: "reason" });
const snoozePanelWin = el("div", { class: "panel snooze-panel" });
const snoozePopoverWin = createAnchoredPanel(snoozePanelWin);
const protectionPanelWin = el("div", { class: "panel keep-awake-panel" });
const protectionPopoverWin = createAnchoredPanel(protectionPanelWin);
const sortPanelWin = el("div", { class: "panel snooze-panel" });
const sortPopoverWin = createAnchoredPanel(sortPanelWin);

// F8-R2: site-only Focus group — filled in hydrate from the guard status + rules.
// Never resembles or imports the retired Workspace Focus; renders + messages only.
const focusSlot = el("div", {});
const focusAccessPanel = createFocusAccessPanel({
  className: "popup-focus-access",
  onNotice: (text) => setMsg(text),
  onEmptied: () => focusSlot.querySelector(".focus-end, .focus-start, button, select")?.focus()
});

const dupCloseSlot = el("div", {}); // J5 bulk "Close N duplicates"

app.append(
  el("h1", { class: "sr-only" }, localeMessage("manifest_name")),
  // P11-12: Search is the stable entry point. Contextual warnings follow it so
  // their variable presence never moves the command field.
  search,
  dupHintSlot,
  vaultWarnSlot,
  statusStrip,
  // Two parallel group cards: same order (Dump · Snooze… · Suspend[/others]),
  // same button styles; each group's snooze panel anchors under its own buttons.
  // D4-3d: flat sections. The object being acted on reads as an object, and its
  // core actions are full-width rows rather than a grid of boxes.
  el("div", { class: "group" },
    el("div", { class: "tabhead" },
      el("h2", { class: "group-head" }, popupStatic.thisTab()), tabFav, tabTitle, tabUtilities),
    tabLabelsSlot,
    tabSuspendStatusSlot,
    tabActions,
    snoozePanelTab,
    keepAwakePanelTab,
    labelPanelTab,
    labelMsg,
    tabReason),
  el("div", { class: "group" },
    el("div", { class: "group-title-row" },
      el("h2", { class: "group-head" }, popupStatic.thisWindow()), windowUtilities),
    // Both objects use the same two-by-two action matrix. Secondary state
    // controls live beside the object title instead of creating odd-sized rows.
    el("div", { class: "actgrid" },
      dumpWinBtn, saveBtn, winSnoozeBtn, sortWinBtn),
    snoozePanelWin,
    protectionPanelWin,
    sortPanelWin,
    winReason),
  // Confirmations (Saved/Undo/Rename, snooze/suspend results) sit directly under
  // the two action groups so they're visible without scrolling past Focus below.
  msgArea,
  focusSlot,
  dupCloseSlot,
  el("div", { class: "linkrow" },
    // F14: open the global side panel for THIS window (needs the popup click's
    // user gesture). On rejection the popup stays open and says so — no silent fail.
    el("button", { class: "quiet", onclick: async () => {
      try {
        const win = await chrome.windows.getCurrent();
        await chrome.sidePanel.open({ windowId: win.id });
        window.close();
      } catch {
        setMsg(popupStatic.sidePanelFailed());
      }
    } }, popupStatic.sidePanel()),
    el("button", { class: "quiet", onclick: () => openDashboard() }, popupStatic.dashboard()),
    el("button", { class: "quiet", onclick: () => chrome.runtime.openOptionsPage() }, popupStatic.settings()))
);
const popupArrowNavigation = createSpatialArrowNavigator({
  root: document,
  candidateSelector: ".group button:not([disabled]), .linkrow button:not([disabled])"
});
focusPopupActions = () => popupArrowNavigation.focusEntry({ preferLast: true });
// P2b-4/P11-05: an ordinary toolbar click still does not autofocus Search, so
// the action rows remain immediately usable. The one explicit exception is the
// named keyboard command, whose one-shot initialState is owned by searchbox.js.
const searchInput = search.querySelector("input");
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type !== "focus-popup-search") return;
  searchInput?.focus({ preventScroll: true });
  respond({ focused: document.activeElement === searchInput });
  return true;
});
/* The current-tab actions carry the same single keys the dashboard
 * binds on a focused row, so the hint beside each one is the real binding and
 * the muscle memory transfers. A disabled action is skipped rather than
 * silently swallowing the key, and typing always wins. */
const TAB_KEYS = {
  i: () => dumpTabBtn,
  t: () => tabSessionBtn,
  s: () => snoozeBtn,
  z: () => suspendBtn,
  l: () => labelTabBtn,
  p: () => keepAwakeBtn
};
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || eventOwnsTextEntry(e, document.activeElement)) return;
  if (e.key === "/") {
    e.preventDefault();
    searchInput?.focus();
    return;
  }
  const btn = TAB_KEYS[e.key?.toLowerCase()]?.();
  if (!btn || btn.disabled) return;
  e.preventDefault();
  btn.click();
});

/* ---------- F8-R2: site-only Focus group ---------- */

const sendGuard = async (m) => {
  try { return await chrome.runtime.sendMessage(m); } catch { return { ok: false, reason: "unavailable" }; }
};
const fmtClock = (at) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Refresh the run status and (re)build the group. */
async function readFocusSnapshot() {
  const res = await sendGuard({ type: "focus-guard-status" });
  const status = res?.status ?? { active: false, guardedCount: 0, duringCount: 0, alwaysCount: 0 };
  const access = Array.isArray(status.accesses)
    ? { accesses: status.accesses }
    : await getFocusAccessStatus();
  return { status, accesses: access.accesses };
}

async function refreshFocus(settings, prefetched = null) {
  const snapshot = prefetched ?? await readFocusSnapshot();
  focusAccessPanel.render(snapshot.accesses);
  renderSiteFocus(settings, snapshot.status);
}

/**
 * Build the site-only Focus group. Inactive: site counts + duration choices + Start
 * focus / Focus settings (or, with no During Focus rule, a calm setup line). Active:
 * Focus is on + remaining time + N sites guarded + End focus. Render + message only.
 * @param {import("../lib/types.js").Settings} settings @param {object} status
 */
function renderSiteFocus(settings, status) {
  const group = el("div", { class: "group focus-group" });
  const heading = el("h2", { class: "group-head" }, popupStatic.focus());
  const openSettings = () => openDashboard("settings-focus");

  if (status.active) {
    const remaining = status.endsAt != null
      ? formatRemaining(status.endsAt, Date.now())
      : localeMessage("focus_until_end");
    const guarded = popupGuardedSites(status.guardedCount);
    // D4-3d: Focus is a status, not a third card competing for the accent. The
    // popup keeps exactly one accent primary (J1's Save window to Inbox).
    const summary = popupFocusSummary(remaining, guarded);
    group.append(
      el("div", { class: "group-title-row focus-title-row" }, heading,
        el("span", { class: "focus-inline-status on", title: summary }, summary),
        el("button", { class: "focus-end", onclick: (e) => withPending(e.currentTarget, async () => {
          const res = await sendGuard({ type: "focus-guard-end" });
          if (res?.ok) window.close(); else setMsg(popupStatic.focusEndFailed());
        }) }, popupStatic.endFocus())),
      focusAccessPanel.element
    );
    focusSlot.replaceChildren(group);
    return;
  }

  // Inactive.
  const { during } = siteRuleCounts(settings.focusSiteRules ?? []);
  const summary = blockedSitesSummary(settings.focusSiteRules ?? []);

  if (during === 0) {
    // No During Focus rule: starting a run is not useful — offer setup, not a dead button.
    group.append(
      el("div", { class: "group-title-row focus-title-row" }, heading,
        el("span", { class: "focus-inline-status" }, popupStatic.notSetUp())),
      el("div", { class: "actions-row" },
        el("button", { class: "focus-start", onclick: openSettings },
          icon("settings", 15), el("span", { class: "lbl" }, popupStatic.setUpFocus()))),
      focusAccessPanel.element);
    focusSlot.replaceChildren(group);
    return;
  }

  const now = Date.now();
  const morning = nextWallClockInfo(now, Number(settings.focusMorningEndMinutes) || 0);
  const day = nextWallClockInfo(now, Number(settings.focusDayEndMinutes) || 0);
  // C8: a saved "duration" default other than 60 must be shown and sent as its real value,
  // not silently replaced with one hour. 60 keeps the natural "1 hour" copy.
  const durInfo = focusPopupDurationInfo(settings);
  const savedMinutes = durInfo.minutes;
  const savedIsCustomDuration = durInfo.customDefault;
  const durationSelect = el("select", { class: "focus-duration", "aria-label": popupStatic.focusDuration() },
    ...(savedIsCustomDuration ? [el("option", { value: "default" }, popupDefaultDuration(durInfo.label))] : []),
    el("option", { value: "1h" }, popupStatic.oneHour()),
    el("option", { value: "morning-end" }, morning.isTomorrow ? popupUntilTomorrow(fmtClock(morning.at)) : popupUntilTime(fmtClock(morning.at))),
    el("option", { value: "day-end" }, day.isTomorrow ? popupUntilTomorrow(fmtClock(day.at)) : popupUntilTime(fmtClock(day.at))),
    el("option", { value: "manual" }, popupStatic.untilEnd()),
    el("option", { value: "custom" }, popupStatic.custom()));
  durationSelect.value =
    settings.focusDefaultEndMode === "morning-end" ? "morning-end"
      : settings.focusDefaultEndMode === "day-end" ? "day-end"
        : settings.focusDefaultEndMode === "manual" ? "manual"
          : savedIsCustomDuration ? "default" : "1h";

  // Anchored inline custom-time panel (no modal). Escape restores the prior choice.
  const customStatus = el("div", { class: "focus-custom-status", role: "alert", "aria-live": "assertive" });
  const customInput = el("input", { type: "datetime-local", "aria-label": popupStatic.customEndTime() });
  const customPanel = el("div", { class: "panel focus-custom-panel" }, customInput, customStatus);
  customPanel.style.display = "none";
  let prevChoice = durationSelect.value;
  durationSelect.addEventListener("change", () => {
    const isCustom = durationSelect.value === "custom";
    customPanel.style.display = isCustom ? "block" : "none";
    customStatus.textContent = "";
    if (isCustom) customInput.focus(); else prevChoice = durationSelect.value;
  });
  customInput.addEventListener("keydown", (e) => {
    if (isComposingKey(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      durationSelect.value = prevChoice; customPanel.style.display = "none";
      customStatus.textContent = ""; durationSelect.focus();
    }
  });

  const endChoiceOf = () => {
    const v = durationSelect.value;
    if (v === "default") return { mode: "duration", durationMinutes: savedMinutes }; // C8: exact saved value
    if (v === "1h") return { mode: "duration", durationMinutes: 60 };
    if (v === "morning-end") return { mode: "morning-end" };
    if (v === "day-end") return { mode: "day-end" };
    if (v === "manual") return { mode: "manual" };
    if (v === "custom") {
      const t = new Date(customInput.value).getTime();
      if (!Number.isFinite(t) || t <= Date.now()) return null;
      return { mode: "custom", customAt: t };
    }
    return { mode: "duration", durationMinutes: savedMinutes };
  };

  group.append(
    el("div", { class: "group-title-row focus-title-row" }, heading,
      el("span", { class: "focus-inline-status", title: summary }, summary),
      el("button", { class: "group-utility", onclick: openSettings },
        icon("settings", 14), el("span", { class: "lbl" }, popupStatic.settings()))),
    el("div", { class: "focus-start-row" }, durationSelect,
      el("button", { class: "focus-start", onclick: (e) => {
        const choice = endChoiceOf();
        if (choice === null) { customStatus.textContent = popupStatic.futureTime(); customInput.focus(); return; }
        return withPending(e.currentTarget, async () => {
          const res = await sendGuard({ type: "focus-guard-start", endChoice: choice });
          if (res?.ok) window.close(); else setMsg(res?.reason === "no-during-rules" ? popupStatic.focusRulesMissing() : popupStatic.focusStartFailed());
        });
      } }, popupStatic.startFocus())),
    customPanel,
    focusAccessPanel.element
  );
  focusSlot.replaceChildren(group);
}

/* ---------- hydrate (async — no layout shift) ---------- */

function favEl(favUrl, url = "") {
  const source = faviconSource({ favIconUrl: favUrl, url });
  return source
    ? el("img", { class: "fav", src: source, alt: "",
        onerror: (e) => e.currentTarget.replaceWith(el("span", { class: "fav" })) })
    : el("span", { class: "fav" });
}

function setFav(target, favUrl, url) {
  if (faviconSource({ favIconUrl: favUrl, url })) {
    const img = favEl(favUrl, url);
    target.replaceWith(img);
    return img;
  }
  return target;
}

/**
 * Duplicate-tab hint (J6 / P2a-3): if the active tab is already open elsewhere,
 * pin a hint offering to switch to the existing copy. http-only until S1 gives
 * suspended tabs their underlying-URL equivalence. Recomputed on every popup
 * open, so it auto-clears once the duplicate is resolved.
 */
function renderDupHint(active, allTabs, groups, duplicateRules) {
  if (!active || !isHttpTab(active)) return;
  const key = duplicateUrlKey(urlOf(active), duplicateRules);
  if (!key) return;
  // Only surface the hint when this duplication is also what the badge counts,
  // so the badge and the popup's top row always agree (criterion 4).
  if (!groups.some((g) => g.key === key)) return;
  const twins = allTabs.filter(
    (t) => t.id !== active.id && isHttpTab(t) &&
      duplicateUrlKey(urlOf(t), duplicateRules) === key
  );
  if (twins.length === 0) return;
  const existing = twins.reduce((a, b) => (a.id < b.id ? a : b)); // oldest open copy
  const where = popupDuplicateWhere(existing.windowId === active.windowId);

  dupHintSlot.replaceChildren(
    el("div", { class: "banner" },
      favEl(existing.favIconUrl, urlOf(existing)),
      el("div", { class: "banner-body" },
        el("div", { class: "btext" }, popupDuplicateHint(where))),
      el("button", { class: "primary", onclick: () => {
        send({ type: "switch-to-existing", tabId: existing.id,
          windowId: existing.windowId, closeTabId: active.id });
        window.close();
      } }, popupStatic.switch()),
      el("button", { class: "x", "aria-label": popupStatic.dismiss(), onclick: () => dupHintSlot.replaceChildren() }, "×"))
  );
}

async function hydrate() {
  const [settings, activeTabs, winTabs, allTabs, inbox, snoozes, duplicateRules] = await Promise.all([
    getSettings(),
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.tabs.query({ currentWindow: true }),
    chrome.tabs.query({}),
    listItems(STORE_KEYS.inbox),
    listItems(STORE_KEYS.snoozes),
    readDuplicateDomainRules()
  ]);
  activateFromSettings(settings); // E3-0: hidden perfHud → instrument this fill
  const [active] = activeTabs;
  const winCount = new Set(allTabs.map((t) => t.windowId)).size;
  const suspendedRef = active ? ownSuspendedRef(active) : null;
  const activeCapture = active ? saveableTabRef(active) : null;
  const starredRef = activeCapture;
  const groups = findDuplicateGroupsFromTabs(allTabs, duplicateRules);
  const [initialStarred, initialLabels, initialSuspendExemptions, focusSnapshot, vaultSnapshot] = await Promise.all([
    starredRef ? isStarredUrl(starredRef.url) : false,
    activeCapture ? computeTabLabels(active, { inbox }) : [],
    activeCapture ? readProtectionStatus(active.id) : { kind: "none", protected: false },
    readFocusSnapshot(),
    readVaultWarning()
  ]);
  let keepAwakeStatus = initialSuspendExemptions;

  /* --- publish one useful popup state after the independent reads settle --- */
  const endToday = new Date();
  endToday.setHours(23, 59, 59, 999);
  const dueToday = snoozes.filter((s) => s.dueAt <= endToday.getTime()).length;

  const strip = [
    el("span", {}, popupStatusSummary(allTabs.length, winCount))
  ];
  if (inbox.length > 0) {
    strip.push(el("span", { class: "sep" }, "·"),
      el("a", { role: "button", tabindex: "0", onclick: () => openDashboard("inbox"),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") openDashboard("inbox"); } },
        popupInboxCount(inbox.length)));
  }
  if (dueToday > 0) {
    strip.push(el("span", { class: "sep" }, "·"),
      el("a", { role: "button", tabindex: "0", onclick: () => openDashboard("snoozed"),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") openDashboard("snoozed"); } },
        popupDueToday(dueToday)));
  }
  statusStrip.replaceChildren(...strip);

  /* --- THIS TAB (J2) --- */
  tabTitle.textContent =
    suspendedRef?.title || active?.title || active?.url || popupStatic.noActiveTab();
  setFav(tabFav, suspendedRef?.favIconUrl ?? active?.favIconUrl, suspendedRef?.url ?? (active ? urlOf(active) : ""));

  if (active && activeCapture) {
    tabActions.hidden = false;
    // A suspended tab acts on its underlying page: dump-tab / snooze-tab
    // canonicalize in the worker (S1), so Dump/Snooze are enabled here too.
    dumpTabBtn.disabled = false;
    snoozeBtn.disabled = false;
    dumpTabBtn.onclick = async () => {
      const res = await send({ type: "dump-tab", tabId: active.id });
      setMsg(res?.n > 0 ? popupStatic.savedInbox() : popupStatic.nothingSave(), undoControl(res?.undoId));
    };
    snoozeBtn.onclick = (event) => {
      labelPanelTab.style.display = "none";
      snoozePopoverTab.anchor(event.currentTarget);
      snoozePopoverTab.toggle(() => buildSnoozePanel(
        { type: "tab", id: active.id }, snoozePopoverTab), "snooze");
    };
    // F16: quick-label. Same gate as Save → Inbox (a suspended tab canonicalizes
    // to its real page), so the labeled copy works here too. Labeling keeps the
    // tab OPEN — it saves a labeled copy to the Archive (parity with the
    // dashboard's card-level Label), never closes the tab.
    labelTabBtn.disabled = false;
    popupSessionTabId = active.id;
    tabSessionBtn.disabled = false;
    labelTabBtn.onclick = () => toggleLabel(labelPanelTab, active, activeCapture);
    let starred = initialStarred;
    const paintStar = () => {
      const action = starred ? popupStatic.unstarTab() : popupStatic.starTab();
      starTabBtn.title = action;
      starTabBtn.setAttribute("aria-label", action);
      starTabBtn.classList.toggle("is-starred", starred);
      starTabBtn.setAttribute("aria-pressed", String(starred));
    };
    starTabBtn.disabled = false;
    paintStar();
    starTabBtn.onclick = async () => {
      starTabBtn.disabled = true;
      const changed = starred
        ? await unstarUrl(starredRef.url)
        : await starTab(starredRef);
      if (changed) starred = !starred;
      else starred = await isStarredUrl(starredRef.url);
      paintStar();
      starTabBtn.disabled = false;
      const undoId = changed ? (await listActions())[0]?.id : null;
      setMsg(starred ? popupStatic.starred() : popupStatic.unstarred(), undoControl(undoId));
    };
    renderTabLabels(initialLabels); // show any labels this page already carries
    suspendBtn.disabled = false;
    keepAwakeBtn.disabled = false;
    renderKeepAwakeStatus(keepAwakeStatus);
    keepAwakeBtn.onclick = (event) => {
      labelPanelTab.style.display = "none";
      keepAwakePopoverTab.anchor(event.currentTarget);
      keepAwakePopoverTab.toggle(() => buildProtectionPanel(active.id, {
        close: (options) => keepAwakePopoverTab.close(options),
        openSettings: suspensionSettings,
        onChanged: (next) => {
          keepAwakeStatus = next;
          renderKeepAwakeStatus(next);
        }
      }), "protection");
    };
    if (suspendedRef) {
      // The memory action on a suspended tab is Wake, not Suspend.
      setLabel(suspendBtn, popupStatic.wakeTab());
      suspendBtn.onclick = () => { send({ type: "wake-tab", tabId: active.id }); window.close(); };
    } else {
      suspendBtn.onclick = () => {
        // navigation destroys the popup; fire-and-forget, close cleanly.
        send({ type: "suspend-tab", tabId: active.id });
        window.close();
      };
    }
  } else {
    tabActions.hidden = true;
    tabSuspendStatusSlot.replaceChildren();
    tabReason.textContent = active?.incognito
      ? popupStatic.privateTab()
      : popupStatic.unsupportedPage();
  }

  /* --- THIS WINDOW (J1/J3/J7) --- */
  const dumpable = winTabs.filter((t) => !t.pinned && isSaveableTab(t));
  const saveable = winTabs.filter(isSaveableTab);
  const suspendableOthers = winTabs.filter((t) => !isSuspendExempt(t));

  if (dumpable.length > 0) {
    dumpWinBtn.disabled = false;
    dumpWinBtn.onclick = async () => {
      const res = await send({ type: "dump-window", windowId: active?.windowId });
      setMsg(res?.n > 0 ? popupSavedTabs(res.n) : popupStatic.nothingSave(),
        undoControl(res?.undoId));
    };
  } else {
    winReason.textContent = saveable.length === 0
      ? popupStatic.noPagesWindow()
      : popupStatic.pinnedOnly();
  }

  if (saveable.length > 0) {
    popupSessionWindowId = active?.windowId;
    saveBtn.disabled = false;
    // P2b-1: snooze the whole window — reuses the same preset/recurrence panel.
    winSnoozeBtn.disabled = false;
    protectWindowBtn.disabled = false;
    protectWindowBtn.onclick = (event) => {
      labelPanelTab.style.display = "none";
      protectionPopoverWin.anchor(event.currentTarget);
      protectionPopoverWin.toggle(() => buildProtectionPanel({ windowId: active.windowId }, {
        close: (options) => protectionPopoverWin.close(options),
        openSettings: suspensionSettings,
        onChanged: async () => {
          if (!activeCapture) return;
          keepAwakeStatus = await readProtectionStatus(active.id);
          renderKeepAwakeStatus(keepAwakeStatus);
        }
      }), "protection");
    };
    winSnoozeBtn.onclick = (event) => {
      labelPanelTab.style.display = "none";
      snoozePopoverWin.anchor(event.currentTarget);
      snoozePopoverWin.toggle(() => buildSnoozePanel(
        { type: "window", id: active?.windowId }, snoozePopoverWin), "snooze");
    };
  }

  // F13: sort is available whenever there are ≥2 non-pinned tabs to reorder
  // (pinned tabs stay put, chrome:// tabs still reorder). Gather stays dashboard-only.
  if (winTabs.filter((t) => !t.pinned).length >= 2) {
    sortWinBtn.disabled = false;
    sortWinBtn.onclick = (event) => {
      labelPanelTab.style.display = "none";
      sortPopoverWin.anchor(event.currentTarget);
      sortPopoverWin.toggle(() => buildSortPanel(active?.windowId, sortPopoverWin), "organize");
    };
  }

  // F19: copy the window's web pages as a Markdown link list (read-only; a
  // suspended tab is copied under its real page, incognito is excluded).
  if (saveable.length > 0) {
    copyWinBtn.disabled = false;
    copyWinBtn.onclick = async () => {
      const refs = winTabs.filter(isSaveableTab).map(canonicalRef).filter(Boolean);
      const md = linksToMarkdown(refs);
      if (!md) { setMsg(popupStatic.nothingCopy()); return; }
      try {
        await navigator.clipboard.writeText(md);
        setMsg(popupCopiedLinks(refs.length));
      } catch {
        setMsg(popupStatic.copyFailed());
      }
    };
  }

  if (suspendableOthers.length > 0) {
    suspendOthersBtn.disabled = false;
    suspendOthersBtn.onclick = async () => {
      const res = await send({ type: "suspend-others", windowId: active?.windowId });
      setMsg(popupSuspendedTabs(res?.n ?? 0));
    };
  }

  /* --- F8-R2: site-only Focus group --- */
  await refreshFocus(settings, focusSnapshot);

  /* --- dup hint (J6) + bulk "Close N duplicates" (J5) --- */
  const dupCount = groups.reduce((n, g) => n + g.close.length, 0);
  renderDupHint(active, allTabs, groups, duplicateRules);
  if (dupCount > 0) {
    dupCloseSlot.replaceChildren(
      el("div", { class: "group duplicates-group" },
        el("div", { class: "group-title-row" },
          el("h2", { class: "group-head" }, popupStatic.duplicates()),
          el("button", { class: "group-utility", onclick: () => openDashboard("duplicates") },
            icon("duplicates", 14), el("span", { class: "lbl" }, popupStatic.seeDuplicates()))),
        el("div", { class: "actions-row" },
          el("button", { class: "primary duplicate-close", onclick: async () => {
            const res = await send({ type: "close-duplicates" });
            setMsg(popupClosedDuplicates(res?.n ?? 0));
            dupCloseSlot.replaceChildren();
          } }, popupCloseDuplicates(dupCount))))
    );
  }
  renderVaultWarning(vaultSnapshot);

  // E3-0 (B2): script start → fully filled + interactive.
  if (perfActive()) {
    precord("popup:fill(B2)", performance.now() - perfScriptStart, "script start → hydrate settled");
    preport();
  }
}

/**
 * Vault-warn row (J5 / P2a-2) — parity with the dashboard banner. Shows only
 * when sync is failing (same warn conditions as the dashboard's vaultPillState:
 * needs-permission, error, or connected-but-last-sync-not-ok). Click → the
 * dashboard vault panel. Runs independently so it never delays first paint.
 */
async function readVaultWarning() {
  let status;
  try { status = await getVaultStatus(); } catch { return null; }
  const meta = await getVaultSyncMeta();
  const warn =
    status.state === "needs-permission" ||
    status.state === "error" ||
    (status.state === "connected" && meta && !meta.ok);
  if (!warn) return null;
  const text =
    status.state === "needs-permission" ? popupStatic.vaultReconnect()
      : status.state === "error" ? popupStatic.vaultError()
        : popupStatic.vaultIncomplete();
  return text;
}

function renderVaultWarning(text) {
  if (!text) { vaultWarnSlot.replaceChildren(); return; }
  vaultWarnSlot.replaceChildren(
    el("div", { class: "banner warn" },
      el("span", { class: "btext" }, text),
      el("button", { onclick: () => openDashboard("vault") }, popupStatic.review()))
  );
}

// Every anchored inline panel in the popup is mutually exclusive — opening one
// closes the rest (interaction-model P3: at most one panel open at a time).
const INLINE_PANELS = [labelPanelTab];

function closePanelsExcept(panel = null) {
  dismissAnchoredPanel();
  for (const candidate of INLINE_PANELS) {
    if (candidate !== panel) candidate.style.display = "none";
  }
}

/** F16: toggle the quick-label panel; opening it closes any open snooze/sort panel. */
function toggleLabel(panel, tab, ref) {
  const open = panel.style.display !== "none";
  closePanelsExcept(panel);
  if (open) { panel.style.display = "none"; return; }
  labelMsg.textContent = ""; // clear any prior confirmation as we reopen
  // A display:none descendant cannot become the active element. Reveal the
  // panel before buildLabelPanel gives the text field immediate focus.
  panel.style.display = "block";
  buildLabelPanel(panel, tab, ref);
}

/**
 * F16 — the quick-label panel: a label combobox + Save labeled copy. Applying
 * saves a labeled copy of the tab to the Archive and LEAVES THE TAB OPEN (parity
 * with the dashboard's card-level Label — the label lives on the saved copy).
 * The popup stays open; the tab's shown labels refresh to include the new ones.
 * @param {HTMLElement} panel @param {chrome.tabs.Tab} tab
 * @param {import("../lib/types.js").TabRef|null} ref
 */
function buildLabelPanel(panel, tab, ref) {
  let savePending = false;
  let tags;
  const organizer = createInlineOrganizationEditor({ kind: "label", onSubmit: () => saveButton.click() });
  const syncOrganizer = async () => {
    if (!tags) return;
    const labels = tags.getLabels();
    await organizer.setMembers(labels.map((name) => ({ key: name, name })));
  };
  const finish = async (entries, organizationPlan = null) => {
    const labels = entries.map((entry) => entry.name);
    await saveLabeledCopies([ref], labels);
    if (organizationPlan) {
      const grouped = await applyOrganizationMemberPlan("label", organizationPlan);
      if (grouped?.ok === false) reportFailure("Label group assignment");
    }
    labelMsg.textContent = popupLabeledWith(labels);
    panel.style.display = "none";
    await refreshTabLabels(tab);
  };
  const save = async () => {
    if (savePending) return;
    savePending = true;
    saveButton.disabled = true;
    let entries;
    try {
      entries = await tags.getEntries();
    } catch (error) {
      reportFailure("Label choices read", error, console.error);
      labelMsg.textContent = localeMessage("list_save_failed");
      savePending = false;
      saveButton.disabled = false;
      return;
    }
    const labels = entries.map((entry) => entry.name);
    // Confirmations/nudges go to labelMsg (under This tab), not the shared msg
    // area below This window.
    if (labels.length === 0) {
      labelMsg.textContent = popupStatic.typeLabelFirst();
      savePending = false;
      saveButton.disabled = false;
      return;
    }
    if (!ref) {
      labelMsg.textContent = popupStatic.cannotLabel();
      panel.style.display = "none";
      return;
    }
    try {
      await organizer.setMembers(entries.map((entry) => ({
        key: entry.name, name: entry.name, isNew: entry.isNew
      })));
      await finish(entries, await organizer.getPlan());
    } catch (error) {
      reportFailure("Label save", error, console.error);
      labelMsg.textContent = localeMessage("list_save_failed");
      savePending = false;
      saveButton.disabled = false;
    }
  };
  // N13: Enter on the emptied input applies (type a label → Enter → Enter).
  // N22: a second Esc (or Esc with the dropdown closed) backs out to the button.
  tags = createLabelInput({
    placeholder: popupStatic.labelsPlaceholder(),
    onSubmit: save,
    onCancel: () => { panel.style.display = "none"; labelTabBtn.focus(); },
    onChange: () => { void syncOrganizer(); }
  });
  const saveButton = el("button", { class: "primary label-save", onclick: save }, popupStatic.saveLabeledCopy());
  const baseNodes = [
    tags.element,
    organizer.element,
    saveButton,
    el("div", { class: "reason" }, popupStatic.labelExplanation())
  ];
  panel.replaceChildren(...baseNodes);
  // Focus the input so the user can type immediately.
  tags.element.querySelector(".taginput")?.focus({ preventScroll: true });
}

/**
 * Render the tab-label chips (hidden when the page has none). Each chip is
 * clickable → opens the dashboard Labels page on that label's card (deep link
 * `#label:<name>`), then closes the popup.
 */
function renderTabLabels(labels) {
  if (!labels.length) { tabLabelsSlot.replaceChildren(); return; }
  const visible = labels.slice(0, 2);
  const hidden = labels.length - visible.length;
  const children = [
    el("span", { class: "tl-lead" }, popupStatic.labels() + ":"),
    ...visible.map((l) => el("button", {
      class: "chip labelchip", type: "button", title: popupOpenLabel(l),
      onclick: () => { openDashboard("label:" + encodeURIComponent(l)); window.close(); }
    }, l)),
    hidden > 0 ? el("button", {
      class: "tablabels-more", type: "button",
      title: popupMoreLabelsTitle(hidden),
      "aria-label": popupOpenAllLabels(hidden),
      onclick: () => { openDashboard("labels"); window.close(); }
    }, `+${hidden}`) : null
  ].filter(Boolean);
  tabLabelsSlot.replaceChildren(...children);
}

async function refreshTabLabels(tab) {
  renderTabLabels(await computeTabLabels(tab));
}

/** Build the three-order sort panel; each order messages sort-window in the worker. */
function buildSortPanel(windowId, controller) {
  const doSort = async (mode) => {
    const res = await send({ type: "sort-window", windowId, mode });
    setMsg(res?.ok
      ? (res.moved > 0 ? popupSortedBy(listSortLabel(mode).toLocaleLowerCase()) : popupStatic.alreadySorted())
      : popupStatic.cannotSort());
    controller.close();
  };
  return el("div", { class: "organizebar palette-form" },
    buildSortChoices(doSort),
    el("p", { class: "palette-help organize-hint" }, popupStatic.pinnedStay()));
}

/**
 * Build a preset/recurrence snooze panel into `panel` for `target`
 * ({type:"tab", id} | {type:"window", id}). Sends snooze-tab or snooze-window.
 */
function buildSnoozePanel(target, controller) {
  const isWindow = target.type === "window";
  return buildSharedSnoozePanel(async (dueAt, recurrence) => {
    const res = await send(isWindow
      ? { type: "snooze-window", windowId: target.id, dueAt, ...(recurrence ? { recurrence } : {}) }
      : { type: "snooze-tab", tabId: target.id, dueAt, ...(recurrence ? { recurrence } : {}) });
    const when = new Date(dueAt).toLocaleString();
    setMsg(
      res?.ok
        ? popupSnoozedUntil(isWindow, when)
        : (isWindow ? popupStatic.cannotSnoozeWindow() : popupStatic.cannotSnoozeTab()),
      undoControl(res?.undoId)
    );
    controller.close();
  });
}

function suspensionSettings() {
  openDashboard("settings:protection");
  window.close();
}

function keepAwakeStatusText(status) {
  return protectionStatusText(status);
}

/** Persistently show the current page exception each time the popup opens. */
function renderKeepAwakeStatus(status) {
  const text = keepAwakeStatusText(status);
  const active = Boolean(text);
  keepAwakeBtn.classList.toggle("is-active", status?.protected === true);
  setLabel(keepAwakeBtn, active ? text : popupStatic.keepAwake());
  if (!active) {
    tabSuspendStatusSlot.replaceChildren();
    return;
  }
  tabSuspendStatusSlot.replaceChildren(...[
    status?.protected ? icon("shield", 13) : null,
    el("span", { class: "tab-suspend-status-text", title: text }, text),
    el("button", { type: "button", class: "tab-suspend-manage", onclick: suspensionSettings },
      popupStatic.manageSuspension())
  ].filter(Boolean));
}


new MutationObserver(schedulePopupFit).observe(app, {
  childList: true, subtree: true, characterData: true,
  attributes: true, attributeFilter: ["class", "hidden", "style"]
});

hydrate().finally(() => {
  document.body.classList.add("popup-ready");
  schedulePopupFit();
});

// A notification action or another EveryTab surface can move this boundary while the
// popup is open. Refresh only the small access band; it never rebuilds the action groups.
chrome.storage.onChanged.addListener((changes, area) => {
  changes = expandStorageChanges(changes);
  if (area === "local" && changes.focusTemporaryAccess) focusAccessPanel.refresh();
});
