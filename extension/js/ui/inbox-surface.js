/**
 * F14 — the shared Inbox surface.
 *
 * `createInboxSurface(ctx)` owns everything the Inbox section needs that is NOT a
 * generic `createTabList` config: the ordered data-gathering, the inbox-only inline
 * pieces (the snooze panel builder wrapper, delete, "save window to session"), and
 * the whole inbox drag machinery (row drag across/within bundles + the "new bundle"
 * between-zone + the [AP] stale-drop guard's plumbing). It holds the per-surface
 * drag state those pieces need across renders (the lifted row's item/index/modifiedAt).
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
import { createTabList, fromInboxItems } from "./tablist.js";
import { buildInboxListConfig } from "./list-configs.js";
import { STORE_KEYS } from "../lib/types.js";
import { listItems } from "../lib/store.js";
import { snoozeTabRefs, moveInboxTab, moveTabsToSession } from "../lib/actions.js";
import { deleteSavedItem } from "../lib/saved-item-actions.js";
import { formatNumber, msg as localeMessage } from "../lib/i18n.js";

const IN = STORE_KEYS.inbox;

/**
 * @typedef {object} InboxSurfaceCtx
 * @property {() => void} ctx.rerender refresh this surface's Inbox section
 * @property {() => boolean} ctx.shouldRenderBody skip the build when off-screen
 * @property {() => void} ctx.renderLabels @property {(label: string) => void} ctx.goToLabel
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
  /* ---- P2g-4b: Inbox drag — move a row across bundles / reorder within one /
   * drop between bundles to start a new one. Store mutations with EXACT undo
   * and the [AP] stale-drop guard live in lib (`moveInboxTab`); this is only
   * the pointer plumbing. Drag state lives here (not dataTransfer) — the
   * captured modifiedAt values are the LIFT-time state the guard compares
   * against. `body.inbox-dragging` reveals the zones — on a tick, never
   * synchronously in dragstart (the 0.8.29 lesson). ---- */

  /** @type {{itemId: string, index: number, modifiedAt: number}|null} */
  let inboxDrag = null;
  let inboxRevealTimer = 0;

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
    const res = await moveTabsToSession(sources, v.isNew ? "__new" : v.id, v.isNew ? (v.name || undefined) : undefined);
    ctx.rerender();
    if (res?.entry) ctx.showToast(res.entry);
  }

  const inboxRowDrag = {
    draggable: () => true,
    onStart: (c, e) => {
      inboxDrag = { itemId: c.group.data.id, index: c.index, modifiedAt: c.group.data.modifiedAt };
      c.rowEl.classList.add("dragging");
      inboxRevealTimer = setTimeout(() => document.body.classList.add("inbox-dragging"), 0);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", ""); // some platforms need data for a drag to start
    },
    onEnd: (c) => {
      clearTimeout(inboxRevealTimer);
      inboxDrag = null;
      c.rowEl.classList.remove("dragging");
      document.body.classList.remove("inbox-dragging");
    },
    onOver: (c, e) => {
      if (!inboxDrag) return;
      if (inboxDrag.itemId === c.group.data.id && inboxDrag.index === c.index) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      c.rowEl.classList.add("drop-target");
    },
    onLeave: (c) => c.rowEl.classList.remove("drop-target"),
    onDrop: async (c, e) => {
      e.preventDefault();
      c.rowEl.classList.remove("drop-target");
      await dropInboxTab(c.group.data, c.index); // insert before this row
    }
  };

  /** Perform the drop: `targetItem` null = new bundle. The guard's toast lives here. */
  async function dropInboxTab(targetItem, toIndex) {
    const d = inboxDrag;
    if (!d) return;
    if (targetItem && targetItem.id === d.itemId && toIndex === -1) return; // header of its own bundle
    const res = await moveInboxTab(d.itemId, d.index, targetItem ? targetItem.id : null, toIndex,
      { source: d.modifiedAt, ...(targetItem ? { target: targetItem.modifiedAt } : {}) });
    if (!res.ok && res.stale) ctx.showNotice(localeMessage("list_changed_nothing_moved"));
    ctx.rerender();
    ctx.renderLabels();
  }

  /** The between-bundles zone: drop a dragged row to start a fresh bundle. */
  function newBundleZone() {
    const z = el("div", { class: "drop-zone-new" }, localeMessage("list_drop_new_inbox_bundle"));
    z.addEventListener("dragover", (e) => {
      if (!inboxDrag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      z.classList.add("on");
    });
    z.addEventListener("dragleave", () => z.classList.remove("on"));
    z.addEventListener("drop", async (e) => {
      e.preventDefault();
      z.classList.remove("on");
      await dropInboxTab(null, -1);
    });
    return z;
  }

  /**
   * Order the Inbox by when each item ENTERED the Inbox (createdAt), not by
   * modifiedAt. listItems sorts by modifiedAt, and labeling re-upserts an item
   * with a fresh modifiedAt, which visibly jumped the item to the top when you
   * added a label (confusing). createdAt is stable, so a newly saved item still
   * appears at the top while labeling leaves order intact.
   */
  async function render() {
    /** @type {import("../lib/types.js").InboxItem[]} */
    const items = (await listItems(IN))
      .sort((a, b) => (b.createdAt ?? b.modifiedAt ?? 0) - (a.createdAt ?? a.modifiedAt ?? 0));
    const heading = localeMessage("list_inbox_heading", [formatNumber(items.length)]);
    if (!ctx.shouldRenderBody()) return { heading, node: null };
    const node = createTabList(buildInboxListConfig({
      presentation: ctx.presentation ?? "default",
      data: { groups: fromInboxItems(items) },
      renderInbox: ctx.rerender, renderLabels: ctx.renderLabels, goToLabel: ctx.goToLabel,
      buildSnooze, inboxRowDrag, newBundleZone, inboxDrag: () => inboxDrag, dropInboxTab,
      showNotice: ctx.showNotice, copyRefs: ctx.copyRefs, sessionComboboxButton: ctx.sessionComboboxButton,
      saveWindowItemToSession, cardLabelPanel: ctx.cardLabelPanel, confirmDelete: ctx.confirmDelete,
      delInboxItem, flashNote: ctx.flashNote, showToast: ctx.showToast, openRowLabel: ctx.openRowLabel
    }));
    return { heading, node };
  }

  return { render };
}
