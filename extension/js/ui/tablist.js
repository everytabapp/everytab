/**
 * U3 / P2e — the ONE list component every tab list renders through.
 *
 * Five sections (Open tabs, Inbox, Archive, Sessions/Snapshots, Snoozed) used
 * to render "a list of tabs, maybe grouped into windows" five different ways.
 * `createTabList(config)` is the single anatomy; sections supply *only* config
 * (data adapter + which actions exist). The discipline that keeps it unified:
 * NO section-specific branches inside this file — everything that varies comes
 * through the config, and every group is the same normalized shape.
 *
 * Anatomy (list-ui.md):
 *   TabRow    — [checkbox lane] [favicon] [title + secondary context] [chips] [actions]
 *   GroupCard — .item card: header [checkbox?][glyph][title][chips][meta][actions]
 *               + body of TabRows capped at rowCap with a real expand toggle.
 *               A `loose` group renders as bare rows (no card wrapper).
 *   ListShell — optional bulk bar (master checkbox + count + action set),
 *               section cap (groupCap) with "Show all", empty-state slot.
 *
 * State (selection, per-group expand, section expand, keyboard arm/focus) lives
 * here keyed by `section` id, so a section's re-render (which rebuilds the whole
 * component from fresh data) preserves selection and open/closed state.
 */
import { el } from "./dom.js";
import { icon } from "./icons.js";
import { msg } from "../lib/i18n.js";
import { compactRelativeAge } from "../lib/relative-time.js";
import {
  listArchiveMeta, listCurrentWindowBadge, listDuplicateMeta, listInboxMeta,
  listOpenWindowMeta, listOpenWindowTitle, listPanelCopy, listSelectionSummary,
  listSessionMeta, listSessionWindowMeta, listShortActionLabel, listSingleTabTitle,
  listSourceLabel, listUnit, listWindowCardTitle
} from "./list-copy.js";
import { recurrenceLabel } from "../lib/snooze.js";
import { canonicalRef, urlOf, isSaveableTab, isOwnSuspendPage } from "../lib/tabs.js";
import { GROUP_COLOR_HEX } from "../lib/tab-groups.js"; // F18: valid tab-group color names

/** P2g-2: row chips shown before the "+N" overflow button. */
const ROW_CHIP_CAP = 2;

/* ============================ per-section state ============================ */

/** @type {Map<string, {selected:Set<string>, expanded:Set<string>, sectionExpanded:boolean, keeperVisible:boolean, keeperMotionAllowed:boolean, armedDel:{el:HTMLElement,timer:number}|null, pendingFocus:number|null, pendingCardFocus:number|null}>} */
const STATE = new Map();
function stateFor(section) {
  let s = STATE.get(section);
  if (!s) {
    s = { selected: new Set(), expanded: new Set(), sectionExpanded: false,
      keeperVisible: false, keeperMotionAllowed: false,
      armedDel: null, pendingFocus: null, pendingCardFocus: null,
      folded: new Set(),    // F47: cards collapsed to their header (opt-in per section)
      chipsOpen: new Set(), // P2g-2: rows whose label chips are expanded past the cap
      anchor: null,         // N14: last individually-selected row — shift+click's range start
      rangeEnd: null };     // the last range endpoint — re-hitting it toggles the range off
    STATE.set(section, s);
  }
  return s;
}
/** Clear a section's tab selection (used by bulk "clear" flows in the section). */
export function clearSelection(section) {
  stateFor(section).selected.clear();
}

/** The latest live instance per section, so the global keyboard handler can find config. */
const INSTANCES = new Map();

/* ==================== P2g-4d: keyboard move (the P5 handle) ====================
 * ONE lift at a time, module-wide. The component owns the state machine, the
 * slot registry (collected during render, in visual order), the `.kbd-slot`
 * highlight and the aria-live region; the SECTION owns only `keyMoveCommit`,
 * which calls the same op its pointer drops call — stale guards and
 * journaling come free. Focus stays on the handle for the whole flow; after
 * a drop, the P2g-4a focus rule places it. */

/** @type {HTMLElement|null} shared polite live region (lazily attached) */
let liveRegion = null;
function announce(text) {
  if (typeof document === "undefined") return;
  if (!liveRegion) {
    liveRegion = el("div", { class: "sr-only", role: "status", "aria-live": "polite" });
    document.body.append(liveRegion);
  }
  liveRegion.textContent = text;
}

/** @type {{section: string, handle: HTMLElement, srcCtx: object, slots: object[], sel: number}|null} */
let kbdLift = null;
function cancelKbdLift(msg) {
  if (!kbdLift) return;
  kbdLift.slots[kbdLift.sel]?.el?.classList.remove("kbd-slot");
  kbdLift = null;
  if (msg) announce(msg);
}

const rowKey = (gid, idx) => `${gid}::${idx}`;
/** U6 (P2g-3): composite key for a row inside a multi-window group (sessions). */
const rowKeyW = (gid, wi, idx) => `${gid}::w${wi}::${idx}`;

/* ============================== pure helpers ============================== */

/** "N tabs selected (across M items)" — the shared bulk-count phrasing. */
export function selectionSummary(count, sourceCount) {
  return listSelectionSummary(count, sourceCount);
}

/** Is this group immutable (N8: no mutating affordances render)? */
export function isImmutableGroup(group, immutable) {
  return typeof immutable === "function" ? !!immutable(group) : false;
}

/**
 * Actions that survive immutability: only those flagged `always` (the reading
 * exits — restore-window, restore-all, delete-whole, export, per-tab restore).
 * Structural, not a per-button exception (list-ui.md criterion 3). Used for
 * group-header, per-window and per-row action sets alike.
 */
export function visibleGroupActions(actions, isImmutable) {
  if (!isImmutable) return actions ?? [];
  return (actions ?? []).filter((a) => a.always);
}

/**
 * Row actions on an immutable group keep only the reads (`always`) — per-tab
 * mutations (label/delete) are dropped; a read like "Restore this tab" stays.
 * (A section whose row actions are all mutating gets [] — the P2e-1 case.)
 */
export function rowActionsFor(actions, isImmutable) {
  return visibleGroupActions(actions, isImmutable);
}

/** Selection is off on immutable groups (no checkboxes). */
export function selectableFor(base, isImmutable) {
  return isImmutable ? "none" : base;
}

/* =============================== adapters =============================== */
/* Pure store-shape → normalized groups. One per section; unit-tested. A group:
 *   { id, kind, title, glyph?, chips?, meta?, refs: TabRef[], loose?, live?, data }
 */

/**
 * N10 — display names for InboxSource values. W1 (2026-07-15) settled the
 * user-facing verb as "save" (destination: the Inbox): a manual/idle save reads
 * "saved"; the automatic sweep reads "auto-saved". Display layer ONLY: the
 * stored enum values (`dump`, `auto-archive`) are vault data — never migrate.
 * @type {Record<import("../lib/types.js").InboxSource, string>}
 */
export const SOURCE_LABELS = Object.freeze(Object.defineProperties({}, {
  "auto-archive": { enumerable: true, get: () => listSourceLabel("auto-archive") },
  dump: { enumerable: true, get: () => listSourceLabel("dump") },
  dedup: { enumerable: true, get: () => listSourceLabel("dedup") },
  manual: { enumerable: true, get: () => listSourceLabel("manual") },
  snooze: { enumerable: true, get: () => listSourceLabel("snooze") }
}));

/** @param {string} source */
export const sourceLabel = listSourceLabel;

/**
 * Archive (and any InboxItem-shaped store): one card per item.
 * @param {import("../lib/types.js").InboxItem[]} items
 */
export function fromArchiveItems(items) {
  return (items ?? []).map((item) => ({
    id: item.id,
    kind: item.kind,
    // A single-tab card's header is a structural descriptor ("Single tab"), not
    // the tab's own title — the row below already shows that (parity with the
    // window card's "Window · N tabs"; avoids the title appearing twice).
    title: item.kind === "window" ? listWindowCardTitle(item.tabs.length) : listSingleTabTitle(),
    chips: item.labels ?? [],
    meta: listArchiveMeta(item.source, item.archivedAt ?? item.modifiedAt),
    refs: item.tabs,
    loose: false,
    data: item
  }));
}

/**
 * Sessions & Snapshots: one card per session, body split into per-window
 * sub-blocks (`windows`), so "Restore window" survives. `auto` sessions are
 * snapshots — the section marks them immutable.
 * @param {import("../lib/types.js").Session[]} sessions
 */
export function fromSessions(sessions) {
  return (sessions ?? []).map((s) => {
    const tabCount = s.windows.reduce((n, w) => n + w.length, 0);
    return {
      id: s.id,
      kind: s.auto ? "snapshot" : "session",
      title: s.name,
      // U9 (P2g-2): the card surfaces the UNION of its tabs' labels; per-tab
      // chips render on the rows themselves. Snapshots are immutable, so their
      // chips (if any ever exist) carry no remove affordance.
      chips: [...new Set(s.windows.flat().flatMap((t) => t.labels ?? []))],
      meta: listSessionMeta(s.windows.length, tabCount, s.modifiedAt),
      windows: s.windows.map((refs, wi) => {
        // F18: read-only tab-group chips (color dot + name + tab count) on each
        // window block. Only groups that still have tabs in this window show.
        const templates = s.groups?.[wi] ?? [];
        const groupChips = templates
          .map((tpl, gi) => ({
            title: tpl.title || "",
            // Guard the CSS class against an unknown color (defaults to grey).
            color: GROUP_COLOR_HEX[tpl.color] ? tpl.color : "grey",
            count: refs.filter((r) => r.groupIndex === gi).length
          }))
          .filter((c) => c.count > 0);
        return {
          id: `${s.id}::${wi}`,
          meta: listSessionWindowMeta(wi + 1, refs.length),
          refs,
          groups: templates, // F18: passed to restore-window so it recreates groups
          ...(groupChips.length ? { groupChips } : {})
        };
      }),
      data: s
    };
  });
}

/**
 * Inbox: one card per item (window bundle or loose tab). Header carries the
 * labels (chips), source + age, and the item's card actions; body = TabRows.
 * @param {import("../lib/types.js").InboxItem[]} items
 */
export function fromInboxItems(items) {
  return (items ?? []).map((item) => ({
    id: item.id,
    kind: item.kind,
    // Single-tab header = "Single tab" (structural), not the tab's title, which
    // the row below already shows — mirrors the window card's "Window · N tabs".
    title: item.kind === "window" ? listWindowCardTitle(item.tabs.length) : listSingleTabTitle(),
    chips: item.labels ?? [],
    meta: listInboxMeta(item.source, item.createdAt),
    refs: item.tabs,
    loose: false,
    data: item
  }));
}

