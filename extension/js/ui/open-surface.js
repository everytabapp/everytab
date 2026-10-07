// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "../lib/failure-diagnostic.js";
/**
 * F14-2b — the shared Open-tabs surface.
 *
 * `createOpenSurface(ctx)` owns everything the Open section needs that is NOT a
 * generic `createTabList` config: the live-window data-gathering, the Open-only
 * inline panels (per-tab snooze, F13 Organize), the session-drift banner, the F10
 * idle nudge, the F18 group-preservation nudge, and the whole open-tabs drag
 * machinery (selected-set drag + explicit window-end/new-window zones + best-effort move
 * journaling). It holds the per-surface state those pieces need across renders
 * (the dragged tab set, dismissed drift windows, the once-per-session group nudge).
 *
 * Both the dashboard and the side panel build their Open section through this one
 * factory, so there is a single behavior source (spec §5.1/§5.2). Surface-specific
 * pieces are injected via `ctx` (the refresher, the notice/flash sinks, the
 * cross-section helpers that also live elsewhere); domain ops and pure builders are
 * imported. This module performs no storage read-modify-write of its own.
 *
 * Each extension document (dashboard.html, sidepanel.html) loads its own module
 * instance in its own realm, so the closure state below is naturally per-document —
 * no singleton assumption across windows (spec §7).
 */
import { el } from "./dom.js";
import { icon } from "./icons.js";
import {
  createTabList, reconcileOpenPlacement, fromOpenWindows, lazyOpenRefSubset, nameAndOrderOpenWindows
} from "./tablist.js";
import { buildOpenListConfig } from "./list-configs.js";
import { createTabDragController, createTabDropZone } from "./tab-drag.js";
import { orderOpenWindowGroups } from "./open-window-order.js";
import { STORE_KEYS } from "../lib/types.js";
import { listItems, getSettings, patchSettings } from "../lib/store.js";
import {
  getSessionBindings, liveSessionBindings, pruneSessionBindings, updateSessionWindow
} from "../lib/sessions.js";
import {
  ensureTabGroupsPermission, fetchLiveGroupDetails, hasTabGroupsPermission
} from "../lib/tab-groups.js";
import { normalizeUrl } from "../lib/dedup.js";
import { buildSavedLabelsByUrl } from "../lib/saved-label-index.js";
import {
  buildSessionMembershipsByUrl, sessionUrlsForWindow
} from "../lib/session-identity-index.js";
import { readSessionIdentities } from "../lib/session-identity-store.js";
import { isHttpTab, urlOf, toRef, organizeTabOf } from "../lib/tabs.js";
import { gatherOptionsFor } from "../lib/organize.js";
import { buildSnoozePanel, buildSortChoices } from "./list-helpers.js";
import { listUnit } from "./list-copy.js";
import { formatNumber, msg as localeMessage, pluralCategory } from "../lib/i18n.js";
import { pspan } from "../lib/perf.js";
import { createTabFilterControl } from "./tab-filter-control.js";
import { buildProtectionPanel } from "./automation-protection.js";
import { openDashboard } from "../lib/actions.js";
import {
  projectOpenAutomationAwareness, readAutomationAwarenessSnapshot
} from "../lib/automation-awareness-policy.js";

/** Dashboard cap per window; compact surfaces provide their own smaller cap. */
const OPEN_WINDOW_CAP = 50;
const OPEN_SURFACE_INITIAL_BUDGET = 300;
const IDLE_NUDGE_MS = 4 * 3600_000;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Apply the only non-structural Chrome tab update Open displays directly.
 * Returning false asks the caller for a full live-window snapshot because URL
 * and pinned changes affect actions, labels, Sessions, and automation policy.
 * Completion status alone changes no rendered Open field.
 *
 * @param {ParentNode} root mounted Open section
 * @param {number} tabId Chrome tab identity
 * @param {chrome.tabs.TabChangeInfo} changeInfo
 * @returns {boolean} true when no full Open refresh is needed
 */
export function reconcileOpenTabUpdate(root, tabId, changeInfo) {
  if (changeInfo.url || changeInfo.pinned !== undefined || changeInfo.groupId !== undefined) return false;
  if (typeof changeInfo.title !== "string") return true;
  const row = root?.querySelector?.(`[data-tablist-row="t${tabId}"]`);
  const link = row?.querySelector?.(".row-copy .t a");
  if (link) link.textContent = changeInfo.title || link.getAttribute("href") || "";
  return true;
}

