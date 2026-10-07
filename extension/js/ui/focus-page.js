// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * focus-page.js — the same-tab EveryTab Focus guard (focus-mode.md v0.2 §7.4).
 *
 * Privacy: this page NEVER trusts a destination URL, title, or domain from the DOM,
 * query string, or hash. It reads ONLY the opaque attempt id from the fragment and asks
 * the background for the trusted context, which the background resolves by this tab's
 * live `sender.tab.id` plus that opaque id. All site/user text is rendered as text nodes.
 *
 * No modal, no red danger styling, no quotes/illustrations/streaks. Copy is
 * decided by the pure `guardView`; timed access and the Return/Leave decision are the only
 * actions, each messaged to the background (which owns all tab mutation).
 *
 * F8-R2r C7: the page reacts to live run/rule/access changes. It listens for the relevant
 * local storage changes, coalesces, re-requests the trusted context, and re-renders the
 * settled view (Focus ended / no-longer-blocked / a new applicable state). It focuses the
 * primary action only on the initial render; a later refresh preserves the equivalent
 * connected control, never strands focus on a detached node, and never steals focus the
 * user deliberately moved away. An invalidated Return panel closes and lands on the primary.
 */
import { initTheme } from "./theme.js";
import { icon } from "./icons.js";
import { el } from "./dom.js";
import { guardView, minutesLabel, pauseCountdownText } from "../lib/focus-copy.js";
import { applyDocumentLocale, applyUiLanguage, msg as localeMessage } from "../lib/i18n.js";
import { getSettings } from "../lib/store.js";
import {
  markGuardFocus, captureGuardFocus, restoreGuardFocus, createPauseCountdown
} from "./focus-page-state.js";
import { createGuardActionRunner, guardFailureText } from "./focus-page-actions.js";
import { dashboardHref } from "../lib/newtab-focus.js";

// The chosen interface language must be in place before the guard's first text.
await applyUiLanguage((await getSettings()).uiLanguage);
initTheme();
applyDocumentLocale();
document.getElementById("mark-wrap")?.append(icon("mark", 40));

const $ = (id) => document.getElementById(id);
const heading = $("heading");
const line = $("line");
const primaryWrap = $("primary-wrap");
const accessWrap = $("access-wrap");
const accessRow = $("access-row");
const panelWrap = $("panel-wrap");
const msg = $("msg");
const live = $("live");

document.title = localeMessage("focus_guard_heading_on");
$("brand").textContent = localeMessage("focus_page_brand");
heading.textContent = localeMessage("focus_guard_heading_on");
$("access-label").textContent = localeMessage("focus_access_prompt");
$("settings-link").textContent = localeMessage("focus_settings");

const attemptId = location.hash.replace(/^#/, "");

const send = (m) => chrome.runtime.sendMessage(m).catch(() => ({ ok: false, reason: "unavailable" }));
function setMsg(t) { msg.textContent = t || ""; }
function announce(t) { live.textContent = ""; requestAnimationFrame(() => { live.textContent = t; }); }

// Settings link opens the dashboard Focus settings in a new tab (never navigates away
// from the guard, which would lose the attempt).
$("settings-link").addEventListener("click", (e) => {
  // The anchor carries the real destination, so a modified click stays the
  // browser's job: Cmd/Ctrl-click, middle-click, and the context menu all work.
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  try { chrome.tabs.create({ url: dashboardHref("settings-focus") }); } catch { /* no-op */ }
});

function goDashboard() {
  try { chrome.tabs.update({ url: dashboardHref() }); } catch { /* no-op */ }
}

const runAction = createGuardActionRunner({
  send,
  onInvalid: goDashboard,
  onFailure: (res, fallback) => setMsg(guardFailureText(res, fallback))
});

const pauseCountdown = createPauseCountdown({
  now: () => Date.now(),
  setTimer: (fn, delay) => setTimeout(fn, delay),
  clearTimer: (timer) => clearTimeout(timer),
  onTick: (remaining) => {
    const buttons = [...accessRow.querySelectorAll("button")];
    const locked = remaining > 0;
    buttons.forEach((button) => { button.disabled = locked; });
    $("access-label").textContent = locked
      ? pauseCountdownText(remaining)
      : localeMessage("focus_access_prompt");
  },
  onUnlock: () => announce(localeMessage("focus_access_ready"))
});
/** Build the timed-access buttons (Continue for 5/10/15/30 minutes). */
function renderAccess(ctx) {
  pauseCountdown.stop();
  const mins = Array.isArray(ctx.grantMinutes) ? ctx.grantMinutes : [5, 10, 15, 30];
  const buttons = mins.map((m) => {
    const button = markGuardFocus(el("button", {
      class: "mini", type: "button"
    }, localeMessage("focus_continue_for_duration", [minutesLabel(m)])), `grant:${m}`);
    button.onclick = () => runAction(button,
      { type: "focus-guard-grant", attemptId, minutes: m }, localeMessage("focus_error_open_site"));
    return button;
  });
  accessRow.replaceChildren(...buttons);
  accessWrap.hidden = false;

  // Pause: keep the choices unavailable until the persisted 15-second unlock elapses.
  // Reloading cannot restart or bypass it (the background computes the remaining time
  // from the persisted blockedAt). Announce the unlock once, politely.
  const remaining = Number(ctx.pauseRemainingMs) || 0;
  if (ctx.exceptionStyle === "pause" && remaining > 0) {
    const unlockAt = Number(ctx.pauseUnlockAt) || (Date.now() + remaining);
    pauseCountdown.start(unlockAt);
  } else {
    buttons.forEach((button) => { button.disabled = false; });
    $("access-label").textContent = localeMessage("focus_access_prompt");
  }
}

/** The inline P3 Return/Leave decision panel. Opening it mutates nothing. */
function openReturnPanel(returnBtn) {
  const closeNoSave = markGuardFocus(el("button", {
    class: "primary", type: "button"
  }, localeMessage("focus_return_close_without_saving")), "return:close");
  closeNoSave.onclick = () => runAction(closeNoSave,
    { type: "focus-guard-return-close", attemptId, save: false }, localeMessage("focus_error_close_tab"));
  const saveClose = markGuardFocus(el("button", {
    class: "mini", type: "button"
  }, localeMessage("focus_return_save_inbox_close")), "return:save");
  saveClose.onclick = () => {
    setMsg(localeMessage("focus_return_saving_inbox"));
    return runAction(saveClose,
      { type: "focus-guard-return-close", attemptId, save: true }, localeMessage("focus_error_save_page"));
  };
  const cancel = markGuardFocus(el("button", {
    class: "quiet", type: "button",
    onclick: () => closeReturnPanel(returnBtn)
  }, localeMessage("action_cancel")), "return:cancel");
  const returnQuestion = localeMessage("focus_return_question");
  const panel = el("div", { class: "panel", role: "group", "aria-label": returnQuestion },
    el("div", { class: "panel-q" }, returnQuestion),
    el("div", { class: "panel-actions" }, closeNoSave, saveClose, cancel));
  panelWrap.replaceChildren(panel);
  closeNoSave.focus(); // focus the first action; Esc / Cancel restore focus to the primary
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeReturnPanel(returnBtn); }
  });
}
function closeReturnPanel(returnBtn) {
  panelWrap.replaceChildren();
  setMsg("");
  if (returnBtn && document.body.contains(returnBtn)) returnBtn.focus();
  else primaryWrap.querySelector("button")?.focus();
}

