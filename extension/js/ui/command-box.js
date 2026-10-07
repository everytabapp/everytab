// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * One responsive activity line and one persistent Starred workspace rail.
 *
 * Search owns the sticky left edge. Activity remains normal page flow even
 * when wide layouts align it beside Search. Starred is positioned by the sticky
 * hero; wide layouts yield collection space to its flat expanded ledger while
 * narrower layouts retain an overlay fallback.
 */
import { faviconSource } from "./favicon-source.js";
import { createStartupArrival } from "./startup-arrival.js";
import { el, timeAgo, isComposingKey } from "./dom.js";
import { icon } from "./icons.js";
import { listItems, getSettings, readStoreMap } from "../lib/store.js";
import { STORE_KEYS } from "../lib/types.js";
import { listStarred, unstarTab, renameStarred, moveStarred, reorderStarred } from "../lib/starred.js";
import { createDisplayTabReads } from "./display-tab-reads.js";
import { listActions, isVisibleActivityEntry } from "../lib/journal.js";
import { requestUndo } from "./undo-client.js";
import {
  sessionUrlsForWindow
} from "../lib/session-identity-index.js";
import { readSessionIdentities } from "../lib/session-identity-store.js";
import { normalizeUrl } from "../lib/url-key.js";
import { isHttpTab, urlOf } from "../lib/tabs.js";
import { getVaultStatus, getVaultSyncMeta } from "../vault/vault.js";
import { activityAttentionLabel } from "./activity-copy.js";
import { formatNumber, msg as localeMessage } from "../lib/i18n.js";
import { shellSectionTitle } from "./shell-copy.js";

const STARRED_RAIL_OPEN_KEY = "tvStarredRailOpen";

/** One small queue, not a second dashboard. */
export const ATTENTION_LIMIT = 3;
export const RECENT_AUTOMATIC_MS = 24 * 60 * 60 * 1000;
export const INBOX_ATTENTION_COUNT = 20;
export const INBOX_ATTENTION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Pure: only missed/due snoozes need intervention; future wakes are plans. */
export function countOverdueSnoozes(snoozes, now = Date.now()) {
  return snoozes.filter((s) => Number(s?.dueAt) <= now).length;
}

/**
 * Pure: summarize restored windows that contain URLs absent from their saved
 * Session window. The compact Session identity projection excludes automatic
 * snapshots, so they cannot become attention entries through this path.
 */
export function sessionDriftFact(windows = [], bindings = {}, sessions = []) {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  let changedWindows = 0;
  let strayTabs = 0;
  let onlySessionName = "";
  for (const win of windows) {
    const binding = bindings?.[win.id];
    const session = binding ? byId.get(binding.sessionId) : null;
    if (!session) continue;
    const projected = sessionUrlsForWindow(session, binding.windowIndex ?? 0);
    if (projected === null) continue;
    const saved = new Set(projected);
    const strays = (win.tabs ?? []).filter((tab) =>
      isHttpTab(tab) && !saved.has(normalizeUrl(urlOf(tab)))
    ).length;
    if (strays === 0) continue;
    changedWindows += 1;
    strayTabs += strays;
    onlySessionName = changedWindows === 1 ? session.name : "";
  }
  return changedWindows > 0
    ? { windows: changedWindows, tabs: strayTabs, sessionName: onlySessionName }
    : null;
}

/** Pure: automatic journal entries that are recent, unresolved, and useful. */
export function recentAutomaticAttention(actions = [], now = Date.now()) {
  return actions
    .filter((entry) => entry?.auto === true && !entry.undone &&
      !entry.undoStatus && !entry.restoreUndoStatus &&
      Number(entry.at) >= now - RECENT_AUTOMATIC_MS && isVisibleActivityEntry(entry))
    .sort((a, b) => Number(b.at) - Number(a.at))
    .map((entry) => ({
      id: `automatic:${entry.id}`, kind: "automatic", page: "activity",
      label: activityAttentionLabel(entry) || localeMessage("attention_automatic_fallback"),
      at: Number(entry.at), entryId: entry.id
    }));
}