/**
 * Snoozed: one card per snooze. A window snooze (`tabs[]`, P2b-1) is a bundle
 * of rows; a legacy single-tab snooze is a one-row group. The `details` hack
 * goes away — both are ordinary GroupCards.
 * P2g-5: a SESSION snooze (`sessionId`) renders as a bundle named after its
 * session, rows read LIVE from `sessionsById` (the snooze owns no tabs — it is
 * a scheduled Restore-all). A deleted session leaves an empty, labeled card.
 * @param {import("../lib/types.js").Snooze[]} snoozes
 * @param {Map<string, import("../lib/types.js").Session>|null} [sessionsById]
 */
export function fromSnoozes(snoozes, sessionsById = null) {
  return (snoozes ?? []).map((s) => {
    if (s.sessionId) {
      const sess = sessionsById?.get(s.sessionId) ?? null;
      return {
        id: s.id,
        kind: "session-snooze",
        title: msg("list_snoozed_session_title", [sess?.name ?? s.title]),
        chips: s.recurrence ? [recurrenceLabel(s.recurrence)] : [],
        meta: sess
          ? msg("list_restores_at", [new Date(s.dueAt).toLocaleString()])
          : msg("list_restores_at_deleted", [new Date(s.dueAt).toLocaleString()]),
        refs: sess ? sess.windows.flat() : [],
        loose: false,
        data: s
      };
    }
    const bundle = Array.isArray(s.tabs) && s.tabs.length > 0;
    return {
      id: s.id,
      kind: "snooze",
      // F45: a card header is a structural descriptor, so one snoozed tab reads
      // "Single tab" exactly as it does in Inbox and Archive. Repeating the page
      // title here said the same thing twice, once in the header and once in the
      // row directly beneath it.
      title: bundle && s.tabs.length > 1
        ? listWindowCardTitle(s.tabs.length)
        : listSingleTabTitle(),
      chips: s.recurrence ? [recurrenceLabel(s.recurrence)] : [],
      meta: msg("list_due_at", [new Date(s.dueAt).toLocaleString()]),
      refs: bundle ? s.tabs : [{ url: s.url, title: s.title || s.url }],
      loose: false,
      data: s
    };
  });
}

/**
 * Open tabs: one group per live window. Rows display the canonical page (a
 * suspended tab shows its underlying page, not suspend.html); `live` carries the
 * per-tab handles the actions/drag/selection need (tabId, windowId, chrome index,
 * pinned/audible/suspended, and whether it's a saveable http tab).
 * @param {chrome.windows.Window[]} windows already filtered to normal windows
 * @param {((url:string) => string[]|null)|null} getSavedLabels
 * @param {number|null} currentWindowId the window that owns this EveryTab surface
 */
export function fromOpenWindows(windows, getSavedLabels = null, currentWindowId = null) {
  return (windows ?? []).map((win, i) => {
    const tabs = (win.tabs ?? []).filter((t) => t.id !== undefined);
    const refs = [];
    const live = [];
    for (const t of tabs) {
      const cref = canonicalRef(t);
      const url = cref?.url ?? urlOf(t);
      // P2g-2r: a live tab carries no stored labels, but if a labeled SAVED copy
      // of the same page exists (Inbox/Archive), surface those labels read-only.
      const saved = getSavedLabels ? getSavedLabels(url) : null;
      refs.push({ url, title: cref?.title ?? t.title ?? url, favIconUrl: cref?.favIconUrl ?? t.favIconUrl, pinned: t.pinned,
        ...(saved?.length ? { labels: saved } : {}) });
      live.push({
        tabId: t.id, windowId: t.windowId, chromeIndex: t.index,
        pinned: !!t.pinned, audible: !!t.audible, suspended: isOwnSuspendPage(t),
        lastAccessed: t.lastAccessed,
        // N9: canonical selectability — a suspended tab IS selectable (its ref
        // already carries the underlying page); chrome:// etc. stay disabled.
        selectable: isSaveableTab(t)
      });
    }
    const isCurrent = Number.isInteger(currentWindowId)
      ? win.id === currentWindowId
      : !!win.focused;
    return {
      id: String(win.id),
      kind: "openwindow",
      title: listOpenWindowTitle(i + 1),
      glyph: "open",
      // F47r: "current window" left the grey meta for accent-ink text that sits
      // immediately right of the name, because it qualifies the name.
      ...(isCurrent ? { badge: listCurrentWindowBadge() } : {}),
      meta: listOpenWindowMeta(tabs.length),
      refs, live, loose: false, data: win
    };
  });
}

/**
 * F47: name and order the live windows.
 *
 * **Naming.** Chrome's own "Name window" is not exposed to extensions at all,
 * and a name of our own would have to be keyed by `windowId`, which Chrome
 * resets every session — a name that quietly evaporates on restart is worse
 * than no name in a product whose promise is that nothing is lost. What IS
 * durable is a saved session, so a window bound to one takes that session's
 * name. "Name this window" is therefore "Save as session", which already
 * exists, and the name survives restarts, sync, and the vault.
 *
 * **Order.** The window you are in comes first; the rest keep Chrome's own
 * order. Full most-recently-used ordering was deliberately NOT built: it would
 * reshuffle the page every time you alt-tab, and a list that moves under you is
 * a worse trade than a list where only your own window is promoted.
 * @param {ReturnType<typeof fromOpenWindows>} groups
 * @param {Record<string, {sessionId: string, windowIndex?: number}>} bindings
 * @param {Map<string, {name: string}>} sessionsById
 * @param {number|null} currentWindowId the window that owns this EveryTab surface
 */
export function nameAndOrderOpenWindows(
  groups,
  bindings = {},
  sessionsById = new Map(),
  currentWindowId = null
) {
  const named = (groups ?? []).map((g) => {
    const binding = bindings[g.data?.id];
    const session = binding ? sessionsById.get(binding.sessionId) : null;
    return session?.name ? { ...g, title: session.name, glyph: "sessions" } : g;
  });
  const current = named.findIndex((g) => Number.isInteger(currentWindowId)
    ? g.data?.id === currentWindowId
    : g.data?.focused);
  if (current <= 0) return named;
  return [named[current], ...named.slice(0, current), ...named.slice(current + 1)];
}

/**
 * Duplicate copies: one card per canonical page, one live row per open copy.
 * The adapter deliberately includes the survivor and pinned copies so the
 * user can understand the whole group; row actions decide which extras remain
 * closable after the fresh scan.
 * @param {Array<{key:string, keep:chrome.tabs.Tab, close:chrome.tabs.Tab[], tabs:chrome.tabs.Tab[]}>} groups
 */
export function fromDuplicateGroups(groups) {
  return (groups ?? []).map((group) => {
    const tabs = (group.tabs ?? [group.keep, ...group.close])
      .filter((tab) => tab?.id !== undefined)
      .slice()
      .sort((a, b) => (a.windowId ?? 0) - (b.windowId ?? 0) || (a.index ?? 0) - (b.index ?? 0));
    const refs = tabs.map((tab) => {
      const ref = canonicalRef(tab);
      const url = ref?.url ?? urlOf(tab);
      return {
        url,
        title: ref?.title ?? tab.title ?? url,
        favIconUrl: ref?.favIconUrl ?? tab.favIconUrl,
        pinned: !!tab.pinned
      };
    });
    const windowCount = new Set(tabs.map((tab) => tab.windowId)).size;
    return {
      id: `duplicate::${group.key}`,
      kind: "duplicate",
      title: group.keep.title || group.key,
      meta: listDuplicateMeta(tabs.length, windowCount),
      refs,
      live: tabs,
      loose: false,
      data: {
        key: group.key,
        keepId: group.keep.id,
        closeIds: new Set(group.close.map((tab) => tab.id))
      }
    };
  });
}

/* ============================ the component ============================ */

/**
 * @param {Object} config
 * @param {string} config.section stable id for state
 * @param {Array} config.groups normalized groups (see adapters)
 * @param {"tab"|"group"|"none"} [config.selectable]
 * @param {Array<{id,label,icon?,glyph?,key?,danger?,run:(ctx)=>void}>} [config.rowActions]
 * @param {Array<{id,label,icon?,danger?,always?,render?:(ctx)=>Node,run?:(ctx)=>void}>} [config.groupActions]
 * @param {(ctx)=>Node[]} [config.bulkActions] returns the bulk action set given {selection,count,clear,rerender,panel}
 * @param {string} [config.bulkHint] shown in the bulk bar at 0 selection
 * @param {boolean} [config.bulkAlways] render the bulk set even at 0 selection (Open tabs)
 * @param {(ref,group,index)=>(string|Node)} [config.rowMeta]
 * @param {(group)=>boolean} [config.immutable]
 * @param {(group,label)=>void} [config.onChipRemove]
 * @param {(ctx,label)=>void} [config.onRowChipRemove] P2g-2: remove a per-tab label (row chips)
 * @param {number} [config.rowCap] rows shown per group before expand (default 8)
 * @param {number} [config.groupCap] groups shown before section expand (default 20)
 * @param {()=>void} [config.onChange] the section's (coalesced) re-render
 * @param {Node|Node[]} [config.toolbar] section-level controls above the bulk bar
 * @param {string|Node} [config.empty] empty-state
 * @returns {HTMLElement}
 */
