/**
 * Shared list-surface configs (F14 batch 1).
 *
 * Each `buildXListConfig(ctx)` returns the exact `createTabList` config object a
 * surface needs for one section, so the dashboard and (later) the side panel
 * share ONE behavior source: the action ids/keys/guards, journal paths, drag
 * commits, and stale-drop rules are defined here once. Presentation and the
 * surface-specific callbacks (render/refresh, navigation, inline panels, toasts,
 * per-render data) are injected through `ctx`; domain operations are imported
 * directly. This module is DOM-composition + wiring only: it owns no persisted
 * state and performs no storage read-modify-write of its own.
 *
 * Batch 1 extracts all five list configs — Open, Inbox, Sessions/Snapshots,
 * Labels, and Snoozed — with dashboard behavior byte-identical
 * (`presentation: "default"`). The compact presentation lands with the panel.
 *
 * @typedef {"default"|"compact"} ListPresentation
 */
import { el } from "./dom.js";
import { icon } from "./icons.js";
import { starredRowAction } from "./starred-button.js";
import { swapInCombobox } from "./combobox.js";
import { fromSessions, fromSnoozes } from "./tablist.js";
import { confirmWindowClose, selectionActionButton } from "./list-helpers.js";
import { listUnit } from "./list-copy.js";
import { msg as localeMessage } from "../lib/i18n.js";
import { STORE_KEYS } from "../lib/types.js";
import {
  addWindowsToSession, createSessionFromWindowsJournaled,
  restoreSession, restoreWindowRefs, removeSessionTab, renameSession
} from "../lib/sessions.js";
import { restoreTabsFromItems, deleteTabsFromItems, moveTabsToSession, moveInboxTab } from "../lib/actions.js";
import {
  removeLabel, removeLabelFromTab, applyLabels, archiveTabsFromItems, labelTabsFromItems,
  removeSessionLabel, labelSessionTabs, renameLabel, deleteLabelEverywhere,
  saveLabeledCopies
} from "../lib/labels.js";
import {
  cancelSnoozeJournaled, snoozeSession, rescheduleSnooze, wakeSnoozeTabs, cancelSnoozeTabs
} from "../lib/snooze.js";

/**
 * Open-tabs section config. Live Chrome windows/tabs, full row/window actions,
 * selection/bulk, F13 Organize, drag/reorder/new-window zones, keyboard move,
 * session drift + F18 preservation nudge. Identical to the dashboard's original
 * inline config when called with `presentation: "default"`.
 *
 * @param {object} ctx
 * @param {ListPresentation} [ctx.presentation]
 * @param {{groups: any[], bindings: any, sessionsById: Map<string, any>,
 *   simpleWindows: any[], moveDestinations?: any[], groupsUnpreserved: boolean, currentWindowId: number|null,
 *   browserWindowCount: number}} ctx.data per-render data
 * @param {number} ctx.rowCap window row cap before "show all"
 * @param {(m: object) => Promise<any>} ctx.msg background message helper
 * @param {() => void} ctx.renderOpen @param {() => void} ctx.renderArchive
 * @param {() => void} ctx.renderLabels
 * @param {(label: string) => void} ctx.goToLabel chip navigation
 * @param {(ic: Node, label: string) => Node} ctx.mark screen-reader badge wrapper
 * @param {Function} ctx.cardLabelPanel @param {Function} ctx.buildOpenSnooze
 * @param {Function} ctx.idleNudge @param {Function} ctx.sessionComboboxButton
 * @param {Function} ctx.copyRefs @param {Function} ctx.buildOrganizePanel
 * @param {Function} ctx.driftBanner @param {Function} ctx.groupNudge
 * @param {object} ctx.openRowDrag @param {(group:any) => Node} ctx.newWindowZone
 * @param {(group:any) => Node} ctx.endWindowZone
 * @param {(tabIds:number[],destination:object,afterWindowId?:number|null) => Promise<any>} ctx.moveOpenTabs
 * @param {() => number[]} ctx.dragTabIds current dragged tab ids (getter)
 * @param {(anchor: Element, text: string) => void} ctx.flashNote
 * @param {(message: string) => void} ctx.showNotice
 * @param {string} [ctx.empty] contextual empty-state copy
 * @returns {object} a `createTabList` config
 */
