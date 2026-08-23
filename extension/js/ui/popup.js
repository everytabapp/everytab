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
import { openDashboard } from "../lib/actions.js";
import { findDuplicateGroupsFromTabs, normalizeUrl } from "../lib/dedup.js";
import { getSettings, listItems } from "../lib/store.js";
import { tabLabels, saveLabeledCopies } from "../lib/labels.js";
import { STORE_KEYS } from "../lib/types.js";
import { isStarredUrl, starTab, unstarUrl } from "../lib/starred.js";
import { listActions } from "../lib/journal.js";
import {
  isHttpTab, ownSuspendedRef, urlOf, canonicalRef, isSaveableTab, saveableTabRef
} from "../lib/tabs.js";
import { isSuspendExempt } from "../lib/suspend.js";
import { linksToMarkdown } from "../lib/export.js";
import {
  nextWallClockInfo, siteRuleCounts
} from "../lib/focus.js";
import {
  formatRemaining, blockedSitesSummary, focusPopupDurationInfo
} from "../lib/focus-copy.js";
import { applyDocumentLocale, msg as localeMessage } from "../lib/i18n.js";
import { withPending } from "./pending.js";
// E3-0: dev-only perf instrumentation. The real toolbar popup can't carry
// `?perf=1`, so activation ALSO happens from the hidden settings.perfHud the
// moment hydrate's own settings read lands; all calls are no-ops otherwise.
import { activateFromSettings, perfActive, precord, preport } from "../lib/perf.js";
import { getVaultStatus } from "../vault/vault.js";
import { el } from "./dom.js";
import { icon } from "./icons.js";
import { createSearchBox } from "./searchbox.js";
import { createFocusAccessPanel, getFocusAccessStatus } from "./focus-access.js";
import { createLabelInput } from "./labelinput.js";
import { buildSnoozePanel as buildSharedSnoozePanel, buildSortChoices } from "./list-helpers.js";
import { listSortLabel } from "./list-copy.js";
import { initTooltips } from "./tooltip.js";
import { initTheme } from "./theme.js";
import { createAnchoredPanel, dismissAnchoredPanel } from "./tablist.js";
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
const search = createSearchBox({
  placeholder: localeMessage("search_popup_placeholder"),
  historyPlaceholder: localeMessage("search_popup_history_placeholder"),
  enterFallback: true,
  // P11-05/P11-05r: only the named command autofocuses. Once focused, this
  // popup gets the same chips-then-recents state as every other Search host.
  autofocusWhen: consumeSearchPopupMode
});
const statusStrip = el("div", { class: "statusstrip" }, "…");

// THIS TAB group
const tabFav = el("span", { class: "fav" });
const tabTitle = el("span", { class: "th-title" }, "…");
// F16 (nit): read-only chips showing the labels this page already carries (from
// any saved Inbox/Archive copy of the same URL) — parity with the dashboard's
// open-tab row chips. Hidden while empty.
const tabLabelsSlot = el("div", { class: "tablabels" });
/**
 * D4-3d: one action row. The label lives in its own span so a dynamic relabel
 * (Suspend becomes Wake) cannot wipe the icon, and the key hint is rendered only
 * where the popup actually binds that key.
 * @param {string} iconName @param {string} label @param {string} [key]
 */
function actionRow(iconName, label, key) {
  return el("button", { disabled: "" },
    icon(iconName, 15),
    el("span", { class: "lbl" }, label),
    key ? el("span", { class: "k", "aria-hidden": "true" }, key) : null);
}
/** Relabel an action row without touching its icon or key hint. */
function setLabel(btn, text) {
  const lbl = btn.querySelector(".lbl");
  if (lbl) lbl.textContent = text;
}
const dumpTabBtn = actionRow("inbox", popupStatic.saveTabInbox(), "I");
const snoozeBtn = actionRow("snooze", popupStatic.snooze(), "S");
const suspendBtn = actionRow("suspend", popupStatic.suspend(), "Z");
// F16: quick-label — save a labeled copy to Archive and keep the tab open.
const labelTabBtn = actionRow("labels", popupStatic.label(), "L");
// P11-12: Star is state on the named current page, so it lives with the page
// identity rather than consuming a fifth workflow row.
const starTabBtn = el("button", {
  class: "tab-star", type: "button", disabled: "",
  title: popupStatic.starTab(), "aria-label": popupStatic.starTab(), "aria-pressed": "false"
}, icon("star", 15));
const tabReason = el("div", { class: "reason" });
const tabActions = el("div", { class: "actgrid tab-actions" },
  dumpTabBtn, snoozeBtn, labelTabBtn, suspendBtn);