export function createTabList(config) {
  const {
    section,
    // F14-2d: the panel opts into a compact skin. "compact" sets `data-compact` on
    // the tablist root (CSS-only in `css/sidepanel.css`); the DOM structure, action
    // ids/keys/guards, and behavior are identical. The default (omitted) adds NO
    // attribute, so every existing (dashboard) caller's markup is byte-for-byte
    // unchanged. Action-overflow/menu behavior for compact lands in a later batch.
    presentation = "default",
    groups = [],
    selectable = "none",
    rowActions = [],
    groupActions = [],
    windowActions = [],
    bulkActions = null,
    bulkHint = msg("list_bulk_hint_default"),
    bulkAlways = false,
    rowMeta = null,
    immutable = null,
    onChipRemove = null,
    onRowChipRemove = null, // P2g-2: (ctx, label) => void — enables the × on per-tab row chips
    onChipOpen = null,      // P2g-2r2: (label) => void — label chips navigate (e.g. to the Labels section)
    rowCap = 8,
    groupCap = 20,
    // F47: cards can collapse to their header. Opt-in, because it only makes
    // sense where a card is a place you work rather than one saved thing.
    foldable = false,
    onChange = () => {},
    toolbar = null,
    empty = null,
    // --- generic sockets (Open tabs uses these; other sections leave them off) ---
    rowKey: rowKeyFn = null,       // (group,index) => stable key (default group.id::index)
    rowSelectable = null,          // (ctx) => bool — a non-selectable row shows a disabled checkbox and is excluded from select-all
    rowBadges = null,              // (ctx) => Node[] — extra inline marks before the title (e.g. audible)
    rowOpen = null,                // (ctx) => void — override the title-link click (Open tabs: switch to the live tab, not open a duplicate)
    groupBanner = null,            // (group) => Node|null — content between header and rows (e.g. session drift)
    groupPanelTop = false,         // F13: render the card's toggled panel (grpSlot) directly under the header instead of at the card bottom — so a header action's panel opens next to its button, not below a long tab list
    rowDrag = null,                // { draggable, onStart, onEnd, onOver, onLeave, onDrop } — U4/open-tabs drag socket
    onGroupDragOver = null,
    onGroupDragLeave = null,
    onGroupDrop = null,
    betweenZone = null,            // (group) => Node|null — placed after each group (P2g-4: "drop between = new container" zones; the node owns its own drag listeners)
    groupEndZone = null,           // (group) => Node|null — placed after a flat group's rows as an explicit pointer append target
    windowGap = null,              // (group, wi) => Node|null — placed after each WINDOW BLOCK of a multi-window group (P2g-4c: sessions' new-block zones)
    onWindowDragOver = null,       // (group, w, wi, e) — window-block header drop (P2g-4c: append to that window)
    onWindowDragLeave = null,
    onWindowDrop = null,
    // P2g-4d: keyboard move. `keyMoveCommit(srcCtx, slot)` performs the move —
    // slot kinds: {kind:"row", group, wi|null, index, ref, window|null} ·
    // {kind:"groupEnd", group} · {kind:"windowEnd", group, window, wi} ·
    // {kind:"zoneGroup", group} · {kind:"zoneWindow", group, wi}. Call the
    // same op the pointer drop calls. `keyMoveScope:"group"` restricts targets
    // to the source's own group (Sessions: drag never crosses sessions).
    keyMoveCommit = null,
    keyMoveScope = "section"
  } = config;

  installKeyboard();
  const st = stateFor(section);
  /* N42: carry focus across ANY re-render of this section, not only one a row
   * action asked for. A live-tab event (Suspend fires several) schedules a
   * SECOND refresh after the action's own render already consumed
   * `pendingFocus`, and that later render used to drop focus to <body> — the
   * list started from the top again. The previous tree is still attached here,
   * so the focused row is still readable: record its index as the request. An
   * explicit `markRowFocus` always wins, because it knows which row the action
   * targeted. */
  if (st.pendingFocus == null && typeof document !== "undefined") {
    const liveRow = document.activeElement?.closest?.("[data-tablist-row]");
    const liveRoot = liveRow?.closest?.(".tablist");
    if (liveRow && liveRoot?.getAttribute("data-tablist") === section) {
      const idx = [...liveRoot.querySelectorAll("[data-tablist-row]")].indexOf(liveRow);
      if (idx >= 0) st.pendingFocus = idx;
    }
  }
  const root = el("div", { class: "tablist", "data-tablist": section,
    ...(presentation === "compact" ? { "data-compact": "" } : {}) });
  INSTANCES.set(section, { config, root });
  // P2g-4d: a re-render invalidates the lift's slot elements — cancel, said out loud.
  if (kbdLift && kbdLift.section === section) cancelKbdLift(msg("list_move_cancelled_changed"));
  /** @type {object[]|null} keyboard-move slot registry, filled in render order */
  const kbdSlots = keyMoveCommit ? [] : null;

  // F29: stable per-render ids so a disclosure row can name what it reveals.
  // `section` is unique per document (INSTANCES is keyed by it), so the pair
  // section + ordinal cannot collide with another list on the same page.
  let discloseN = 0;
  const nextDiscloseId = () => `tl-${section}-disclosed-${++discloseN}`;

  // key a row by a stable identity (Open tabs keys by tabId, so selection
  // survives live reordering) — everyone else keys by group.id::index.
  const keyFor = (g, i) => (rowKeyFn ? rowKeyFn(g, i) : rowKey(g.id, i));
  const predCtx = (g, i) => ({ group: g, index: i, ref: g.refs[i], live: g.live ? g.live[i] : null });
  const selectableAt = (g, i) => selectable === "tab" && (!rowSelectable || !!rowSelectable(predCtx(g, i)));

  if (toolbar) for (const n of Array.isArray(toolbar) ? toolbar : [toolbar]) if (n) root.append(n);

  if (groups.length === 0) {
    if (empty) root.append(typeof empty === "string" ? el("div", { class: "empty" }, empty) : empty);
    return root;
  }

  // prune selection of tabs that no longer exist (splits, deletions, sync, close)
  const valid = new Set();
  for (const g of groups) {
    if (Array.isArray(g.windows)) g.windows.forEach((w, wi) => w.refs.forEach((_, i) => valid.add(rowKeyW(g.id, wi, i))));
    else g.refs.forEach((_, i) => valid.add(keyFor(g, i)));
  }
  for (const k of [...st.selected]) if (!valid.has(k)) st.selected.delete(k);

  // U6: every selectable row's KEY, in render order — multi-window groups
  // (sessions) yield composite keys; immutable groups (snapshots) yield none.
  const eachSelectable = (fn) => {
    if (selectable !== "tab") return;
    for (const g of groups) {
      if (isImmutableGroup(g, immutable)) continue;
      if (Array.isArray(g.windows)) g.windows.forEach((w, wi) => w.refs.forEach((_, i) => fn(rowKeyW(g.id, wi, i))));
      else g.refs.forEach((_, i) => { if (selectableAt(g, i)) fn(keyFor(g, i)); });
    }
  };
  let totalSelectable = 0;
  eachSelectable(() => totalSelectable++);
  // N14: shift+click selects the visual range from the anchor (the last row
  // selected on its own) to the clicked row — standard list-selection idiom.
  // Keys are collected in render order, so the range IS the visual range.
  const orderedKeys = [];
  eachSelectable((key) => orderedKeys.push(key));
  if (st.anchor && !orderedKeys.includes(st.anchor)) st.anchor = null;
  if (st.rangeEnd && !orderedKeys.includes(st.rangeEnd)) st.rangeEnd = null;
  const noteKeeperTrigger = () => {
    st.keeperMotionAllowed = !document.activeElement?.matches?.(":focus-visible");
  };
  const rangeTo = (key) => {
    const a = orderedKeys.indexOf(st.anchor ?? "");
    const b = orderedKeys.indexOf(key);
    if (a < 0 || b < 0) return false;
    const span = orderedKeys.slice(Math.min(a, b), Math.max(a, b) + 1);
    // Re-hitting the same endpoint whose range is still fully selected toggles
    // that range OFF (user feedback: "reclicking the last one unselects all").
    if (st.rangeEnd === key && span.every((k) => st.selected.has(k))) {
      for (const k of span) st.selected.delete(k);
      st.rangeEnd = null;
    } else {
      for (const k of span) st.selected.add(k);
      st.rangeEnd = key;
    }
    noteKeeperTrigger();
    onChange();
    return true;
  };
  const selection = () => {
    const out = [];
    for (const g of groups) {
      if (Array.isArray(g.windows)) {
        // U6: multi-window groups (sessions) report per-window picks
        const picks = g.windows
          .map((w, wi) => ({ windowIndex: wi,
            indexes: w.refs.map((_, i) => i).filter((i) => st.selected.has(rowKeyW(g.id, wi, i))) }))
          .filter((p) => p.indexes.length);
        if (picks.length) out.push({ group: g, picks });
      } else {
        const indexes = g.refs.map((_, i) => i).filter((i) => st.selected.has(keyFor(g, i)));
        if (indexes.length) out.push({ group: g, indexes });
      }
    }
    return out;
  };
  /** Tabs in a selection entry, flat or per-window. */
  const entryCount = (s) =>
    (s.indexes?.length ?? 0) + (s.picks?.reduce((n, p) => n + p.indexes.length, 0) ?? 0);
  const clear = () => { st.selected.clear(); onChange(); };

  /* ---- bulk bar (ListShell) ---- */
  let bulkSelection = [];
  let bulkCount = 0;
  let headerBulkGroupId = null;
  if (selectable === "tab" && bulkActions) {
    bulkSelection = selection();
    bulkCount = bulkSelection.reduce((n, s) => n + entryCount(s), 0);
    headerBulkGroupId = bulkCount > 0 && bulkSelection.length === 1
      ? bulkSelection[0].group.id
      : null;
    const keeperEntering = bulkCount > 0 && !st.keeperVisible && st.keeperMotionAllowed;
    st.keeperVisible = bulkCount > 0;
    st.keeperMotionAllowed = false;
    const master = el("input", { type: "checkbox", class: "tip",
      "aria-label": msg("list_select_all_none"), title: msg("list_select_all_none") });
    master.checked = bulkCount > 0 && bulkCount === totalSelectable;
    master.indeterminate = bulkCount > 0 && bulkCount < totalSelectable;
    master.addEventListener("change", () => {
      noteKeeperTrigger();
      if (master.checked) eachSelectable((key) => st.selected.add(key));
      else st.selected.clear();
      onChange();
    });
    // F29: the keeper's panel slot is identified by its OWN marker, never by
    // "the div after a .bulk-bar". A static section toolbar may also carry
    // .bulk-bar (Duplicates, Smart views, Data), and sibling-shape matching
    // used to fix the first following block to the viewport.
    const panelSlot = el("div", { class: "keeper-panel-slot" });
    const bar = el("div", {
      class: `bulk-bar${bulkCount > 0 ? " has-selection" : " is-empty"}${keeperEntering ? " keeper-enter" : ""}`,
      role: "toolbar",
      "aria-label": bulkCount > 0
        ? msg("list_selection_actions", [selectionSummary(bulkCount, bulkSelection.length)])
        : bulkHint
    }, master,
      el("span", { class: "keeper-count" }, bulkCount === 0 ? bulkHint : selectionSummary(bulkCount, bulkSelection.length)));
    if ((bulkCount > 0 && !headerBulkGroupId) || bulkAlways) {
      const ctx = { selection: bulkSelection, count: bulkCount, clear, rerender: onChange, panel: slotPanel(panelSlot) };
      for (const n of bulkActions(ctx)) if (n) bar.append(n);
    }
    if (!headerBulkGroupId) root.append(bar, panelSlot);
  }

  /* ---- groups ---- */
  const shownGroups = st.sectionExpanded ? groups : groups.slice(0, groupCap);
  for (const g of shownGroups) {
    root.append(renderGroup(g));
    if (betweenZone) {
      const z = betweenZone(g);
      if (z) {
        root.append(z);
        if (kbdSlots && !isImmutableGroup(g, immutable)) kbdSlots.push({ kind: "zoneGroup", group: g, el: z });
      }
    }
  }
  if (groups.length > groupCap) {
    // F29: the section-level control is the same full-row disclosure. It reveals
    // sibling cards rather than one container, so it names no single region.
    root.append(el("button", {
      class: "disclosure-row disclosure-section",
      type: "button",
      "aria-expanded": st.sectionExpanded ? "true" : "false",
      onclick: () => { st.sectionExpanded = !st.sectionExpanded; onChange(); }
    }, el("span", { class: "disclosure-label" },
      st.sectionExpanded
        ? msg("list_show_latest_only", [String(groupCap)])
        : msg("list_show_all_items", [String(groups.length)]))));
  }

  /* ---- focus restore after an action re-rendered the list ----
   * P2g-4a, the [AP] "focus never dies with its row" rule: the restore is
   * DEFERRED (microtask) because this tree is still detached here — the
   * section attaches it via replaceChildren right after createTabList
   * returns, and focus() on a detached node is a silent no-op (the N1 bug
   * class). Target: the same row index (= the next row once one was removed;
   * the previous row if it was last); a section emptied of rows falls back
   * to its first control (toolbar/bulk bar), so focus lands somewhere real. */
  if (st.pendingCardFocus != null) {
    const idx = st.pendingCardFocus;
    let tries = 0;
    const restoreCard = () => {
      if (!root.isConnected) {
        if (++tries > 6) return;
        raf(restoreCard);
        return;
      }
      if (st.pendingCardFocus === idx) st.pendingCardFocus = null;
      const ae = document.activeElement;
      if (ae && ae !== document.body) return;
      const cards = [...root.querySelectorAll("[data-tablist-card]")];
      const target = cards[Math.min(idx, cards.length - 1)];
      target?.querySelector(".item-head-toggle, .item-head button, .item-head input")
        ?.focus({ preventScroll: true });
    };
    raf(restoreCard);
  } else if (st.pendingFocus != null) {
    const idx = st.pendingFocus;
    /* N41: the microtask was firing BEFORE this tree was in the document, so
     * the restore bailed on every real action and focus stayed dead at <body>
     * — which is why the list started from the top again after a suspend.
     * Every section renderer `await`s its data, so `createTabList` returns
     * inside an async function and the caller's `replaceChildren` runs in a
     * LATER microtask than this one. Retry across a few frames instead, and
     * keep `pendingFocus` until a connected tree consumes it, so a superseded
     * render cannot swallow the request. */
    let tries = 0;
    const restore = () => {
      if (!root.isConnected) {
        if (++tries > 6) return; // never attached — this render was replaced
        raf(restore);
        return;
      }
      if (st.pendingFocus === idx) st.pendingFocus = null;
      // Only restore if focus actually DIED (fell to <body>) — never yank it
      // from a control the user is using (search box, a panel input, …).
      const ae = document.activeElement;
      if (ae && ae !== document.body) return;
      const rows = [...root.querySelectorAll("[data-tablist-row]")];
      const target = rows[Math.min(idx, rows.length - 1)];
      if (target) focusRow(target, { preventScroll: true });
      else root.querySelector("button, input, a")?.focus({ preventScroll: true });
    };
    queueMicrotask(restore);
  }

  return root;

  /* ---------------------- P2g-4d: keyboard move flow ---------------------- */

  function kbdHandle(ctx, ref) {
    const btn = el("button", { class: "mini iconbtn move-handle", title: msg("action_move"),
      "aria-label": msg("list_move_named", [ref.title || ref.url]) }, "⠿");
    btn.addEventListener("keydown", (e) => onHandleKey(e, ctx, btn));
    // mouse path too: first click lifts, second drops at the highlighted slot
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      kbdLift?.handle === btn ? commitLift() : startLift(ctx, btn);
    });
    btn.addEventListener("blur", () => {
      if (kbdLift?.handle === btn) cancelKbdLift(msg("list_cancelled"));
    });
    return btn;
  }

  function onHandleKey(e, ctx, btn) {
    const mine = kbdLift && kbdLift.handle === btn;
    if (!mine) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        startLift(ctx, btn);
      }
      return; // ↑/↓ keep their roving-focus meaning until lifted
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      kbdLift.slots[kbdLift.sel]?.el?.classList.remove("kbd-slot");
      kbdLift.sel = Math.min(Math.max(kbdLift.sel + (e.key === "ArrowDown" ? 1 : -1), 0),
        kbdLift.slots.length - 1);
      highlightLift();
      announce(describeSlot(kbdLift.slots[kbdLift.sel]));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      commitLift();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelKbdLift(msg("list_cancelled"));
    }
  }

  function startLift(ctx, btn) {
    cancelKbdLift();
    const scoped = keyMoveScope === "group" ? kbdSlots.filter((s) => s.group === ctx.group) : kbdSlots;
    const slots = scoped.filter((s) => !(s.kind === "row" && s.group === ctx.group &&
      (s.wi ?? null) === (ctx.windowIndex ?? null) && s.index === ctx.index));
    if (slots.length === 0) {
      announce(msg("list_nowhere_to_move"));
      return;
    }
    // start at the first slot below the lifted row (or the last slot if none)
    let sel = slots.findIndex((s) => s.el && ctx.rowEl &&
      (ctx.rowEl.compareDocumentPosition(s.el) & Node.DOCUMENT_POSITION_FOLLOWING));
    if (sel < 0) sel = slots.length - 1;
    kbdLift = { section, handle: btn, srcCtx: ctx, slots, sel };
    highlightLift();
    announce(msg("list_lifted_instructions", [
      ctx.ref.title || ctx.ref.url,
      describeSlot(slots[sel])
    ]));
  }

  async function commitLift() {
    if (!kbdLift) return;
    const { slots, sel, srcCtx } = kbdLift;
    const rows = [...root.querySelectorAll("[data-tablist-row]")];
    const i = srcCtx.rowEl ? rows.indexOf(srcCtx.rowEl) : -1;
    if (i >= 0) st.pendingFocus = i; // the focus rule places focus after the re-render
    const slot = slots[sel];
    cancelKbdLift();
    announce(msg("list_dropped"));
    await keyMoveCommit(srcCtx, slot);
  }

  function highlightLift() {
    const target = kbdLift.slots[kbdLift.sel]?.el;
    if (!target) return;
    target.classList.add("kbd-slot"); // also forces hidden zones visible (CSS)
    target.scrollIntoView?.({ block: "nearest" });
  }

  function describeSlot(s) {
    if (s.kind === "row") {
      const where = s.window ? s.window.meta : s.group.title;
      return msg("list_move_before", [s.ref.title || s.ref.url, where]);
    }
    if (s.kind === "groupEnd") return msg("list_move_end_group", [s.group.title]);
    if (s.kind === "windowEnd") return msg("list_move_end_window", [s.window.meta, s.group.title]);
    return msg("list_move_new_container", [s.el?.textContent || msg("list_new_container")]);
  }

  /* --------------------------------------------------------------------- */
  function renderGroup(g) {
    const isImm = isImmutableGroup(g, immutable);
    // action sets may be a static array or a per-group function (e.g. Inbox:
    // window bundles and loose tabs get different header actions).
    const rowActs = rowActionsFor(resolveActions(rowActions, g), isImm);
    const grpActs = visibleGroupActions(resolveActions(groupActions, g), isImm);
    const winActs = visibleGroupActions(resolveActions(windowActions, g), isImm);
    const sel = selectableFor(selectable, isImm);
    const multiWin = Array.isArray(g.windows);
    /* F47: a folded card builds no rows at all. Deciding this before the loops,
     * rather than dropping a built subtree, is what makes folding a real way to
     * quieten a big window instead of a way to hide one. */
    const folded = foldable && !g.loose && st.folded.has(g.id);
    let endZone = null;

    // body: per-window sub-blocks (sessions/snapshots) OR a flat capped row list
    const body = el("div", { class: "tl-rows" });
    if (folded) {
      /* nothing: the header IS the card while it is folded */
    } else if (multiWin) {
      g.windows.forEach((w, wi) => {
        body.append(renderWindowBlock(g, w, wi, rowActs, winActs, sel));
        if (windowGap && !isImm) {
          const z = windowGap(g, wi);
          if (z) {
            body.append(z);
            if (kbdSlots) kbdSlots.push({ kind: "zoneWindow", group: g, wi, el: z });
          }
        }
      });
    } else {
      const expanded = st.expanded.has(g.id);
      const shown = expanded ? g.refs.length : Math.min(rowCap, g.refs.length);
      for (let i = 0; i < shown; i++) {
        const slot = el("div", {});
        const ctx = rowCtx(g, null, null, i, g.refs[i], slot, sel);
        const on = sel === "tab" && selectableAt(g, i);
        body.append(buildTabRow(ctx, keyFor(g, i), rowActs, on, sel === "tab" && !on), slot);
      }
      if (!folded && !isImm && groupEndZone) {
        endZone = groupEndZone(g);
        if (endZone) body.append(endZone);
      }
      if (g.refs.length > rowCap) body.append(moreBtn(g.id, g.refs.length - rowCap, expanded, body));
    }

    if (g.loose) return body; // bare rows, no card wrapper

    const head = el("div", { class: "item-head" });
    /* F47r (MH's pick, option D): the card's own name area IS the fold control,
     * so no glyph is added to a header that already carries a checkbox and an
     * action lane. Folding COMPRESSES rather than hides: a folded card shows
     * its tabs' favicons, so it still answers "what is in here". Past the strip
     * cap the count says it in words instead, which is option B's wording.
     * The fold itself is INSTANT — D4-4 removed every disclosure animation
     * because animating `grid-template-rows` animates layout on routine
     * rendering. */
    const toggleFold = () => {
      /* F47r3: folding removes everything below this header, so the document
       * gets shorter and the browser keeps its scroll offset — which slides the
       * page under you and can leave you far below where you were looking. Hold
       * the header itself still instead: remember where it sits in the viewport,
       * then correct the scroll by however far it moved once the new tree is
       * attached. Everything above the header therefore stays put, which is the
       * only frame of reference the user has. */
      const before = head.getBoundingClientRect().top;
      folded ? st.folded.delete(g.id) : st.folded.add(g.id);
      Promise.resolve(onChange()).then(() => raf(() => holdCardInPlace(g.id, before)));
    };
    // group select-all reflects only the SELECTABLE rows (Open tabs: http tabs).
    // U6: on a multi-window group (session card) it spans every window's rows.
    let selCnt = 0, selTotal = 0;
    const groupKeys = [];
    if (sel === "tab") {
      if (multiWin) g.windows.forEach((w, wi) => w.refs.forEach((_, i) => groupKeys.push(rowKeyW(g.id, wi, i))));
      else g.refs.forEach((_, i) => { if (selectableAt(g, i)) groupKeys.push(keyFor(g, i)); });
      selTotal = groupKeys.length;
      for (const k of groupKeys) if (st.selected.has(k)) selCnt++;
    }
    let toggleGroup = null;
    if (sel === "tab" && selTotal > 0) {
      const headCb = el("input", { type: "checkbox", "aria-label": msg("list_select_all_named", [g.title]) });
      headCb.checked = selCnt > 0 && selCnt === selTotal;
      headCb.indeterminate = selCnt > 0 && selCnt < selTotal;
      toggleGroup = () => {
        noteKeeperTrigger();
        const all = selCnt === selTotal;
        for (const k of groupKeys) all ? st.selected.delete(k) : st.selected.add(k);
        onChange();
      };
      headCb.addEventListener("change", toggleGroup);
      head.append(headCb);
    }
    if (g.glyph) head.append(el("span", { class: "tmark" }, icon(g.glyph, 15)));
    const titleNode = el("span", { class: "item-title" }, g.title);
    // F47r: the accented mark sits immediately right of the name, because it
    // qualifies the name. Deliberately NOT a chip: chips here are labels and
    // navigate to the Labels page.
    const badgeNode = g.badge ? el("span", { class: "item-badge" }, g.badge) : null;
    // F47r4: the state belongs next to the name, where the eye already is. The
    // favicon stack on the right says what is inside; this says what happened.
    const foldedMark = folded ? el("span", { class: "item-folded-mark" }, msg("list_folded")) : null;
    const metaNode = folded ? foldedSummary(g) : (g.meta ? el("span", { class: "item-meta" }, g.meta) : null);
    if (foldable) {
      head.append(el("button", {
        class: "item-head-toggle", type: "button",
        "aria-expanded": folded ? "false" : "true",
        "aria-label": folded
          ? msg("list_expand_card_named", [[g.title, g.badge, g.meta].filter(Boolean).join(", ")])
          : msg("list_collapse_card_named", [[g.title, g.badge, g.meta].filter(Boolean).join(", ")]),
        title: folded ? msg("list_expand") : msg("list_collapse"),
        onclick: toggleFold
      }, titleNode, badgeNode, foldedMark, metaNode));
    } else {
      head.append(titleNode, badgeNode);
    }
    // P2g-2: an immutable group's chips carry no remove affordance (N8, structural)
    if (g.chips && g.chips.length) head.append(chipsNode(g, isImm ? null : onChipRemove));
    if (!foldable && metaNode) head.append(metaNode);

    const grpSlot = el("div", {});
    // Whole-card removals can request header-level focus restoration. The same
    // visual card index becomes the next card after removal, or the previous
    // card when the removed one was last.
    const markCardFocus = () => {
      const cards = [...root.querySelectorAll("[data-tablist-card]")];
      const card = head.closest("[data-tablist-card]");
      const idx = card ? cards.indexOf(card) : -1;
      if (idx >= 0) st.pendingCardFocus = idx;
    };
    const gctx = {
      group: g, rerender: onChange, clear, panel: slotPanel(grpSlot),
      beforeRemoveCard: markCardFocus
    };
    // P2g-4a focus rule: a card action (e.g. Delete) records the card's first
    // row — after the card disappears, that index IS the next card's first row.
    const grpFocus = () => {
      const rows = [...root.querySelectorAll("[data-tablist-row]")];
      const first = head.closest("[data-tablist-card]")?.querySelector("[data-tablist-row]");
      const idx = first ? rows.indexOf(first) : -1;
      if (idx >= 0) st.pendingFocus = idx;
    };
    const grpActionLane = el("span", { class: "gacts" });
    if (headerBulkGroupId === g.id) {
      grpActionLane.classList.add("header-bulk-actions");
      grpActionLane.setAttribute("role", "toolbar");
      grpActionLane.setAttribute("aria-label", msg("list_selected_tabs_actions", [String(bulkCount)]));
      grpActionLane.append(el("span", { class: "header-bulk-count" },
        msg("list_selected_count", [String(bulkCount)])));
      const bulkCtx = {
        selection: bulkSelection, count: bulkCount, clear, rerender: onChange,
        panel: slotPanel(grpSlot)
      };
      for (const node of bulkActions(bulkCtx)) if (node) grpActionLane.append(node);
    } else {
      for (const a of grpActs) grpActionLane.append(groupActionNode(a, gctx, grpFocus));
    }
    if (grpActionLane.childNodes.length) head.append(grpActionLane);

    // group-level drag drop socket (e.g. drop a tab onto a window header)
    if (onGroupDrop) {
      head.addEventListener("dragover", (e) => onGroupDragOver?.(g, e));
      head.addEventListener("dragleave", (e) => onGroupDragLeave?.(g, e));
      head.addEventListener("drop", (e) => onGroupDrop(g, e));
    }

    // P2g-4d: "end of this group" keyboard slot (append) — flat groups only;
    // multi-window groups get per-window end slots instead.
    if (kbdSlots && !multiWin && !isImm && !g.loose) {
      kbdSlots.push({ kind: "groupEnd", group: g, el: endZone ?? head });
    }

    const banner = groupBanner ? groupBanner(g) : null;
    // F13: with groupPanelTop the toggled panel sits right under the header (next
    // to the action that opened it); otherwise it stays at the card bottom.
    // F34-15: the scrolling card must not own a border that can travel above
    // its sticky header. Give every below-header surface one structural frame;
    // the cap and body can now own their boundaries independently. This also
    // keeps banners and toggled panels inside the same lower frame instead of
    // special-casing flat, session, and snapshot cards in CSS.
    const bodyFrame = groupPanelTop
      ? el("div", { class: "item-body-frame" }, banner, grpSlot, body)
      : el("div", { class: "item-body-frame" }, banner, body, grpSlot);
    // F34-17: keep the rounded cap as an ordinary foreground element. Its
    // sticky shell supplies only two small page-material patches BEHIND the
    // cap's transparent corner cutouts, so passing rows cannot show through
    // without any mask or curtain painting over the real curved border.
    const headShell = el("div", { class: "item-head-shell" }, head);
    const card = el("div", { class: `item${folded ? " is-folded" : ""}`, "data-tablist-card": g.id },
      headShell, folded ? null : bodyFrame);
    card._tlCard = { ctx: gctx, byKey: keyMap(grpActs), del: grpActs.find((a) => a.danger) ?? null, toggleGroup };
    return card;
  }

  function renderWindowBlock(g, w, wi, rowActs, winActs, sel) {
    const key = `${g.id}::w${wi}`;
    const expanded = st.expanded.has(key);
    const shown = expanded ? w.refs.length : Math.min(rowCap, w.refs.length);
    const wHead = el("div", { class: "item-head" });
    // U6: per-window select-all (sessions) — mirrors the flat group-header one
    if (sel === "tab") {
      let selCnt = 0;
      w.refs.forEach((_, i) => { if (st.selected.has(rowKeyW(g.id, wi, i))) selCnt++; });
      const wCb = el("input", { type: "checkbox", "aria-label": msg("list_select_all_named", [w.meta]) });
      wCb.checked = selCnt > 0 && selCnt === w.refs.length;
      wCb.indeterminate = selCnt > 0 && selCnt < w.refs.length;
      wCb.addEventListener("change", () => {
        noteKeeperTrigger();
        const all = selCnt === w.refs.length;
        w.refs.forEach((_, i) => {
          all ? st.selected.delete(rowKeyW(g.id, wi, i)) : st.selected.add(rowKeyW(g.id, wi, i));
        });
        onChange();
      });
      wHead.append(wCb);
    }
    wHead.append(el("span", { class: "item-meta" }, w.meta));
    // F18: read-only group chips (color dot + name + count). Chrome's fixed group
    // palette is applied via `.gdot-<color>` classes (no inline colors).
    for (const c of w.groupChips ?? []) {
      wHead.append(el("span", { class: "group-chip",
        title: c.title ? msg("list_tab_group_named", [c.title]) : msg("list_group_fallback") },
        el("span", { class: `gdot gdot-${c.color}` }),
        el("span", {}, msg("list_group_chip_count", [c.title || msg("list_group_fallback"), String(c.count)]))));
    }
    const winActionLane = el("span", { class: "gacts" });
    for (const a of winActs) {
      winActionLane.append(groupActionNode(a, { group: g, window: w, windowIndex: wi, rerender: onChange }));
    }
    if (winActionLane.childNodes.length) wHead.append(winActionLane);
    // P2g-4c: window-block header as a drop surface (sessions: append there)
    if (onWindowDrop) {
      wHead.addEventListener("dragover", (e) => onWindowDragOver?.(g, w, wi, e));
      wHead.addEventListener("dragleave", (e) => onWindowDragLeave?.(g, w, wi, e));
      wHead.addEventListener("drop", (e) => onWindowDrop(g, w, wi, e));
    }
    const block = el("div", { class: "window-block" }, wHead);
    for (let i = 0; i < shown; i++) {
      const slot = el("div", {});
      const ctx = rowCtx(g, w, wi, i, w.refs[i], slot, sel);
      block.append(buildTabRow(ctx, rowKeyW(g.id, wi, i), rowActs, sel === "tab", false), slot);
    }
    if (w.refs.length > rowCap) block.append(moreBtn(key, w.refs.length - rowCap, expanded, block));
    if (kbdSlots && !isImmutableGroup(g, immutable)) {
      kbdSlots.push({ kind: "windowEnd", group: g, window: w, wi, el: wHead });
    }
    return block;
  }

  /**
   * F29: overflow disclosure is a full list row, not a chip. The whole row is
   * the activation target and carries the hover/focus state; `controls` is the
   * container whose rows it reveals, so the state is announced, not just seen.
   * @param {string} key expansion key in `st.expanded`
   * @param {number} hidden rows currently withheld
   * @param {boolean} expanded current state of `key`
   * @param {HTMLElement} [controls] container holding the disclosed rows
   */
  function moreBtn(key, hidden, expanded, controls) {
    const btn = el("button", {
      class: "disclosure-row",
      type: "button",
      "aria-expanded": expanded ? "true" : "false",
      onclick: () => {
        expanded ? st.expanded.delete(key) : st.expanded.add(key);
        onChange();
      }
    }, el("span", { class: "disclosure-label" },
      expanded ? msg("list_show_fewer") : msg("list_more_hidden", [String(hidden)])));
    if (controls) {
      if (!controls.id) controls.id = nextDiscloseId();
      btn.setAttribute("aria-controls", controls.id);
    }
    return btn;
  }

  /** Assemble the ctx an action closure receives for a row. */
  function rowCtx(g, w, wi, index, ref, slot, sel) {
    const ctx = { group: g, window: w, windowIndex: wi, index, ref, live: g.live ? g.live[index] : null,
      panel: slotPanel(slot), rerender: onChange };
    // U6: window rows (sessions) select under their composite key
    const on = sel === "tab" && (w ? true : selectableAt(g, index));
    if (on) {
      const key = w ? rowKeyW(g.id, wi, index) : keyFor(g, index);
      ctx.toggleSelect = () => {
        noteKeeperTrigger();
        if (st.selected.has(key)) st.selected.delete(key);
        else { st.selected.add(key); st.anchor = key; } // N14: a lone select re-anchors
        st.rangeEnd = null; // a fresh anchor starts a new range
        onChange();
      };
      ctx.rangeTo = () => rangeTo(key); // N14: shift+click path (false = no anchor)
    }
    return ctx;
  }

  function buildTabRow(ctx, key, rowActs, withCheckbox, disabledCheckbox) {
    const ref = ctx.ref;
    let host = "";
    try { host = new URL(ref.url).hostname.replace(/^www\./, ""); } catch { /* non-URL */ }
    const isSel = withCheckbox && st.selected.has(key);
    let cb = null;
    if (withCheckbox) {
      cb = el("input", { type: "checkbox", "aria-label": msg("list_select_named", [ref.title || ref.url]) });
      cb.checked = isSel;
      // N14: shift+click ranges from the anchor; preventDefault stops the
      // native toggle so the change handler below never double-fires.
      cb.addEventListener("click", (e) => {
        if (e.shiftKey && ctx.rangeTo && ctx.rangeTo()) e.preventDefault();
      });
      cb.addEventListener("change", ctx.toggleSelect);
    } else if (disabledCheckbox) {
      cb = el("input", { type: "checkbox", disabled: true, "aria-label": msg("list_select_named", [ref.title || ref.url]) });
    }
    const badges = rowBadges ? rowBadges(ctx) : null;
    // P2g-4d: the ⠿ move handle — same eligibility as pointer drag
    const canMove = kbdSlots && !isImmutableGroup(ctx.group, immutable) &&
      (rowDrag?.draggable ? rowDrag.draggable(ctx) : true);
    const visibleActs = rowActs.filter((a) => !a.when || a.when(ctx));
    // P2g-2r: `hidden` actions keep their keyboard binding (byKey below) but
    // render no button — for verbs the title click already performs.
    const shownActs = visibleActs.filter((a) => !a.hidden);
    const rowMetaNode = rowMeta
      ? el("span", { class: "item-meta" }, rowMeta(ref, ctx.group, ctx.index))
      : null;
    const row = el("div", { class: `trow${isSel ? " sel" : ""}${withCheckbox ? " selrow" : ""}`, "data-tablist-row": key },
      el("span", { class: "row-select-slot" }, cb),
      ref.favIconUrl
        ? el("img", {
            class: "fv", src: ref.favIconUrl, alt: "",
            onerror: (e) => e.currentTarget.replaceWith(
              el("span", { class: "fv-placeholder", "aria-hidden": "true" }))
          })
        : el("span", { class: "fv-placeholder", "aria-hidden": "true" }),
      el("span", { class: "row-copy" },
        el("span", { class: "t" },
          ...(badges || []),
          el("a", { href: ref.url, target: "_blank", rel: "noreferrer",
            onclick: rowOpen ? (e) => { e.preventDefault(); rowOpen(ctx); } : null }, ref.title || ref.url)),
        el("span", { class: "row-subline" },
          ref.pinned ? el("span", { class: "pinned-state", title: msg("list_pinned_tab"),
            "data-tip": msg("list_pinned_tab") }, msg("list_pinned")) : null,
          el("span", { class: "host" }, host),
          rowMetaNode,
          rowRecencyNode(ctx))),
      // chips sit OUTSIDE .t — its ellipsis overflow would clip them after any
      // long title (the 0.8.22 "chips only show on short titles" bug)
      el("span", { class: "row-chip-slot" }, rowChipsNode(ctx, key)),
      el("span", { class: "tacts" },
        canMove ? kbdHandle(ctx, ref) : null,
        ...shownActs.map((a) => rowActionNode(a, ctx, markRowFocus)))
    );
    if (kbdSlots && !isImmutableGroup(ctx.group, immutable)) {
      kbdSlots.push({ kind: "row", group: ctx.group, wi: ctx.windowIndex ?? null,
        index: ctx.index, ref, window: ctx.window ?? null, el: row });
    }
    // P2g-4a focus rule: a mouse click on a row action records the row's index
    // so the post-action re-render can put focus back (same as the keyboard
    // path). Evaluated at CLICK time — indices shift as rows come and go.
    function markRowFocus() {
      const rows = [...root.querySelectorAll("[data-tablist-row]")];
      const idx = rows.indexOf(row);
      if (idx >= 0) st.pendingFocus = idx;
    }
    ctx.rowEl = row;
    row._tlRow = { ctx, byKey: keyMap(visibleActs), del: visibleActs.find((a) => a.danger) ?? null };
    // P2g-2r: the row's empty space toggles selection (the checkbox stays, but
    // stops being the only target); interactive children keep their own clicks.
    if (withCheckbox && ctx.toggleSelect) {
      row.addEventListener("click", (e) => {
        if (e.target.closest("a, button, input, .chip, .tacts")) return;
        if (e.shiftKey && ctx.rangeTo && ctx.rangeTo()) return; // N14
        ctx.toggleSelect();
      });
      // shift+click must not smear a text selection across the rows
      row.addEventListener("mousedown", (e) => {
        if (e.shiftKey && !e.target.closest("a, input, button")) e.preventDefault();
      });
    }
    // N27/N37: ←/→ rove through the row's visual focus lanes (checkbox,
    // primary URL, labels, then actions). The primary URL is deliberately in
    // this sequence: Enter on it performs the same switch/restore/open action
    // as a mouse click, so the keyboard path does not require the hidden `r`
    // binding. ↑/↓ leave to the previous/next row through the shared handler;
    // once a move-lift is in progress the ⠿ handle owns the arrows.
    row.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Escape") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (kbdLift) return; // a move-lift owns the arrows until it commits/cancels
      const targets = rowFocusTargets(row);
      if (targets.length === 0) return;
      const i = targets.indexOf(e.target);
      if (e.key === "Escape") {
        if (i >= 0) { e.preventDefault(); e.stopPropagation(); focusRow(row); }
        return;
      }
      if (e.key === "ArrowRight") {
        const next = i < 0 ? targets[0] : targets[i + 1];
        if (next) { e.preventDefault(); next.focus(); }
        return;
      }
      // ArrowLeft
      const previous = i > 0 ? targets[i - 1] : i === 0 ? null : null;
      if (previous) { e.preventDefault(); previous.focus(); }
      else if (i === 0) { e.preventDefault(); focusRow(row); }
    });
    // per-row drag socket (Open tabs; later U4)
    if (rowDrag) {
      if (rowDrag.draggable && rowDrag.draggable(ctx)) {
        row.draggable = true;
        row.addEventListener("dragstart", (e) => rowDrag.onStart?.({
          ...ctx,
          // Snapshot only when the dragged row belongs to the selection. An
          // unselected row remains an ordinary one-row drag even if another
          // selection is still visible elsewhere in the list.
          dragSelection: st.selected.has(key) ? selection() : []
        }, e));
        row.addEventListener("dragend", (e) => rowDrag.onEnd?.(ctx, e));
      }
      row.addEventListener("dragover", (e) => rowDrag.onOver?.(ctx, e));
      row.addEventListener("dragleave", (e) => rowDrag.onLeave?.(ctx, e));
      row.addEventListener("drop", (e) => rowDrag.onDrop?.(ctx, e));
    }
    return row;
  }

  function rowRecencyNode(ctx) {
    const data = ctx.group?.data ?? {};
    const ts = ctx.live?.lastAccessed ?? ctx.ref?.modifiedAt ??
      data.modifiedAt ?? data.archivedAt ?? data.createdAt ?? data.dueAt;
    return Number.isFinite(ts)
      ? el("span", { class: "row-recency item-meta", title: new Date(ts).toLocaleString() }, compactRelativeAge(ts))
      : null;
  }

  /**
   * N37: the horizontal row walk follows the same visual order as the ledger.
   * Keep this as a DOM query rather than a second action registry so optional
   * labels, hidden actions, and immutable rows naturally disappear from the
   * path. Nested label remove buttons remain reachable after their label link.
   */
  function rowFocusTargets(row) {
    return [...row.querySelectorAll(
      ".row-select-slot input:not([disabled]), .row-copy a[href], " +
      ".row-chip-slot button:not([disabled]), .row-chip-slot a[href], " +
      ".tacts button:not([disabled])"
    )].filter((node) => node.offsetParent !== null);
  }

  /**
   * P2g-2 (N11): per-tab label chips on the row — ALWAYS visible, capped at 2
   * with a real "+N" button that expands them inline ("–" collapses back).
   * Shows the ref's OWN labels (true tab grain); item-level labels stay on the
   * card chip, so nothing renders twice. The × (when the section wires
   * onRowChipRemove and the group is mutable) names both the label and the tab.
   * NOTE: the cap constant lives at module scope — this function runs during
   * the build (before this point in the closure body), so a local `const`
   * here would be a temporal-dead-zone ReferenceError for any labeled row.
   */
  function rowChipsNode(ctx, key) {
    const labels = ctx.ref?.labels ?? [];
    if (labels.length === 0) return null;
    const isImm = isImmutableGroup(ctx.group, immutable);
    const open = st.chipsOpen.has(key);
    const shown = open ? labels : labels.slice(0, ROW_CHIP_CAP);
    const tabName = ctx.ref.title || ctx.ref.url;
    const span = el("span", { class: "chips rowchips" });
    for (const l of shown) {
      const chip = el("span", { class: "chip" }, chipText(l));
      if (onRowChipRemove && !isImm) {
        chip.append(el("button", { class: "x", type: "button",
          "aria-label": msg("list_remove_label_from_tab", [l, tabName]),
          onclick: (e) => { e.stopPropagation(); onRowChipRemove(ctx, l); } }, "×"));
      }
      span.append(chip);
    }
    if (labels.length > ROW_CHIP_CAP) {
      span.append(el("button", { class: "chip more", type: "button",
        "aria-label": open
          ? msg("list_show_fewer_labels_of", [tabName])
          : msg("list_show_all_labels_of", [String(labels.length), tabName]),
        "aria-expanded": open ? "true" : "false",
        onclick: (e) => {
          e.stopPropagation();
          // N31: truly inline — the old onChange() here re-rendered the WHOLE
          // section, which rebuilt every card and jumped the scroll away from
          // the row being read (worst on the uncapped Labels page). Swap only
          // this chips span and land focus on the replacement toggle
          // (focus-never-dies rule); st.chipsOpen already survives re-renders.
          open ? st.chipsOpen.delete(key) : st.chipsOpen.add(key);
          const next = rowChipsNode(ctx, key);
          span.replaceWith(next);
          next?.querySelector(".chip.more")?.focus();
        } }, open ? "–" : `+${labels.length - ROW_CHIP_CAP}`));
    }
    return span;
  }

  /** P2g-2r2: a chip's text navigates (onChipOpen — jump to the label's card in
   *  the Labels section); the × keeps its own click. Sections whose chips are
   *  NOT labels (Snoozed recurrence) simply don't wire onChipOpen. */
  function chipText(l) {
    if (!onChipOpen) return l;
    return el("button", { class: "chiplink", type: "button",
      "aria-label": msg("list_show_label", [l]),
      onclick: (e) => { e.stopPropagation(); onChipOpen(l); } }, l);
  }

  function chipsNode(g, remove) {
    const span = el("span", { class: "chips" });
    for (const l of g.chips) {
      const chip = el("span", { class: "chip" }, chipText(l));
      if (remove) {
        chip.append(el("button", { class: "x", type: "button", "aria-label": msg("list_remove_label", [l]),
          onclick: (e) => { e.stopPropagation(); remove(g, l); } }, "×"));
      }
      span.append(chip);
    }
    return span;
  }
}

