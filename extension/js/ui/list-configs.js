// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Shared list configurations for Dashboard and Side Panel.
 * Each builder supplies actions, keyboard bindings and drag behavior for one
 * section. The host supplies data, presentation and refresh callbacks; domain
 * operations own persistence and Undo. This module does not edit store maps.
 *
 * @typedef {"default"|"compact"} ListPresentation
 */
import { el } from "./dom.js";
import { icon } from "./icons.js";
import { currentProtection } from "./automation-protection.js";
import { starredRowAction } from "./starred-button.js";
import { swapInCombobox } from "./combobox.js";
import { fromSessions, fromSnoozes } from "./tablist.js";
import { confirmDelete, confirmWindowClose, selectionActionButton } from "./list-helpers.js";
import { listUnit } from "./list-copy.js";
import { msg as localeMessage } from "../lib/i18n.js";
import { STORE_KEYS } from "../lib/types.js";
import {
  addWindowsToSession, createSessionFromWindowsJournaled,
  restoreSession, restoreSessionWindow, removeSessionTab, renameSession
} from "../lib/sessions.js";
import { restoreTabsFromItems, deleteTabsFromItems, moveTabsToSession, moveInboxTab } from "../lib/actions.js";
import {
  removeLabel, removeLabelFromTab, removeLabelsFromSelections, applyLabelsToSelections, applyLabels, archiveTabsFromItems, labelTabsFromItems,
  removeSessionLabel, labelSessionTabs, renameLabel, deleteLabelEverywhere,
  saveLabeledCopies
} from "../lib/labels.js";
import {
  cancelSnoozeJournaled, snoozeSession, rescheduleSnooze, cancelSnoozeTabs
} from "../lib/snooze.js";

/** @typedef {import("./tablist.js").TabListConfig} TabListConfig */
/** @typedef {import("./tablist.js").TabListGroup} TabListGroup */
/** @typedef {import("./tablist.js").TabListPredicateContext} TabListPredicateContext */
/** @typedef {import("./tablist.js").TabListRowDrag} TabListRowDrag */
/** @typedef {import("./tablist.js").TabListAction} TabListAction */
/** @typedef {import("./tablist.js").TabListPanelController} TabListPanelController */
/** @typedef {import("../lib/types.js").TabRef} TabRef */
/** @typedef {import("../lib/types.js").InboxItem} InboxItem */
/** @typedef {import("../lib/types.js").Session} Session */
/** @typedef {import("../lib/types.js").Snooze} Snooze */
/** @typedef {(message:Record<string, unknown>)=>Promise<unknown>} BackgroundMessage */
/** @typedef {()=>unknown} ListRefresh */
/** @typedef {(refs:TabRef[],heading?:string)=>unknown} CopyRefs */
/** @typedef {(...args:unknown[])=>Node|null} ListNodeFactory */
/** @typedef {(apply:(labels:string[])=>Promise<unknown>,buttonText?:string,panel?:TabListPanelController|null)=>Node} CardLabelPanel */

/**
 * Count saved addresses without canonicalizing: query, fragment and spelling
 * differences remain separate. Invalid legacy values are not addresses.
 * @param {TabRef[]} refs
 * @returns {Set<string>}
 */