/** Pure, ranked queue. Actionables always consume the available slots first. */
export function attentionItems({
  vaultIssue = "", duplicates = 0, overdueSnoozes = 0,
  sessionDrift = null, inboxItems = [], inboxExpiryDays = 0, automaticActions = []
} = {}, now = Date.now()) {
  const items = [];
  if (vaultIssue === "reconnect") {
    items.push({ id: "vault", kind: "actionable", page: "vault",
      label: localeMessage("attention_vault_reconnect") });
  } else if (vaultIssue === "failed") {
    items.push({ id: "vault", kind: "actionable", page: "vault",
      label: localeMessage("attention_vault_failed") });
  }
  if (overdueSnoozes > 0) {
    items.push({ id: "snoozed", kind: "actionable", page: "snoozed",
      label: overdueSnoozes === 1
        ? localeMessage("attention_snoozes_overdue_one", [formatNumber(overdueSnoozes)])
        : localeMessage("attention_snoozes_overdue_other", [formatNumber(overdueSnoozes)]) });
  }
  if (sessionDrift?.windows > 0) {
    const one = sessionDrift.windows === 1 && sessionDrift.sessionName;
    items.push({ id: "session-drift", kind: "actionable", page: "open",
      label: one
        ? sessionDrift.tabs === 1
          ? localeMessage("attention_session_drift_one", [formatNumber(sessionDrift.tabs), sessionDrift.sessionName])
          : localeMessage("attention_session_drift_other", [formatNumber(sessionDrift.tabs), sessionDrift.sessionName])
        : localeMessage("attention_session_drift_windows", [formatNumber(sessionDrift.windows)]) });
  }
  if (duplicates > 0) {
    items.push({ id: "duplicates", kind: "actionable", page: "duplicates",
      label: duplicates === 1
        ? localeMessage("attention_duplicates_one", [formatNumber(duplicates)])
        : localeMessage("attention_duplicates_other", [formatNumber(duplicates)]) });
  }

  const oldestInboxAt = inboxItems.reduce((oldest, item) => {
    // Match the expiry worker and the age people see in Inbox. Relabeling or
    // regrouping an item updates modifiedAt but must not postpone this warning.
    const stamp = Number(item?.createdAt) || Number(item?.modifiedAt) || now;
    return Math.min(oldest, stamp);
  }, now);
  const oldestInboxAge = inboxItems.length ? Math.max(0, now - oldestInboxAt) : 0;
  const expiryMs = Number(inboxExpiryDays) > 0
    ? oldestInboxAt + Number(inboxExpiryDays) * 86400_000 - now
    : Infinity;
  const expirySoon = inboxItems.length > 0 && expiryMs > 0 && expiryMs <= 86400_000;
  if (expirySoon) {
    const hours = Math.max(1, Math.ceil(expiryMs / 3600_000));
    items.push({ id: "inbox-expiry", kind: "actionable", page: "inbox",
      label: localeMessage("attention_inbox_expiry", [formatNumber(hours)]) });
  } else if (inboxItems.length >= INBOX_ATTENTION_COUNT || oldestInboxAge >= INBOX_ATTENTION_AGE_MS) {
    const days = Math.max(1, Math.floor(oldestInboxAge / (24 * 60 * 60 * 1000)));
    items.push({ id: "inbox", kind: "actionable", page: "inbox",
      label: inboxItems.length >= INBOX_ATTENTION_COUNT
        ? localeMessage("attention_inbox_count", [formatNumber(inboxItems.length)])
        : localeMessage("attention_inbox_waiting", [formatNumber(days)]) });
  }

  return [...items, ...recentAutomaticAttention(automaticActions, now)]
    .slice(0, ATTENTION_LIMIT);
}

async function readVaultIssue() {
  const [status, meta] = await Promise.all([getVaultStatus(), getVaultSyncMeta()]);
  if (status.state === "needs-permission") return "reconnect";
  if (status.state === "error") return "failed";
  if (status.state === "connected" && meta?.ok === false) return "failed";
  return "";
}