/**
 * F47r3: keep one card's header at the viewport position it already had, after a
 * render that changed how much content sits below it. Module level because it
 * needs nothing from an instance, and it is a no-op wherever there is no window
 * to scroll (tests, workers).
 * @param {string} cardId @param {number} before viewport top before the render
 */
function holdCardInPlace(cardId, before) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  // Call it as a METHOD: `CSS.escape` checks its receiver, so a detached
  // reference throws where a plain call does not.
  const key = typeof globalThis.CSS?.escape === "function" ? CSS.escape(cardId) : cardId;
  const card = document.querySelector(`[data-tablist-card="${key}"]`);
  if (!card) return;
  if (before < 0) {
    // The header was ABOVE the viewport: you were reading this window's rows,
    // and those rows no longer exist, so there is no scroll position that keeps
    // it where it was. Bring it to the top instead, through the card's own
    // `scroll-margin-top`, which already clears the measured sticky chrome.
    card.scrollIntoView({ block: "start", behavior: "auto" });
    return;
  }
  const delta = card.getBoundingClientRect().top - before;
  if (Math.abs(delta) > 0.5) window.scrollBy(0, delta);
}

/** F47r: how many favicons a folded card shows before it says it in words. */
const FOLD_STRIP_CAP = 8;

/**
 * F47r: what a folded card shows in place of its rows. Up to `FOLD_STRIP_CAP`
 * favicons, so folding compresses rather than hides; past that the strip stops
 * being scannable and the count says it plainly instead.
 *
 * MODULE level on purpose. It was declared inside `createTabList`, below the
 * point where `renderGroup` already runs, so the `const` cap was still in its
 * temporal dead zone and every render of a folded card threw — which killed the
 * re-render that folding, row selection, and select-all all depend on. Nothing
 * here closes over per-instance state, so nothing has to live in that scope.
 */
