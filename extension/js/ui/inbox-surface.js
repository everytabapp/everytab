// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "../lib/failure-diagnostic.js";
/**
 * F14 — the shared Inbox surface.
 *
 * `createInboxSurface(ctx)` owns everything the Inbox section needs that is NOT a
 * generic `createTabList` config: the ordered data-gathering, the inbox-only inline
 * pieces (the snooze panel builder wrapper, delete, "save window to session"), and
 * the Inbox adapter for the shared selected-set drag controller (row moves
 * across/within bundles, explicit bundle-end targets, and the "new bundle"
 * between-zone). The atomic stale guard stays in the domain operation.
 *
 * Both the dashboard and the side panel build their Inbox section through this one
 * factory, so there is a single behavior source (spec §5.1/§5.2). Surface-specific
 * pieces are injected via `ctx` (the refresher, notice/toast sinks, and the
 * cross-section helpers that also live elsewhere: the shared snooze panel builder,
 * the shared row-label panel, the copy/leaf helpers); domain ops are imported. This
 * module performs no storage read-modify-write of its own.
 *
 * Each extension document loads its own module instance in its own realm, so the
 * closure drag state below is naturally per-document (spec §7).
 */
import { el } from "./dom.js";
import { clearSelection, createTabList, fromInboxItems } from "./tablist.js";
import { buildInboxListConfig } from "./list-configs.js";
import { createTabDragController, createTabDropZone } from "./tab-drag.js";
import { STORE_KEYS } from "../lib/types.js";
import { listItems, inboxItemTabCount, readGeneration } from "../lib/store.js";
import { snoozeTabRefs, moveInboxTabs, moveTabsToSession } from "../lib/actions.js";
import { deleteSavedItem } from "../lib/saved-item-actions.js";
import { formatNumber, msg as localeMessage } from "../lib/i18n.js";
import { buildSessionMembershipsByUrl, SESSION_IDENTITY_INDEX_KEY } from "../lib/session-identity-index.js";
import { ACTIVITY_KEY } from "../lib/tab-activity.js";
import { TAB_PROTECTIONS_KEY } from "../lib/automation-protection.js";
import { TEMPORARY_AUTOMATION_EXEMPTIONS_KEY } from "../lib/tabs.js";
import { readSessionIdentities } from "../lib/session-identity-store.js";
import { normalizeUrl } from "../lib/dedup.js";
import { createTabFilterControl } from "./tab-filter-control.js";
import {
  projectInboxAutomationAwareness, readAutomationAwarenessSnapshot
} from "../lib/automation-awareness-policy.js";

const IN = STORE_KEYS.inbox;

/**
 * @typedef {object} InboxSurfaceCtx
 * @property {() => void} ctx.rerender refresh this surface's Inbox section
 * @property {() => boolean} ctx.shouldRenderBody skip the build when off-screen
 * @property {HTMLElement} [ctx.sectionActionHost] stable header action lane
 * @property {HTMLElement} [ctx.filterHost] optional local-control row for the filter
 * @property {() => void} ctx.renderLabels @property {(label: string) => void} ctx.goToLabel
 * @property {(sessionId: string) => void} ctx.goToSession
 * @property {(m: string) => void} ctx.showNotice @property {(entry: any) => void} ctx.showToast
 * @property {(anchor: Element, text: string) => void} ctx.flashNote
 * @property {(refs: any[], heading?: string) => void} ctx.copyRefs
 * @property {Function} ctx.sessionComboboxButton @property {Function} ctx.cardLabelPanel
 * @property {Function} ctx.confirmDelete
 * @property {(commit: (dueAt: number, recurrence?: string) => any) => Node} ctx.buildSnoozePanel
 * @property {(rowCtx: any, store: string, rerender: () => void) => void} ctx.openRowLabel
 * @property {"default"|"compact"} [ctx.presentation]
 */

/**
 * @param {InboxSurfaceCtx} ctx
 * @returns {{ render: () => Promise<{heading: string, node: Node|null}> }}
 */