export function buildOpenListConfig(ctx) {
  const {
    presentation = "default", data, rowCap,
    msg, renderOpen, renderArchive, renderLabels, goToLabel, mark,
    cardLabelPanel, buildOpenSnooze, idleNudge, sessionComboboxButton, copyRefs,
    buildOrganizePanel, driftBanner, groupNudge,
    openRowDrag, newWindowZone, endWindowZone = () => null, moveOpenTabs = (tabIds, destination) =>
      msg({ type: "move-tabs", tabIds, destination }),
    dragTabIds = () => [], flashNote, showNotice
  } = ctx;
  const {
    groups, bindings, sessionsById, simpleWindows, moveDestinations = groups, groupsUnpreserved,
    currentWindowId = null, browserWindowCount = 0
  } = data;

  // component selection is `[{group, indexes}]`; resolve to live tab ids / refs
  const tabIdsOf = (sel) => sel.flatMap((s) => s.indexes.map((i) => s.group.live[i].tabId));
  const refsOf = (sel) => sel.flatMap((s) => s.indexes.map((i) => s.group.refs[i]));

  let nudgeConsumed = false; // show the F18 nudge on at most one window per render

  return {
    section: "open",
    presentation,
    groups,
    selectable: "tab",
    rowCap,
    // P2g-2r: bulk bar appears on selection, like every other section
    bulkHint: localeMessage("list_open_bulk_hint"),
    onChange: renderOpen,
    empty: ctx.empty ?? localeMessage("list_open_empty"),
    onChipOpen: goToLabel, // P2g-2r2: saved-copy chips navigate like every label chip
    rowKey: (g, i) => "t" + g.live[i].tabId,       // key by tab id → selection survives live reordering
    rowSelectable: (ctx) => ctx.live.selectable,        // http tabs only (chrome:// etc. get a disabled checkbox)
    rowOpen: (ctx) => msg({ type: "focus-tab", tabId: ctx.live.tabId, windowId: ctx.live.windowId }),
    rowBadges: (ctx) => (ctx.live.audible
      ? [mark(icon("volume", 13), localeMessage("list_playing_audio"))]
      : []),
    rowActions: [
      starredRowAction(),
      // P2g-2r: the title click IS "switch" (rowOpen) — the button was a true
      // duplicate and is gone; `hidden` keeps the keyboard binding alive.
      { id: "switch", label: localeMessage("list_switch_tab"), icon: "switch", key: "r", hidden: true,
        run: (ctx) => msg({ type: "focus-tab", tabId: ctx.live.tabId, windowId: ctx.live.windowId }) },
      { id: "dump", label: localeMessage("list_save_to_inbox"), icon: "inbox", key: "i", // N28: i = Inbox
        run: (ctx) => msg({ type: "dump-tab", tabId: ctx.live.tabId }) },
      { id: "label", label: localeMessage("action_label"), icon: "labels", key: "l",
        when: (ctx) => ctx.live.selectable,
        run: (ctx) => ctx.panel.toggle(() => cardLabelPanel(async (labels) => {
          await saveLabeledCopies([ctx.ref], labels);
          renderArchive();
          renderLabels();
          renderOpen();
        }, localeMessage("list_save_labeled_copy"), ctx.panel), "label") },
      { id: "snooze", label: localeMessage("list_snooze_ellipsis"), icon: "snooze", key: "s", // N28: parity with Inbox row snooze
        run: (ctx) => ctx.panel.toggle(() => buildOpenSnooze(ctx.live.tabId, renderOpen), "snooze") },
      // N28: z = suspend/wake (mutually exclusive via `when`, so one 'z' toggles state)
      { id: "suspend", label: localeMessage("list_suspend_tab_title"), icon: "suspend", key: "z",
        when: (ctx) => !ctx.live.suspended,
        run: (ctx) => msg({ type: "suspend-tab", tabId: ctx.live.tabId }) },
      { id: "wake", label: localeMessage("list_wake_tab_title"), icon: "sun", key: "z",
        when: (ctx) => ctx.live.suspended,
        run: (ctx) => msg({ type: "wake-tab", tabId: ctx.live.tabId }) },
      { id: "close", label: localeMessage("list_close_tab"), glyph: "×", danger: true,
        when: (ctx) => ctx.live.selectable,
        run: (ctx) => msg({ type: "close-tabs", tabIds: [ctx.live.tabId] }) }
    ],
    groupActions: [
      // F10: the idle nudge sits immediately before the remedy (Save window).
      ...(idleNudge ? [{ id: "idle-nudge", label: localeMessage("list_idle_tabs"),
        render: (ctx) => idleNudge(ctx.group.data) }] : []),
      { id: "dump-window", label: localeMessage("list_save_window_inbox"),
        shortLabel: localeMessage("action_inbox"), icon: "inbox", key: "i", // N28: i = Inbox
        run: (ctx) => msg({ type: "dump-window", windowId: ctx.group.data.id }) },
      { id: "save-session", label: localeMessage("list_save_as_session"),
        render: (ctx) => sessionComboboxButton(localeMessage("list_save_as_session"), {
          cls: "mini",
          iconName: "sessions",
          actionId: "save-session",
          title: localeMessage("list_save_window_session_title"),
          onPick: async (v) => {
            if (v.isNew) {
              await msg({ type: "save-window-session", windowId: ctx.group.data.id, name: v.name || undefined });
            } else {
              const refs = ctx.group.refs.filter((_, i) => ctx.group.live?.[i]?.selectable);
              if (refs.length > 0) await addWindowsToSession(v.id, [refs]);
            }
          }
        }) },
      { id: "copy", label: localeMessage("list_copy_markdown"),
        shortLabel: localeMessage("action_copy"), icon: "copy", key: "c",
        run: (ctx) => copyRefs(ctx.group.refs) }, // F19: copy this whole window's web pages
      { id: "organize", label: localeMessage("list_organize_window"),
        render: (ctx) => el("button", { class: "mini", "aria-haspopup": "true",
          "data-action-id": "organize",
          "aria-label": localeMessage("list_organize_window"),
          title: localeMessage("list_organize_window_title"),
          onclick: () => ctx.panel.toggle(() => buildOrganizePanel(ctx.group.data, simpleWindows), "organize") },
          el("span", { class: "action-icon" }, icon("organize", 14)),
          el("span", { class: "action-label" }, localeMessage("list_organize"))) },
      { id: "close-window", label: localeMessage("list_close_window"), danger: true,
        render: (actionCtx) => {
          const win = actionCtx.group.data;
          const tabs = (win.tabs ?? []).filter((tab) => Number.isInteger(tab.id));
          return confirmWindowClose({
            windowName: actionCtx.group.title,
            tabCount: tabs.length,
            pinnedCount: tabs.filter((tab) => tab.pinned).length,
            isCurrent: win.id === currentWindowId,
            isLast: browserWindowCount === 1,
            onConfirm: async () => {
              actionCtx.beforeRemoveCard?.();
              const result = await msg({
                type: "close-window",
                windowId: win.id,
                expectedTabCount: tabs.length,
                expectedTabIds: tabs.map((tab) => tab.id).filter(Number.isInteger),
                expectedPinnedTabIds: tabs.filter((tab) => tab.pinned).map((tab) => tab.id).filter(Number.isInteger)
              });
              if (result?.ok) {
                showNotice?.(result.recoverySaved === false
                  ? localeMessage("list_window_closed_no_recovery")
                  : localeMessage("list_window_closed"));
                renderOpen();
                return true;
              }
              if (result?.reason === "changed") {
                showNotice?.(localeMessage("list_window_changed_review"));
              } else if (result?.reason === "gone") {
                showNotice?.(localeMessage("list_window_already_closed"));
              } else {
                showNotice?.(localeMessage("list_window_close_failed"));
              }
              renderOpen();
              return false;
            }
          });
        } }
    ],
    // Drift banner wins the slot; else the F18 group-preservation nudge (shown on
    // just the first eligible window this render).
    groupBanner: (group) => {
      const drift = driftBanner(group, bindings, sessionsById);
      if (drift) return drift;
      if (nudgeConsumed) return null;
      const nudge = groupNudge(group.data, groupsUnpreserved);
      if (nudge) nudgeConsumed = true;
      return nudge;
    },
    // F13: window-header action panels (Organize ▾, Label window) open directly
    // under the header, not below the whole tab list.
    groupPanelTop: true,
    // F47: a live window is a place you work, so it can be folded down to its
    // header to get a big one out of the way. Saved things stay expanded.
    foldable: true,
    rowDrag: openRowDrag,
    betweenZone: (group) => newWindowZone(group), // P2g-4a: the visible slot is retained
    groupEndZone: (group) => endWindowZone(group),
    // P2g-4d: keyboard move — same ops as the pointer drops (journaled, best-effort undo)
    keyMoveCommit: async (src, slot) => {
      const id = src.live.tabId;
      if (slot.kind === "row") {
        await moveOpenTabs([id], { kind: "window",
          windowId: slot.group.live[slot.index].windowId,
          index: slot.group.live[slot.index].chromeIndex });
      } else if (slot.kind === "groupEnd") {
        await moveOpenTabs([id], { kind: "window", windowId: slot.group.data.id });
      } else {
        await moveOpenTabs([id], { kind: "new-window" }, slot.group?.data?.id);
      }
    },
    onGroupDragOver: (_g, e) => {
      if (dragTabIds().length === 0) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      e.currentTarget.classList.add("drop-target");
    },
    onGroupDragLeave: (_g, e) => e.currentTarget.classList.remove("drop-target"),
    onGroupDrop: async (g, e) => {
      e.preventDefault();
      e.currentTarget.classList.remove("drop-target");
      const ids = dragTabIds();
      if (ids.length === 0) return;
      await moveOpenTabs(ids, { kind: "window", windowId: g.data.id });
    },
    bulkActions: (ctx) => {
      const sel = ctx.selection;
      const some = () => tabIdsOf(sel).length > 0;
      const keeperButton = (id, label, iconName, attrs) => el("button", {
        ...attrs, "data-bulk-action": id, title: attrs.title, "aria-label": attrs.title
      },
      el("span", { class: "action-icon" }, iconName ? icon(iconName, 14) : "×"),
      el("span", { class: "action-label" }, label));
      const labelBtn = keeperButton("label", localeMessage("action_label"), "labels", {
        title: localeMessage("list_label_selected_tabs"),
        onclick: () => ctx.panel.toggle(() => cardLabelPanel(async (labels) => {
            if (!some()) return;
            await saveLabeledCopies(refsOf(sel), labels);
            ctx.clear();
          }, localeMessage("list_apply_labels"), ctx.panel), "bulk-label") });
      const tabIds = () => tabIdsOf(sel);
      const awakeIds = () => sel.flatMap((s) => s.indexes
        .filter((i) => !s.group.live[i].suspended).map((i) => s.group.live[i].tabId));
      const sleepingIds = () => sel.flatMap((s) => s.indexes
        .filter((i) => s.group.live[i].suspended).map((i) => s.group.live[i].tabId));
      const buildMovePanel = () => {
        const ids = tabIds();
        const sourceWindows = new Set(sel.map((entry) => entry.group.data.id));
        const destinations = moveDestinations.filter((group) =>
          sourceWindows.size > 1 || !sourceWindows.has(group.data.id));
        let pending = false;
        const buttons = [];
        const commit = async (destination) => {
          if (pending) return;
          pending = true;
          for (const button of buttons) button.disabled = true;
          const result = await msg({ type: "move-tabs", tabIds: ids, destination });
          if (result?.ok) {
            ctx.clear();
            return;
          }
          pending = false;
          for (const button of buttons) button.disabled = false;
          showNotice?.(result?.reason === "changed"
            ? localeMessage("list_move_changed_review")
            : localeMessage("list_move_failed"));
        };
        const destinationButton = (group) => {
          const current = group.data.id === currentWindowId;
          const count = group.refs.length;
          const button = el("button", {
            class: "move-destination",
            "data-move-window-id": group.data.id,
            onclick: () => commit({ kind: "window", windowId: group.data.id })
          },
          el("span", { class: "action-icon", "aria-hidden": "true" }, icon("open", 14)),
          el("span", { class: "move-destination-copy" }, group.title),
          el("span", { class: "move-destination-meta" },
            current
              ? localeMessage("list_window_tabs_current", [listUnit("tab", count)])
              : listUnit("tab", count)));
          buttons.push(button);
          return button;
        };
        const fresh = el("button", {
          class: "move-destination",
          "data-move-new-window": "",
          onclick: () => commit({ kind: "new-window" })
        },
        el("span", { class: "action-icon", "aria-hidden": "true" }, icon("add", 14)),
        el("span", { class: "move-destination-copy" }, localeMessage("list_new_window")));
        buttons.push(fresh);
        return el("div", { class: "palette-form" },
          el("div", { class: "move-destinations" },
            ...destinations.map(destinationButton), fresh));
      };
      return [
        keeperButton("inbox", localeMessage("action_inbox"), "inbox", {
          title: localeMessage("list_save_selected_inbox_title"),
          onclick: async () => {
            if (!some()) return;
            await msg({ type: "dump-tabs", tabIds: tabIds() });
            ctx.clear();
          } }),
        labelBtn,
        keeperButton("snooze", localeMessage("action_snooze"), "snooze", {
          title: localeMessage("list_snooze_selected_title"),
          onclick: () => ctx.panel.toggle(() => buildOpenSnooze(tabIds(), renderOpen), "bulk-snooze") }),
        awakeIds().length ? keeperButton("suspend", localeMessage("action_suspend"), "suspend", {
          title: localeMessage("list_suspend_selected_title"),
          onclick: async () => {
            await Promise.all(awakeIds().map((tabId) => msg({ type: "suspend-tab", tabId })));
            ctx.clear();
          } }) : null,
        sleepingIds().length ? keeperButton("wake", localeMessage("action_wake"), "sun", {
          title: localeMessage("list_wake_selected_title"),
          onclick: async () => {
            await Promise.all(sleepingIds().map((tabId) => msg({ type: "wake-tab", tabId })));
            ctx.clear();
          } }) : null,
        keeperButton("move", localeMessage("action_move"), "move", {
          title: localeMessage("list_move_selected_title", [listUnit("tab", ctx.count)]),
          onclick: () => ctx.panel.toggle(buildMovePanel, "bulk-move")
        }),
        sessionComboboxButton(localeMessage("list_to_session"), {
          iconName: "sessions",
          actionId: "session",
          title: localeMessage("list_save_selection_session_title"),
          onPick: async (v) => {
            // MH 2026-07-20 fix: preserve window structure — one session window
            // per source browser window (the old code flattened the whole
            // selection into a single window), and the new-session path is
            // journaled so Undo exists like every other creation.
            const windows = sel
              .map((s) => s.indexes.map((i) => s.group.refs[i]).filter(Boolean))
              .filter((w) => w.length > 0);
            if (windows.length === 0) return;
            if (v.isNew) await createSessionFromWindowsJournaled(windows, v.name || undefined);
            else await addWindowsToSession(v.id, windows);
            ctx.clear();
          }
        }),
        keeperButton("close", localeMessage("action_close"), "", {
          class: "danger", title: localeMessage("list_close_selected_tabs"),
          onclick: async () => { if (!some()) return; await msg({ type: "close-tabs", tabIds: tabIdsOf(sel) }); ctx.clear(); } },
        )
      ];
    }
  };
}