function idleAgeLabel(ageMs) {
  const days = Math.floor(ageMs / DAY_MS);
  if (days >= 1) {
    return localeMessage(
      pluralCategory(days) === "one" ? "settings_duration_day_one" : "settings_duration_day_many",
      [formatNumber(days)]
    );
  }
  const hours = Math.max(1, Math.floor(ageMs / HOUR_MS));
  return localeMessage(
    pluralCategory(hours) === "one" ? "settings_duration_hour_one" : "settings_duration_hour_many",
    [formatNumber(hours)]
  );
}

/**
 * Live idle header nudge. Four hours is only its quiet appearance threshold;
 * once visible, the label follows the oldest tab from hours into days. One
 * exact boundary timer per visible window is cheaper than polling or
 * rerendering Open, and it retires itself with the rendered header.
 * @param {{tabs?: any[]}} win
 * @param {{now?: () => number, schedule?: typeof setTimeout}} [clock]
 */
export function createIdleNudge(win, clock = {}) {
  const now = clock.now ?? Date.now;
  const schedule = clock.schedule ?? setTimeout;
  const tabs = win?.tabs ?? [];
  const label = el("span", { class: "idle-nudge-label" });
  const node = el("span", {
    class: "item-meta idle-nudge",
    title: localeMessage("list_idle_tabs_title"),
    hidden: true
  }, icon("activity", 12), label);

  const refresh = () => {
    const current = now();
    let count = 0;
    let oldestAccessed = Infinity;
    let nextBoundary = Infinity;
    for (const tab of tabs) {
      if (typeof tab.lastAccessed !== "number") continue;
      const boundary = tab.lastAccessed + IDLE_NUDGE_MS;
      if (boundary <= current) {
        count++;
        oldestAccessed = Math.min(oldestAccessed, tab.lastAccessed);
      }
      else nextBoundary = Math.min(nextBoundary, boundary);
    }
    node.hidden = count === 0;
    label.textContent = count
      ? localeMessage("list_idle_tabs_count", [
        listUnit("tab", count),
        idleAgeLabel(current - oldestAccessed)
      ])
      : "";
    if (count) {
      const unit = current - oldestAccessed < DAY_MS ? HOUR_MS : DAY_MS;
      const nextAgeBoundary = oldestAccessed +
        (Math.floor((current - oldestAccessed) / unit) + 1) * unit;
      nextBoundary = Math.min(nextBoundary, nextAgeBoundary);
    }
    if (Number.isFinite(nextBoundary)) {
      schedule(() => {
        if (!node.isConnected) return;
        refresh();
      }, Math.max(32, nextBoundary - current + 16));
    }
  };
  refresh();
  return node;
}

/**
 * Keep the Open scanner a pure view over the already-captured window groups.
 * The live-tab lane stays index-aligned with its ref lane, so actions always
 * target the row the user can see.
 * @param {any[]} groups
 * @param {string} rawQuery
 */
export function filterOpenGroups(groups, rawQuery) {
  const query = String(rawQuery ?? "").trim().toLocaleLowerCase();
  if (!query) return groups;
  return groups.map((group) => {
    const indexes = [];
    const searchText = Array.isArray(group.searchText) ? group.searchText : null;
    for (let index = 0; index < group.refs.length; index += 1) {
      const haystack = searchText?.[index] ??
        `${group.refs[index]?.title ?? ""}\n${group.refs[index]?.url ?? ""}`.toLocaleLowerCase();
      if (haystack.includes(query)) indexes.push(index);
    }
    const live = indexes.map((index) => group.live?.[index]);
    return {
      ...group,
      refs: lazyOpenRefSubset(group.refs, indexes),
      live,
      searchText: indexes.map((index) => searchText?.[index] ?? ""),
      selectableCount: live.reduce((count, row) => count + Number(row?.selectable), 0)
    };
  }).filter((group) => group.refs.length > 0);
}

