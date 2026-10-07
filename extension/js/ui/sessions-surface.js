// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * F14 — the shared Sessions surface.
 *
 * `createSessionsSurface(ctx)` owns everything the Sessions section needs that is
 * NOT a generic `createTabList` config: the ordered data-gathering, the per-session
 * selected-set adapter for the shared drag controller (moves within one Session,
 * terminal window targets, and new-window-block zones scoped to that card), the
 * "save all open windows" toolbar, and
 * the tab-grain selection/bulk actions. It holds the per-surface drag state those
 * pieces need across renders. It builds Sessions via the shared
 * `buildSessionListConfig` (also used by the dashboard's Snapshots), so there is one
 * behavior source (spec §5.1/§5.2).
 *
 * `render()` returns `{ heading, node, named, sortMode }`: the built tablist plus the
 * sorted session list and sort mode, so each host can wrap it with its own index bar
 * (the filter/sort/jump chrome stays per-host because its jump-scroll is
 * host-specific — page scroll on the dashboard, panel scroll in the side panel).
 *
 * Surface-specific pieces are injected via `ctx`; domain ops are imported. This
 * module performs no storage read-modify-write of its own.
 */
import { el, coalesce, settleAnchor, settleCue } from "./dom.js";
import { formatNumber, msg as localeMessage } from "../lib/i18n.js";
import { pointerDriven } from "./input-modality.js";
import { createIndexBar } from "./indexbar.js";
import { clearSelection, createTabList } from "./tablist.js";
import { buildSessionListConfig } from "./list-configs.js";
import { createTabDragController, createTabDropZone } from "./tab-drag.js";
import { selectionActionButton } from "./list-helpers.js";
import { STORE_KEYS } from "../lib/types.js";
import { listItems, listNamedSessions, getSettings, patchSettings } from "../lib/store.js";
import {
  sortSessions, moveSessionTabsWithin, moveSessionTabs, restoreSessionTabs, deleteSessionTabs,
  saveAllWindowsAsSession, addAllWindowsToSession, sessionTabCount
} from "../lib/sessions.js";
import { labelSessionTabs } from "../lib/labels.js";
import { readOrganizationState, projectOrganization } from "../lib/organization.js";
import {
  ALL_ORGANIZATION_LENS, createOrganizationControls, membersForOrganizationLens,
  revealOrganizationLensResult
} from "./organization-controls.js";

/**
 * @typedef {object} SessionsSurfaceCtx
 * @property {() => void} ctx.rerender @property {() => boolean} ctx.shouldRenderBody
 * @property {() => Element} ctx.getBody active host for the index + list
 * @property {(heading: string) => void} ctx.setHeading
 * @property {() => boolean} ctx.isActive
 * @property {() => void} ctx.activate
 * @property {() => number} ctx.stickyOffset
 * @property {() => void} ctx.renderLabels @property {() => void} ctx.renderSnoozes
 * @property {(label: string) => void} ctx.goToLabel
 * @property {(m: object) => Promise<any>} ctx.msg
 * @property {(m: string) => void} ctx.showNotice @property {(entry: any) => void} ctx.showToast
 * @property {(refs: any[], heading?: string) => void} ctx.copyRefs
 * @property {Function} ctx.sessionComboboxButton @property {Function} ctx.cardLabelPanel
 * @property {Function} ctx.confirmDelete @property {(anchor: Element, text: string) => void} ctx.flashNote
 * @property {Function} ctx.buildSnoozePanel @property {(session: any) => void} ctx.copySession
 * @property {(session: any, rerender: () => void) => Promise<void>} ctx.delSession
 * @property {Element} [ctx.sectionActionHost] host-owned sticky section action lane
 * @property {"default"|"compact"} [ctx.presentation]
 */

/**
 * @param {SessionsSurfaceCtx} ctx
 * @returns {{ render: () => Promise<{heading: string, node: Node|null, named: any[], sortMode: string}>,
 *   goToSession: (id: string) => Promise<void>, setGroupLens: (id: string) => Promise<void>,
 *   goToGroup: (id: string) => Promise<void>, positionSessionCard: (id: string) => void }}
 */
export function createSessionsSurface(ctx) {
  let sessionFilter = "";
  let activeGroupLens = ALL_ORGANIZATION_LENS;
  let jumpSessionId = null;
  let jumpCueSessionId = null;

  const jumpCueFrames = new WeakMap();
  const jumpCueCleanups = new WeakMap();
  const jumpCueTimers = new WeakMap();

  function sessionCardEl(id) {
    return ctx.getBody().querySelector(`[data-tablist-card="${CSS.escape(id)}"]`);
  }

  function cueSessionJumpArrival(card) {
    if (!card?.isConnected) return;
    cancelAnimationFrame(jumpCueFrames.get(card));
    clearTimeout(jumpCueTimers.get(card));
    const oldCleanup = jumpCueCleanups.get(card);
    if (oldCleanup) card.removeEventListener("animationend", oldCleanup);
    card.classList.remove("jump-arrival");
    const frame = requestAnimationFrame(() => {
      jumpCueFrames.delete(card);
      if (!card.isConnected) return;
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
        card.classList.add("jump-arrival");
        const timer = setTimeout(() => {
          jumpCueTimers.delete(card);
          card.classList.remove("jump-arrival");
        }, 540);
        jumpCueTimers.set(card, timer);
        return;
      }
      const cleanup = (event) => {
        if (event.animationName !== "jump-arrival") return;
        card.removeEventListener("animationend", cleanup);
        jumpCueCleanups.delete(card);
        card.classList.remove("jump-arrival");
      };
      jumpCueCleanups.set(card, cleanup);
      card.addEventListener("animationend", cleanup);
      card.classList.add("jump-arrival");
    });
    jumpCueFrames.set(card, frame);
  }

  function positionSessionCard(id, { cue = false } = {}) {
    const card = sessionCardEl(id);
    if (!card) return;
    card.style.scrollMarginTop = `${ctx.stickyOffset() + 12}px`;
    card.scrollIntoView({ block: "start", behavior: "auto" });
    if (cue) cueSessionJumpArrival(card);
  }

  /** Keep same-page index jumps inside the current group lens and filter. */
  function jumpWithinSessionLens(id) {
    positionSessionCard(id, { cue: pointerDriven() });
  }

  async function goToSession(id) {
    const cue = pointerDriven();
    const already = ctx.isActive();
    const hadGroupLens = activeGroupLens !== ALL_ORGANIZATION_LENS;
    activeGroupLens = ALL_ORGANIZATION_LENS;
    sessionFilter = "";
    ctx.activate();
    const present = sessionCardEl(id);
    if (present && !hadGroupLens) positionSessionCard(id);
    jumpSessionId = id;
    jumpCueSessionId = cue ? id : null;
    await render();
    jumpSessionId = null;
    jumpCueSessionId = null;
    positionSessionCard(id);
    settleAnchor(() => positionSessionCard(id));
    if (cue) settleCue(() => sessionCardEl(id), cueSessionJumpArrival);
    if (already && present && !hadGroupLens && cue) cueSessionJumpArrival(sessionCardEl(id));
  }

  async function setGroupLens(id) {
    activeGroupLens = id || ALL_ORGANIZATION_LENS;
    sessionFilter = "";
    ctx.activate();
    await render();
    revealOrganizationLensResult(ctx.getBody(), ctx.stickyOffset());
    settleAnchor(() => revealOrganizationLensResult(ctx.getBody(), ctx.stickyOffset()));
  }

  /* ---- Sessions drag — reorder selected rows / cross-window drops / new-window
   * block, all WITHIN one session (cross-session moves go through → Session merge).
   * zones reveal on a tick (0.8.29 lesson) and only inside the dragged row's
   * own card (`.drag-home`); nothing steals focus. Snapshots never drag. ---- */

  const sessionDrag = createTabDragController({ bodyClass: "session-dragging", scopeHome: true });

  function selectedSessionPicks(entries, sessionId) {
    return entries?.find((entry) => entry.group.data.id === sessionId)?.picks ?? [];
  }

  function sourceContains(drag, wi, index) {
    return drag?.picks.some((pick) =>
      pick.windowIndex === wi && pick.indexes.includes(index));
  }

  const sessionRowDrag = {
    draggable: (c) => !c.group.data.auto,
    onStart: (c, e) => {
      const selected = selectedSessionPicks(c.dragSelection, c.group.data.id);
      const count = selected.reduce((total, pick) => total + pick.indexes.length, 0);
      const picks = count > 1 ? selected : [{ windowIndex: c.windowIndex, indexes: [c.index] }];
      sessionDrag.start(c, e, {
        session: structuredClone(c.group.data), picks
      }, picks.reduce((total, pick) => total + pick.indexes.length, 0));
    },
    onEnd: () => sessionDrag.reset(),
    onOver: (c, e) => {
      const drag = sessionDrag.current();
      if (!drag || drag.session.id !== c.group.data.id) return; // same session only
      if (sourceContains(drag, c.windowIndex, c.index)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      c.rowEl.classList.add("drop-target");
    },
    onLeave: (c) => c.rowEl.classList.remove("drop-target"),
    onDrop: async (c, e) => {
      e.preventDefault();
      c.rowEl.classList.remove("drop-target");
      await dropSessionTabs(c.group.data, { wi: c.windowIndex, index: c.index });
    }
  };

  /** Perform the drop; `target` is a saved window position or a new window slot. */
  async function dropSessionTabs(session, target) {
    const d = sessionDrag.current();
    if (!d || session.id !== d.session.id) return;
    sessionDrag.reset();
    const res = await moveSessionTabsWithin(d.session, d.picks, target);
    if (!res.ok && res.stale) ctx.showNotice(localeMessage("list_changed_nothing_moved"));
    if (res.ok && !res.noop) clearSelection("sessions");
    ctx.rerender();
  }

  /** The between-blocks zone of a session card: drop = new window block there. */
  function newBlockZone(group, wi) {
    return createTabDropZone({ className: "drop-zone-new",
      text: localeMessage("list_drop_new_session_window"),
      canDrop: () => sessionDrag.current()?.session.id === group.id,
      onDrop: () => dropSessionTabs(group.data, { newAt: wi + 1 }) });
  }

  function endSessionWindowZone(group, window, wi) {
    const label = localeMessage("list_move_end_named", [window.meta]);
    return createTabDropZone({ className: "drop-zone-window-end", label,
      canDrop: () => sessionDrag.current()?.session.id === group.id,
      onDrop: () => dropSessionTabs(group.data, { wi, index: -1 }) });
  }

  /** Thin adapter over the shared session config, injecting this surface's helpers. */
  function sessionListConfig(
    section, sessions, rerender, extra, organizationCardAction = null, sessionTargetCount = 0
  ) {
    return buildSessionListConfig({
      section, sessions, rerender, extra,
      renderLabels: ctx.renderLabels, renderSnoozes: ctx.renderSnoozes, goToLabel: ctx.goToLabel,
      msg: ctx.msg, cardLabelPanel: ctx.cardLabelPanel, copySession: ctx.copySession,
      buildSnoozePanel: ctx.buildSnoozePanel, confirmDelete: ctx.confirmDelete, delSession: ctx.delSession,
      showNotice: ctx.showNotice,
      organizationCardAction,
      sessionComboboxButton: ctx.sessionComboboxButton,
      sessionTargetCount
    });
  }

  function buildSessionIndex(sorted, sortMode, onFilter, groupRow) {
    return createIndexBar({
      placeholder: localeMessage("list_filter_sessions_placeholder"),
      filterAria: localeMessage("list_filter_sessions_aria"),
      filterValue: sessionFilter,
      onFilter: (text) => { sessionFilter = text; onFilter?.(text); },
      sortModes: [
        { id: "az", label: localeMessage("list_sort_az") },
        { id: "count", label: localeMessage("list_sort_most_tabs") },
        { id: "recent", label: localeMessage("list_sort_recent") }
      ],
      sortMode, sortAria: localeMessage("list_sort_sessions"),
      onSort: async (mode) => {
        await patchSettings({ uiSessionSort: mode });
        ctx.rerender();
      },
      items: sorted.map((session) => ({
        key: session.id, text: session.name || localeMessage("list_unnamed"), count: sessionTabCount(session)
      })),
      onJump: jumpWithinSessionLens,
      emptyText: (q) => q
        ? localeMessage("list_no_sessions_match", [q])
        : localeMessage("list_no_sessions_view"),
      groupRow
    });
  }

  const render = coalesce(async () => {
    /** @type {import("../lib/types.js").Session[]} */
    const all = await listNamedSessions();
    const sortMode = (await getSettings()).uiSessionSort ?? "recent";
    const named = sortSessions(all, sortMode); // N32: cards render in this order
    const organizationState = await readOrganizationState("session");
    const projection = projectOrganization("session", named, organizationState,
      { memberKey: (session) => session.id });
    if (activeGroupLens !== ALL_ORGANIZATION_LENS &&
        activeGroupLens !== "ungrouped" && !projection.groupById.has(activeGroupLens)) {
      activeGroupLens = ALL_ORGANIZATION_LENS;
    }
    const visibleSessions = membersForOrganizationLens(projection, activeGroupLens);
    const heading = localeMessage("list_sessions_heading", [formatNumber(named.length)]);
    if (!ctx.shouldRenderBody()) return { heading, node: null, named, sortMode };
    ctx.setHeading(heading);
    // P2g-5: which sessions have a scheduled restore (badge + Snooze/Cancel swap)
    const sessionSnoozes = new Map(
      (await listItems(STORE_KEYS.snoozes)).filter((s) => s.sessionId).map((s) => [s.sessionId, s]));
    // U6 (P2g-3): selection entries for sessions carry per-window `picks`
    const toSessionSources = (sel) => sel.map((s) => ({ session: s.group.data, picks: s.picks ?? [] }));
    const flatPicks = (picks) => picks.flatMap((p) => p.indexes.map((i) => ({ wi: p.windowIndex, i })));
    const saveOpenWindows = ctx.sessionComboboxButton(
      ctx.sectionActionHost
        ? localeMessage("list_save_all_to_session")
        : localeMessage("list_save_all_windows_as_session"), {
        cls: ctx.sectionActionHost ? "section-session-save tip" : "",
        title: localeMessage("list_save_all_windows_session_title"),
        onPick: async (v) => {
          const result = v.isNew
            ? await saveAllWindowsAsSession(v.name || undefined, v.organization)
            : await addAllWindowsToSession(v.id);
          if (result?.id) ctx.rerender();
          return Boolean(result?.id);
        }
      }
    );
    if (ctx.sectionActionHost) ctx.sectionActionHost.replaceChildren(saveOpenWindows);

    const controls = createOrganizationControls({
      kind: "session", members: named, memberKey: (session) => session.id,
      projection, activeLens: activeGroupLens,
      onLensChange: setGroupLens,
      onChange: render, showNotice: ctx.showNotice, focusRoot: ctx.getBody
    });

    const node = createTabList(sessionListConfig("sessions", visibleSessions, ctx.rerender, {
      presentation: ctx.presentation ?? "default",
      sessionSnoozes,
      // P2g-4c: drag within a session — rows, block headers (append), and
      // between-block zones (new window block). Snapshots never get these
      // (separate section; and draggable() refuses `auto` regardless).
      rowDrag: sessionRowDrag,
      windowGap: (g, wi) => newBlockZone(g, wi),
      windowEndZone: (g, w, wi) => endSessionWindowZone(g, w, wi),
      onWindowDragOver: (g, _w, _wi, e) => {
        if (sessionDrag.current()?.session.id !== g.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        e.currentTarget.classList.add("drop-target");
      },
      onWindowDragLeave: (_g, _w, _wi, e) => e.currentTarget.classList.remove("drop-target"),
      onWindowDrop: async (g, _w, wi, e) => {
        e.preventDefault();
        e.currentTarget.classList.remove("drop-target");
        await dropSessionTabs(g.data, { wi, index: -1 }); // append to this window
      },
      toolbar: ctx.sectionActionHost ? null : el("div", { class: "bulk-bar" }, saveOpenWindows),
      selectable: "tab",
      bulkHint: localeMessage("list_sessions_bulk_hint"),
      bulkActions: (c) => {
        const applyLabels = async (labels) => {
            for (const { session, picks } of toSessionSources(c.selection)) {
              await labelSessionTabs(session, labels, flatPicks(picks));
            }
            await Promise.resolve(c.rerender());
            ctx.renderLabels();
        };
        return [
          ctx.sessionComboboxButton(localeMessage("list_to_session"), {
            actionId: "session",
            title: localeMessage("list_sessions_move_selected_title"),
            onPick: async (v) => {
              const res = await moveSessionTabs(toSessionSources(c.selection),
                v.isNew ? "__new" : v.id, v.isNew ? (v.name || undefined) : undefined,
                v.organization);
              if (!res?.moved) return false;
              await Promise.resolve(c.rerender());
              if (res.entry) ctx.showToast(res.entry);
              return true;
            }
          }),
          selectionActionButton("restore", localeMessage("search_action_restore"), "switch", {
            title: localeMessage("list_sessions_restore_selected_title"),
            onclick: async () => {
              for (const { session, picks } of toSessionSources(c.selection)) {
                await restoreSessionTabs(session, picks);
              }
            }
          }),
          selectionActionButton("copy", localeMessage("action_copy"), "copy", {
            title: localeMessage("list_copy_selected_title"),
            onclick: () => ctx.copyRefs(toSessionSources(c.selection).flatMap(({ session, picks }) =>
              picks.flatMap((p) => p.indexes.map((i) => session.windows[p.windowIndex]?.[i]))))
          }),
          selectionActionButton("label", localeMessage("action_label"), "labels", {
            title: localeMessage("list_sessions_add_labels_title"),
            onclick: () => c.panel.toggle(() => ctx.cardLabelPanel(
              applyLabels, localeMessage("list_apply_labels"), c.panel), "bulk-label")
          }),
          ctx.confirmDelete(async () => {
            const result = await deleteSessionTabs(toSessionSources(c.selection));
            if (result.stale) {
              ctx.showNotice(localeMessage("list_changed_review_selection"));
              return;
            }
            await Promise.resolve(c.rerender());
            ctx.renderLabels();
            if (result.entry) ctx.showToast(result.entry);
          }, localeMessage("action_delete"), localeMessage("list_delete_selected_tabs_question"))
        ];
      },
      empty: activeGroupLens === ALL_ORGANIZATION_LENS
        ? localeMessage("list_sessions_empty")
        : localeMessage("list_sessions_group_empty")
    }, controls.cardAction, named.length));

    const nameById = new Map(visibleSessions.map((session) =>
      [session.id, (session.name || localeMessage("list_unnamed")).toLocaleLowerCase()]));
    const emptyMsg = el("div", { class: "note" }, localeMessage("list_sessions_filter_empty"));
    emptyMsg.style.display = "none";
    const filterCards = (text) => {
      const q = String(text ?? "").trim().toLocaleLowerCase();
      let anyVisible = false;
      node.querySelectorAll("[data-tablist-card]").forEach((card) => {
        const show = !q || (nameById.get(card.getAttribute("data-tablist-card")) ?? "").includes(q);
        card.style.display = show ? "" : "none";
        if (show) anyVisible = true;
      });
      emptyMsg.style.display = q && !anyVisible ? "" : "none";
    };
    ctx.getBody().replaceChildren(
      buildSessionIndex(visibleSessions, sortMode, filterCards, controls.groupRow),
      node,
      emptyMsg
    );
    if (sessionFilter) filterCards(sessionFilter);
    const jump = jumpSessionId;
    const cueJump = jump && jumpCueSessionId === jump;
    if (jump) positionSessionCard(jump, { cue: cueJump });
    return { heading, node, named, sortMode };
  });

  return {
    render, goToSession, positionSessionCard,
    setGroupLens, goToGroup: setGroupLens
  };
}