async function readSessionDrift() {
  const [bindings, sessions] = await Promise.all([
    readStoreMap("sessionWindows"), readSessionIdentities()
  ]);
  if (Object.keys(bindings).length === 0 || sessions.length === 0) return null;
  const windows = await chrome.windows.getAll({ populate: true });
  return sessionDriftFact(windows, bindings, sessions);
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/**
 * @param {{go:(page:string)=>void, showNotice?:(message:string)=>void,
 *   onRailTransition?:(update:()=>void)=>void}} deps
 * @returns {{attention:HTMLElement, starred:HTMLElement,
 *   refreshStarred:()=>Promise<void>,
 *   refreshAttention:(reads?:ReturnType<typeof createDisplayTabReads>)=>Promise<void>}}
 */
export function createPageUtilities({ go, showNotice = () => {}, onRailTransition }) {
  const startupArrival = createStartupArrival();
  globalThis.addEventListener?.("pagehide", () => startupArrival.destroy(), { once: true });
  let starred = [];
  let starredReady = false;
  let attention = [];
  let railOpen = false;
  try { railOpen = localStorage.getItem(STARRED_RAIL_OPEN_KEY) === "true"; }
  catch { /* unavailable storage keeps the compact default */ }

  const attentionBody = el("div", { class: "page-attention-items" });
  const attentionLine = el(
    "section",
    { class: "page-attention", "aria-label": shellSectionTitle("activity"), hidden: true },
    attentionBody
  );

  const starCount = startupArrival.pendingCount("starred-edge-count");
  const starBody = el("div", { class: "starred-edge-list" });
  /* F45r: reorder-by-drag state. One row is dragged at a time, so this lives
   * with the rail rather than on each row, and the drop indicator is a class on
   * the row under the pointer — no node is inserted, so nothing reflows mid
   * gesture. */
  let dragFrom = null;
  let dragId = null;
  let reorderAnimations = [];
  let reorderTail = Promise.resolve();
  let reorderPending = 0;
  let deferredStarredRefresh = false;
  const starredRowPositions = () => new Map(
    [...starBody.querySelectorAll(".pu-star-row[data-star-id]")]
      .map((row) => [row.dataset.starId, row.getBoundingClientRect().top])
  );
  const starredSignature = (items) => JSON.stringify(items.map((item) => [
    item.id, item.position ?? 0, item.title ?? "", item.url ?? "", item.favIconUrl ?? ""
  ]));
  const captureStarredFocus = ({ forceId = null } = {}) => {
    if (forceId) return { id: forceId, control: "launch", force: true, node: null };
    const node = document.activeElement;
    if (!node || !starBody.contains(node)) return null;
    const row = node.closest?.(".pu-star-row[data-star-id]");
    if (!row) return null;
    return {
      id: row.dataset.starId,
      control: node.dataset.starControl || "launch",
      force: false,
      node
    };
  };
  const restoreStarredFocus = (snapshot, allowed) => {
    if (!snapshot || !allowed) return;
    const row = [...starBody.querySelectorAll(".pu-star-row[data-star-id]")]
      .find((candidate) => candidate.dataset.starId === snapshot.id);
    const control = [...(row?.querySelectorAll("[data-star-control]") ?? [])]
      .find((candidate) => candidate.dataset.starControl === snapshot.control) ??
      row?.querySelector(".pu-star-link");
    control?.focus();
  };
  const settleStarredReorder = (before) => {
    if (!before?.size ||
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
        typeof Element.prototype.animate !== "function") return;
    const style = getComputedStyle(document.documentElement);
    const duration = Number.parseFloat(style.getPropertyValue("--motion-continuity")) || 180;
    const easing = style.getPropertyValue("--ease-out").trim() || "cubic-bezier(.2, .8, .2, 1)";
    reorderAnimations = [...starBody.querySelectorAll(".pu-star-row[data-star-id]")]
      .flatMap((row) => {
        const previousTop = before.get(row.dataset.starId);
        const delta = previousTop == null ? 0 : previousTop - row.getBoundingClientRect().top;
        if (Math.abs(delta) < .5) return [];
        const animation = row.animate([
          { transform: `translateY(${delta}px)`, opacity: .72 },
          { transform: "translateY(0)", opacity: 1 }
        ], { duration, easing, fill: "none" });
        return [animation];
      });
  };
  const commitStarredReorder = (mutate, focusSnapshot) => {
    const run = reorderTail.then(async () => {
      const before = starredRowPositions();
      reorderPending++;
      try {
        if (await mutate() === false) return false;
        await refreshStarred({ reorderFrom: before, focusSnapshot });
        return true;
      } finally {
        reorderPending--;
        if (reorderPending === 0 && deferredStarredRefresh) {
          deferredStarredRefresh = false;
          await refreshStarred();
        }
      }
    });
    reorderTail = run.catch(() => {});
    return run;
  };
  const clearDropMarks = () => {
    for (const row of starBody.querySelectorAll(".drop-before, .drop-after, .dragging")) {
      row.classList.remove("drop-before", "drop-after", "dragging");
    }
  };
  /* F46r: the whole rail accepts the drop, not only the rows. Chrome draws the
     "no drop" cursor over any area that refuses `dragover`, so leaving the
     gaps unhandled made the pointer flicker between move and forbidden. */
  starBody.addEventListener("dragover", (event) => {
    if (dragFrom == null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  });
  starBody.addEventListener("drop", (event) => {
    if (dragFrom != null) event.preventDefault();
  });
  const starHintId = "pu-star-hint";
  const starHint = el("p", { class: "sr-only", id: starHintId },
    localeMessage("starred_reorder_hint"));
  const starToggle = el(
    "button",
    { class: "starred-edge-toggle", type: "button", "aria-expanded": "false" },
    icon("star", 15),
    el("span", { class: "starred-edge-label" }, localeMessage("starred_rail_title")),
    starCount,
    el("span", { class: "starred-edge-collapse", "aria-hidden": "true" }, "›")
  );
  const starredEdge = el(
    "aside",
    { class: "starred-edge", "aria-label": localeMessage("starred_rail_aria") },
    starToggle,
    el("div", { class: "starred-edge-body" }, starBody)
  );

  function publishRailState({ persist = true } = {}) {
    starredEdge.classList.toggle("is-open", railOpen);
    starToggle.setAttribute("aria-expanded", String(railOpen));
    const toggleState = railOpen ? localeMessage("starred_rail_collapse") : localeMessage("starred_rail_open");
    starToggle.setAttribute("aria-label", starredReady
      ? localeMessage("starred_rail_toggle_aria", [toggleState, starred.length === 1
        ? localeMessage("starred_shortcut_count_one", [formatNumber(starred.length)])
        : localeMessage("starred_shortcut_count_other", [formatNumber(starred.length)])])
      : toggleState);
    if (!persist) return;
    try { localStorage.setItem(STARRED_RAIL_OPEN_KEY, String(railOpen)); }
    catch { /* state still survives page routes in this document */ }
  }
  function setRailOpen(next) {
    const update = () => {
      railOpen = next;
      publishRailState();
    };
    if (onRailTransition) onRailTransition(update);
    else update();
  }
  starToggle.addEventListener("click", () => setRailOpen(!railOpen));
  starredEdge.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !railOpen) return;
    event.preventDefault();
    setRailOpen(false);
    starToggle.focus();
  });

  function favicon(item) {
    const source = faviconSource(item);
    return source
      ? el("img", { class: "pu-fav", src: source, alt: "",
          onerror: (event) => event.currentTarget.replaceWith(
            el("span", { class: "pu-fav cmd-fav-blank", "aria-hidden": "true" })) })
      : el("span", { class: "pu-fav cmd-fav-blank", "aria-hidden": "true" });
  }

  async function removeStar(item, wrap) {
    wrap.classList.add("leaving");
    const changed = await unstarTab(item.id);
    if (!changed) showNotice(localeMessage("starred_changed_elsewhere"));
    await refreshStarred();
  }

  /** Inline rename. Esc restores; Enter or blur commits. */
  function startRename(item, wrap) {
    if (wrap.querySelector(".pu-rename")) return;
    const oldName = item.title || hostOf(item.url);
    const input = el("input", {
      class: "pu-rename", type: "text", value: oldName, "aria-label": localeMessage("starred_rename_aria", [oldName])
    });
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      const next = input.value;
      input.remove();
      wrap.classList.remove("renaming");
      if (commit) await renameStarred(item.id, next);
      await refreshStarred();
    };
    input.addEventListener("keydown", (event) => {
      if (isComposingKey(event)) return;
      if (event.key === "Enter") { event.preventDefault(); finish(true); }
      else if (event.key === "Escape") { event.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    wrap.classList.add("renaming");
    wrap.append(input);
    input.focus();
    input.select();
  }

  function starredRow(item, index, total) {
    const name = item.title || hostOf(item.url);
    const wrap = el("div", { class: "pu-star-row", "data-star-id": item.id, "data-star-index": String(index) });
    /* F45r: the order is set by dragging the row itself — MH's call, and the
     * right one: reorder controls would take permanent width in a 280px rail to
     * serve a rare action. The launcher IS the drag handle, so a press-and-move
     * reorders and a plain click still launches; the browser never fires a click
     * after a completed drag, so the two gestures cannot be confused.
     *
     * A pointer-only affordance would strand keyboard users, so Alt+↑/↓ on the
     * focused shortcut does the same move without occupying a single pixel. */
    const launch = el("button", {
      class: "pu-star-link", type: "button", draggable: "true",
      "data-star-control": "launch",
      title: localeMessage("starred_item_title", [name]), "aria-label": localeMessage("starred_item_open_aria", [name]),
      "aria-describedby": starHintId,
      onclick: () => chrome.runtime.sendMessage({ type: "activate-starred", url: item.url }),
      ondragstart: (event) => {
        dragFrom = index;
        dragId = item.id;
        event.dataTransfer.effectAllowed = "move";
        // Firefox refuses to start a drag with no payload; the id is also the
        // honest description of what is moving.
        event.dataTransfer.setData("text/plain", item.id);
        wrap.classList.add("dragging");
      },
      ondragend: () => { dragFrom = null; dragId = null; clearDropMarks(); },
      onkeydown: async (event) => {
        if (event.key === "F2") { event.preventDefault(); startRename(item, wrap); return; }
        if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault();
        event.stopPropagation(); // the list walk must not also move focus
        await commitStarredReorder(
          () => moveStarred(item.id, event.key === "ArrowUp" ? -1 : 1),
          captureStarredFocus({ forceId: item.id })
        );
      }
    }, favicon(item), el("span", {}, name));
    wrap.addEventListener("dragover", (event) => {
      if (dragFrom == null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const box = wrap.getBoundingClientRect();
      const after = event.clientY > box.top + box.height / 2;
      clearDropMarks();
      wrap.classList.add(after ? "drop-after" : "drop-before");
    });
    wrap.addEventListener("dragleave", (event) => {
      if (!wrap.contains(event.relatedTarget)) {
        wrap.classList.remove("drop-before", "drop-after");
      }
    });
    wrap.addEventListener("drop", async (event) => {
      if (dragFrom == null) return;
      event.preventDefault();
      const box = wrap.getBoundingClientRect();
      const after = event.clientY > box.top + box.height / 2;
      const from = dragFrom;
      const moving = dragId;
      dragFrom = null;
      dragId = null;
      clearDropMarks();
      if (moving == null) return;
      // Removing the dragged row first shifts every later index down by one.
      let to = index + (after ? 1 : 0);
      if (from < to) to -= 1;
      if (to === from) return;
      const focusSnapshot = captureStarredFocus();
      await commitStarredReorder(() => reorderStarred(moving, to), focusSnapshot);
    });
    const rename = el("button", { class: "pu-row-action", type: "button",
      "data-star-control": "rename",
      title: localeMessage("starred_rename_aria", [name]), "aria-label": localeMessage("starred_rename_aria", [name]),
      onclick: () => startRename(item, wrap) }, icon("rename", 13));
    const remove = el("button", { class: "pu-row-action", type: "button",
      "data-star-control": "remove",
      title: localeMessage("starred_unstar_aria", [name]), "aria-label": localeMessage("starred_unstar_aria", [name]),
      onclick: () => removeStar(item, wrap) }, "×");
    wrap.append(launch, el("span", { class: "pu-row-actions" }, rename, remove));
    return wrap;
  }

  function attentionEntry(item) {
    const age = item.kind === "automatic" ? timeAgo(item.at) : "";
    const open = el("button", {
      class: "page-attention-link",
      type: "button", title: age ? localeMessage("attention_entry_title", [item.label, age]) : item.label,
      onclick: () => go(item.kind === "automatic" && item.entryId
        ? `activity:${encodeURIComponent(item.entryId)}` : item.page)
    },
    item.kind === "automatic" ? icon("refresh", 12) : null,
    el("span", { class: "page-attention-copy" }, item.label),
    age ? el("span", { class: "page-attention-age" }, age) : null);
    if (item.kind !== "automatic") {
      return el("span", { class: "page-attention-entry" }, open);
    }
    const undo = el("button", {
      class: "page-attention-undo", type: "button",
      title: localeMessage("attention_undo_entry", [item.label]), "aria-label": localeMessage("attention_undo_entry", [item.label]),
      onclick: async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const result = await requestUndo(item.entryId);
          showNotice(result.status === "undone"
            ? localeMessage("attention_undid", [item.label])
            : localeMessage("attention_undo_changed"));
        } catch {
          showNotice(localeMessage("attention_undo_failed"));
        }
        await refreshAttention();
      }
    }, localeMessage("action_undo"));
    return el("span", { class: "page-attention-entry is-automatic" }, open, undo);
  }

  function renderStarred({ reorderFrom = null, focusSnapshot = null } = {}) {
    const shouldRestoreFocus = !!focusSnapshot &&
      (focusSnapshot.force || document.activeElement === focusSnapshot.node);
    for (const animation of reorderAnimations) animation.cancel();
    reorderAnimations = [];
    startupArrival.settleCount(starCount, starred.length, "starred-count");
    starBody.replaceChildren(...(starred.length
      ? [starHint, ...starred.map((item, index) => starredRow(item, index, starred.length))]
      : [el("p", { class: "pu-empty" }, localeMessage("starred_empty"))]));
    publishRailState({ persist: false });
    restoreStarredFocus(focusSnapshot, shouldRestoreFocus);
    settleStarredReorder(reorderFrom);
  }

  function renderAttention() {
    attentionLine.hidden = attention.length === 0;
    attentionBody.replaceChildren(...(attention.length
      ? [
          ...attention.map(attentionEntry),
          // The durable history is Activity. No arrow sits beside Focus: the
          // hover underline is enough to identify this as the overflow route.
          el("button", { class: "page-attention-activity", type: "button",
            onclick: () => go("activity") }, localeMessage("attention_all_activity"))
        ]
      : []));
    if (attention.length) startupArrival.reveal(attentionLine, "attention");
  }

  async function refreshStarred({ reorderFrom = null, focusSnapshot = null } = {}) {
    if (reorderPending > 0 && !reorderFrom) {
      deferredStarredRefresh = true;
      return;
    }
    const next = await listStarred();
    if (starredReady && !reorderFrom && starredSignature(next) === starredSignature(starred)) {
      starred = next;
      publishRailState({ persist: false });
      return;
    }
    if (!focusSnapshot) focusSnapshot = captureStarredFocus();
    starred = next;
    starredReady = true;
    renderStarred({ reorderFrom, focusSnapshot });
  }

  /**
   * Saved-store inputs of the last complete refresh. Needs you only reads the
   * Inbox record count and timestamps, so the retained projection stays small
   * even for a large Inbox. Every saved input changes only through a storage
   * event, and each of those events schedules a complete refresh.
   * @type {{inboxItems:{createdAt?:number,modifiedAt?:number}[], snoozes:object[],
   *   actions:object[], vaultIssue:string, inboxExpiryDays:number}|null}
   */
  let savedAttentionInputs = null;

  async function readSavedAttentionInputs(reads) {
    const settings = await getSettings();
    const safe = (promise, fallback) => Promise.resolve(promise).catch(() => fallback);
    const [inboxItems, snoozes, actions, vaultIssue] = await Promise.all([
      safe(reads.inboxItems?.() ?? listItems(STORE_KEYS.inbox), []),
      safe(reads.snoozeItems?.() ?? listItems(STORE_KEYS.snoozes), []),
      safe(listActions(), []),
      safe(readVaultIssue(), "")
    ]);
    return {
      inboxItems: inboxItems.map(({ createdAt, modifiedAt }) => ({ createdAt, modifiedAt })),
      snoozes,
      actions,
      vaultIssue,
      inboxExpiryDays: settings.inboxExpiryDays
    };
  }

  /**
   * @param {ReturnType<typeof createDisplayTabReads> & {inboxItems?:() => Promise<object[]>,
   *   snoozeItems?:() => Promise<object[]>}} [reads]
   * @param {{liveOnly?: boolean}} [options] `liveOnly` re-reads live tabs,
   *   duplicates and Session drift while reusing the saved inputs of the last
   *   complete refresh. It falls back to a complete read until one has run.
   */
  async function refreshAttention(reads = createDisplayTabReads(), { liveOnly = false } = {}) {
    const safe = (promise, fallback) => Promise.resolve(promise).catch(() => fallback);
    const live = Promise.all([
      safe(reads.groups(), []),
      safe(readSessionDrift(), null)
    ]);
    const saved = (liveOnly && savedAttentionInputs) || await readSavedAttentionInputs(reads);
    savedAttentionInputs = saved;
    const [groups, sessionDrift] = await live;
    attention = attentionItems({
      vaultIssue: saved.vaultIssue,
      duplicates: groups.reduce((n, group) => n + group.close.length, 0),
      overdueSnoozes: countOverdueSnoozes(saved.snoozes),
      sessionDrift,
      inboxItems: saved.inboxItems,
      inboxExpiryDays: saved.inboxExpiryDays,
      automaticActions: saved.actions
    }, Date.now());
    renderAttention();
  }

  publishRailState({ persist: false });
  return { attention: attentionLine, starred: starredEdge, refreshStarred, refreshAttention };
}