/**
 * @typedef {object} OpenSurfaceCtx
 * @property {(m: object) => Promise<any>} msg background message helper
 * @property {() => void} rerender refresh this surface's Open section
 * @property {() => boolean} shouldRenderBody skip the heavy build when off-screen
 * @property {() => boolean} [canReconcilePlacement] explicit host permission to mutate its mounted list
 * @property {HTMLElement} [sectionActionHost] stable header action lane
 * @property {HTMLElement} [filterHost] optional local-control row for the filter
 * @property {() => Element} getFlashAnchor element to flash validation notes near
 * @property {(m: string) => void} showNotice transient notice/toast sink
 * @property {(anchor: Element, text: string) => void} flashNote
 * @property {(ic: Node, label: string) => Node} mark
 * @property {Function} cardLabelPanel @property {Function} sessionComboboxButton
 * @property {(refs: any[], heading?: string) => void} copyRefs
 * @property {() => void} renderArchive @property {() => void} renderLabels
 * @property {(label: string) => void} goToLabel
 * @property {(sessionId: string) => void} goToSession
 * @property {() => Promise<any[]|null>|null} [takeInitialSnapshot]
 * @property {"default"|"compact"} [presentation]
 * @property {number|(() => number|undefined)} [rowCap]
 */

/**
 * @param {OpenSurfaceCtx} ctx
 * @returns {{
 *   render: () => Promise<{heading: string, node: Node|null, placementUpdated?: boolean}>,
 *   warm: (snapshot: Promise<any[]|null>|any[]|null) => void,
 *   invalidateSavedLabels: () => void
 * }}
 */