/**
 * Inbox section config (P2e-3, ports U2). Row/card/bulk actions, cross-bundle
 * drag + new-bundle zones, labels, snooze, Archive, delete, and undo. Identical
 * to the dashboard's original inline config when called with the default
 * presentation. Domain ops (restore/archive/delete/move/label) are imported;
 * surface-specific inline panels, drag state, toasts, and render callbacks are
 * injected through `ctx`.
 *
 * @param {object} ctx
 * @param {ListPresentation} [ctx.presentation]
 * @param {{groups: any[]}} ctx.data per-render groups (from `fromInboxItems`)
 * @param {() => void} ctx.renderInbox @param {() => void} ctx.renderLabels
 * @param {(label: string) => void} ctx.goToLabel
 * @param {Function} ctx.buildSnooze @param {object} ctx.inboxRowDrag
 * @param {() => Node} ctx.newBundleZone @param {() => any} ctx.inboxDrag drag-state getter
 * @param {(item: any, toIndex: number) => Promise<void>} ctx.dropInboxTab
 * @param {(message: string) => void} ctx.showNotice @param {Function} ctx.copyRefs
 * @param {Function} ctx.sessionComboboxButton @param {Function} ctx.saveWindowItemToSession
 * @param {Function} ctx.cardLabelPanel @param {Function} ctx.confirmDelete
 * @param {(item: any) => Promise<void>} ctx.delInboxItem
 * @param {(anchor: Element, text: string) => void} ctx.flashNote
 * @param {(entry: any) => void} ctx.showToast @param {Function} ctx.openRowLabel
 * @returns {object} a `createTabList` config
 */