const snoozePanelTab = el("div", { class: "panel snooze-panel" });
const snoozePopoverTab = createAnchoredPanel(snoozePanelTab);
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
const saveBtn = actionRow("sessions", popupStatic.saveSession());
// F13: one-shot sort of the current window (same three orders as the dashboard).
const sortWinBtn = actionRow("organize", popupStatic.sort());
// F19: copy this window's web pages to the clipboard as a Markdown link list.
const copyWinBtn = el("button", { class: "group-utility", type: "button", disabled: "" },
  icon("copy", 14), el("span", { class: "lbl" }, popupStatic.copyLinks()));
const winReason = el("div", { class: "reason" });
const snoozePanelWin = el("div", { class: "panel snooze-panel" });
const snoozePopoverWin = createAnchoredPanel(snoozePanelWin);
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
      el("h2", { class: "group-head" }, popupStatic.thisTab()), tabFav, tabTitle, starTabBtn),
    tabLabelsSlot,
    tabActions,
    snoozePanelTab,
    labelPanelTab,
    labelMsg,
    tabReason),
  el("div", { class: "group" },
    el("div", { class: "group-title-row" },
      el("h2", { class: "group-head" }, popupStatic.thisWindow()), copyWinBtn),
    // P11-12r: keep the highest-frequency window action first and full-width,
    // but use the same quiet command material as every other section.
    el("div", { class: "actions-row" }, dumpWinBtn),
    // Four secondary actions form a complete two-column grid. Copy is a quiet
    // object utility in the heading instead of an orphaned fifth tile.
    el("div", { class: "actgrid" },
      saveBtn, winSnoozeBtn, suspendOthersBtn, sortWinBtn),
    snoozePanelWin,
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
// P2b-4/P11-05: an ordinary toolbar click still does not autofocus Search, so
// the action rows remain immediately usable. The one explicit exception is the
// named keyboard command, whose one-shot initialState is owned by searchbox.js.
const searchInput = search.querySelector("input");
function isTyping(t) {
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" ||
    t.tagName === "SELECT" || t.isContentEditable);
}
/* D4-3d: the four current-tab actions carry the SAME single keys the dashboard
 * binds on a focused row, so the hint beside each one is the real binding and
 * the muscle memory transfers. A disabled action is skipped rather than
 * silently swallowing the key, and typing always wins. */
const TAB_KEYS = { i: () => dumpTabBtn, s: () => snoozeBtn, z: () => suspendBtn, l: () => labelTabBtn };
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
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

function favEl(favUrl) {
  return favUrl
    ? el("img", { class: "fav", src: favUrl, alt: "",
        onerror: (e) => e.currentTarget.replaceWith(el("span", { class: "fav" })) })
    : el("span", { class: "fav" });
}

