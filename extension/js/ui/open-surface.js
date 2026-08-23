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
import { clearSelection, createTabList, fromOpenWindows, nameAndOrderOpenWindows } from "./tablist.js";
import { buildOpenListConfig } from "./list-configs.js";
import { orderOpenWindowGroups } from "./open-window-order.js";
import { STORE_KEYS } from "../lib/types.js";
import { listItems, getSettings, patchSettings } from "../lib/store.js";
import {
  getSessionBindings, liveSessionBindings, pruneSessionBindings, updateSessionWindow
} from "../lib/sessions.js";
import { hasTabGroupsPermission, ensureTabGroupsPermission } from "../lib/tab-groups.js";
import { normalizeUrl } from "../lib/dedup.js";
import { buildSavedLabelsByUrl } from "../lib/saved-label-index.js";
import { readSessionIdentities, sessionUrlsForWindow } from "../lib/session-identity-index.js";
import { isHttpTab, urlOf, toRef, organizeTabOf } from "../lib/tabs.js";
import { gatherOptionsFor } from "../lib/organize.js";
import { RECURRENCE_OPTIONS, presetDue } from "../lib/snooze.js";
import { buildSortChoices } from "./list-helpers.js";
import { listRecurrenceOptionLabel, listSnoozePresetLabel, listUnit } from "./list-copy.js";
import { formatNumber, msg as localeMessage, pluralCategory } from "../lib/i18n.js";
import { pspan } from "../lib/perf.js";

/** Cap rows shown per window before a "show all" (mirrors Archive's cap of 20). */
const OPEN_WINDOW_CAP = 20;
const IDLE_NUDGE_MS = 4 * 3600_000;

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
    const indexes = group.refs.map((ref, index) => ({ ref, index }))
      .filter(({ ref }) => `${ref.title ?? ""}\n${ref.url ?? ""}`.toLocaleLowerCase().includes(query))
      .map(({ index }) => index);
    return {
      ...group,
      refs: indexes.map((index) => group.refs[index]),
      live: indexes.map((index) => group.live?.[index])
    };
  }).filter((group) => group.refs.length > 0);
}

/**
 * @typedef {object} OpenSurfaceCtx
 * @property {(m: object) => Promise<any>} msg background message helper
 * @property {() => void} rerender refresh this surface's Open section
 * @property {() => boolean} shouldRenderBody skip the heavy build when off-screen
 * @property {HTMLElement} [sectionActionHost] stable header action lane
 * @property {() => Element} getFlashAnchor element to flash validation notes near
 * @property {(m: string) => void} showNotice transient notice/toast sink
 * @property {(anchor: Element, text: string) => void} flashNote
 * @property {(ic: Node, label: string) => Node} mark
 * @property {Function} cardLabelPanel @property {Function} sessionComboboxButton
 * @property {(refs: any[], heading?: string) => void} copyRefs
 * @property {() => void} renderArchive @property {() => void} renderLabels
 * @property {(label: string) => void} goToLabel
 * @property {() => Promise<any[]|null>|null} [takeInitialSnapshot]
 * @property {"default"|"compact"} [presentation]
 * @property {number|(() => number|undefined)} [rowCap]
 */

/**
 * @param {OpenSurfaceCtx} ctx
 * @returns {{
 *   render: () => Promise<{heading: string, node: Node|null}>,
 *   warm: (snapshot: Promise<any[]|null>|any[]|null) => void,
 *   invalidateSavedLabels: () => void
 * }}
 */