/** Build the primary action for the current view. */
function renderPrimary(view) {
  const btn = markGuardFocus(
    el("button", { class: "primary", type: "button" }, view.primary), "primary");
  switch (view.primaryAction) {
    case "close-without-saving":
      btn.onclick = () => runAction(btn,
        { type: "focus-guard-return-close", attemptId, save: false },
        localeMessage("focus_error_close_tab"));
      break;
    case "safe-return":
      btn.onclick = () => runAction(btn,
        { type: "focus-guard-safe-return", attemptId }, localeMessage("focus_error_go_back"));
      break;
    case "continue-to-site":
      btn.onclick = () => runAction(btn,
        { type: "focus-guard-continue", attemptId }, localeMessage("focus_error_open_site"));
      break;
    case "return-flow":
      btn.onclick = () => openReturnPanel(btn);
      break;
    default:
      btn.onclick = () => goDashboard();
  }
  primaryWrap.replaceChildren(btn);
  return btn;
}

let rendered = false;
function render(ctx) {
  const view = guardView(ctx, Date.now());
  const focusSnapshot = captureGuardFocus(document, [primaryWrap, accessRow, panelWrap]);
  const initial = !rendered;
  rendered = true;

  heading.textContent = view.heading;
  line.textContent = view.line;
  document.title = view.heading;

  // C7: an open Return panel that no longer applies (run ended, no longer blocked, or
  // access changed) is invalid — close it and land on the primary action.
  const panelOpen = panelWrap.childElementCount > 0;
  const panelInvalidated = panelOpen && view.primaryAction !== "return-flow";
  if (panelInvalidated) {
    panelWrap.replaceChildren();
    setMsg("");
  }

  const primaryBtn = renderPrimary(view);
  if (view.showAccess) renderAccess(ctx);
  else { pauseCountdown.stop(); accessWrap.hidden = true; accessRow.replaceChildren(); }
  $("settings-link").hidden = ctx.kind === "missing" || ctx.kind === "not-guard";

  restoreGuardFocus({
    document,
    snapshot: focusSnapshot,
    primary: primaryBtn,
    findIdentity: (identity) => [primaryWrap, accessRow, panelWrap]
      .flatMap((surface) => [...surface.querySelectorAll("[data-guard-focus-id]")])
      .find((control) => control.dataset.guardFocusId === identity) ?? null,
    initial,
    forcePrimary: panelInvalidated
  });
}

async function refresh() {
  if (!attemptId) { render({ kind: "missing" }); return; }
  const res = await send({ type: "focus-guard-context", attemptId });
  render(res?.ok && res.context ? res.context : { kind: "missing" });
}

// C7: coalesce local changes that can alter the guard view and re-request the trusted
// context. We watch settings (rules/scope/access style), the run state, and the
// attempts/access maps; the background stays the source of truth for what actually applies.
let refreshQueued = false;
function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => { refreshQueued = false; void refresh(); });
}
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings || changes.focusGuardState || changes.focusTemporaryAccess || changes.focusBlockedAttempts) {
    scheduleRefresh();
  }
});

void refresh();