function foldedSummary(g) {
  // A multi-window card (a session) keeps its tabs in `windows`, not `refs`.
  const refs = g.refs ?? (Array.isArray(g.windows)
    ? g.windows.flatMap((w) => w.refs ?? [])
    : []);
  if (refs.length === 0 || refs.length > FOLD_STRIP_CAP) {
    // F47r4: the state is said beside the NAME, so the right-hand summary goes
    // back to the plain count it shows when open. Saying "folded" twice in one
    // header is worse than saying it once where the eye already is.
    return el("span", { class: "item-meta" },
      listUnit("tab", refs.length));
  }
  const strip = el("span", { class: "fold-strip", "aria-hidden": "true" });
  for (const ref of refs) {
    strip.append(ref.favIconUrl
      ? el("img", { class: "fv", src: ref.favIconUrl, alt: "",
          onerror: (e) => e.currentTarget.replaceWith(el("span", { class: "fv-placeholder" })) })
      : el("span", { class: "fv-placeholder" }));
  }
  return el("span", { class: "fold-summary" }, strip,
    el("span", { class: "fold-count" }, listUnit("tab", refs.length)));
}

/* =============================== rendering bits =============================== */

function rowActionNode(a, ctx, onAct = null) {
  if (a.render) return a.render(ctx);
  const short = shortActionLabel(a);
  return el("button", { class: `mini ${a.danger ? "danger" : "iconbtn"}`, title: a.label, "aria-label": a.label,
    "data-action-id": a.id,
    onclick: (event) => { ctx.panel.anchor(event.currentTarget); onAct?.(); a.run(ctx); } },
    el("span", { class: "action-icon" }, a.icon ? icon(a.icon, 14) : a.glyph ?? short),
    el("span", { class: "action-label" }, short));
}