function duplicateSavedAddresses(refs) {
  const counts = new Map();
  for (const ref of refs) {
    const url = ref?.url;
    if (typeof url !== "string" || !url.trim()) continue;
    if (!counts.has(url)) {
      try { new URL(url); } catch { continue; }
    }
    counts.set(url, (counts.get(url) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([url]) => url));
}

/** A fresh visible badge for each occurrence; existing row actions own removal. */
function savedDuplicateBadge() {
  const description = localeMessage("list_saved_duplicate_description");
  return el("span", { class: "tmark item-badge saved-duplicate-badge", title: description },
    icon("duplicates", 13),
    el("span", { "aria-hidden": "true" }, localeMessage("list_saved_duplicate_badge")),
    el("span", { class: "sr-only" }, description + " "));
}

/**
 * @typedef {Object} OpenListData
 * @property {TabListGroup[]} groups
 * @property {unknown} bindings
 * @property {Map<string, Session>} sessionsById
 * @property {unknown[]|(()=>unknown[])} simpleWindows
 * @property {TabListGroup[]} [moveDestinations]
 * @property {boolean} groupsUnpreserved
 * @property {number|null} [currentWindowId]
 * @property {number} [browserWindowCount]
 * @property {Map<number, unknown>} [awarenessByTabId]
 */

/**
 * @typedef {Object} OpenListContext
 * @property {ListPresentation} [presentation]
 * @property {OpenListData} data
 * @property {number} rowCap
 * @property {number} [initialRowBudget]
 * @property {BackgroundMessage} msg
 * @property {ListRefresh} renderOpen
 * @property {ListRefresh} renderArchive
 * @property {ListRefresh} renderLabels
 * @property {(label:string)=>unknown} goToLabel
 * @property {(sessionId:string)=>unknown} goToSession
 * @property {(content:Node,label:string)=>Node} mark
 * @property {CardLabelPanel} cardLabelPanel
 * @property {ListNodeFactory} buildOpenSnooze
 * @property {ListNodeFactory|null} [idleNudge]
 * @property {ListNodeFactory} sessionComboboxButton
 * @property {CopyRefs} copyRefs
 * @property {ListNodeFactory} buildOrganizePanel
 * @property {ListNodeFactory} driftBanner
 * @property {ListNodeFactory} groupAccessAction
 * @property {ListNodeFactory} buildProtectionPanel
 * @property {TabListRowDrag} openRowDrag
 * @property {(group:TabListGroup)=>Node|null} newWindowZone
 * @property {(group:TabListGroup)=>Node|null} [endWindowZone]
 * @property {(tabIds:number[],destination:Record<string,unknown>,afterWindowId?:number|null)=>Promise<unknown>} [moveOpenTabs]
 * @property {()=>number[]} [dragTabIds]
 * @property {(anchor:Element,text:string)=>void} flashNote
 * @property {(message:string)=>void} [showNotice]
 * @property {string} [empty]
 * @property {{row:(view:unknown)=>Node|null}} [automationAwareness]
 */

/**
 * Open-tabs section config. Live Chrome windows/tabs, full row/window actions,
 * selection/bulk, F13 Organize, drag/reorder/new-window zones, keyboard move,
 * session drift + F18 preservation nudge. Identical to the dashboard's original
 * inline config when called with `presentation: "default"`.
 *
 * @param {OpenListContext} ctx
 * @returns {TabListConfig}
 */
export function buildOpenListConfig(ctx) {
  const protectionPanel = ctx.buildProtectionPanel;
  const {
    presentation = "default", data, rowCap, initialRowBudget,
    msg, renderOpen, renderArchive, renderLabels, goToLabel, goToSession, mark,
    cardLabelPanel, buildOpenSnooze, idleNudge, sessionComboboxButton, copyRefs,
    buildOrganizePanel, driftBanner, groupAccessAction = () => null,
    openRowDrag, newWindowZone, endWindowZone = () => null, moveOpenTabs = (tabIds, destination) =>
      msg({ type: "move-tabs", tabIds, destination }),
    dragTabIds = () => [], flashNote, showNotice, automationAwareness = null
  } = ctx;
  const {
    groups, bindings, sessionsById, simpleWindows, moveDestinations = groups, groupsUnpreserved,
    currentWindowId = null, browserWindowCount = 0
  } = data;

  // component selection is `[{group, indexes}]`; resolve to live tab ids / refs
  const tabIdsOf = (sel) => sel.flatMap((s) => s.indexes.map((i) => s.group.live[i].tabId));
  const refsOf = (sel) => sel.flatMap((s) => s.indexes.map((i) => s.group.refs[i]));

  return {
    section: "open",
    presentation,
    groups,
    selectable: "tab",
    rowCap,
    initialRowBudget,
    // P2g-2r: bulk bar appears on selection, like every other section
    bulkHint: localeMessage("list_open_bulk_hint"),
    onChange: renderOpen,
    empty: ctx.empty ?? localeMessage("list_open_empty"),
    onChipOpen: goToLabel, // P2g-2r2: saved-copy chips navigate like every label chip
    onSessionOpen: goToSession,
    rowKey: (g, i) => "t" + g.live[i].tabId,       // key by tab id → selection survives live reordering
    rowSelectable: (ctx) => ctx.live.selectable,        // http tabs only (chrome:// etc. get a disabled checkbox)
    selectionSelectable: (group, index) => !!group.live[index]?.selectable,
    selectionCount: (group) => group.selectableCount,
    // The Side Panel keeps its compact flat list. Dashboard gives live Chrome
    // groups a quiet, action-free hierarchy without changing row identity.
    rowGroup: presentation === "compact" ? null : (group, index) => group.live[index]?.tabGroup ?? null,
    rowGroupSupplement: presentation === "compact"
      ? null
      : (group) => groupAccessAction(group, groupsUnpreserved),
    rowOpen: (ctx) => msg({ type: "focus-tab", tabId: ctx.live.tabId, windowId: ctx.live.windowId }),
    rowBadges: (ctx) => {
      const badges = ctx.live.audible ? [mark(icon("volume", 13), localeMessage("list_playing_audio"))] : [];
      const protection = currentProtection(data.awarenessByTabId?.get(ctx.live.tabId)?.protection);
      if (protection?.protected && (!protection.expiresAt || protection.expiresAt > Date.now())) {
        let lastLayer = protection;
        while (lastLayer.afterExpiry?.protected) lastLayer = lastLayer.afterExpiry;
        badges.push(el("span", { class: "automation-protection-badge",
          ...(lastLayer.expiresAt ? { "data-expires-at": String(lastLayer.expiresAt) } : {}),
          "aria-label": localeMessage("protection_protected"), title: localeMessage("protection_protected")
        }, icon("shield", 13)));
      }
      return badges;
    },
    rowSupplement: automationAwareness
      ? (rowCtx) => automationAwareness.row(
        data.awarenessByTabId?.get(rowCtx.live?.tabId), rowCtx.live?.tabId
      )
      : null,
    rowActions: [
      starredRowAction(),
      // P2g-2r: the title click IS "switch" (rowOpen) — the button was a true
      // duplicate and is gone; `hidden` keeps the keyboard binding alive.
      { id: "switch", label: localeMessage("list_switch_tab"), icon: "switch", key: "r", hidden: true,
        run: (ctx) => msg({ type: "focus-tab", tabId: ctx.live.tabId, windowId: ctx.live.windowId }) },
      { id: "dump", label: localeMessage("list_save_to_inbox"), icon: "inbox", key: "i", // N28: i = Inbox
        when: (ctx) => ctx.live.selectable,
        run: (ctx) => msg({ type: "dump-tab", tabId: ctx.live.tabId }) },
      { id: "session", label: localeMessage("list_save_as_session"), key: "t",
        when: (ctx) => ctx.live.selectable,
        render: (ctx) => sessionComboboxButton(localeMessage("list_save_as_session"), {
          cls: "mini iconbtn",
          iconName: "sessions",
          actionId: "session",
          title: localeMessage("list_save_tab_session_title"),
          onPick: async (value) => Boolean((await msg({
            type: "save-tabs-session",
            tabIds: [ctx.live.tabId],
            ...(value.isNew
              ? { name: value.name || undefined, organization: value.organization }
              : { sessionId: value.id })
          }))?.id)
        }) },
      { id: "label", label: localeMessage("action_label"), icon: "labels", key: "l",
        when: (ctx) => ctx.live.selectable,
        run: (ctx) => ctx.panel.toggle(() => cardLabelPanel(async (labels) => {
          await saveLabeledCopies([ctx.ref], labels);
          renderArchive();
          renderLabels();
          renderOpen();
        }, localeMessage("list_save_labeled_copy"), ctx.panel), "label") },
      { id: "snooze", label: localeMessage("list_snooze_ellipsis"), icon: "snooze", key: "s", // N28: parity with Inbox row snooze
        when: (ctx) => ctx.live.selectable,
        run: (ctx) => ctx.panel.toggle(() => buildOpenSnooze(ctx.live.tabId, renderOpen), "snooze") },
      // N28: z = suspend/wake (mutually exclusive via `when`, so one 'z' toggles state)
      { id: "protection", label: localeMessage("action_protect"), icon: "shield", key: "p",
        title: localeMessage("list_protect_tab_title"),
        when: (ctx) => ctx.live.selectable,
        run: (rowCtx) => rowCtx.panel.toggle(() => protectionPanel(
          rowCtx.live.tabId, rowCtx.panel), "protection") },
      { id: "suspend", label: localeMessage("list_suspend_tab_title"), icon: "suspend", key: "z",
        when: (ctx) => ctx.live.selectable && !ctx.live.suspended,
        run: (ctx) => msg({ type: "suspend-tab", tabId: ctx.live.tabId }) },
      { id: "wake", label: localeMessage("list_wake_tab_title"), icon: "sun", key: "z",
        when: (ctx) => ctx.live.selectable && ctx.live.suspended,
        run: (ctx) => msg({ type: "wake-tab", tabId: ctx.live.tabId }) },
      { id: "close", label: localeMessage("list_close_tab"), glyph: "×", danger: true, key: "w",
        when: (ctx) => ctx.live.selectable,
        run: (ctx) => msg({ type: "close-tabs", tabIds: [ctx.live.tabId] }) },
      { id: "close-unsaveable", label: localeMessage("list_close_unrecoverable_title"),
        glyph: "×", danger: true, key: "w",
        when: (ctx) => !ctx.live.selectable,
        run: (ctx) => msg({ type: "close-unsaveable-tabs", tabIds: [ctx.live.tabId] }),
        render: (ctx) => confirmDelete(
          () => msg({ type: "close-unsaveable-tabs", tabIds: [ctx.live.tabId] }),
          localeMessage("list_close_unrecoverable_title"),
          localeMessage("list_close_without_undo")
        ) }
    ],
    groupActions: [
      // F10: the idle nudge sits immediately before the remedy (Save window).
      ...(idleNudge ? [{ id: "idle-nudge", label: localeMessage("list_idle_tabs"),
        render: (ctx) => idleNudge(ctx.group.data) }] : []),
      { id: "dump-window", label: localeMessage("list_save_window_inbox"),
        shortLabel: localeMessage("action_inbox"), icon: "inbox", key: "i", // N28: i = Inbox
        run: (ctx) => msg({ type: "dump-window", windowId: ctx.group.data.id }) },
      { id: "save-session", label: localeMessage("list_save_as_session"), key: "t",
        render: (ctx) => sessionComboboxButton(localeMessage("list_save_as_session"), {
          cls: "mini",
          iconName: "sessions",
          actionId: "save-session",
          title: localeMessage("list_save_window_session_title"),
          onPick: async (v) => {
            const result = await msg({
              type: "save-window-session",
              windowId: ctx.group.data.id,
              ...(v.isNew
                ? { name: v.name || undefined, organization: v.organization }
                : { sessionId: v.id })
            });
            return Boolean(result?.id);
          }
        }) },
      { id: "label-window", label: localeMessage("list_label_window"),
        shortLabel: localeMessage("action_label"), icon: "labels", key: "l",
        run: (ctx) => ctx.panel.toggle(() => cardLabelPanel(async (labels) => {
          await saveLabeledCopies(ctx.group.refs, labels);
          renderArchive();
          renderLabels();
          renderOpen();
        }, localeMessage("list_apply_labels"), ctx.panel), "label") },
      { id: "snooze-window", label: localeMessage("list_snooze_window"),
        shortLabel: localeMessage("action_snooze"), icon: "snooze", key: "s",
        run: (ctx) => ctx.panel.toggle(() =>
          buildOpenSnooze({ windowId: ctx.group.data.id }, renderOpen), "snooze") },
      { id: "protection-window", label: localeMessage("action_protect"),
        title: localeMessage("list_protect_window_title"),
        shortLabel: localeMessage("action_protect"), icon: "shield", key: "p",
        run: (groupCtx) => groupCtx.panel.toggle(() => protectionPanel(
          { windowId: groupCtx.group.data.id }, groupCtx.panel), "protection") },
      { id: "copy", label: localeMessage("list_copy_markdown"),
        shortLabel: localeMessage("action_copy"), icon: "copy", key: "c",
        run: (ctx) => copyRefs(ctx.group.refs) }, // F19: copy this whole window's web pages
      { id: "organize", label: localeMessage("list_organize_window"),
        render: (ctx) => el("button", { class: "mini", "aria-haspopup": "true",
          "data-action-id": "organize",
          "aria-label": localeMessage("list_organize_window"),
          title: localeMessage("list_organize_window_title"),
          onclick: () => ctx.panel.toggle(() => buildOrganizePanel(ctx.group.data,
            typeof simpleWindows === "function" ? simpleWindows() : simpleWindows), "organize") },
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
    groupBanner: (group) => driftBanner(group, bindings, sessionsById),
    // F13: window-header action panels (Organize ▾, Label window) open directly
    // under the header, not below the whole tab list.
    groupPanelTop: true,
    // F47: a live window is a place you work, so it can be folded down to its
    // header to get a big one out of the way. Saved things stay expanded.
    foldable: true,
    rowDrag: openRowDrag,
    betweenZone: (group) => newWindowZone(group), // P2g-4a: the visible slot is retained
    groupEndZone: (group) => endWindowZone(group),
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
        ...attrs, class: ["tip", attrs.class].filter(Boolean).join(" "),
        "data-bulk-action": id, title: attrs.title, "aria-label": attrs.title
      },
      el("span", { class: "action-icon" }, iconName ? icon(iconName, 14) : "×"),
      el("span", { class: "action-label" }, label));
      const labelBtn = keeperButton("label", localeMessage("action_label"), "labels", {
        title: localeMessage("list_label_selected_tabs"),
        onclick: () => ctx.panel.toggle(() => cardLabelPanel(async (labels) => {
            if (!some()) return;
            await saveLabeledCopies(refsOf(sel), labels);
            renderArchive();
            renderLabels();
            renderOpen();
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
            await Promise.resolve(ctx.rerender());
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
        sessionComboboxButton(localeMessage("list_to_session"), {
          iconName: "sessions",
          actionId: "session",
          title: localeMessage("list_save_selection_session_title"),
          onPick: async (v) => {
            const windows = sel
              .map((s) => s.indexes.map((i) => s.group.refs[i]).filter(Boolean))
              .filter((w) => w.length > 0);
            if (windows.length === 0) return false;
            const result = v.isNew
              ? await createSessionFromWindowsJournaled(windows, v.name || undefined, v.organization)
              : await addWindowsToSession(v.id, windows);
            return Boolean(result?.id);
          }
        }),
        labelBtn,
        keeperButton("snooze", localeMessage("action_snooze"), "snooze", {
          title: localeMessage("list_snooze_selected_title"),
          onclick: () => ctx.panel.toggle(() => buildOpenSnooze(tabIds(), renderOpen), "bulk-snooze") }),
        keeperButton("protection", localeMessage("action_protect"), "shield", {
          title: localeMessage("list_protect_selected_title"),
          onclick: () => ctx.panel.toggle(() => protectionPanel({
            tabs: sel.flatMap((entry) => entry.indexes.map((index) => ({
              id: entry.group.live[index].tabId, url: entry.group.refs[index].url
            })))
          }, ctx.panel), "protection") }),
        keeperButton("copy", localeMessage("action_copy"), "copy", {
          title: localeMessage("list_copy_selected_title"),
          onclick: () => copyRefs(refsOf(sel))
        }),
        awakeIds().length ? keeperButton("suspend", localeMessage("action_suspend"), "suspend", {
          title: localeMessage("list_suspend_selected_title"),
          onclick: async () => {
            await Promise.all(awakeIds().map((tabId) => msg({ type: "suspend-tab", tabId })));
            await Promise.resolve(ctx.rerender());
          } }) : null,
        sleepingIds().length ? keeperButton("wake", localeMessage("action_wake"), "sun", {
          title: localeMessage("list_wake_selected_title"),
          onclick: async () => {
            await Promise.all(sleepingIds().map((tabId) => msg({ type: "wake-tab", tabId })));
            await Promise.resolve(ctx.rerender());
          } }) : null,
        keeperButton("move", localeMessage("action_move"), "move", {
          title: localeMessage("list_move_selected_title"),
          onclick: () => ctx.panel.toggle(buildMovePanel, "bulk-move")
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
 * @typedef {Object} InboxListContext
 * @property {ListPresentation} [presentation]
 * @property {{groups:TabListGroup[],awarenessByItemId?:Map<string,unknown>}} data
 * @property {ListRefresh} renderInbox
 * @property {ListRefresh} renderLabels
 * @property {(label:string)=>unknown} goToLabel
 * @property {(sessionId:string)=>unknown} goToSession
 * @property {ListNodeFactory} buildSnooze
 * @property {TabListRowDrag} inboxRowDrag
 * @property {()=>Node|null} newBundleZone
 * @property {(group:TabListGroup)=>Node|null} endBundleZone
 * @property {()=>unknown} inboxDrag
 * @property {(item:InboxItem,toIndex:number)=>Promise<unknown>} dropInboxTabs
 * @property {(message:string)=>void} [showNotice]
 * @property {CopyRefs} copyRefs
 * @property {ListNodeFactory} sessionComboboxButton
 * @property {(item:InboxItem,value:unknown)=>Promise<unknown>} saveWindowItemToSession
 * @property {CardLabelPanel} cardLabelPanel
 * @property {ListNodeFactory} confirmDelete
 * @property {(item:InboxItem)=>Promise<unknown>} delInboxItem
 * @property {(anchor:Element,text:string)=>void} flashNote
 * @property {(entry:unknown)=>void} showToast
 * @property {ListNodeFactory} openRowLabel
 * @property {(context:TabListPredicateContext)=>boolean} [rowVisible]
 * @property {string|Node|null} [empty]
 * @property {{inbox:(view:unknown)=>Node|null}} [automationAwareness]
 */

/**
 * Inbox section config (P2e-3, ports U2). Row/card/bulk actions, cross-bundle
 * drag + new-bundle zones, labels, snooze, Archive, delete, and undo. Identical
 * to the dashboard's original inline config when called with the default
 * presentation. Domain ops (restore/archive/delete/move/label) are imported;
 * surface-specific inline panels, drag state, toasts, and render callbacks are
 * injected through `ctx`.
 *
 * @param {InboxListContext} ctx
 * @returns {TabListConfig}
 */
export function buildInboxListConfig(ctx) {
  const {
    presentation = "default", data,
    renderInbox, renderLabels, goToLabel, goToSession,
    buildSnooze, inboxRowDrag, newBundleZone, endBundleZone, inboxDrag, dropInboxTabs,
    showNotice, copyRefs, sessionComboboxButton, saveWindowItemToSession,
    cardLabelPanel, confirmDelete, delInboxItem, flashNote, showToast, openRowLabel,
    rowVisible = null, empty = null, automationAwareness = null
  } = ctx;
  const { groups } = data;
  const duplicateAddresses = duplicateSavedAddresses(groups.flatMap(group => group.refs ?? []));
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
    rowVisible,
    rowBadges: ({ ref }) => duplicateAddresses.has(ref.url) ? [savedDuplicateBadge()] : [],
    // Inbox is an active triage queue, not a catalogue preview. Hiding the
    // 21st card behind a generic disclosure made saved work look absent.
    groupCap: groups.length,
    selectable: "tab",
    onChange: renderInbox,
    groupSupplement: automationAwareness
      ? (group) => automationAwareness.inbox(data.awarenessByItemId?.get(group.id), group.id)
      : null,
    onSessionOpen: goToSession,
    // P2g-4b: drag rows across bundles; bundle header = append to that bundle;
    // the zone between bundles starts a new one. All journaled, exact undo.
    rowDrag: inboxRowDrag,
    betweenZone: () => newBundleZone(),
    groupEndZone: typeof endBundleZone === "function" ? (group) => endBundleZone(group) : null,
    onGroupDragOver: (g, e) => {
      const d = inboxDrag();
      if (!d) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      e.currentTarget.classList.add("drop-target");
    },
    onGroupDragLeave: (_g, e) => e.currentTarget.classList.remove("drop-target"),
    onGroupDrop: async (g, e) => {
      e.preventDefault();
      e.currentTarget.classList.remove("drop-target");
      await dropInboxTabs(g.data, -1); // append to this bundle
    },
    bulkHint: localeMessage("list_inbox_bulk_hint"),
    empty: empty ?? el("div", { class: "empty inbox-zero" },
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
      { id: "session", label: localeMessage("list_to_session"), key: "t",
        render: (ctx) => sessionComboboxButton(localeMessage("list_to_session"), {
          cls: "mini iconbtn",
          iconName: "sessions",
          actionId: "session",
          title: localeMessage("list_inbox_move_tab_session_title"),
          onPick: async (value) => {
            const result = await moveTabsToSession(
              [{ item: ctx.group.data, indexes: [ctx.index] }],
              value.isNew ? "__new" : value.id,
              value.isNew ? (value.name || undefined) : undefined,
              value.organization
            );
            if (!result?.moved) return false;
            renderInbox();
            if (result.entry) showToast(result.entry);
            return true;
          }
        }) },
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
          { id: "session", label: localeMessage("list_save_as_session"), key: "t",
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
      const openLabelPanel = (apply, buttonText = localeMessage("list_apply_labels"), clearAfter = false) =>
        ctx.panel.toggle(() => cardLabelPanel(async (labels) => {
          await apply(labels);
          renderInbox();
          if (clearAfter) clearAnd();
          renderLabels();
        }, buttonText, ctx.panel), "bulk-label");
      return [
        sessionComboboxButton(localeMessage("list_to_session"), {
          actionId: "session",
          title: localeMessage("list_inbox_move_selected_session_title"),
          onPick: async (v) => {
            const sources = srcs();
            if (sources.length === 0) return false;
            const res = await moveTabsToSession(sources, v.isNew ? "__new" : v.id,
              v.isNew ? (v.name || undefined) : undefined, v.organization);
            if (!res?.moved) return false;
            clearAnd();
            if (res.entry) showToast(res.entry);
            return true;
          }
        }),
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
        selectionActionButton("snooze", localeMessage("action_snooze"), "snooze", {
          title: localeMessage("list_inbox_snooze_selected_title"),
          onclick: () => ctx.panel.toggle(() => buildSnooze(srcs(), clearAnd), "snooze") },
        ),
        selectionActionButton("label-archive", localeMessage("list_label_archive"), "archive", {
          title: localeMessage("list_label_archive_selected_title"),
          onclick: () => openLabelPanel(
            (labels) => archiveTabsFromItems(srcs(), labels), localeMessage("list_label_archive"), true)
        }),
        selectionActionButton("delete", localeMessage("action_delete"), "delete", {
          class: "danger", title: localeMessage("action_delete"),
          onclick: async () => { await deleteTabsFromItems(srcs()); clearAnd(); }
        })
      ];
    }
  };
}

/** @typedef {Partial<TabListConfig> & {sessionSnoozes?:Map<string,Snooze>}} SessionListExtra */

/**
 * @typedef {Object} SessionListContext
 * @property {string} section
 * @property {Session[]} sessions
 * @property {ListRefresh} rerender
 * @property {SessionListExtra} [extra]
 * @property {ListRefresh} renderLabels
 * @property {ListRefresh} renderSnoozes
 * @property {(label:string)=>unknown} goToLabel
 * @property {BackgroundMessage} msg
 * @property {CardLabelPanel} cardLabelPanel
 * @property {(session:Session)=>unknown} copySession
 * @property {ListNodeFactory} buildSnoozePanel
 * @property {ListNodeFactory} confirmDelete
 * @property {(session:Session,rerender:ListRefresh)=>Promise<unknown>} delSession
 * @property {(message:string)=>void} [showNotice]
 * @property {TabListAction} [organizationCardAction]
 * @property {ListNodeFactory} [sessionComboboxButton]
 * @property {number} [sessionTargetCount]
 */

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
 * @param {SessionListContext} ctx
 * @returns {TabListConfig}
 */
export function buildSessionListConfig(ctx) {
  const {
    section, sessions, rerender, extra = {},
    renderLabels, renderSnoozes, goToLabel, msg, cardLabelPanel,
    copySession, buildSnoozePanel, confirmDelete, delSession, showNotice,
    organizationCardAction = null, sessionComboboxButton = null, sessionTargetCount = 0
  } = ctx;
  // P2g-5: `sessionSnoozes` (Map sessionId → Snooze) turns on the session-snooze
  // affordances — the "snoozed until…" card badge and Snooze/Cancel actions.
  const { sessionSnoozes = null, ...rest } = extra;
  const groups = fromSessions(sessions);
  // Each Named Session is its own scope, including all its windows. Snapshot
  // repetitions describe captured browser state and are intentionally unmarked.
  const duplicateAddresses = new Map(groups.filter(group => !group.data.auto)
    .map(group => [group, duplicateSavedAddresses(group.windows.flatMap(window => window.refs))]));
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
    rowBadges: ({ group, ref }) => duplicateAddresses.get(group)?.has(ref.url) ? [savedDuplicateBadge()] : [],
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
      { id: "restore-window", label: localeMessage("list_restore_window"), icon: "refresh", always: true,
        run: (ctx) => restoreSessionWindow(ctx.group.data, ctx.windowIndex) }
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
      ...(section === "sessions" && sessionComboboxButton && sessionTargetCount > 1 ? [{
        id: "add-session", label: localeMessage("list_add_to_session"), key: "t",
        render: (ctx) => sessionComboboxButton(localeMessage("list_add_to_session"), {
          cls: "mini",
          iconName: "sessions",
          actionId: "add-session",
          title: localeMessage("list_add_session_to_existing_title"),
          excludeIds: [ctx.group.data.id],
          allowCreate: false,
          ariaLabel: localeMessage("list_existing_session_picker_aria"),
          placeholder: localeMessage("list_existing_session_picker_placeholder"),
          onPick: async (value) => {
            const updated = await addWindowsToSession(
              value.id, ctx.group.data.windows, ctx.group.data.groups
            );
            if (updated) rerender();
            else showNotice?.(localeMessage("list_save_failed"));
            return Boolean(updated?.id);
          }
        })
      }] : []),
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
              onclick: async (event) => {
                const button = event.currentTarget;
                if (button.disabled) return;
                button.disabled = true;
                try {
                  const result = await cancelSnoozeJournaled(sn);
                  if (!result?.ok) { showNotice?.(snoozeActionMessage(result)); return; }
                  rerender(); renderSnoozes();
                } catch (error) {
                  showNotice?.(snoozeActionMessage(error));
                } finally { button.disabled = false; }
              } },
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
 * @typedef {Object} LabelsListContext
 * @property {ListPresentation} [presentation]
 * @property {{groups:TabListGroup[]}} data
 * @property {ListRefresh} renderLabels
 * @property {(label:string)=>unknown} goToLabel
 * @property {BackgroundMessage} msg
 * @property {ListRefresh} refreshLabelViews
 * @property {CopyRefs} copyRefs
 * @property {ListNodeFactory} confirmDelete
 * @property {CardLabelPanel} cardLabelPanel
 * @property {TabListAction} [organizationCardAction]
 * @property {(message:string)=>void} [showNotice]
 * @property {string|Node} [empty]
 */

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
 * @param {LabelsListContext} ctx
 * @returns {TabListConfig}
 */
export function buildLabelsListConfig(ctx) {
  const {
    presentation = "default", data,
    renderLabels, goToLabel, msg, refreshLabelViews, copyRefs, confirmDelete,
    cardLabelPanel, organizationCardAction = null, showNotice,
    empty = localeMessage("list_labels_empty")
  } = ctx;
  const IN = STORE_KEYS.inbox;
  let editing = false;
  const selectedSources = (selection) => selection.flatMap(({ group, indexes }) =>
    indexes.map(index => ({ ...group.data.locs[index], label: group.data.label })));
  const removeSelected = async (button, selectionContext) => {
    if (editing) return;
    editing = true;
    button.disabled = true;
    try {
      const sources = selectedSources(selectionContext.selection);
      const result = await removeLabelsFromSelections(sources);
      if (!result.ok || !result.count) {
        showNotice?.(localeMessage("list_labels_selection_changed"));
        return;
      }
      selectionContext.clear();
      refreshLabelViews();
    } catch {
      showNotice?.(localeMessage("list_labels_remove_failed"));
    } finally {
      editing = false;
      button.disabled = false;
    }
  };
  const openSelectedLabelPicker = (selectionContext) => {
    const sources = selectedSources(selectionContext.selection);
    selectionContext.panel.toggle(() => cardLabelPanel(async (labels) => {
      if (editing) throw new Error(localeMessage("list_save_failed"));
      editing = true;
      try {
        const result = await applyLabelsToSelections(sources, labels);
        if (!result.ok) {
          const message = localeMessage("list_labels_selection_changed");
          showNotice?.(message);
          throw new Error(message);
        }
        selectionContext.clear();
        refreshLabelViews();
      } finally {
        editing = false;
      }
    }, localeMessage("list_add_labels"), selectionContext.panel), "bulk-label");
  };
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
    selectable: "tab",
    bulkHint: localeMessage("list_labels_bulk_hint"),
    bulkActions: (selectionContext) => [
      selectionActionButton("copy", localeMessage("action_copy"), "copy", {
        title: localeMessage("list_copy_selected_markdown_title"),
        onclick: () => copyRefs(selectionContext.selection.flatMap(({ group, indexes }) =>
          indexes.map(index => group.refs[index])))
      }),
      selectionActionButton("label", localeMessage("action_label"), "labels", {
        title: localeMessage("list_add_labels"),
        onclick: () => openSelectedLabelPicker(selectionContext)
      }),
      ...(selectionContext.selection.some(({ group }) => group.data.combined) ? [] : [
        selectionActionButton("delete", localeMessage("list_remove_selected_labels"), null, {
          glyph: "×", class: "danger",
          onclick: (event) => removeSelected(event.currentTarget, selectionContext)
        })
      ])
    ],
    onChange: renderLabels,
    onChipOpen: goToLabel, // N30: row label chips navigate here, like every other section
    // L-nav-4 (real fix): render ALL label cards — no section cap. The default
    // 20-card cap left a "Show all N" button, and a jump chip for any card past
    // #20 found nothing (its card wasn't in the DOM yet). The jump-index + filter
    // are the navigation aid now, so every card is present for chips to land on.
    groupCap: data.groups.length,
    empty,
    rowMeta: (ref, group, i) => whereText(group.data.locs[i]),
    rowActions: (group) => [
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
      ...(group.data.combined ? [] : [{ id: "unlabel", label: localeMessage("list_remove_label_action"), glyph: "×", danger: true, key: "d",
        run: async (ctx) => {
          const loc = ctx.group.data.locs[ctx.index];
          const label = ctx.group.data.label;
          if (loc.store === STORE_KEYS.sessions) await removeSessionLabel(loc.item, label, { wi: loc.wi, i: loc.i });
          else await removeLabelFromTab(loc.store, loc.item, loc.i, label);
          refreshLabelViews();
        } }])
    ],
    groupActions: (group) => [
      { id: "open-all", label: localeMessage("list_open_all"), key: "r", // N28: r = restore/open all (card parity)
        run: (ctx) => restoreWindowRefs(ctx.group.refs) },
      { id: "copy", label: localeMessage("list_copy_markdown"), key: "c",
        run: (ctx) => copyRefs(ctx.group.refs, ctx.group.data.label) },
      ...(group.data.combined ? [] : [
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
      ])
    ]
  };
}

function snoozeActionMessage(result) {
  const reason = result?.reason ?? result?.status;
  if (reason === "session-unavailable") return localeMessage("list_snooze_session_unavailable");
  return localeMessage(["interrupted", "uncertain"].includes(reason)
    ? "list_snooze_uncertain"
    : ["stale", "missing", "busy", "already-delivered", "unavailable"].includes(reason)
      ? "list_snooze_unavailable" : "list_snooze_action_failed");
}

/**
 * @typedef {Object} SnoozedListContext
 * @property {ListPresentation} [presentation]
 * @property {{groups:TabListGroup[]}} data
 * @property {ListRefresh} renderSnoozes
 * @property {ListRefresh} renderSessions
 * @property {BackgroundMessage} msg
 * @property {CopyRefs} copyRefs
 * @property {(message:string)=>void} [showNotice]
 */

/**
 * Shared Snoozed actions. The domain operations own validation, persistence
 * and Undo; the list keeps selections on refusal and reports uncertain effects.
 * Session Snoozes refer to templates, so their individual rows are not selectable.
 *
 * @param {SnoozedListContext} ctx
 * @returns {TabListConfig}
 */
export function buildSnoozedListConfig(ctx) {
  const { presentation = "default", data, renderSnoozes, renderSessions, msg, copyRefs,
    showNotice } = ctx;

  // Selected tabs leave their Snooze with an Undo receipt for the exact split.
  const toSnoozeSources = (sel) => sel.map((s) => ({ snooze: s.group.data, indexes: s.indexes }));
  const selectionRefs = (sel) => (sel ?? []).flatMap((s) => s.indexes.map((i) => s.group.refs[i])).filter(Boolean);

  const wakeSelected = async (selections) => {
    const result = await msg({ type: "wake-snooze-tabs", selections });
    if (result?.ok) return result.opened;
    const error = new Error("Snooze delivery did not complete");
    error.reason = result?.status ?? "failed";
    error.opened = result?.opened ?? 0;
    throw error;
  };

  const runSelected = async (button, selectionContext, action) => {
    if (button.disabled) return;
    button.disabled = true;
    try {
      const count = await action(toSnoozeSources(selectionContext.selection));
      if (count > 0) selectionContext.clear();
      else showNotice?.(snoozeActionMessage({ reason: "unavailable" }));
    } catch (error) {
      // Partial completion can invalidate the old selected indexes.
      if (error?.opened > 0) selectionContext.clear();
      showNotice?.(snoozeActionMessage(error));
    } finally { button.disabled = false; }
  };

  /** Inline "reschedule to…" datetime panel for a snooze (group action). */
  const openReschedule = (c) => {
    c.panel.toggle(() => {
      const input = el("input", { type: "datetime-local", class: "inline-input" });
      const note = el("span", { class: "note", role: "alert" });
      const bar = el("div", { class: "snoozebar" },
        el("span", { class: "host" }, localeMessage("list_reschedule_to")), input,
        el("button", { class: "mini", onclick: async (event) => {
          const button = event.currentTarget;
          if (button.disabled) return;
          const t = new Date(input.value).getTime();
          if (!Number.isFinite(t)) {
            note.textContent = localeMessage("list_reschedule_pick_time");
            return;
          }
          if (t <= Date.now()) {
            note.textContent = localeMessage("list_reschedule_future_time");
            return;
          }
          button.disabled = true;
          note.textContent = "";
          try {
            const result = await rescheduleSnooze(c.group.data, t);
            if (!result?.ok) { note.textContent = snoozeActionMessage(result); return; }
            renderSnoozes();
          } catch (error) {
            note.textContent = snoozeActionMessage(error);
          } finally { button.disabled = false; }
        } }, localeMessage("list_reschedule_set")),
        note);
      setTimeout(() => input.focus(), 0);
      return bar;
    }, "reschedule");
  };

  return {
    section: "snoozed",
    foldable: true,

    presentation,
    groups: data.groups,
    selectable: "tab",
    // a session snooze's rows belong to the SESSION — per-tab wake/cancel would
    // have to mutate it (it's a template); rows show a disabled checkbox instead
    rowSelectable: (ctx) => !ctx.group.data.sessionId,
    bulkHint: localeMessage("list_snoozed_bulk_hint"),
    bulkActions: (ctx) => [
      selectionActionButton("restore", localeMessage("list_wake_now"), "switch", {
        title: localeMessage("list_wake_selected_snoozed_title"),
        onclick: (event) => runSelected(event.currentTarget, ctx, wakeSelected)
      }),
      selectionActionButton("copy", localeMessage("action_copy"), "copy", {
        title: localeMessage("list_copy_selected_markdown_title"),
        onclick: () => copyRefs(selectionRefs(ctx.selection))
      }),
      selectionActionButton("delete", localeMessage("list_cancel_selected"), "delete", { class: "danger",
        title: localeMessage("list_cancel_selected_snoozes_title"),
        onclick: (event) => runSelected(event.currentTarget, ctx, cancelSnoozeTabs)
      })
    ],
    onChange: renderSnoozes,
    empty: localeMessage("list_snoozed_empty"),
    rowActions: [starredRowAction()],
    groupActions: [
      { id: "wake", label: localeMessage("list_wake_now"), always: true, key: "r", // N28: r = restore/bring back
        run: async (ctx) => {
          try {
            const result = await msg({ type: "wake-snooze", id: ctx.group.data.id,
              expected: ctx.group.data });
            if (!result?.ok) { showNotice?.(snoozeActionMessage(result)); return; }
            renderSnoozes();
          } catch (error) { showNotice?.(snoozeActionMessage(error)); }
        } },
      { id: "reschedule", label: localeMessage("list_reschedule"), run: (ctx) => openReschedule(ctx) },
      // Cancel keeps an Undo receipt without changing a linked Session.
      { id: "cancel", label: localeMessage("action_cancel"), danger: true, key: "d", // N28: d = delete/cancel
        run: async (ctx) => {
          try {
            const result = await cancelSnoozeJournaled(ctx.group.data);
            if (!result?.ok) { showNotice?.(snoozeActionMessage(result)); return; }
            renderSessions(); renderSnoozes();
          } catch (error) { showNotice?.(snoozeActionMessage(error)); }
        } }
    ]
  };
}