export function buildInboxListConfig(ctx) {
  const {
    presentation = "default", data,
    renderInbox, renderLabels, goToLabel,
    buildSnooze, inboxRowDrag, newBundleZone, inboxDrag, dropInboxTab,
    showNotice, copyRefs, sessionComboboxButton, saveWindowItemToSession,
    cardLabelPanel, confirmDelete, delInboxItem, flashNote, showToast, openRowLabel
  } = ctx;
  const { groups } = data;
  const IN = STORE_KEYS.inbox;

  /** All tab indexes of a normalized group (whole-card scope). */
  const allIdx = (group) => group.refs.map((_, i) => i);
  const toSources = (sel) => sel.map((s) => ({ item: s.group.data, indexes: s.indexes }));
  const selectionRefs = (sel) => (sel ?? []).flatMap((s) => s.indexes.map((i) => s.group.refs[i])).filter(Boolean);
  // Row/card Snooze: toggle the shared panel in that scope's slot.
  const snoozeIn = (c, sources) => c.panel.toggle(() => buildSnooze(sources, renderInbox), "snooze");

  return {
    section: "inbox",
    // F47r4: every card list folds. A big card is a big card wherever it lives.
    foldable: true,
    presentation,
    groups,
    selectable: "tab",
    onChange: renderInbox,
    // P2g-4b: drag rows across bundles; bundle header = append to that bundle;
    // the zone between bundles starts a new one. All journaled, exact undo.
    rowDrag: inboxRowDrag,
    betweenZone: () => newBundleZone(),
    // P2g-4d: keyboard move — same store op as the pointer drops (guard + exact undo)
    keyMoveCommit: async (src, slot) => {
      const srcItem = src.group.data;
      const res = slot.kind === "zoneGroup"
        ? await moveInboxTab(srcItem.id, src.index, null, -1, { source: srcItem.modifiedAt })
        : await moveInboxTab(srcItem.id, src.index, slot.group.data.id,
            slot.kind === "row" ? slot.index : -1,
            { source: srcItem.modifiedAt, target: slot.group.data.modifiedAt });
      if (!res.ok && res.stale) showNotice(localeMessage("list_changed_nothing_moved"));
      renderInbox();
      renderLabels();
    },
    onGroupDragOver: (g, e) => {
      const d = inboxDrag();
      if (!d || g.data.id === d.itemId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      e.currentTarget.classList.add("drop-target");
    },
    onGroupDragLeave: (_g, e) => e.currentTarget.classList.remove("drop-target"),
    onGroupDrop: async (g, e) => {
      e.preventDefault();
      e.currentTarget.classList.remove("drop-target");
      await dropInboxTab(g.data, -1); // append to this bundle
    },
    bulkHint: localeMessage("list_inbox_bulk_hint"),
    empty: el("div", { class: "empty inbox-zero" },
      el("div", { class: "iz-title" }, localeMessage("list_inbox_zero_title")),
      el("div", {}, localeMessage("list_inbox_zero_body"))),
    onChipRemove: async (group, label) => { await removeLabel(IN, group.data, label); renderInbox(); renderLabels(); },
    onRowChipRemove: async (ctx, label) => {
      await removeLabelFromTab(IN, ctx.group.data, ctx.index, label);
      renderInbox();
      renderLabels();
    },
    onChipOpen: goToLabel,
    rowActions: [
      starredRowAction(),
      { id: "restore", label: localeMessage("search_action_restore"), icon: "switch", key: "r",
        run: async (ctx) => { await restoreTabsFromItems([{ item: ctx.group.data, indexes: [ctx.index] }]); renderInbox(); } },
      { id: "label", label: localeMessage("action_label"), icon: "labels", key: "l",
        run: (ctx) => openRowLabel(ctx, IN, renderInbox) },
      { id: "snooze", label: localeMessage("action_snooze"), icon: "snooze", key: "s",
        run: (ctx) => snoozeIn(ctx, [{ item: ctx.group.data, indexes: [ctx.index] }]) },
      { id: "archive", label: localeMessage("action_archive"), icon: "archive", key: "a",
        run: async (ctx) => { await archiveTabsFromItems([{ item: ctx.group.data, indexes: [ctx.index] }]); renderInbox(); } },
      { id: "delete", label: localeMessage("action_delete"), glyph: "×", danger: true, key: "d",
        run: async (ctx) => { await deleteTabsFromItems([{ item: ctx.group.data, indexes: [ctx.index] }]); renderInbox(); } }
    ],
    groupActions: (group) => group.data.kind === "window"
      ? [
          { id: "restore-all", label: localeMessage("list_restore_all"), key: "r",
            run: async (ctx) => { await restoreTabsFromItems([{ item: ctx.group.data, indexes: allIdx(ctx.group) }]); renderInbox(); } },
          { id: "copy", label: localeMessage("list_copy_markdown"), key: "c",
            run: (ctx) => copyRefs(ctx.group.refs) },
          { id: "session", label: localeMessage("list_save_as_session"),
            render: (ctx) => sessionComboboxButton(localeMessage("list_save_as_session"), {
              cls: "mini",
              title: localeMessage("list_move_window_session_title"),
              onPick: (v) => saveWindowItemToSession(ctx.group.data, v)
            }) },
          { id: "label-window", label: localeMessage("list_label_window"), key: "l",
            run: (ctx) => ctx.panel.toggle(() => cardLabelPanel(async (labels) => {
              await applyLabels(IN, ctx.group.data, labels);
              renderInbox();
              renderLabels();
            }, localeMessage("list_label_all_tabs"), ctx.panel), "label") },
          { id: "snooze", label: localeMessage("list_snooze_window"), key: "s",
            run: (ctx) => snoozeIn(ctx, [{ item: ctx.group.data, indexes: allIdx(ctx.group) }]) },
          { id: "delete", label: localeMessage("action_delete"), danger: true, key: "d",
            render: (ctx) => confirmDelete(() => delInboxItem(ctx.group.data)),
            run: (ctx) => delInboxItem(ctx.group.data) }
        ]
      : [
          { id: "restore", label: localeMessage("search_action_restore"), key: "r",
            run: async (ctx) => { await restoreTabsFromItems([{ item: ctx.group.data, indexes: allIdx(ctx.group) }]); renderInbox(); } },
          { id: "copy", label: localeMessage("list_copy_markdown"), key: "c",
            run: (ctx) => copyRefs(ctx.group.refs) },
          { id: "snooze", label: localeMessage("action_snooze"), key: "s",
            run: (ctx) => snoozeIn(ctx, [{ item: ctx.group.data, indexes: allIdx(ctx.group) }]) },
          { id: "delete", label: localeMessage("action_delete"), danger: true, key: "d",
            render: (ctx) => confirmDelete(() => delInboxItem(ctx.group.data)),
            run: (ctx) => delInboxItem(ctx.group.data) }
        ],
    bulkActions: (ctx) => {
      const clearAnd = () => ctx.clear();
      const srcs = () => toSources(ctx.selection);
      const openLabelPanel = (apply, buttonText = localeMessage("list_apply_labels")) =>
        ctx.panel.toggle(() => cardLabelPanel(async (labels) => {
          await apply(labels);
          clearAnd();
          renderLabels();
        }, buttonText, ctx.panel), "bulk-label");
      return [
        selectionActionButton("restore", localeMessage("search_action_restore"), "switch", {
          title: localeMessage("list_sessions_restore_selected_title"),
          onclick: async () => { await restoreTabsFromItems(srcs()); clearAnd(); }
        }),
        selectionActionButton("copy", localeMessage("action_copy"), "copy", {
          title: localeMessage("list_copy_selected_title"),
          onclick: () => copyRefs(selectionRefs(ctx.selection))
        }),
        selectionActionButton("label", localeMessage("action_label"), "labels", {
          title: localeMessage("list_inbox_add_labels_title"),
          onclick: () => openLabelPanel((labels) => labelTabsFromItems(srcs(), labels))
        }),
        selectionActionButton("archive", localeMessage("action_archive"), "archive", {
          title: localeMessage("list_inbox_archive_selected_title"),
          onclick: async () => { await archiveTabsFromItems(srcs()); clearAnd(); } },
        ),
        sessionComboboxButton(localeMessage("list_to_session"), {
          actionId: "session",
          title: localeMessage("list_inbox_move_selected_session_title"),
          onPick: async (v) => {
            // N6: → Session MOVES the selected tabs out of the Inbox (split-aware,
            // journal-backed), then confirms with an Undo toast.
            const sources = srcs();
            if (sources.length === 0) return;
            const res = await moveTabsToSession(sources, v.isNew ? "__new" : v.id, v.isNew ? (v.name || undefined) : undefined);
            clearAnd();
            if (res?.entry) showToast(res.entry);
          }
        }),
        selectionActionButton("snooze", localeMessage("action_snooze"), "snooze", {
          title: localeMessage("list_inbox_snooze_selected_title"),
          onclick: () => ctx.panel.toggle(() => buildSnooze(srcs(), clearAnd), "snooze") },
        ),
        selectionActionButton("label-archive", localeMessage("list_label_archive"), "archive", {
          title: localeMessage("list_label_archive_selected_title"),
          onclick: () => openLabelPanel(
            (labels) => archiveTabsFromItems(srcs(), labels), localeMessage("list_label_archive"))
        }),
        selectionActionButton("delete", localeMessage("action_delete"), "delete", {
          class: "danger", title: localeMessage("action_delete"),
          onclick: async () => { await deleteTabsFromItems(srcs()); clearAnd(); }
        })
      ];
    }
  };
}

/**
 * Sessions / Snapshots section config (shared: Sessions and the immutable
 * Snapshots list both use it). Per-window blocks, tab-group chips, session
 * labels, Restore/Rename/Delete, and the P2g-5 Snooze-session affordance (only
 * when `extra.sessionSnoozes` is supplied). `extra` (`...rest`) passes through
 * section-specific `createTabList` options (Sessions' drag/keyboard-move/toolbar/
 * bulk; Snapshots' empty copy) and overrides the base, exactly as the dashboard's
 * original inline helper did. Domain ops (session restore/label/rename/remove +
 * session snooze) are imported; render/nav/inline-panel/toast helpers injected.
 *
 * @param {object} ctx
 * @param {string} ctx.section @param {any[]} ctx.sessions
 * @param {() => void} ctx.rerender
 * @param {object} [ctx.extra] section-specific createTabList options (`...rest`);
 *   `extra.sessionSnoozes` (Map sessionId→Snooze) turns on the snooze affordances
 * @param {() => void} ctx.renderLabels @param {() => void} ctx.renderSnoozes
 * @param {(label: string) => void} ctx.goToLabel
 * @param {(m: object) => Promise<any>} ctx.msg @param {Function} ctx.cardLabelPanel
 * @param {(session: any) => void} ctx.copySession @param {Function} ctx.buildSnoozePanel
 * @param {Function} ctx.confirmDelete
 * @param {(session: any, rerender: () => void) => Promise<void>} ctx.delSession
 * @param {(message: string) => void} [ctx.showNotice]
 * @returns {object} a `createTabList` config
 */
export function buildSessionListConfig(ctx) {
  const {
    section, sessions, rerender, extra = {},
    renderLabels, renderSnoozes, goToLabel, msg, cardLabelPanel,
    copySession, buildSnoozePanel, confirmDelete, delSession, showNotice,
    organizationCardAction = null
  } = ctx;
  // P2g-5: `sessionSnoozes` (Map sessionId → Snooze) turns on the session-snooze
  // affordances — the "snoozed until…" card badge and Snooze/Cancel actions.
  const { sessionSnoozes = null, ...rest } = extra;
  const groups = fromSessions(sessions);
  if (sessionSnoozes) {
    for (const g of groups) {
      const sn = sessionSnoozes.get(g.id);
      if (sn) g.meta += localeMessage("list_snoozed_until", [new Date(sn.dueAt).toLocaleString()]);
    }
  }
  return {
    section,
    // F47r4: every card list folds. A big card is a big card wherever it lives.
    foldable: true,
    groups,
    selectable: "none",
    immutable: (g) => !!g.data.auto,
    onChange: rerender,
    // U9 (P2g-2): card chips are the union of the session's per-tab labels; the
    // union × strips the label from every ref, a row-chip × from just its tab.
    // Both are journaled; snapshots never show either (immutable guard).
    onChipRemove: async (group, label) => {
      await removeSessionLabel(group.data, label);
      rerender();
      renderLabels();
    },
    onRowChipRemove: async (ctx, label) => {
      await removeSessionLabel(ctx.group.data, label, { wi: ctx.windowIndex, i: ctx.index });
      rerender();
      renderLabels();
    },
    onChipOpen: goToLabel,
    rowActions: [
      starredRowAction(),
      // P2g-2r: the title click already opens the tab — the button was a true
      // duplicate and is gone; `hidden` keeps the keyboard "r" binding alive.
      { id: "restore-tab", label: localeMessage("search_action_restore"), icon: "switch", key: "r", always: true, hidden: true,
        run: (ctx) => msg({ type: "open-url", url: ctx.ref.url }) },
      { id: "label", label: localeMessage("action_label"), icon: "labels", key: "l",
        run: (ctx) => ctx.panel.toggle(() => cardLabelPanel(async (labels) => {
          await labelSessionTabs(ctx.group.data, labels, { wi: ctx.windowIndex, i: ctx.index });
          rerender();
          renderLabels();
        }, localeMessage("list_add_labels"), ctx.panel), "label") },
      // P2g-5: Remove from session [P4] — in-place removal; emptied window
      // collapses, emptied session tombstones; undo restores exactly.
      { id: "remove", label: localeMessage("list_remove_from_session"), glyph: "×", danger: true, key: "d",
        run: async (ctx) => {
          await removeSessionTab(ctx.group.data, ctx.windowIndex, ctx.index);
          rerender();
          renderLabels();
        } }
    ],
    windowActions: [
      { id: "restore-window", label: localeMessage("list_restore_window"), always: true,
        run: (ctx) => restoreWindowRefs(ctx.window.refs, undefined, ctx.window.groups) } // F18: recreate this window's groups
    ],
    groupActions: [
      { id: "restore-all", label: localeMessage("list_restore_all"), always: true, key: "r", // N28: r = restore all
        run: (ctx) => restoreSession(ctx.group.data) },
      { id: "copy", label: localeMessage("list_copy_markdown"), key: "c",
        run: (ctx) => copySession(ctx.group.data) },
      { id: "label-session", label: localeMessage("action_label"), key: "l",
        run: (ctx) => ctx.panel.toggle(() => cardLabelPanel(async (labels) => {
          await labelSessionTabs(ctx.group.data, labels);
          rerender();
          renderLabels();
        }, localeMessage("list_label_all_tabs"), ctx.panel), "label") },
      ...(organizationCardAction ? [organizationCardAction] : []),
      { id: "rename", label: localeMessage("action_rename"),
        render: (ctx) => {
          const btn = el("button", { class: "mini", title: localeMessage("list_rename_session"),
            "aria-label": localeMessage("list_rename_session"),
            "data-action-id": "rename",
            onclick: () => swapInCombobox(btn, {
              ariaLabel: localeMessage("list_session_name"),
              placeholder: localeMessage("list_session_name"),
              value: ctx.group.data.name,
              restoreBeforeCommit: true,
              onCommit: async (v) => {
                const clean = v.name.trim();
                if (!clean) return;
                const previous = ctx.group.data.name;
                const title = btn.closest("[data-tablist-card]")?.querySelector(".item-title");
                ctx.group.data.name = clean;
                if (title) title.textContent = clean;
                if (!await renameSession(ctx.group.data.id, clean)) {
                  ctx.group.data.name = previous;
                  if (title?.isConnected) title.textContent = previous;
                  rerender();
                  showNotice?.(localeMessage("list_session_rename_failed"));
                }
              }
            }) },
            el("span", { class: "action-icon" }, icon("rename", 14)),
            el("span", { class: "action-label" }, localeMessage("action_rename")));
          return btn;
        } },
      // P2g-5: Snooze session [P3] = a scheduled "Restore all" — the session is
      // never mutated; a Snoozed entry references it. Only offered when the
      // section supplies the snooze map (Sessions, not Snapshots), and swaps to
      // "Cancel snooze" while one is scheduled. Cancel works from either section.
      ...(sessionSnoozes ? [{
        id: "snooze-session",
        label: localeMessage("action_snooze"),
        // F45: a rendered action still owes the shared card-action anatomy —
        // `data-action-id`, an `.action-icon`, and an `.action-label` — or it
        // arrives as bare text with no glyph and ignores the Icons-only
        // preference. Rename above already did it; these two did not.
        render: (ctx) => {
          const sn = sessionSnoozes.get(ctx.group.id);
          if (sn) {
            return el("button", { class: "mini", "data-action-id": "snooze-session",
              title: localeMessage("list_cancel_session_restore"),
              "aria-label": localeMessage("list_cancel_session_restore"),
              onclick: async () => { await cancelSnoozeJournaled(sn); rerender(); renderSnoozes(); } },
              el("span", { class: "action-icon" }, icon("stop", 14)),
              el("span", { class: "action-label" }, localeMessage("list_cancel_snooze")));
          }
          const btn = el("button", { class: "mini", "data-action-id": "snooze-session",
            title: localeMessage("list_snooze_session_title"),
            "aria-label": localeMessage("list_snooze_session"),
            onclick: () => ctx.panel.toggle(() => buildSnoozePanel(async (dueAt, recurrence) => {
              await snoozeSession(ctx.group.data, dueAt, recurrence);
              ctx.panel.close();
              rerender();
              renderSnoozes();
            }), "snooze-session") },
            el("span", { class: "action-icon" }, icon("snooze", 14)),
            el("span", { class: "action-label" }, localeMessage("action_snooze")));
          return btn;
        }
      }] : []),
      { id: "delete", label: localeMessage("action_delete"), danger: true, always: true, key: "d", // N28: d = delete
        render: (ctx) => confirmDelete(() => delSession(ctx.group.data, rerender)),
        run: (ctx) => delSession(ctx.group.data, rerender) }
    ],
    ...rest
  };
}

/**
 * Labels section config (M6; P2g-2 tab-grain labels). One list group per label,
 * rows are the tabs CARRYING the label (both grains, all stores incl. sessions),
 * each with its precise location so Open / Remove label / Rename / Delete act
 * exactly where the tab lives. This is the `createTabList` config only — the
 * dashboard (and later the side panel) own their own render loop, index bar
 * (filter/sort/jump chips via the shared `createIndexBar`), and the N29 single-
 * card quick pass; they build this config once per group set. Identical to the
 * dashboard's original inline `buildList` config when called with the default
 * presentation.
 *
 * Domain ops (open-url via `msg`, unlabel, rename, delete-everywhere, open-all)
 * are imported; surface-specific render/refresh/navigation/copy/confirm helpers
 * are injected through `ctx`.
 *
 * @param {object} ctx
 * @param {ListPresentation} [ctx.presentation]
 * @param {{groups: any[]}} ctx.data per-render label groups (built by the caller)
 * @param {() => void} ctx.renderLabels onChange for in-list mutations
 * @param {(label: string) => void} ctx.goToLabel row-chip navigation
 * @param {(m: object) => Promise<any>} ctx.msg background message helper (open-url)
 * @param {() => void} ctx.refreshLabelViews refresh every chip-showing section
 * @param {(refs: any[], heading?: string) => void} ctx.copyRefs copy-as-markdown
 * @param {(run: () => void) => Node} ctx.confirmDelete two-step delete affordance
 * @returns {object} a `createTabList` config
 */
export function buildLabelsListConfig(ctx) {
  const {
    presentation = "default", data,
    renderLabels, goToLabel, msg, refreshLabelViews, copyRefs, confirmDelete,
    cardLabelPanel, organizationCardAction = null,
    empty = localeMessage("list_labels_empty")
  } = ctx;
  const IN = STORE_KEYS.inbox;
  // Row meta: the human-readable location of the tab carrying this label.
  const whereText = (loc) =>
    loc.store === STORE_KEYS.sessions
      ? localeMessage("list_location_session", [loc.item.name])
      : loc.store === IN
        ? localeMessage("list_location_inbox")
        : localeMessage("list_location_archive");

  return {
    section: "labels",
    // F47r4: every card list folds. A big card is a big card wherever it lives.
    foldable: true,
    presentation,
    groups: data.groups,
    selectable: "none",
    onChange: renderLabels,
    onChipOpen: goToLabel, // N30: row label chips navigate here, like every other section
    // L-nav-4 (real fix): render ALL label cards — no section cap. The default
    // 20-card cap left a "Show all N" button, and a jump chip for any card past
    // #20 found nothing (its card wasn't in the DOM yet). The jump-index + filter
    // are the navigation aid now, so every card is present for chips to land on.
    groupCap: data.groups.length,
    empty,
    rowMeta: (ref, group, i) => whereText(group.data.locs[i]),
    rowActions: [
      starredRowAction(),
      /* F49r: add ANOTHER label to a tab that is already here. It is the same
       * apply used everywhere else, so an existing name appends this tab to
       * that label's card and a new name simply starts one — there is no
       * separate "create a label" concept, and none is wanted. The tab's own
       * carrier decides which domain op applies: a session tab is labelled on
       * its session, an Inbox/Archive tab on its item.
       *
       * It replaces the old "Open" row action, which was a true duplicate: the
       * row's title is already a link that opens the page. */
      { id: "label", label: localeMessage("action_label"), icon: "labels", key: "l",
        run: (ctx) => ctx.panel.toggle(() => cardLabelPanel(async (labels) => {
          const loc = ctx.group.data.locs[ctx.index];
          if (loc.store === STORE_KEYS.sessions) {
            await labelSessionTabs(loc.item, labels, [{ wi: loc.wi, i: loc.i }]);
          } else {
            await labelTabsFromItems([{ item: loc.item, indexes: [loc.i] }], labels, loc.store);
          }
          refreshLabelViews();
        }, localeMessage("list_add_labels"), ctx.panel), "label") },
      { id: "unlabel", label: localeMessage("list_remove_label_action"), glyph: "×", danger: true, key: "d",
        run: async (ctx) => {
          const loc = ctx.group.data.locs[ctx.index];
          const label = ctx.group.data.label;
          if (loc.store === STORE_KEYS.sessions) await removeSessionLabel(loc.item, label, { wi: loc.wi, i: loc.i });
          else await removeLabelFromTab(loc.store, loc.item, loc.i, label);
          refreshLabelViews();
        } }
    ],
    groupActions: [
      { id: "open-all", label: localeMessage("list_open_all"), key: "r", // N28: r = restore/open all (card parity)
        run: (ctx) => restoreWindowRefs(ctx.group.refs) },
      { id: "copy", label: localeMessage("list_copy_markdown"), key: "c",
        run: (ctx) => copyRefs(ctx.group.refs, ctx.group.data.label) },
      ...(organizationCardAction ? [organizationCardAction] : []),
      { id: "rename", label: localeMessage("action_rename"),
        render: (ctx) => {
          const btn = el("button", { class: "mini", title: localeMessage("list_rename_label_everywhere"),
            "aria-label": localeMessage("list_rename_label"),
            "data-action-id": "rename",
            onclick: () => swapInCombobox(btn, {
              ariaLabel: localeMessage("list_label_name"),
              placeholder: localeMessage("list_label_name"),
              value: ctx.group.data.label,
              onCommit: async (v) => {
                const name = v.name.trim();
                if (!name || name === ctx.group.data.label) return;
                await renameLabel(ctx.group.data.label, name);
                refreshLabelViews();
              }
            }) },
            el("span", { class: "action-icon" }, icon("rename", 14)),
            el("span", { class: "action-label" }, localeMessage("action_rename")));
          return btn;
        } },
      { id: "delete", label: localeMessage("action_delete"), danger: true, key: "d", // N28: d = delete (card parity)
        render: (ctx) => confirmDelete(async () => {
          await deleteLabelEverywhere(ctx.group.data.label);
          refreshLabelViews();
        }),
        run: async (ctx) => {
          await deleteLabelEverywhere(ctx.group.data.label);
          refreshLabelViews();
        } }
    ]
  };
}

/**
 * Snoozed section config (P2g-5 + U7). Per-tab selection with subset wake/cancel
 * (split-aware, journaled), an inline reschedule datetime panel, and the two
 * snooze kinds (a plain tab snooze vs a session snooze whose rows are the live
 * session's tabs, non-selectable because the session is a template). Identical to
 * the dashboard's original inline config when called with the default
 * presentation. Snooze domain ops (wake/cancel subset, reschedule, journaled
 * cancel) are imported; render/nav/copy/toast helpers are injected through `ctx`.
 *
 * @param {object} ctx
 * @param {ListPresentation} [ctx.presentation]
 * @param {{groups: any[]}} ctx.data per-render groups (from `fromSnoozes`)
 * @param {() => void} ctx.renderSnoozes @param {() => void} ctx.renderSessions
 * @param {(m: object) => Promise<any>} ctx.msg background message helper
 * @param {(refs: any[], heading?: string) => void} ctx.copyRefs copy-as-markdown
 * @returns {object} a `createTabList` config
 */
export function buildSnoozedListConfig(ctx) {
  const { presentation = "default", data, renderSnoozes, renderSessions, msg, copyRefs } = ctx;

  // U7 (P2g-3): tab-grain selection in snooze bundles; wake/cancel a subset
  // splits the snooze (an exit) — journaled, undoable.
  const toSnoozeSources = (sel) => sel.map((s) => ({ snooze: s.group.data, indexes: s.indexes }));
  const selectionRefs = (sel) => (sel ?? []).flatMap((s) => s.indexes.map((i) => s.group.refs[i])).filter(Boolean);

  /** Inline "reschedule to…" datetime panel for a snooze (group action). */
  const openReschedule = (c) => {
    c.panel.toggle(() => {
      const input = el("input", { type: "datetime-local", class: "inline-input" });
      const note = el("span", { class: "note", role: "alert" });
      const bar = el("div", { class: "snoozebar" },
        el("span", { class: "host" }, localeMessage("list_reschedule_to")), input,
        el("button", { class: "mini", onclick: async () => {
          const t = new Date(input.value).getTime();
          if (!Number.isFinite(t)) {
            note.textContent = localeMessage("list_reschedule_pick_time");
            return;
          }
          if (t <= Date.now()) {
            note.textContent = localeMessage("list_reschedule_future_time");
            return;
          }
          await rescheduleSnooze(c.group.data, t);
          renderSnoozes();
        } }, localeMessage("list_reschedule_set")),
        note);
      setTimeout(() => input.focus(), 0);
      return bar;
    }, "reschedule");
  };

  return {
    section: "snoozed",
    // F47r4: every card list folds. A big card is a big card wherever it lives.
    foldable: true,

    presentation,
    groups: data.groups,
    selectable: "tab",
    // a session snooze's rows belong to the SESSION — per-tab wake/cancel would
    // have to mutate it (it's a template); rows show a disabled checkbox instead
    rowSelectable: (ctx) => !ctx.group.data.sessionId,
    bulkHint: localeMessage("list_snoozed_bulk_hint"),
    bulkActions: (ctx) => [
      el("button", { title: localeMessage("list_wake_selected_title"),
        onclick: async () => { await wakeSnoozeTabs(toSnoozeSources(ctx.selection)); ctx.clear(); } },
        localeMessage("list_wake_now")),
      el("button", { title: localeMessage("list_copy_selected_markdown_title"),
        onclick: () => copyRefs(selectionRefs(ctx.selection)) }, localeMessage("action_copy")),
      el("button", { class: "danger",
        title: localeMessage("list_cancel_selected_snoozes_title"),
        onclick: async () => { await cancelSnoozeTabs(toSnoozeSources(ctx.selection)); ctx.clear(); } },
        localeMessage("list_cancel_selected"))
    ],
    onChange: renderSnoozes,
    empty: localeMessage("list_snoozed_empty"),
    rowActions: [starredRowAction()],
    groupActions: [
      { id: "wake", label: localeMessage("list_wake_now"), always: true, key: "r", // N28: r = restore/bring back
        run: async (ctx) => { await msg({ type: "wake-snooze", id: ctx.group.data.id }); renderSnoozes(); } },
      { id: "reschedule", label: localeMessage("list_reschedule"), run: (ctx) => openReschedule(ctx) },
      // P2g-5: cancel is journaled now (undo revives the snooze; on a session
      // snooze the session was never touched). Works for both kinds.
      { id: "cancel", label: localeMessage("action_cancel"), danger: true, key: "d", // N28: d = delete/cancel
        run: async (ctx) => { await cancelSnoozeJournaled(ctx.group.data); renderSessions(); renderSnoozes(); } }
    ]
  };
}