export function createOpenSurface(ctx) {
  const openDrag = createTabDragController({
    bodyClass: "tab-dragging",
    onReset: () => {
      for (const zone of document.querySelectorAll('[data-tablist="open"] .drop-zone-new')) {
        zone.textContent = localeMessage("list_drop_new_window");
      }
    }
  });
  /** Last visible window-card order for this Dashboard/side-panel surface. */
  let visibleWindowOrder = [];
  let mountedPlacement = null;
  /** @type {{windowId:number,afterWindowId:number}|null} */
  let pendingWindowPlacement = null;
  /** @type {Map<number, number>} windowId → stray count at dismissal (drift banner) */
  const driftDismissed = new Map();
  let bindingPruneScheduled = false;
  let initialSnapshot = ctx.takeInitialSnapshot?.() ?? null;
  // N45: saved labels enrich Open rows, but must never hold the first live
  // window paint behind a mature Inbox/Archive clone + sort + full scan.
  // Keep the last good index visible while a precisely invalidated replacement
  // builds behind the first paint.
  let savedLabelsByUrl = new Map();
  let savedLabelsFresh = false;
  let savedLabelEnrichment = null;
  let savedLabelGeneration = 0;
  const filter = createTabFilterControl({
    placeholder: localeMessage("list_filter_tabs_placeholder"),
    ariaLabel: localeMessage("list_filter_open_tabs_aria"),
    shortcut: "f",
    rerender: ctx.rerender
  });
  const mountedFilterHost = ctx.filterHost ?? ctx.sectionActionHost;
  mountedFilterHost?.prepend(filter.element);

  function startSavedLabelEnrichment(prefetchedItems = null) {
    if (savedLabelsFresh || savedLabelEnrichment) return;
    const generation = savedLabelGeneration;
    let endEnrichment = null;
    let detail = "failed";
    // A returned DOM node is not necessarily a painted DOM node: a storage
    // promise can resolve in the same microtask checkpoint. Start the expensive
    // read in a task after the next animation frame, so the primary ledger gets
    // a real compositor opportunity before cloning or scanning mature stores.
    const afterFirstPaint = new Promise((resolve) => {
      const nextFrame = globalThis.requestAnimationFrame ?? ((fn) => setTimeout(fn, 0));
      nextFrame(() => setTimeout(resolve, 0));
    });
    const pending = afterFirstPaint.then(() => {
      endEnrichment = pspan("open:saved-label-enrichment");
      return prefetchedItems ?? Promise.all([
        listItems(STORE_KEYS.inbox),
        listItems(STORE_KEYS.archive)
      ]);
    }).then(([inboxItems, archiveItems]) => {
      const next = buildSavedLabelsByUrl(inboxItems, archiveItems);
      detail = `${next.size} labeled URLs`;
      if (generation !== savedLabelGeneration) return;
      savedLabelsByUrl = next;
      savedLabelsFresh = true;
      // The primary node has been returned to its host. Reconcile chips only
      // after the browser has had a frame in which to paint that useful state.
      const afterPaint = globalThis.requestAnimationFrame ?? ((fn) => setTimeout(fn, 0));
      afterPaint(() => ctx.rerender());
    }).catch(() => {
      // Labels are optional display enrichment. A failed read must not replace
      // the useful live-window UI with an error or a retry loop.
    }).finally(() => {
      endEnrichment?.(detail);
      if (savedLabelEnrichment === pending) savedLabelEnrichment = null;
    });
    savedLabelEnrichment = pending;
  }

  function invalidateSavedLabels() {
    savedLabelGeneration += 1;
    savedLabelsFresh = false;
    savedLabelEnrichment = null;
  }

  /**
   * Stale binding cleanup is maintenance, not display data. Re-read the live
   * window ids at idle so a window created after the paint snapshot can never
   * have its fresh binding removed by an old id list.
   */
  function scheduleBindingPrune() {
    if (bindingPruneScheduled) return;
    bindingPruneScheduled = true;
    const run = async () => {
      try {
        const current = await chrome.windows.getAll();
        await pruneSessionBindings(current.map((w) => w.id));
      } catch {
        /* context/window changed during idle maintenance — next render retries */
      } finally {
        bindingPruneScheduled = false;
      }
    };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => { void run(); }, { timeout: 1500 });
    } else {
      setTimeout(() => { void run(); }, 250);
    }
  }

  /**
   * One complete Snooze picker for a row, a selected set, or a whole Chrome
   * window. The shared builder keeps Custom time and recurrence identical to
   * Popup, Inbox, Sessions, and Snoozed.
   */
  function buildOpenSnooze(target, after) {
    return buildSnoozePanel(async (dueAt, recurrence) => {
      if (target && typeof target === "object" && Number.isInteger(target.windowId)) {
        await ctx.msg({ type: "snooze-window", windowId: target.windowId, dueAt,
          ...(recurrence ? { recurrence } : {}) });
      } else {
        const tabIds = Array.isArray(target) ? target : [target];
        await Promise.all(tabIds.filter(Number.isInteger).map((tabId) =>
          ctx.msg({ type: "snooze-tab", tabId, dueAt, ...(recurrence ? { recurrence } : {}) })
        ));
      }
      after();
    });
  }

  /**
   * F13 — the Open-tabs window "Organize" panel (one spot per window, P-pattern):
   * three one-shot sorts for THIS window + a "Gather a domain…" dropdown that pulls
   * a domain's tabs from every window into a new one. All moves run in the worker
   * (sort-window / gather-domain) with one best-effort undo; the section re-renders
   * after. Pinned tabs are never touched.
   */
  function buildOrganizePanel(win, simpleWindows) {
    const thisTabs = simpleWindows.find((w) => w.id === win.id)?.tabs ?? [];
    const options = gatherOptionsFor(thisTabs, simpleWindows);

    const controls = [
      buildSortChoices(async (mode) => {
        const r = await ctx.msg({ type: "sort-window", windowId: win.id, mode });
        if (r?.ok === false && r.reason === "gone") {
          ctx.flashNote(ctx.getFlashAnchor(), localeMessage("list_sort_window_gone"));
        }
        ctx.rerender();
      })
    ];

    if (options.length > 0) {
      const sel = el("select", { class: "snooze-recur",
        "aria-label": localeMessage("list_gather_domain_aria") },
        el("option", { value: "" }, localeMessage("list_gather_domain_placeholder")),
        ...options.map((o) => el("option", { value: o.domain },
          localeMessage("list_domain_tabs", [o.domain, listUnit("tab", o.count)]))));
      sel.addEventListener("change", async () => {
        const domain = sel.value;
        if (!domain) return;
        const r = await ctx.msg({ type: "gather-domain", domain });
        if (r?.ok === false) ctx.flashNote(ctx.getFlashAnchor(), localeMessage("list_nothing_to_gather"));
        ctx.rerender();
      });
      controls.push(el("label", { class: "palette-field palette-field-inline" },
        el("span", { class: "palette-field-label" }, localeMessage("list_gather")), sel));
    }

    controls.push(el("p", { class: "palette-help organize-hint" },
      localeMessage("list_gather_help")));
    return el("div", { class: "organizebar palette-form" }, ...controls);
  }

  /** Session-drift banner for a window bound to a session that has grown new tabs. */
  function driftBanner(group, bindings, sessionsById) {
    const win = group.data;
    const b = bindings[win.id];
    const boundSession = b ? sessionsById.get(b.sessionId) : null;
    if (!boundSession) return null;
    const projectedUrls = sessionUrlsForWindow(boundSession, b.windowIndex);
    if (projectedUrls === null) return null;
    const sessionUrls = new Set(projectedUrls);
    const httpTabs = (win.tabs ?? []).filter((t) => isHttpTab(t));
    const strays = httpTabs.filter((t) => !sessionUrls.has(normalizeUrl(urlOf(t))));
    if (strays.length === 0 || driftDismissed.get(win.id) === strays.length) return null;
    return el("div", { class: "driftrow" },
      icon("refresh", 14),
      el("span", {}, pluralCategory(strays.length) === "one"
        ? localeMessage("list_session_drift_one", [boundSession.name])
        : localeMessage("list_session_drift_other", [String(strays.length), boundSession.name])),
      el("button", { class: "mini2", title: localeMessage("list_replace_session_window"),
        onclick: async () => { await updateSessionWindow(b.sessionId, b.windowIndex ?? 0, (win.tabs ?? []).filter(isHttpTab).map(toRef)); ctx.rerender(); } },
        localeMessage("list_update_session")),
      el("button", { class: "mini2", "aria-label": localeMessage("list_dismiss_drift"),
        onclick: () => { driftDismissed.set(win.id, strays.length); ctx.rerender(); } }, "×"));
  }

  /** Flatten the generic list selection without teaching the list about tabs. */
  function selectedTabIds(entries) {
    return [...new Set((entries ?? []).flatMap((entry) =>
      (entry.indexes ?? []).map((index) => entry.group.live?.[index]?.tabId))
      .filter(Number.isInteger))];
  }

  /**
   * One UI orchestrator for pointer/keyboard Open moves. Validation, Chrome
   * mutation, and whole-set Undo remain behind the worker's move-tabs seam.
   */
  async function moveOpenTabs(tabIds, destination, afterWindowId = null) {
    const ids = [...new Set((tabIds ?? []).filter(Number.isInteger))];
    if (ids.length === 0) return { ok: false, reason: "empty", moved: 0 };
    openDrag.reset();
    const result = await ctx.msg({ type: "move-tabs", tabIds: ids, destination });
    if (!result?.ok) {
      ctx.showNotice?.(result?.reason === "changed"
        ? localeMessage("list_move_changed_review")
        : localeMessage("list_move_failed"));
      return result ?? { ok: false, reason: "error", moved: 0 };
    }
    if (destination?.kind === "new-window" && Number.isInteger(result.windowId) &&
        Number.isInteger(afterWindowId)) {
      pendingWindowPlacement = { windowId: result.windowId, afterWindowId };
    }
    await Promise.resolve(ctx.rerender());
    return result;
  }

  /** Drag socket for the open-tabs rows (move tabs within/across windows). */
  const openRowDrag = {
    draggable: (c) => c.live.tabId !== undefined && !c.live.pinned,
    onStart: (c, e) => {
      const picked = selectedTabIds(c.dragSelection);
      const tabIds = picked.length > 1 ? picked : [c.live.tabId];
      openDrag.start(c, e, { sourceTabId: c.live.tabId, tabIds }, tabIds.length, c.live.tabId);
      for (const zone of document.querySelectorAll('[data-tablist="open"] .drop-zone-new')) {
        zone.textContent = tabIds.length > 1
          ? localeMessage("list_drop_selected_new_window", [listUnit("tab", tabIds.length)])
          : localeMessage("list_drop_new_window");
      }
    },
    onEnd: () => openDrag.reset(),
    onOver: (c, e) => {
      const drag = openDrag.current();
      if (!drag || drag.tabIds.includes(c.live.tabId)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      c.rowEl.classList.add("drop-target");
    },
    onLeave: (c) => c.rowEl.classList.remove("drop-target"),
    onDrop: async (c, e) => {
      e.preventDefault();
      c.rowEl.classList.remove("drop-target");
      const ids = openDrag.current()?.tabIds ?? [Number(e.dataTransfer.getData("text/plain"))];
      if (ids.length === 0 || ids.includes(c.live.tabId)) return;
      await moveOpenTabs(ids, {
        kind: "window", windowId: c.live.windowId, index: c.live.chromeIndex
      });
    }
  };

  /** Explicit append target after the last rendered row of one live window. */
  function endWindowZone(group) {
    const label = localeMessage("list_move_end_named", [group.title]);
    return createTabDropZone({ className: "drop-zone-window-end", label,
      canDrop: () => Boolean(openDrag.current()), onDrop: async (e) => {
      const ids = openDrag.current()?.tabIds ?? [Number(e.dataTransfer.getData("text/plain"))];
      if (ids.length === 0) return;
      await moveOpenTabs(ids, { kind: "window", windowId: group.data.id, index: -1 });
    } });
  }

  /** P2g-4a: the P5 between-containers zone — drop a dragged tab into a new window. */
  function newWindowZone(afterGroup) {
    return createTabDropZone({ className: "drop-zone-new", text: localeMessage("list_drop_new_window"),
      canDrop: () => Boolean(openDrag.current()), onDrop: async (e) => {
      const ids = openDrag.current()?.tabIds ?? [Number(e.dataTransfer.getData("text/plain"))];
      if (ids.length === 0) return;
      await moveOpenTabs(ids, { kind: "new-window" }, afterGroup?.data?.id);
    } });
  }

  /** F10 — a quiet "these have gone stale" nudge on each Open-tabs window header. */
  function idleNudge(win) {
    return createIdleNudge(win);
  }

  /** F18: does a live window visibly contain any Chrome tab group? */
  function windowHasGroups(win) {
    return (win?.tabs ?? []).some((t) => typeof t.groupId === "number" && t.groupId !== -1);
  }

  /** F18: keep group access beside the unnamed group it can improve. */
  function groupAccessAction(group, unpreserved) {
    if (!unpreserved || group?.named) return null;
    const title = localeMessage("list_show_group_names_title");
    return el("button", {
      class: "mini2 tip open-tab-group-access",
      type: "button",
      title,
      "data-tip": title,
      "aria-label": localeMessage("list_show_group_names"),
      onclick: async (event) => {
        event.stopPropagation();
        const granted = await ensureTabGroupsPermission();
        // A denied browser prompt leaves this contextual retry exactly where it
        // was; no banner disappears and no rows shift underneath the pointer.
        if (!granted) {
          ctx.showNotice?.(localeMessage("settings_group_permission_note"));
          return;
        }
        await patchSettings({ preserveTabGroups: true });
        ctx.rerender();
      }
    }, icon("labels", 13),
    el("span", { class: "open-tab-group-access-label" }, localeMessage("list_show_group_names")));
  }

  /**
   * Gather live windows and build the Open `createTabList`. Returns the heading
   * string always, and the built node — or null when the caller says the body is
   * off-screen (the dashboard keeps its prior subtree so its height holds).
   */
  async function render() {
    const endPrimary = pspan("open:primary-data");
    const renderBody = ctx.shouldRenderBody();
    const awarenessSnapshotRequest = renderBody && ctx.automationAwareness
      ? readAutomationAwarenessSnapshot().catch((error) => {
        reportFailure("Open automation indicators", error);
        return null;
      })
      : null;
    const prefetched = initialSnapshot ? await initialSnapshot : null;
    initialSnapshot = null; // one cold snapshot only; live refreshes always query
    // Start the small Session/binding identity snapshots beside Chrome's live-
    // window query. Full Inbox/Archive label indexing is deliberately excluded
    // from this first-paint gate and starts after the primary node is built.
    // If hidden, retain the old heading-only contract and start neither path.
    const savedSnapshots = !prefetched && renderBody ? Promise.all([
      readSessionIdentities(),
      getSessionBindings()
    ]) : null;
    const currentTabRequest = typeof chrome.tabs?.getCurrent === "function"
      ? chrome.tabs.getCurrent().catch(() => null)
      : Promise.resolve(null);
    const [windows, currentWindow, currentTab] = await Promise.all([
      Promise.resolve(prefetched?.[0] ?? chrome.windows.getAll({ populate: true })),
      chrome.windows.getCurrent().catch(() => null),
      currentTabRequest
    ]);
    // Incognito windows are never shown or captured — EveryTab stays out of them.
    const browserWindowCount = windows.filter((w) => !w.type || w.type === "normal").length;
    const normal = windows.filter((w) => (!w.type || w.type === "normal") && !w.incognito);
    const allTabs = normal.flatMap((w) => w.tabs ?? []);
    const heading = localeMessage("list_open_heading", [
      formatNumber(allTabs.length), listUnit("window", normal.length)
    ]);
    if (!renderBody) {
      endPrimary("heading only");
      return { heading, node: null };
    }

    // These two identity snapshots are independent. Cold Open no longer waits
    // for saved-label enrichment or store-lock binding cleanup before paint.
    const [sessions, storedBindings] = prefetched
      ? prefetched.slice(1, 3)
      : await (savedSnapshots ?? Promise.all([
        readSessionIdentities(),
        getSessionBindings()
      ]));
    const namedSessions = sessions;
    const liveWindowIds = normal.map((w) => w.id);
    const bindings = liveSessionBindings(storedBindings, liveWindowIds);
    if (Object.keys(bindings).length !== Object.keys(storedBindings).length) {
      scheduleBindingPrune();
    }
    const sessionsById = new Map(namedSessions.map((s) => [s.id, s]));
    const sessionMembershipsByUrl = buildSessionMembershipsByUrl(namedSessions);

    // Live membership comes free with tabs. Dashboard performs one optional
    // metadata read so its group headers can use Chrome's name and hue; compact
    // Side Panel remains intentionally flat. Without permission the headers use
    // the same membership with neutral, theme-safe presentation.
    const hasLiveGroups = normal.some(windowHasGroups);
    const needsGroupPermission = hasLiveGroups && ctx.presentation !== "compact";
    const [withGroupPermission, groupSettings] = await Promise.all([
      needsGroupPermission ? hasTabGroupsPermission() : false,
      needsGroupPermission ? getSettings() : null
    ]);
    const liveGroupIds = ctx.presentation === "compact" ? [] : normal.flatMap((win) =>
      (win.tabs ?? []).map((tab) => tab.groupId)
        .filter((groupId) => Number.isInteger(groupId) && groupId !== -1));
    const liveGroupDetails = await fetchLiveGroupDetails(liveGroupIds, withGroupPermission);

    // F18: only pay for settings when a window actually has groups.
    let groupsUnpreserved = false;
    if (groupSettings) {
      groupsUnpreserved = groupSettings.preserveTabGroups === false || !withGroupPermission;
    }
    // F13's complete organization projection is only needed after the user
    // opens Organize. Keep it out of Open's primary preparation path and
    // memoize it for repeated work within this render.
    let simpleWindows = null;
    const getSimpleWindows = () => {
      simpleWindows ??= normal.map((w) => ({ id: w.id, tabs: (w.tabs ?? []).map(organizeTabOf) }));
      return simpleWindows;
    };

    const currentWindowId = currentWindow?.id ?? null;
    const namedGroups = nameAndOrderOpenWindows(
      fromOpenWindows(normal, (url) => savedLabelsByUrl.get(normalizeUrl(url)),
        currentWindowId, currentTab?.id ?? null,
        (url) => sessionMembershipsByUrl.get(normalizeUrl(url)), null, liveGroupDetails),
      bindings, sessionsById, currentWindowId);
    const allGroups = orderOpenWindowGroups(namedGroups, visibleWindowOrder, pendingWindowPlacement);
    visibleWindowOrder = allGroups.map((group) => group.data.id);
    if (pendingWindowPlacement && visibleWindowOrder.includes(pendingWindowPlacement.windowId)) {
      pendingWindowPlacement = null;
    }
    const query = filter.value().trim().toLocaleLowerCase();
    const groups = filterOpenGroups(allGroups, query);
    const awarenessSnapshot = await awarenessSnapshotRequest;
    const awarenessByTabId = awarenessSnapshot
      ? projectOpenAutomationAwareness(windows, awarenessSnapshot)
      : new Map();
    const requestedRowCap = typeof ctx.rowCap === "function" ? ctx.rowCap() : ctx.rowCap;
    // Reuse is deliberately restricted to unchanged surface inputs. The list
    // separately verifies exact per-tab data and complete flat row coverage.
    const placementInputs = JSON.stringify({
      query, requestedRowCap, bindings, sessions, currentWindowId,
      currentTabId: currentTab?.id ?? null, browserWindowCount,
      withGroupPermission, groupSettings, groupsUnpreserved,
      savedLabelGeneration, savedLabelsFresh, savedLabels: [...savedLabelsByUrl], awareness: [...awarenessByTabId].sort(([a], [b]) => a - b)
    });
    if (!query && !openDrag.current() && mountedPlacement?.inputs === placementInputs &&
        mountedPlacement.node.isConnected && ctx.canReconcilePlacement?.() === true) {
      const y = window.scrollY;
      if (reconcileOpenPlacement(mountedPlacement.node, groups)) {
        mountedPlacement.invalidateOrganization();
        if (window.scrollY !== y) window.scrollTo(0, y);
        endPrimary(`${allTabs.length} tabs, placement`);
        startSavedLabelEnrichment(prefetched?.length >= 5 ? prefetched.slice(3, 5) : null);
        return { heading, node: mountedPlacement.node, placementUpdated: true };
      }
    }
    const buildList = () => createTabList({ ...buildOpenListConfig({
      presentation: ctx.presentation ?? "default",
      data: {
        groups, bindings, sessionsById, simpleWindows: getSimpleWindows,
        moveDestinations: allGroups, groupsUnpreserved,
        currentWindowId, browserWindowCount, awarenessByTabId
      },
      rowCap: requestedRowCap ?? OPEN_WINDOW_CAP,
      initialRowBudget: ctx.presentation === "compact" ? Infinity : OPEN_SURFACE_INITIAL_BUDGET,
      msg: ctx.msg, renderOpen: ctx.rerender, renderArchive: ctx.renderArchive,
      renderLabels: ctx.renderLabels, goToLabel: ctx.goToLabel, goToSession: ctx.goToSession, mark: ctx.mark,
      cardLabelPanel: ctx.cardLabelPanel, buildOpenSnooze,
      buildProtectionPanel: (tabId, panel) => buildProtectionPanel(tabId, {
        close: (options) => panel.close(options), onChanged: ctx.rerender,
        openSettings: () => {
          if (ctx.openSettings) ctx.openSettings("protection");
          else void openDashboard("settings:protection");
        }
      }),
      idleNudge: ctx.presentation === "compact" ? null : idleNudge,
      sessionComboboxButton: ctx.sessionComboboxButton, copyRefs: ctx.copyRefs,
      buildOrganizePanel, driftBanner, groupAccessAction,
      openRowDrag, newWindowZone, endWindowZone, moveOpenTabs,
      dragTabIds: () => openDrag.current()?.tabIds ?? [],
      flashNote: ctx.flashNote, showNotice: ctx.showNotice,
      automationAwareness: ctx.automationAwareness,
      empty: query ? localeMessage("list_open_filter_empty") : localeMessage("list_open_empty")
    }), openPlacement: typeof ctx.canReconcilePlacement === "function" });
    const node = ctx.automationAwareness?.withRowRender
      ? ctx.automationAwareness.withRowRender(buildList)
      : buildList();
    mountedPlacement = { node, inputs: placementInputs, invalidateOrganization: () => { simpleWindows = null; } };
    // Harnesses without a section lead retain the control. Production hosts
    // choose either the section action line or a measured local-control row.
    if (!mountedFilterHost) node.prepend(filter.element);
    endPrimary(`${allTabs.length} tabs`);
    startSavedLabelEnrichment(prefetched?.length >= 5 ? prefetched.slice(3, 5) : null);
    return { heading, node };
  }

  return {
    render,
    handleFilterShortcut: filter.handleShortcut,
    // A hidden Dashboard keeps replacing this with the latest background read.
    // Expansion therefore consumes already-started work instead of creating a
    // new cold Chrome/storage waterfall at click time.
    warm(snapshot) {
      initialSnapshot = snapshot;
    },
    invalidateSavedLabels
  };
}