function groupActionNode(a, ctx, onAct = null) {
  // `render:` actions (two-step deletes, comboboxes) manage themselves and
  // skip the focus capture — their own controls keep focus until they act.
  if (a.render) {
    const rendered = a.render(ctx);
    rendered?.addEventListener?.("pointerdown", (event) => {
      const trigger = event.target.closest?.("button");
      if (trigger) ctx.panel.anchor(trigger);
    }, true);
    rendered?.addEventListener?.("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        const trigger = event.target.closest?.("button");
        if (trigger) ctx.panel.anchor(trigger);
      }
    }, true);
    return rendered;
  }
  const compactIcon = groupActionIcon(a);
  return el("button", { class: `mini${a.danger ? " danger" : ""}`, title: a.label, "aria-label": a.label,
    "data-action-id": a.id,
    onclick: (event) => { ctx.panel.anchor(event.currentTarget); onAct?.(); a.run(ctx); } },
    el("span", { class: "action-icon" },
      compactIcon.icon ? icon(compactIcon.icon, 14) : compactIcon.glyph),
    el("span", { class: "action-label" }, a.shortLabel ?? a.label));
}

function groupActionIcon(a) {
  if (a.icon) return { icon: a.icon };
  const mapped = {
    "dump-window": "inbox", "save-session": "sessions", session: "sessions",
    copy: "copy", label: "labels", "label-session": "labels",
    snooze: "snooze", reschedule: "snooze",
    archive: "archive", restore: "refresh", "restore-all": "refresh",
    "open-all": "open", wake: "sun", "wake-all": "sun",
    rename: "rename", delete: "delete"
  }[a.id];
  if (mapped) return { icon: mapped };
  return a.danger || /delete|remove|cancel/.test(a.id)
    ? { glyph: "×" }
    : { icon: "organize" };
}