export function createOpenSurface(ctx) {
  /** @type {{sourceTabId:number,tabIds:number[],sourceRowEl:HTMLElement}|null} stable pointer-drag payload */
  let dragState = null;
  let dragRevealTimer = 0;
  let dragPreview = null;
  /** Last visible window-card order for this Dashboard/side-panel surface. */
  let visibleWindowOrder = [];
  /** @type {{windowId:number,afterWindowId:number}|null} */
  let pendingWindowPlacement = null;
  /** @type {Map<number, number>} windowId → stray count at dismissal (drift banner) */
  const driftDismissed = new Map();
  // F18: the contextual group-preservation nudge shows at most once per surface.
  let groupNudgeRetired = false;
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
  let filterText = "";
  let filterTimer = 0;
  const filterInput = el("input", {
    type: "search",
    class: "open-filter-input",
    placeholder: localeMessage("list_filter_tabs_placeholder"),
    "aria-label": localeMessage("list_filter_open_tabs_aria")
  });
  const filterControl = el("div", { class: "open-filter-control" }, filterInput);
  const clearFilter = () => {
    filterText = "";
    filterInput.value = "";
    clearTimeout(filterTimer);
    return Promise.resolve(ctx.rerender());
  };
  filterInput.addEventListener("input", () => {
    filterText = filterInput.value;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      const start = filterInput.selectionStart ?? filterText.length;
      Promise.resolve(ctx.rerender()).then(() => requestAnimationFrame(() => {
        filterInput.focus({ preventScroll: true });
        filterInput.setSelectionRange(start, start);
      }));
    }, 60);
  });
  filterInput.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (filterText) clearFilter();
  });
  ctx.sectionActionHost?.prepend(filterControl);

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

  /** Open-tabs per-tab snooze panel (sends snooze-tab per preset, then re-renders). */
  function buildOpenSnooze(tabIdOrIds, after) {
    const tabIds = Array.isArray(tabIdOrIds) ? tabIdOrIds : [tabIdOrIds];
    const recur = el("select", { class: "snooze-recur", "aria-label": localeMessage("list_repeat") },
      ...RECURRENCE_OPTIONS.map(([v, l]) =>
        el("option", { value: v }, listRecurrenceOptionLabel(v, l))));
    const mk = (label, preset) => el("button", { class: "mini", onclick: async () => {
      const recurrence = recur.value;
      await Promise.all(tabIds.map((tabId) =>
        ctx.msg({ type: "snooze-tab", tabId, dueAt: presetDue(preset), ...(recurrence ? { recurrence } : {}) })
      ));
      after();
    } }, label);
    return el("div", { class: "snoozebar palette-form" },
      el("div", { class: "palette-field" },
        el("span", { class: "palette-field-label" }, localeMessage("list_quick_choices")),
        el("div", { class: "palette-choice-grid" },
          mk(listSnoozePresetLabel("later-today"), "later-today"),
          mk(listSnoozePresetLabel("this-evening"), "this-evening"),
          mk(listSnoozePresetLabel("tomorrow"), "tomorrow"),
          mk(listSnoozePresetLabel("weekend"), "weekend"),
          mk(listSnoozePresetLabel("next-week"), "next-week"))),
      el("label", { class: "palette-field palette-field-inline" },
        el("span", { class: "palette-field-label" }, localeMessage("list_repeat")), recur));
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
        onclick: async () => { await updateSessionWindow(b.sessionId, b.windowIndex ?? 0, httpTabs.map(toRef)); ctx.rerender(); } },
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

  function resetPointerDrag() {
    clearTimeout(dragRevealTimer);
    dragState?.sourceRowEl?.classList.remove("dragging");
    dragState = null;
    dragPreview?.remove();
    dragPreview = null;
    document.body.classList.remove("tab-dragging");
    for (const zone of document.querySelectorAll('[data-tablist="open"] .drop-zone-new')) {
      zone.textContent = localeMessage("list_drop_new_window");
    }
  }

  function mountDragPreview(tabCount) {
    dragPreview?.remove();
    dragPreview = el("div", { class: "open-drag-preview", "aria-hidden": "true" },
      icon("open", 16),
      el("span", {}, listUnit("tab", tabCount)));
    document.body.append(dragPreview);
    return dragPreview;
  }

  /**
   * One UI orchestrator for pointer/keyboard Open moves. Validation, Chrome
   * mutation, and whole-set Undo remain behind the worker's move-tabs seam.
   */
  async function moveOpenTabs(tabIds, destination, afterWindowId = null) {
    const ids = [...new Set((tabIds ?? []).filter(Number.isInteger))];
    if (ids.length === 0) return { ok: false, reason: "empty", moved: 0 };
    resetPointerDrag();
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
    clearSelection("open");
    await Promise.resolve(ctx.rerender());
    return result;
  }

  /** Drag socket for the open-tabs rows (move tabs within/across windows). */
  const openRowDrag = {
    draggable: (c) => c.live.tabId !== undefined && !c.live.pinned,
    onStart: (c, e) => {
      resetPointerDrag();
      const picked = selectedTabIds(c.dragSelection);
      const tabIds = picked.length > 1 ? picked : [c.live.tabId];
      dragState = { sourceTabId: c.live.tabId, tabIds, sourceRowEl: c.rowEl };
      c.rowEl.classList.add("dragging");
      for (const zone of document.querySelectorAll('[data-tablist="open"] .drop-zone-new')) {
        zone.textContent = tabIds.length > 1
          ? localeMessage("list_drop_selected_new_window", [listUnit("tab", tabIds.length)])
          : localeMessage("list_drop_new_window");
      }
      // P2g-4a fix: Chrome cancels a drag whose source node moves during dragstart.
      // Reveal the zones one tick later, after dragstart returns.
      dragRevealTimer = setTimeout(() => document.body.classList.add("tab-dragging"), 0);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(c.live.tabId));
      e.dataTransfer.setDragImage?.(mountDragPreview(tabIds.length), 18, 18);
    },
    onEnd: () => resetPointerDrag(),
    onOver: (c, e) => {
      if (!dragState || dragState.tabIds.includes(c.live.tabId)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      c.rowEl.classList.add("drop-target");
    },
    onLeave: (c) => c.rowEl.classList.remove("drop-target"),
    onDrop: async (c, e) => {
      e.preventDefault();
      c.rowEl.classList.remove("drop-target");
      const ids = dragState?.tabIds ?? [Number(e.dataTransfer.getData("text/plain"))];
      if (ids.length === 0 || ids.includes(c.live.tabId)) return;
      await moveOpenTabs(ids, {
        kind: "window", windowId: c.live.windowId, index: c.live.chromeIndex
      });
    }
  };

  /** Explicit append target after the last rendered row of one live window. */
  function endWindowZone(group) {
    const label = localeMessage("list_move_end_named", [group.title]);
    const z = el("div", { class: "drop-zone-window-end", role: "separator",
      "aria-orientation": "horizontal", "aria-label": label, title: label });
    z.addEventListener("dragover", (e) => {
      if (!dragState) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      z.classList.add("on");
    });
    z.addEventListener("dragleave", () => z.classList.remove("on"));
    z.addEventListener("drop", async (e) => {
      e.preventDefault();
      z.classList.remove("on");
      const ids = dragState?.tabIds ?? [Number(e.dataTransfer.getData("text/plain"))];
      if (ids.length === 0) return;
      await moveOpenTabs(ids, { kind: "window", windowId: group.data.id, index: -1 });
    });
    return z;
  }

  /** P2g-4a: the P5 between-containers zone — drop a dragged tab into a new window. */
  function newWindowZone(afterGroup) {
    const z = el("div", { class: "drop-zone-new" }, localeMessage("list_drop_new_window"));
    z.addEventListener("dragover", (e) => {
      if (!dragState) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      z.classList.add("on");
    });
    z.addEventListener("dragleave", () => z.classList.remove("on"));
    z.addEventListener("drop", async (e) => {
      e.preventDefault();
      z.classList.remove("on");
      const ids = dragState?.tabIds ?? [Number(e.dataTransfer.getData("text/plain"))];
      if (ids.length === 0) return;
      await moveOpenTabs(ids, { kind: "new-window" }, afterGroup?.data?.id);
    });
    return z;
  }

  /** F10 — a quiet "these have gone stale" nudge on each Open-tabs window header. */
  function idleNudge(win) {
    const now = Date.now();
    let n = 0;
    for (const t of win?.tabs ?? []) {
      if (typeof t.lastAccessed === "number" && now - t.lastAccessed > IDLE_NUDGE_MS) n++;
    }
    if (n === 0) return el("span", {}); // nothing idle (also the lastAccessed-missing case)
    return el("span", {
      class: "item-meta idle-nudge",
      title: localeMessage("list_idle_tabs_title")
    }, localeMessage("list_idle_tabs_count", [listUnit("tab", n)]));
  }

  /** F18: does a live window visibly contain any Chrome tab group? */
  function windowHasGroups(win) {
    return (win?.tabs ?? []).some((t) => typeof t.groupId === "number" && t.groupId !== -1);
  }

  /** F18 nudge: a window visibly has tab groups but preservation is off/unpermitted. */
  function groupNudge(win, unpreserved) {
    if (groupNudgeRetired || !unpreserved || !windowHasGroups(win)) return null;
    return el("div", { class: "driftrow group-nudge" },
      icon("labels", 14),
      el("span", {}, localeMessage("list_group_preservation_nudge")),
      el("button", { class: "mini2", onclick: async () => {
        groupNudgeRetired = true;
        await ensureTabGroupsPermission();
        await patchSettings({ preserveTabGroups: true });
        ctx.rerender();
      } }, localeMessage("list_enable")),
      el("button", { class: "mini2", "aria-label": localeMessage("list_dismiss"),
        onclick: () => { groupNudgeRetired = true; ctx.rerender(); } }, "×"));
  }

  /**
   * Gather live windows and build the Open `createTabList`. Returns the heading
   * string always, and the built node — or null when the caller says the body is
   * off-screen (the dashboard keeps its prior subtree so its height holds).
   */
  async function render() {
    const endPrimary = pspan("open:primary-data");
    const prefetched = initialSnapshot ? await initialSnapshot : null;
    initialSnapshot = null; // one cold snapshot only; live refreshes always query
    // Start the small Session/binding identity snapshots beside Chrome's live-
    // window query. Full Inbox/Archive label indexing is deliberately excluded
    // from this first-paint gate and starts after the primary node is built.
    // If hidden, retain the old heading-only contract and start neither path.
    const savedSnapshots = !prefetched && ctx.shouldRenderBody() ? Promise.all([
      readSessionIdentities(),
      getSessionBindings()
    ]) : null;
    const [windows, currentWindow] = await Promise.all([
      Promise.resolve(prefetched?.[0] ?? chrome.windows.getAll({ populate: true })),
      chrome.windows.getCurrent().catch(() => null)
    ]);
    // Incognito windows are never shown or captured — EveryTab stays out of them.
    const browserWindowCount = windows.filter((w) => !w.type || w.type === "normal").length;
    const normal = windows.filter((w) => (!w.type || w.type === "normal") && !w.incognito);
    const allTabs = normal.flatMap((w) => w.tabs ?? []);
    const heading = localeMessage("list_open_heading", [
      formatNumber(allTabs.length), listUnit("window", normal.length)
    ]);
    if (!ctx.shouldRenderBody()) {
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

    // F18: only pay for the settings/permission read when a window actually has groups.
    let groupsUnpreserved = false;
    if (!groupNudgeRetired && normal.some(windowHasGroups)) {
      const settings = await getSettings();
      groupsUnpreserved = settings.preserveTabGroups === false || !(await hasTabGroupsPermission());
    }
    // P2g-2r: an open tab whose URL matches a labeled saved tab shows those labels
    // as read-only chips (labeling an open tab visibly sticks).
    // F13: canonical per-window tab shapes for the Organize panel's sort/gather planning.
    const simpleWindows = normal.map((w) => ({ id: w.id, tabs: (w.tabs ?? []).map(organizeTabOf) }));

    const currentWindowId = currentWindow?.id ?? null;
    const namedGroups = nameAndOrderOpenWindows(
      fromOpenWindows(normal, (url) => savedLabelsByUrl.get(normalizeUrl(url)), currentWindowId),
      bindings, sessionsById, currentWindowId);
    const allGroups = orderOpenWindowGroups(namedGroups, visibleWindowOrder, pendingWindowPlacement);
    visibleWindowOrder = allGroups.map((group) => group.data.id);
    if (pendingWindowPlacement && visibleWindowOrder.includes(pendingWindowPlacement.windowId)) {
      pendingWindowPlacement = null;
    }
    const query = filterText.trim().toLocaleLowerCase();
    const groups = filterOpenGroups(allGroups, query);
    const requestedRowCap = typeof ctx.rowCap === "function" ? ctx.rowCap() : ctx.rowCap;
    const node = createTabList(buildOpenListConfig({
      presentation: ctx.presentation ?? "default",
      data: {
        groups, bindings, sessionsById, simpleWindows, moveDestinations: allGroups, groupsUnpreserved,
        currentWindowId, browserWindowCount
      },
      rowCap: query ? Number.MAX_SAFE_INTEGER : (requestedRowCap ?? OPEN_WINDOW_CAP),
      msg: ctx.msg, renderOpen: ctx.rerender, renderArchive: ctx.renderArchive,
      renderLabels: ctx.renderLabels, goToLabel: ctx.goToLabel, mark: ctx.mark,
      cardLabelPanel: ctx.cardLabelPanel, buildOpenSnooze,
      idleNudge: ctx.presentation === "compact" ? null : idleNudge,
      sessionComboboxButton: ctx.sessionComboboxButton, copyRefs: ctx.copyRefs,
      buildOrganizePanel, driftBanner, groupNudge,
      openRowDrag, newWindowZone, endWindowZone, moveOpenTabs,
      dragTabIds: () => dragState?.tabIds ?? [],
      flashNote: ctx.flashNote, showNotice: ctx.showNotice,
      empty: query ? localeMessage("list_open_filter_empty") : localeMessage("list_open_empty")
    }));
    // Harnesses without a section lead retain the control, but production
    // Dashboard and side panel mount it in their persistent action line.
    if (!ctx.sectionActionHost) node.prepend(filterControl);
    endPrimary(`${allTabs.length} tabs`);
    startSavedLabelEnrichment(prefetched?.length >= 5 ? prefetched.slice(3, 5) : null);
    return { heading, node };
  }

  return {
    render,
    // A hidden Dashboard keeps replacing this with the latest background read.
    // Expansion therefore consumes already-started work instead of creating a
    // new cold Chrome/storage waterfall at click time.
    warm(snapshot) {
      initialSnapshot = snapshot;
    },
    invalidateSavedLabels
  };
}