function setFav(target, favUrl) {
  if (favUrl) {
    const img = favEl(favUrl);
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
function renderDupHint(active, allTabs, groups) {
  if (!active || !isHttpTab(active)) return;
  const key = normalizeUrl(urlOf(active));
  // Only surface the hint when this duplication is also what the badge counts,
  // so the badge and the popup's top row always agree (criterion 4).
  if (!groups.some((g) => g.key === key)) return;
  const twins = allTabs.filter(
    (t) => t.id !== active.id && isHttpTab(t) && normalizeUrl(urlOf(t)) === key
  );
  if (twins.length === 0) return;
  const existing = twins.reduce((a, b) => (a.id < b.id ? a : b)); // oldest open copy
  const where = popupDuplicateWhere(existing.windowId === active.windowId);

  dupHintSlot.replaceChildren(
    el("div", { class: "banner" },
      favEl(existing.favIconUrl),
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
  const [settings, activeTabs, winTabs, allTabs, inbox, snoozes] = await Promise.all([
    getSettings(),
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.tabs.query({ currentWindow: true }),
    chrome.tabs.query({}),
    listItems(STORE_KEYS.inbox),
    listItems(STORE_KEYS.snoozes)
  ]);
  activateFromSettings(settings); // E3-0: hidden perfHud → instrument this fill
  const [active] = activeTabs;
  const winCount = new Set(allTabs.map((t) => t.windowId)).size;
  const suspendedRef = active ? ownSuspendedRef(active) : null;
  const activeCapture = active ? saveableTabRef(active) : null;
  const starredRef = activeCapture;
  const groups = findDuplicateGroupsFromTabs(allTabs);
  const [initialStarred, initialLabels, focusSnapshot, vaultSnapshot] = await Promise.all([
    starredRef ? isStarredUrl(starredRef.url) : false,
    activeCapture ? computeTabLabels(active) : [],
    readFocusSnapshot(),
    readVaultWarning()
  ]);

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
  setFav(tabFav, suspendedRef?.favIconUrl ?? active?.favIconUrl);

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
    saveBtn.disabled = false;
    saveBtn.onclick = (e) => withPending(e.currentTarget, async () => {
      // Immediate feedback + one-in-flight guard: without these a click looked
      // like a broken no-op, and repeat clicks each created a whole new session.
      setMsg(popupStatic.saving());
      const res = await send({ type: "save-window-session", windowId: active?.windowId });
      if (res?.name) setMsg(popupSavedSession(res.name), renameControl(res.id, res.name));
      else setMsg(popupStatic.nothingSave());
    });
    // P2b-1: snooze the whole window — reuses the same preset/recurrence panel.
    winSnoozeBtn.disabled = false;
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
  renderDupHint(active, allTabs, groups);
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
  const meta = (await chrome.storage.local.get("vaultMeta")).vaultMeta;
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

/** F16: toggle the quick-label panel; opening it closes any open snooze/sort panel. */
function toggleLabel(panel, tab, ref) {
  dismissAnchoredPanel();
  const open = panel.style.display !== "none";
  for (const p of INLINE_PANELS) if (p !== panel) p.style.display = "none";
  if (open) { panel.style.display = "none"; return; }
  labelMsg.textContent = ""; // clear any prior confirmation as we reopen
  buildLabelPanel(panel, tab, ref);
  panel.style.display = "block";
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
  const save = async () => {
    const labels = tags.getLabels();
    // Confirmations/nudges go to labelMsg (under This tab), not the shared msg
    // area below This window.
    if (labels.length === 0) { labelMsg.textContent = popupStatic.typeLabelFirst(); return; }
    if (!ref) { labelMsg.textContent = popupStatic.cannotLabel(); panel.style.display = "none"; return; }
    await saveLabeledCopies([ref], labels);
    labelMsg.textContent = popupLabeledWith(labels);
    panel.style.display = "none";
    await refreshTabLabels(tab); // reflect the new labels immediately
  };
  // N13: Enter on the emptied input applies (type a label → Enter → Enter).
  // N22: a second Esc (or Esc with the dropdown closed) backs out to the button.
  const tags = createLabelInput({
    placeholder: popupStatic.labelsPlaceholder(),
    onSubmit: save,
    onCancel: () => { panel.style.display = "none"; labelTabBtn.focus(); }
  });
  panel.replaceChildren(
    tags.element,
    el("button", { class: "primary label-save", onclick: save }, popupStatic.saveLabeledCopy()),
    el("div", { class: "reason" }, popupStatic.labelExplanation())
  );
  // Focus the input so the user can type immediately.
  tags.element.querySelector(".taginput")?.focus();
}

/**
 * F16 (nit) — the labels this page already carries: the union of labels on any
 * saved Inbox/Archive copy of the same (normalized) URL. Same matching as the
 * dashboard's open-tab row chips.
 * @param {chrome.tabs.Tab} tab @returns {Promise<string[]>}
 */
async function computeTabLabels(tab) {
  const ref = canonicalRef(tab);
  if (!ref) return [];
  const key = normalizeUrl(ref.url);
  const out = new Set();
  for (const store of [STORE_KEYS.inbox, STORE_KEYS.archive]) {
    for (const item of await listItems(store)) {
      for (const t of item.tabs) {
        if (normalizeUrl(t.url) !== key) continue;
        for (const l of tabLabels(item, t)) out.add(l);
      }
    }
  }
  return [...out];
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

hydrate().finally(() => document.body.classList.add("popup-ready"));

// A notification action or another EveryTab surface can move this boundary while the
// popup is open. Refresh only the small access band; it never rebuilds the action groups.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.focusTemporaryAccess) focusAccessPanel.refresh();
});