function shortActionLabel(a) {
  if (a.shortLabel) return a.shortLabel;
  return listShortActionLabel(a.id, a.label);
}

/**
 * One anchored, top-layer action palette for list workflows.
 *
 * The old in-flow slots made Label/Snooze/Organize insert a new row and push the
 * list. They also created a stacking context that could trap the label menu under
 * later rows. The slot now remains only as a lifecycle anchor; the workflow is a
 * manual Popover API surface attached to the invoking control. One palette may be
 * open per document. It light-dismisses, traps Tab, keeps button arrow-roving,
 * and returns focus to its opener on Escape.
 */
const PANEL_FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, a[href], [tabindex]:not([tabindex="-1"])';
let panelHeadingSeq = 0;
let activePanelController = null;
let panelEventsInstalled = false;

/** Shared scroll-dismiss policy kept pure so nested palette scrolling is testable. */
export function shouldDismissAnchoredPanelOnScroll(panelOwnsTarget) {
  return !panelOwnsTarget;
}

/** Close the one shared top-layer action panel without restoring its opener. */
export function dismissAnchoredPanel() {
  activePanelController?.close();
}

function installPanelEvents() {
  if (panelEventsInstalled || typeof document === "undefined") return;
  panelEventsInstalled = true;
  document.addEventListener("pointerdown", (event) => {
    if (activePanelController && !activePanelController.owns(event.target)) {
      activePanelController.close();
    }
  }, true);
  window.addEventListener("resize", () => activePanelController?.position());
  window.addEventListener("scroll", (event) => {
    if (!activePanelController) return;
    if (shouldDismissAnchoredPanelOnScroll(activePanelController.owns(event.target))) {
      activePanelController.close();
    }
  }, true);
}