export function createInboxSurface(ctx) {
  // A filter keystroke changes which rows are shown, not the saved data. The
  // next render may reuse the last read as long as every key it came from is
  // still at the generation it was read at; any storage change in between
  // reads fresh. The flag is consumed by exactly one render.
  let filterRerender = false;
  /** @type {{signature:string, items:object[], sessionMembershipsByUrl:Map<string,unknown>, awarenessSnapshot:object|null}|null} */
  let lastRead = null;
  // Every key the three reads below depend on: Inbox items, the Session
  // identity index, and the automation awareness inputs.
  const READ_KEYS = [
    IN, SESSION_IDENTITY_INDEX_KEY, STORE_KEYS.sessions, "settings",
    ACTIVITY_KEY, TEMPORARY_AUTOMATION_EXEMPTIONS_KEY, TAB_PROTECTIONS_KEY
  ];
  const readSignature = () => READ_KEYS.map((key) => readGeneration(key)).join(":");
  /** The list most recently returned by render(), for instant in-place filtering. */
  let mountedList = null;
  const rowMatches = (ref, query) =>
    `${ref?.title ?? ""}\n${ref?.url ?? ""}`.toLocaleLowerCase().includes(query);
  /**
   * Typing feedback must not wait for a rebuild of thousands of cards. Hide or
   * show the already mounted rows against the new query immediately; the
   * debounced render then rebuilds the exact list (counts, empty state,
   * selection) from the reused read. Row source indexes are untouched.
   */
  function applyLiveFilter(rawQuery) {
    const query = rawQuery.trim().toLocaleLowerCase();
    if (!mountedList?.isConnected) return;
    for (const card of mountedList.querySelectorAll("[data-tablist-card]")) {
      let visible = 0;
      for (const row of card.querySelectorAll("[data-tablist-row]")) {
        const show = !query || rowMatches(row._tlRow?.ctx?.ref, query);
        row.hidden = !show;
        if (show) visible += 1;
      }
      card.hidden = visible === 0;
    }
  }
  const filter = createTabFilterControl({
    placeholder: localeMessage("list_filter_tabs_placeholder"),
    ariaLabel: localeMessage("list_filter_inbox_tabs_aria"),
    shortcut: "f",
    // A large mounted list waits a little longer for the typing burst to end.
    debounceMs: () => ((lastRead?.items.length ?? 0) > 400 ? 160 : 60),
    rerender: () => { filterRerender = true; return ctx.rerender(); },
    onInput: (value) => { clearSelection("inbox"); applyLiveFilter(value); },
    onClear: () => { clearSelection("inbox"); applyLiveFilter(""); }
  });
  const mountedFilterHost = ctx.filterHost ?? ctx.sectionActionHost;
  mountedFilterHost?.prepend(filter.element);

  /* ---- Inbox drag — move selected rows across bundles / reorder within one /
   * drop between bundles to start a new one. Store mutations with exact undo
   * and the [AP] stale-drop guard live in lib (`moveInboxTabs`); this is only
   * the pointer plumbing. Drag state lives here (not dataTransfer) — complete
   * rendered source snapshots are captured at lift, and the rendered target is
   * captured at drop. `body.inbox-dragging` reveals the zones — on a tick, never
   * synchronously in dragstart (the 0.8.29 lesson). ---- */

  const inboxDrag = createTabDragController({ bodyClass: "inbox-dragging" });

  function selectedInboxSources(entries) {
    return (entries ?? []).map((entry) => ({
      item: structuredClone(entry.group.data),
      indexes: entry.indexes ?? []
    })).filter((source) => source.indexes.length);
  }

  function sourceContains(drag, itemId, index) {
    return drag?.sources.some((source) =>
      source.item.id === itemId && source.indexes.includes(index));
  }

  /** Snooze panel (presets/custom/recurrence) → snoozeTabRefs, then `after`. */
  function buildSnooze(sources, after) {
    return ctx.buildSnoozePanel(async (dueAt, recurrence) => {
      const srcs = typeof sources === "function" ? sources() : sources;
      if (!srcs.length) return;
      await snoozeTabRefs(srcs, dueAt, recurrence);
      after();
    });
  }

  async function delInboxItem(item) {
    await deleteSavedItem(IN, item, localeMessage("list_deleted_inbox_item"), {
      actionKind: "deleted-saved-item", actionParams: { location: "inbox" }
    });
    ctx.rerender();
  }

  /**
   * P2g-1: an Inbox window card enters a session via moveTabsToSession over ALL
   * its tabs — the same split-aware, journaled path as bulk "→ Session", so
   * "save as new" and "append to existing" behave identically (the emptied item
   * tombstones itself; Undo restores it exactly).
   */
  async function saveWindowItemToSession(item, v) {
    const sources = [{ item, indexes: item.tabs.map((_, i) => i) }];
    const res = await moveTabsToSession(sources, v.isNew ? "__new" : v.id,
      v.isNew ? (v.name || undefined) : undefined, v.organization);
    if (!res?.moved) return false;
    ctx.rerender();
    if (res.entry) ctx.showToast(res.entry);
    return true;
  }

  const inboxRowDrag = {
    draggable: () => true,
    onStart: (c, e) => {
      const selected = selectedInboxSources(c.dragSelection);
      const count = selected.reduce((total, source) => total + source.indexes.length, 0);
      const sources = count > 1 ? selected : [{
        item: structuredClone(c.group.data), indexes: [c.index]
      }];
      inboxDrag.start(c, e, { sources },
        sources.reduce((total, source) => total + source.indexes.length, 0));
    },
    onEnd: () => inboxDrag.reset(),
    onOver: (c, e) => {
      const drag = inboxDrag.current();
      if (!drag || sourceContains(drag, c.group.data.id, c.index)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      c.rowEl.classList.add("drop-target");
    },
    onLeave: (c) => c.rowEl.classList.remove("drop-target"),
    onDrop: async (c, e) => {
      e.preventDefault();
      c.rowEl.classList.remove("drop-target");
      await dropInboxTabs(c.group.data, c.index); // insert before this row
    }
  };

  /** Perform the drop: `targetItem` null = new bundle. The guard's toast lives here. */
  async function dropInboxTabs(targetItem, toIndex) {
    const d = inboxDrag.current();
    if (!d) return;
    const sources = d.sources;
    const targetExpected = targetItem ? structuredClone(targetItem) : null;
    inboxDrag.reset();
    const res = await moveInboxTabs(sources, targetExpected, toIndex);
    if (!res.ok && res.stale) ctx.showNotice(localeMessage("list_changed_nothing_moved"));
    if (res.ok && !res.noop) clearSelection("inbox");
    ctx.rerender();
    ctx.renderLabels();
  }

  /** The between-bundles zone: drop a dragged row to start a fresh bundle. */
  function newBundleZone() {
    return createTabDropZone({ className: "drop-zone-new",
      text: localeMessage("list_drop_new_inbox_bundle"),
      canDrop: () => Boolean(inboxDrag.current()), onDrop: () => dropInboxTabs(null, -1) });
  }

  function endBundleZone(group) {
    const label = localeMessage("list_move_end_named", [group.title]);
    return createTabDropZone({ className: "drop-zone-window-end", label,
      canDrop: () => Boolean(inboxDrag.current()),
      onDrop: () => dropInboxTabs(group.data, -1) });
  }

  /**
   * Order the Inbox by when each item ENTERED the Inbox (createdAt), not by
   * modifiedAt. listItems sorts by modifiedAt, and labeling re-upserts an item
   * with a fresh modifiedAt, which visibly jumped the item to the top when you
   * added a label (confusing). createdAt is stable, so a newly saved item still
   * appears at the top while labeling leaves order intact.
   */
  async function readInputs() {
    /** @type {import("../lib/types.js").InboxItem[]} */
    const [rawItems, identities, awarenessSnapshot] = await Promise.all([
      listItems(IN),
      readSessionIdentities(),
      ctx.shouldRenderBody() && ctx.automationAwareness
        ? readAutomationAwarenessSnapshot().catch((error) => {
          reportFailure("Inbox automation indicators", error);
          return null;
        }) : null
    ]);
    const items = rawItems
      .sort((a, b) => (b.createdAt ?? b.modifiedAt ?? 0) - (a.createdAt ?? a.modifiedAt ?? 0));
    // Capture the generations after the reads: the first read in a context
    // registers the store's change listener, which advances every cached
    // generation once. Any later storage change schedules an ordinary render,
    // which always reads fresh.
    return {
      signature: readSignature(), items, awarenessSnapshot,
      sessionMembershipsByUrl: buildSessionMembershipsByUrl(identities)
    };
  }

  async function render() {
    const reuse = filterRerender && lastRead && lastRead.signature === readSignature();
    filterRerender = false;
    const read = reuse ? lastRead : await readInputs();
    lastRead = read;
    const { items, sessionMembershipsByUrl, awarenessSnapshot } = read;
    const awarenessByItemId = awarenessSnapshot
      ? projectInboxAutomationAwareness(items, awarenessSnapshot)
      : new Map();
    const tabCount = items.reduce((total, item) => total + inboxItemTabCount(item), 0);
    const heading = localeMessage("list_inbox_heading", [formatNumber(tabCount)]);
    if (!ctx.shouldRenderBody()) return { heading, node: null };
    // Sample every cached awareness trigger once before the build; see
    // automation-awareness.withRowRender for the quadratic recalc it avoids.
    const buildList = () => createTabList(buildInboxListConfig({
      presentation: ctx.presentation ?? "default",
      data: {
        groups: fromInboxItems(items,
          (url) => sessionMembershipsByUrl.get(normalizeUrl(url))),
        awarenessByItemId
      },
      renderInbox: ctx.rerender, renderLabels: ctx.renderLabels,
      goToLabel: ctx.goToLabel, goToSession: ctx.goToSession,
      buildSnooze, inboxRowDrag, newBundleZone, endBundleZone,
      inboxDrag: () => inboxDrag.current(), dropInboxTabs,
      showNotice: ctx.showNotice, copyRefs: ctx.copyRefs, sessionComboboxButton: ctx.sessionComboboxButton,
      saveWindowItemToSession, cardLabelPanel: ctx.cardLabelPanel, confirmDelete: ctx.confirmDelete,
      delInboxItem, flashNote: ctx.flashNote, showToast: ctx.showToast, openRowLabel: ctx.openRowLabel,
      rowVisible: ({ ref }) => {
        const query = filter.value().trim().toLocaleLowerCase();
        return !query || rowMatches(ref, query);
      },
      automationAwareness: ctx.automationAwareness,
      empty: filter.value().trim() ? localeMessage("search_no_matches") : null
    }));
    const node = ctx.automationAwareness?.withRowRender
      ? ctx.automationAwareness.withRowRender(buildList)
      : buildList();
    mountedList = node;
    return { heading, node };
  }

  return { render, handleFilterShortcut: filter.handleShortcut };
}