export function createAnchoredPanel(slotEl) {
  let open = null;
  let opener = null;
  let anchorHint = null;
  let popover = null;
  let observer = null;
  let source = null;

  function focusables() {
    return popover
      ? [...popover.querySelectorAll(PANEL_FOCUSABLE)].filter((node) => node.offsetParent !== null)
      : [];
  }

  function positionPopover() {
    if (!popover || !opener?.isConnected) return;
    const edge = 10;
    const gap = 8;
    const compact = Boolean(slotEl.closest("[data-compact]")) || window.innerWidth <= 480;
    const width = Math.min(compact ? 420 : 460, window.innerWidth - edge * 2);
    popover.style.width = `${Math.max(280, width)}px`;
    const trigger = opener.getBoundingClientRect();
    const panel = popover.getBoundingClientRect();
    let left = compact ? edge : trigger.right - panel.width;
    left = Math.max(edge, Math.min(left, window.innerWidth - panel.width - edge));
    let top = trigger.bottom + gap;
    const fitsBelow = top + panel.height <= window.innerHeight - edge;
    if (!fitsBelow && trigger.top - panel.height - gap >= edge) {
      top = trigger.top - panel.height - gap;
      popover.dataset.side = "top";
    } else {
      top = Math.max(edge, Math.min(top, window.innerHeight - panel.height - edge));
      popover.dataset.side = "bottom";
    }
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
    const stemCenter = Math.max(18, Math.min(trigger.left + trigger.width / 2 - left, panel.width - 18));
    popover.style.setProperty("--palette-stem-x", `${Math.round(stemCenter)}px`);
  }

  function close({ restore = false } = {}) {
    const trigger = opener;
    observer?.disconnect();
    observer = null;
    if (popover) {
      try {
        if (popover.matches(":popover-open")) popover.hidePopover();
      } catch { /* Popover API fallback below still removes the host. */ }
      popover.remove();
    }
    trigger?.setAttribute?.("aria-expanded", "false");
    source?.classList.remove("palette-source");
    source?.removeAttribute("data-palette-source");
    popover = null;
    open = null;
    opener = null;
    anchorHint = null;
    source = null;
    if (activePanelController === controller) activePanelController = null;
    if (restore && trigger instanceof HTMLElement && document.contains(trigger)) {
      trigger.focus({ preventScroll: true });
    }
  }

  function onKeydown(e) {
    if (!popover) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close({ restore: true });
      return;
    }
    if (e.key === "Tab") {
      const items = focusables();
      if (items.length === 0) return;
      const i = items.indexOf(document.activeElement);
      if (e.shiftKey && (i <= 0)) {
        e.preventDefault();
        items[items.length - 1].focus();
      } else if (!e.shiftKey && i === items.length - 1) {
        e.preventDefault();
        items[0].focus();
      }
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "ArrowUp") {
      const btns = [...popover.querySelectorAll("button:not([disabled])")].filter((b) => b.offsetParent !== null);
      const i = btns.indexOf(e.target);
      if (i < 0 || btns.length < 2) return; // focus not on a panel button → fields keep their arrows
      e.preventDefault();
      e.stopPropagation();
      const fwd = e.key === "ArrowRight" || e.key === "ArrowDown";
      btns[(i + (fwd ? 1 : -1) + btns.length) % btns.length].focus();
    }
  }

  function openPopover(panel, name) {
    installPanelEvents();
    const copy = listPanelCopy(name);
    const headingId = `action-popover-title-${++panelHeadingSeq}`;
    const descriptionId = `${headingId}-description`;
    const closeButton = el("button", {
      class: "action-popover-close",
      type: "button",
      "aria-label": msg("list_close_palette", [copy.title.toLocaleLowerCase()]),
      onclick: () => close({ restore: true })
    }, "×");
    const header = el("div", { class: "action-popover-header" },
      copy.icon ? el("span", { class: "action-popover-icon", "aria-hidden": "true" }, icon(copy.icon, 16)) : null,
      el("div", { class: "action-popover-heading" },
        el("h3", { id: headingId }, copy.title),
        el("p", { id: descriptionId }, copy.description)),
      closeButton);
    popover = el("div", {
      class: "action-popover",
      popover: "manual",
      role: "dialog",
      "aria-labelledby": headingId,
      "aria-describedby": descriptionId,
      "data-kind": name
    }, el("span", { class: "action-popover-stem", "aria-hidden": "true" }),
    header, el("div", { class: "action-popover-body" }, panel));
    if (slotEl.closest("[data-compact]")) popover.dataset.compact = "";
    for (const node of popover.querySelectorAll("[title]")) {
      const detail = node.getAttribute("title");
      if (detail && !node.hasAttribute("aria-description")) {
        node.setAttribute("aria-description", detail);
      }
      node.removeAttribute("title");
    }
    popover.addEventListener("keydown", onKeydown);
    document.body.append(popover);
    try { popover.showPopover(); }
    catch { popover.dataset.open = "true"; }
    positionPopover();
    opener?.setAttribute?.("aria-haspopup", "dialog");
    opener?.setAttribute?.("aria-expanded", "true");
    source = opener?.closest?.(".trow, .item") ?? null;
    source?.classList.add("palette-source");
    source?.setAttribute("data-palette-source", name);
    activePanelController = controller;
    observer = new MutationObserver(() => {
      if (!slotEl.isConnected || !opener?.isConnected) close();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    queueMicrotask(() => {
      const firstBodyControl = popover?.querySelector(`.action-popover-body ${PANEL_FOCUSABLE}`);
      (firstBodyControl ?? closeButton).focus({ preventScroll: true });
    });
  }

  const controller = {
    anchor(node) {
      if (node instanceof HTMLElement) anchorHint = node;
    },
    owns(node) {
      return Boolean(popover?.contains(node) || opener?.contains?.(node));
    },
    position() {
      positionPopover();
    },
    toggle(factory, name = "_") {
      if (popover && open === name) { close({ restore: true }); return; }
      activePanelController?.close();
      opener = anchorHint instanceof HTMLElement && anchorHint.isConnected
        ? anchorHint
        : document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const panel = factory();
      open = name;
      openPopover(panel, name);
    },
    close() { close(); }
  };
  return controller;
}

// Retain the private call-site name used throughout the list renderer. Other
// same-page workflows (for example organization groups) may reuse the exact
// same top-layer interaction grammar through the exported interface above.
const slotPanel = createAnchoredPanel;

function keyMap(actions) {
  const m = new Map();
  for (const a of actions) if (a.key) m.set(a.key, a);
  return m;
}

/** An action set is either a static array or a `(group) => actions[]` function. */
function resolveActions(actions, group) {
  return (typeof actions === "function" ? actions(group) : actions) ?? [];
}

/**
 * One frame later, or a timer where there is no frame loop. A HIDDEN document
 * is the case that matters: Chrome suspends `requestAnimationFrame` there, so a
 * frame-based retry would simply never run and a background refresh would still
 * strand focus. Tests and workers take the same fallback.
 */
const raf = (fn) =>
  typeof requestAnimationFrame === "function" && globalThis.document?.hidden !== true
    ? requestAnimationFrame(fn)
    : setTimeout(fn, 16);

function focusRow(row, options = undefined) {
  const target = row.querySelector("input:not([disabled]),button,a") ?? row;
  if (target === row) row.tabIndex = -1;
  target.focus(options);
}

/* ============================ keyboard triage ============================ */
/* Roving ↑/↓ stays the shared generic handler in dashboard.js (it already moves
 * focus across .trow/.item). This adds single-key triage (x + configured action
 * keys, two-step for danger) on the focused row/card of ANY tablist — so
 * "keyboard triage exists everywhere selection does" comes for free. One global
 * listener, installed lazily (guarded for node/tests where document is absent). */

let keyboardInstalled = false;
function installKeyboard() {
  if (keyboardInstalled || typeof document === "undefined") return;
  keyboardInstalled = true;
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTextEntry(e.target)) return;
    const rowEl = e.target.closest?.("[data-tablist-row]");
    const cardEl = e.target.closest?.("[data-tablist-card]");
    const meta = (rowEl && rowEl._tlRow) || (cardEl && cardEl._tlCard);
    if (!meta) return;
    const root = (rowEl || cardEl).closest("[data-tablist]");
    const st = root ? stateFor(root.getAttribute("data-tablist")) : null;
    const rows = root ? [...root.querySelectorAll("[data-tablist-row]")] : [];
    const idxNow = rowEl ? rows.indexOf(rowEl) : null;

    // N26: shift+x extends the selection from the anchor (last row x-toggled on
    // its own) to the focused row — the keyboard mirror of N14's shift+click,
    // reusing the exact same range logic. No anchor yet → behave like plain x.
    if (e.shiftKey && (e.key === "X" || e.key === "x")) {
      if (meta.ctx?.rangeTo) {
        e.preventDefault();
        if (st && idxNow != null) st.pendingFocus = idxNow;
        if (!meta.ctx.rangeTo()) meta.ctx.toggleSelect?.();
      }
      return;
    }

    if (e.key === "x") {
      if (meta.ctx.toggleSelect) { e.preventDefault(); if (st && idxNow != null) st.pendingFocus = idxNow; meta.ctx.toggleSelect(); }
      else if (meta.toggleGroup) { e.preventDefault(); meta.toggleGroup(); }
      return;
    }

    const isDel = e.key === "Delete" || e.key === "Backspace";
    const action = meta.byKey.get(e.key) || (isDel ? meta.del : null);
    // Only keyboard-dispatch actions that carry a `run`; a `render`-only action
    // (e.g. an inline two-step confirm control) is mouse-only.
    if (!action || typeof action.run !== "function") return;
    e.preventDefault();
    const anchor = rowEl || cardEl;

    if (action.danger) {
      if (st?.armedDel && st.armedDel.el === anchor) {
        clearTimeout(st.armedDel.timer);
        anchor.classList.remove("armed-del");
        st.armedDel = null;
        if (st && idxNow != null) st.pendingFocus = idxNow;
        action.run(meta.ctx);
      } else {
        if (st?.armedDel) { st.armedDel.el.classList.remove("armed-del"); clearTimeout(st.armedDel.timer); }
        anchor.classList.add("armed-del");
        if (st) st.armedDel = { el: anchor,
          timer: setTimeout(() => { anchor.classList.remove("armed-del"); if (st) st.armedDel = null; }, 2500) };
      }
      return;
    }
    if (st && idxNow != null) st.pendingFocus = idxNow;
    const actionButton = action.id
      ? anchor.querySelector(`[data-action-id="${CSS.escape(action.id)}"]`)
      : null;
    meta.ctx.panel?.anchor(actionButton ?? anchor);
    action.run(meta.ctx);
  });
}

function isTextEntry(t) {
  if (!t) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === "TEXTAREA" || t.tagName === "SELECT") return true;
  if (t.tagName === "INPUT") {
    const ty = (t.type || "text").toLowerCase();
    return !["checkbox", "radio", "button", "submit", "reset"].includes(ty);
  }
  return false;
}
