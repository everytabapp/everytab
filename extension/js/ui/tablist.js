// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * U3 / P2e — the ONE list component every tab list renders through.
 *
 * Five sections (Open tabs, Inbox, Archive, Sessions/Snapshots, Snoozed) used
 * to render "a list of tabs, maybe grouped into windows" five different ways.
 * `createTabList(config)` owns the shared anatomy. Sections provide normalized
 * groups, available actions, and the few explicit policies needed by their
 * workflows; list mechanics remain centralized here.
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
import { animateDisclosure, finishDisclosure } from "./disclosure-motion.js";
import { cachedFaviconUrl, faviconSource } from "./favicon-source.js";
import { el, isComposingKey } from "./dom.js";
import { icon } from "./icons.js";
import { msg } from "../lib/i18n.js";
import { compactRelativeAge } from "../lib/relative-time.js";
import {
  listArchiveMeta, listCurrentWindowBadge, listDuplicateMeta, listInboxMeta,
  listOpenWindowMeta, listOpenWindowTitle, listPanelCopy, listSelectionSummary,
  listRecurrenceOptionLabel, listSessionMeta, listSessionWindowMeta, listShortActionLabel,
  listSingleTabTitle, listSourceLabel, listUnit, listWindowCardTitle
} from "./list-copy.js";
import { snoozeRefs } from "../lib/snooze.js";
import { canonicalRef, urlOf, isSaveableTab, isOwnSuspendPage } from "../lib/tabs.js";
import { GROUP_COLOR_HEX } from "../lib/tab-groups.js"; // F18: valid tab-group color names

/**
 * P2g-2: the narrow fallback remains two labels, while wider ledgers reveal
 * progressively more without changing row height. `rowChipsNode()` renders the
 * matching overflow control for each structural width tier; CSS chooses the
 * tier from the tab-list container, so a resize never needs a JS re-render.
 */
const ROW_CHIP_CAPS = [2, 3, 4, 6, 8];
const ROW_CHIP_MAX = ROW_CHIP_CAPS[ROW_CHIP_CAPS.length - 1];

/* ============================ per-section state ============================ */

/**
 * @typedef {Object} TabListState
 * @property {Set<string>} selected
 * @property {Set<string>} expanded
 * @property {boolean} sectionExpanded
 * @property {boolean} keeperVisible
 * @property {boolean} keeperMotionAllowed
 * @property {{el:HTMLElement,timer:number}|null} armedDel
 * @property {number|null} pendingFocus
 * @property {number|null} pendingCardFocus
 * @property {Set<string>} folded
 * @property {Set<string>} chipsOpen
 * @property {string|null} anchor
 * @property {string|null} rangeEnd
 * @property {Map<string,{signature:string,nested:boolean,rowCounts:number[]}>} savedLayouts
 */

/** @type {Map<string, TabListState>} */
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
      rangeEnd: null,       // the last range endpoint — re-hitting it toggles the range off
      savedLayouts: new Map() };
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

const rowKey = (gid, idx) => `${gid}::${idx}`;
/** U6 (P2g-3): composite key for a row inside a multi-window group (sessions). */
const rowKeyW = (gid, wi, idx) => `${gid}::w${wi}::${idx}`;

/**
 * Saved refs have no durable occurrence ID. Positional selection is safe only
 * while its carrier and ordered window layout remain unchanged. Serialize at
 * render time so callers mutating the same objects cannot rewrite our baseline.
 * Unique URLs tolerate display/label edits. Duplicate URLs are ambiguous: their
 * title, labels and restore metadata must also agree, or that group's selection
 * is retired conservatively rather than transferred to another occurrence.
 */
function savedSelectionLayout(group) {
  const nested = Array.isArray(group.windows);
  const windows = nested ? group.windows.map((window) => window.refs) : [group.refs ?? []];
  const urls = windows.flatMap((refs) => refs.map((ref) => ref?.url ?? ""));
  const duplicateUrls = new Set();
  const seen = new Set();
  for (const url of urls) {
    if (seen.has(url)) duplicateUrls.add(url);
    seen.add(url);
  }
  const layout = windows.map((refs) => refs.map((ref) => {
    const url = ref?.url ?? "";
    return duplicateUrls.has(url)
      ? [url, ref?.title ?? "", ref?.labels ?? [], Boolean(ref?.pinned),
        ref?.groupIndex ?? null, Boolean(ref?.incognito)]
      : url;
  }));
  // Row keys are positional and therefore implied by the per-window counts.
  // They are derived only for a group whose layout changed, so a render of
  // thousands of saved cards does not allocate one key string per row.
  return {
    signature: JSON.stringify([nested, group.data?.createdAt ?? null,
      group.data?.deviceId ?? null, layout]),
    nested,
    rowCounts: windows.map((refs) => refs.length)
  };
}

/** Every row key the retained layout of one saved group covered. */
function* savedLayoutRowKeys(id, layout) {
  for (let wi = 0; wi < layout.rowCounts.length; wi += 1) {
    for (let index = 0; index < layout.rowCounts[wi]; index += 1) {
      yield layout.nested ? rowKeyW(id, wi, index) : rowKey(id, index);
    }
  }
}

/** Retire only affected positional selections; explicit live-tab keys stay intact. */
function reconcileSavedSelection(state, groups, rowKeyFn) {
  const layouts = new Map();
  for (const group of groups) {
    if (!rowKeyFn || Array.isArray(group.windows)) {
      layouts.set(group.id, savedSelectionLayout(group));
    }
  }
  for (const [id, previous] of state.savedLayouts) {
    if (layouts.get(id)?.signature === previous.signature) continue;
    for (const key of savedLayoutRowKeys(id, previous)) {
      state.selected.delete(key);
      if (state.anchor === key) state.anchor = null;
      if (state.rangeEnd === key) state.rangeEnd = null;
    }
  }
  state.savedLayouts = layouts;
}

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
 * Define presentation fields that are computed on first read and then stored
 * as plain values. Archive maps every saved record while the list shows twenty
 * cards, so localized titles and formatted ages for hidden cards are never
 * computed. Assignment replaces the field like an ordinary property.
 * @template {object} T
 * @param {T} target
 * @param {Record<string, () => unknown>} fields
 * @returns {T}
 */
function defineLazyFields(target, fields) {
  for (const [name, compute] of Object.entries(fields)) {
    const store = (value) => Object.defineProperty(target, name, {
      configurable: true, enumerable: true, writable: true, value
    });
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: true,
      get() {
        const value = compute();
        store(value);
        return value;
      },
      set: store
    });
  }
  return target;
}

/**
 * Archive (and any InboxItem-shaped store): one card per item.
 * @param {import("../lib/types.js").InboxItem[]} items
 */
export function fromArchiveItems(items, getSessionMemberships = null) {
  return (items ?? []).map((item) => defineLazyFields({
    id: item.id,
    kind: item.kind,
    chips: item.labels ?? [],
    refs: item.tabs.map((ref) => {
      const sessionMemberships = getSessionMemberships?.(ref.url) ?? [];
      return sessionMemberships.length ? { ...ref, sessionMemberships } : ref;
    }),
    loose: false,
    data: item
  }, {
    // A single-tab card's header is a structural descriptor ("Single tab"), not
    // the tab's own title — the row below already shows that (parity with the
    // window card's "Window · N tabs"; avoids the title appearing twice).
    title: () => item.kind === "window"
      ? listWindowCardTitle(item.tabs.length)
      : listSingleTabTitle(),
    meta: () => listArchiveMeta(item.source, item.archivedAt ?? item.modifiedAt)
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
export function fromInboxItems(items, getSessionMemberships = null) {
  return (items ?? []).map((item) => ({
    id: item.id,
    kind: item.kind,
    // Single-tab header = "Single tab" (structural), not the tab's title, which
    // the row below already shows — mirrors the window card's "Window · N tabs".
    title: item.kind === "window" ? listWindowCardTitle(item.tabs.length) : listSingleTabTitle(),
    chips: item.labels ?? [],
    meta: listInboxMeta(item.source, item.createdAt),
    refs: item.tabs.map((ref) => {
      const sessionMemberships = getSessionMemberships?.(ref.url) ?? [];
      return sessionMemberships.length ? { ...ref, sessionMemberships } : ref;
    }),
    loose: false,
    data: item
  }));
}

/**
 * Snoozed: one card per snooze. A window snooze (`tabs[]`, P2b-1) is a bundle
 * of rows; a scalar single-tab snooze is a one-row group. Saved single-tab
 * transfers may also carry one full ref. The `details` hack goes away — all
 * are ordinary GroupCards.
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
        chips: s.recurrence ? [listRecurrenceOptionLabel(s.recurrence, s.recurrence)] : [],
        meta: sess
          ? msg("list_restores_at", [new Date(s.dueAt).toLocaleString()])
          : msg("list_restores_at_deleted", [new Date(s.dueAt).toLocaleString()]),
        refs: sess ? sess.windows.flat() : [],
        loose: false,
        data: s
      };
    }
    const refs = snoozeRefs(s);
    return {
      id: s.id,
      kind: "snooze",
      // F45: a card header is a structural descriptor, so one snoozed tab reads
      // "Single tab" exactly as it does in Inbox and Archive. Repeating the page
      // title here said the same thing twice, once in the header and once in the
      // row directly beneath it.
      title: refs.length > 1
        ? listWindowCardTitle(refs.length)
        : listSingleTabTitle(),
      chips: s.recurrence ? [listRecurrenceOptionLabel(s.recurrence, s.recurrence)] : [],
      meta: msg("list_due_at", [new Date(s.dueAt).toLocaleString()]),
      refs,
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
 * @param {number|null} currentTabId the exact tab hosting this EveryTab surface
 * @param {((tab:chrome.tabs.Tab,index:number)=>void)|null} preparation optional lazy preparation observer
 * @param {Map<number,{title?:string,color?:string}>|Object|null} liveGroupDetails optional Chrome group metadata
 */
export function fromOpenWindows(
  windows,
  getSavedLabels = null,
  currentWindowId = null,
  currentTabId = null,
  getSessionMemberships = null,
  preparation = null,
  liveGroupDetails = null
) {
  return (windows ?? []).map((win, i) => {
    const tabs = (win.tabs ?? []).filter((t) => t.id !== undefined);
    const tabGroups = new Map();
    for (const tab of tabs) {
      const groupId = tab.groupId;
      if (!Number.isInteger(groupId) || groupId === -1 || tabGroups.has(groupId)) continue;
      const detail = liveGroupDetails?.get?.(groupId) ?? liveGroupDetails?.[groupId] ?? {};
      tabGroups.set(groupId, {
        id: groupId,
        ...(typeof detail.title === "string" && detail.title ? { title: detail.title } : {}),
        ...(GROUP_COLOR_HEX[detail.color] ? { color: detail.color } : {})
      });
    }
    // Open keeps every stable browser handle, count, and row position, but the
    // canonical display ref is prepared only when a row or an explicit
    // whole-window action needs it. This makes the visual row cap a real
    // preparation boundary instead of a DOM-only limit.
    const suspendedRefs = tabs.map((tab) => isOwnSuspendPage(tab) ? canonicalRef(tab) : undefined);
    const refs = lazyMappedArray(tabs, (t, index) => {
      const cref = suspendedRefs[index] ?? canonicalRef(t);
      const url = cref?.url ?? urlOf(t);
      // P2g-2r: a live tab carries no stored labels, but if a labeled SAVED copy
      // of the same page exists (Inbox/Archive), surface those labels read-only.
      const saved = getSavedLabels ? getSavedLabels(url) : null;
      const sessionMemberships = getSessionMemberships ? getSessionMemberships(url) : null;
      const favIconUrl = cref?.favIconUrl ?? t.favIconUrl;
      preparation?.onPrepareRef?.(t, index);
      return { url, title: cref?.title ?? t.title ?? url,
        ...(favIconUrl ? { favIconUrl } : {}), pinned: t.pinned,
        ...(saved?.length ? { labels: saved } : {}),
        ...(sessionMemberships?.length ? { sessionMemberships } : {}) };
    });
    const live = tabs.map((t) => {
      const tabGroup = tabGroups.get(t.groupId);
      return {
        tabId: t.id, windowId: t.windowId, chromeIndex: t.index,
        pinned: !!t.pinned, audible: !!t.audible, suspended: isOwnSuspendPage(t),
        currentSurface: Number.isInteger(currentTabId) && t.id === currentTabId,
        lastAccessed: t.lastAccessed,
        ...(tabGroup ? { tabGroup } : {}),
        // N9: canonical selectability — a suspended tab IS selectable (its ref
        // already carries the underlying page); chrome:// etc. stay disabled.
        selectable: isSaveableTab(t)
      };
    });
    const searchText = tabs.map((t, index) => {
      const ref = suspendedRefs[index];
      return `${ref?.title ?? t.title ?? ""}\n${ref?.url ?? urlOf(t)}`.toLocaleLowerCase();
    });
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
      refs, live, searchText,
      selectableCount: live.reduce((count, row) => count + Number(row.selectable), 0),
      loose: false, data: win
    };
  });
}

/**
 * Array-compatible, memoized projection. Length and stable indices are
 * available immediately; reading a row performs its richer conversion once.
 * @template T,U
 * @param {T[]} source
 * @param {(value:T,index:number)=>U} project
 * @returns {U[]}
 */
function lazyMappedArray(source, project) {
  const out = new Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    Object.defineProperty(out, index, {
      configurable: true,
      enumerable: true,
      get() {
        const value = project(source[index], index);
        Object.defineProperty(out, index, {
          configurable: false,
          enumerable: true,
          writable: false,
          value
        });
        return value;
      }
    });
  }
  return out;
}

/** Preserve a filtered row's source identity without preparing its ref. */
export function lazyOpenRefSubset(refs, indexes) {
  return lazyMappedArray(indexes, (sourceIndex) => refs[sourceIndex]);
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
    const chromeTitlesDiffer = new Set(refs.map((ref) =>
      String(ref.title || ref.url || "").trim()
    )).size > 1;
    const keepIndex = tabs.findIndex((tab) => tab.id === group.keep.id);
    const keepRef = refs[keepIndex >= 0 ? keepIndex : 0];
    return {
      id: `duplicate::${group.key}`,
      kind: "duplicate",
      // Lead with the survivor's human-readable title. The canonical address
      // remains the authoritative duplicate identity, but the surface presents
      // it as secondary context so long URLs cannot dominate the card cap.
      title: keepRef?.title ?? group.key,
      meta: listDuplicateMeta(tabs.length, windowCount),
      refs,
      live: tabs,
      loose: false,
      data: {
        key: group.key,
        canonicalUrl: group.key,
        keepId: group.keep.id,
        closeIds: new Set(group.close.map((tab) => tab.id)),
        chromeTitlesDiffer
      }
    };
  });
}

/* ============================ the component ============================ */

/**
 * Share a bounded first-render row budget evenly across visible flat groups.
 * Small groups return unused capacity to larger ones. Expanded groups remain a
 * deliberate user action and are not constrained by this initial budget.
 */
export function allocateInitialRowCaps(groups = [], perGroupCap = 8, totalBudget = Infinity) {
  const cap = Math.max(0, Math.floor(Number(perGroupCap) || 0));
  const demand = groups.map((group) => ({
    id: group.id,
    n: Math.min(cap, Array.isArray(group.refs) ? group.refs.length : cap)
  }));
  if (!Number.isFinite(totalBudget)) return new Map(demand.map(({ id, n }) => [id, n]));

  let remaining = Math.max(0, Math.floor(totalBudget));
  const allocated = new Map(demand.map(({ id }) => [id, 0]));
  while (remaining > 0) {
    let progressed = false;
    for (const { id, n } of demand) {
      if (remaining === 0) break;
      const current = allocated.get(id) ?? 0;
      if (current >= n) continue;
      allocated.set(id, current + 1);
      remaining -= 1;
      progressed = true;
    }
    if (!progressed) break;
  }
  return allocated;
}

/** @typedef {import("../lib/types.js").TabRef} TabRef */

/**
 * @typedef {Object} TabListWindow
 * @property {string} [id]
 * @property {string} [meta]
 * @property {TabRef[]} refs
 * @property {unknown[]} [groups]
 * @property {Array<{title:string,color:string,count:number}>} [groupChips]
 */

/**
 * Normalized display model consumed by the shared list renderer.
 * @typedef {Object} TabListGroup
 * @property {string} id
 * @property {string} title
 * @property {string} [kind]
 * @property {string} [glyph]
 * @property {string} [badge]
 * @property {string[]} [chips]
 * @property {string} [meta]
 * @property {TabRef[]} [refs]
 * @property {TabListWindow[]} [windows]
 * @property {boolean} [loose]
 * @property {Array<Record<string, unknown>>} [live]
 * @property {unknown} [data]
 * @property {string[]} [searchText]
 * @property {number} [selectableCount]
 */

/**
 * @typedef {Object} TabListPanelController
 * @property {(node:HTMLElement)=>void} anchor
 * @property {(factory:()=>Node|null,name?:string)=>void} toggle
 * @property {(options?:{restore?:boolean})=>void} close
 */

/**
 * Lightweight context used before a row is rendered. It deliberately excludes
 * panels, selection methods, the row element, and multi-window coordinates.
 * @typedef {Object} TabListPredicateContext
 * @property {TabListGroup} group
 * @property {number} index
 * @property {TabRef} ref
 * @property {Record<string, unknown>|null} live
 */

/**
 * @typedef {Object} TabListRowContext
 * @property {TabListGroup} group
 * @property {TabListWindow|null} window
 * @property {number|null} windowIndex
 * @property {number} index
 * @property {TabRef} ref
 * @property {Record<string, unknown>|null} live
 * @property {TabListPanelController} panel
 * @property {()=>unknown} rerender
 * @property {()=>void} [toggleSelect]
 * @property {()=>boolean} [rangeTo]
 * @property {HTMLElement} [rowEl]
 * @property {TabListSelectionEntry[]} [dragSelection]
 */

/**
 * @typedef {Object} TabListGroupContext
 * @property {TabListGroup} group
 * @property {()=>unknown} rerender
 * @property {()=>void} clear
 * @property {TabListPanelController} panel
 * @property {()=>void} beforeRemoveCard
 */

/**
 * @typedef {Object} TabListWindowContext
 * @property {TabListGroup} group
 * @property {TabListWindow} window
 * @property {number} windowIndex
 * @property {()=>unknown} rerender
 */

/**
 * @typedef {Object} TabListSelectionEntry
 * @property {TabListGroup} group
 * @property {number[]} [indexes] flat-group indexes
 * @property {Array<{windowIndex:number,indexes:number[]}>} [picks] multi-window indexes
 */

/**
 * @typedef {Object} TabListBulkContext
 * @property {TabListSelectionEntry[]} selection
 * @property {number} count
 * @property {()=>void} clear
 * @property {()=>unknown} rerender
 * @property {TabListPanelController} panel
 */

/**
 * Mounted header controls retained across local selection commits. Keys describe
 * the header's selection scope; replacing an action lane must update its owner.
 * @typedef {Object} TabListSelectionHeaderOwner
 * @property {HTMLElement} head
 * @property {HTMLInputElement|null} checkbox
 * @property {string[]} keys
 * @property {HTMLElement|null} actionLane
 */

/** @typedef {TabListSelectionHeaderOwner & {
 *   g: TabListGroup, total: number, grpActs: TabListAction[],
 *   gctx: TabListGroupContext, grpFocus: ()=>void, grpSlot: HTMLElement,
 *   isBulk: boolean
 * }} TabListGroupSelectionOwner */

/** @typedef {TabListSelectionHeaderOwner & {
 *   g: TabListGroup, w: TabListWindow, wi: number, winActs: TabListAction[]
 * }} TabListWindowSelectionOwner */

/** @typedef {TabListRowContext|TabListGroupContext|TabListWindowContext} TabListActionContext */

/** @typedef {{row:TabListAction[],group:TabListAction[],window:TabListAction[]}} TabListActionSets */

/**
 * @typedef {Object} TabListAction
 * @property {string} id
 * @property {string} label
 * @property {string} [title]
 * @property {string} [shortLabel]
 * @property {string} [icon]
 * @property {string} [glyph]
 * @property {string} [key]
 * @property {boolean} [danger]
 * @property {boolean} [always]
 * @property {boolean} [hidden]
 * @property {(context:TabListRowContext)=>boolean} [when]
 * @property {(context:TabListActionContext)=>Node|null} [render]
 * @property {(context:TabListActionContext)=>unknown} [run]
 */

/**
 * @typedef {Object} TabListRowDrag
 * @property {(context:TabListRowContext)=>boolean} [draggable]
 * @property {(context:TabListRowContext,event:DragEvent)=>unknown} [onStart]
 * @property {(context:TabListRowContext,event:DragEvent)=>unknown} [onEnd]
 * @property {(context:TabListRowContext,event:DragEvent)=>unknown} [onOver]
 * @property {(context:TabListRowContext,event:DragEvent)=>unknown} [onLeave]
 * @property {(context:TabListRowContext,event:DragEvent)=>unknown} [onDrop]
 */

/**
 * @typedef {Object} TabListConfig
 * @property {string} section stable state id
 * @property {"default"|"compact"} [presentation]
 * @property {TabListGroup[]} [groups]
 * @property {"tab"|"group"|"none"} [selectable]
 * @property {TabListAction[]|((group:TabListGroup)=>TabListAction[])|null} [rowActions]
 * @property {TabListAction[]|((group:TabListGroup)=>TabListAction[])|null} [groupActions]
 * @property {TabListAction[]|((group:TabListGroup)=>TabListAction[])|null} [windowActions]
 * @property {((context:TabListBulkContext)=>Node[])|null} [bulkActions]
 * @property {string} [bulkHint]
 * @property {boolean} [bulkAlways]
 * @property {((ref:TabRef,group:TabListGroup,index:number)=>string|Node)|null} [rowMeta]
 * @property {((context:TabListRowContext)=>Node|null)|null} [rowSupplement]
 * @property {((group:TabListGroup)=>Node|null)|null} [groupSupplement]
 * @property {((group:TabListGroup)=>boolean)|null} [immutable]
 * @property {((group:TabListGroup,label:string)=>unknown)|null} [onChipRemove]
 * @property {((context:TabListRowContext,label:string)=>unknown)|null} [onRowChipRemove]
 * @property {((label:string)=>unknown)|null} [onChipOpen]
 * @property {((sessionId:string)=>unknown)|null} [onSessionOpen]
 * @property {number} [rowCap]
 * @property {number} [initialRowBudget]
 * @property {number} [groupCap]
 * @property {boolean} [foldable]
 * @property {boolean} [openPlacement] canonical Open-only placement capability; surface owns input/gate validation
 * @property {()=>unknown} [onChange]
 * @property {Node|Node[]|null} [toolbar]
 * @property {string|Node|null} [empty]
 * @property {((group:TabListGroup,index:number)=>string)|null} [rowKey]
 * @property {((context:TabListPredicateContext)=>boolean)|null} [rowVisible]
 * @property {((context:TabListPredicateContext)=>boolean)|null} [rowSelectable]
 * @property {((group:TabListGroup,index:number)=>boolean)|null} [selectionSelectable]
 * @property {((group:TabListGroup)=>number)|null} [selectionCount]
 * @property {((group:TabListGroup,index:number)=>{id:number|string,title?:string,color?:string}|null)|null} [rowGroup]
 * @property {((context:TabListRowContext)=>Node[])|null} [rowBadges]
 * @property {((context:TabListRowContext)=>unknown)|null} [rowOpen]
 * @property {((group:TabListGroup)=>Node|null)|null} [groupBanner]
 * @property {boolean} [groupPanelTop]
 * @property {TabListRowDrag|null} [rowDrag]
 * @property {((group:TabListGroup,event:DragEvent)=>unknown)|null} [onGroupDragOver]
 * @property {((group:TabListGroup,event:DragEvent)=>unknown)|null} [onGroupDragLeave]
 * @property {((group:TabListGroup,event:DragEvent)=>unknown)|null} [onGroupDrop]
 * @property {((group:TabListGroup)=>Node|null)|null} [betweenZone]
 * @property {((group:TabListGroup)=>Node|null)|null} [groupEndZone]
 * @property {((group:TabListGroup,windowIndex:number)=>Node|null)|null} [windowGap]
 * @property {((group:TabListGroup,window:TabListWindow,windowIndex:number)=>Node|null)|null} [windowEndZone]
 * @property {((group:TabListGroup,window:TabListWindow,windowIndex:number,event:DragEvent)=>unknown)|null} [onWindowDragOver]
 * @property {((group:TabListGroup,window:TabListWindow,windowIndex:number,event:DragEvent)=>unknown)|null} [onWindowDragLeave]
 * @property {((group:TabListGroup,window:TabListWindow,windowIndex:number,event:DragEvent)=>unknown)|null} [onWindowDrop]
 */

/** Keep focus eligibility and accessibility visibility in sync without unmounting controls.
 * @param {HTMLElement|null} lane
 * @param {boolean} available
 */
function setActionLaneAvailability(lane, available) {
  if (!lane) return;
  lane.inert = !available;
  if (available) lane.removeAttribute("aria-hidden");
  else lane.setAttribute("aria-hidden", "true");
}

const OPEN_PLACEMENT_OWNERS = new WeakMap();

/**
 * Reorder a mounted, fully visible flat Open list after its surface has verified
 * unchanged presentation/library inputs. Returns false without changes for any
 * unsupported shape or non-placement change. Existing group identities remain
 * the action owners; this capability never installs closures from another list.
 * @param {HTMLElement} root
 * @param {TabListGroup[]} nextGroups
 * @returns {boolean}
 */
export function reconcileOpenPlacement(root, nextGroups) {
  return OPEN_PLACEMENT_OWNERS.get(root)?.(nextGroups) ?? false;
}

/** @param {TabListConfig} config @returns {HTMLElement} */
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
    rowSupplement = null,
    groupSupplement = null,
    immutable = null,
    onChipRemove = null,
    onRowChipRemove = null, // P2g-2: (ctx, label) => void — enables the × on per-tab row chips
    onChipOpen = null,      // P2g-2r2: (label) => void — label chips navigate (e.g. to the Labels section)
    onSessionOpen = null,
    rowCap = 8,
    initialRowBudget = Infinity,
    groupCap = 20,
    // F47: cards can collapse to their header. Opt-in, because it only makes
    // sense where a card is a place you work rather than one saved thing.
    foldable = false,
    onChange = () => {},
    toolbar = null,
    empty = null,
    // --- generic sockets (Open tabs uses these; other sections leave them off) ---
    rowKey: rowKeyFn = null,       // (group,index) => stable key (default group.id::index)
    rowVisible = null,              // (ctx) => bool — filter rows without changing their source indexes
    rowSelectable = null,          // (ctx) => bool — a non-selectable row shows a disabled checkbox and is excluded from select-all
    selectionSelectable = null,    // (group,index) => bool — avoids reading rich lazy refs during selection bookkeeping
    selectionCount = null,         // (group) => number — avoids constructing every selection key for the initial view
    rowGroup = null,               // (group,index) => live tab-group descriptor; Dashboard Open only
    rowGroupSupplement = null,     // (group descriptor) => Node|null — contextual control in a live tab-group heading
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
    windowEndZone = null,          // (group, window, wi) => Node|null — terminal append target inside a multi-window block
    onWindowDragOver = null,       // (group, w, wi, e) — window-block header drop (P2g-4c: append to that window)
    onWindowDragLeave = null,
    onWindowDrop = null
  } = config;

  installKeyboard();
  const st = stateFor(section);
  reconcileSavedSelection(st, groups, rowKeyFn);
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
  const placementRows = config.openPlacement === true ? new Map() : null;
  const root = el("div", { class: "tablist", "data-tablist": section,
    ...(presentation === "compact" ? { "data-compact": "" } : {}) });
  if (section === "open") {
    // A replacement shell inherits the pointer's position after mounting.
    // Settle that initial state without replaying hover transitions.
    root.classList.add("is-mounting");
    raf(() => raf(() => root.classList.remove("is-mounting")));
  }
  INSTANCES.set(section, { config, root });
  // Selection is local UI state. A pointer or key transaction must update the
  // row, owning header, and cross-card keeper together without entering the
  // asynchronous Chrome/storage refresh path used for changed tab data.
  const paintSelectedRows = () => {
    const multiple = st.selected.size > 1;
    root.classList.toggle("has-multiple-selection", multiple);
    for (const row of root.querySelectorAll("[data-tablist-row]")) {
      const selected = st.selected.has(row.getAttribute("data-tablist-row"));
      row.classList.toggle("sel", selected);
      const checkbox = row.querySelector('.row-select-slot input[type="checkbox"]');
      if (checkbox && !checkbox.disabled) checkbox.checked = selected;
      setActionLaneAvailability(row.querySelector(".tacts"), !multiple);
    }
  };
  function commitSelectionDom() {
    // Selection is interaction state, not new tab data. Reconcile only the
    // controls whose meaning changed; rebuilding hundreds of unchanged rows
    // made the first click miss a frame and briefly destroyed keyboard focus.
    paintSelectedRows();
    reconcileSelectionHeadersAndKeeper();
    return root;
  }
  // F29: stable per-render ids so a disclosure row can name what it reveals.
  // `section` is unique per document (INSTANCES is keyed by it), so the pair
  // section + ordinal cannot collide with another list on the same page.
  let discloseN = 0;
  const nextDiscloseId = () => `tl-${section}-disclosed-${++discloseN}`;

  // key a row by a stable identity (Open tabs keys by tabId, so selection
  // survives live reordering) — everyone else keys by group.id::index.
  const keyFor = (g, i) => (rowKeyFn ? rowKeyFn(g, i) : rowKey(g.id, i));
  const predCtx = (g, i) => ({ group: g, index: i, ref: g.refs[i], live: g.live ? g.live[i] : null });
  const visibleAt = (g, i) => !rowVisible || !!rowVisible(predCtx(g, i));
  const visibleIndexes = (g) => {
    const indexes = [];
    for (let i = 0; i < rowCountOf(g); i += 1) if (visibleAt(g, i)) indexes.push(i);
    return indexes;
  };
  const selectableAt = (g, i) => selectable === "tab" && (!rowSelectable || !!rowSelectable(predCtx(g, i)));
  const selectionSelectableAt = (g, i) => selectable === "tab" && (selectionSelectable
    ? !!selectionSelectable(g, i)
    : selectableAt(g, i));
  const rowCountOf = (g) => Array.isArray(g.refs) ? g.refs.length : 0;

  const displayGroups = rowVisible
    ? groups.filter((group) => Array.isArray(group.windows) || visibleIndexes(group).length > 0)
    : groups;

  if (toolbar) for (const n of Array.isArray(toolbar) ? toolbar : [toolbar]) if (n) root.append(n);

  if (displayGroups.length === 0) {
    if (empty) root.append(typeof empty === "string" ? el("div", { class: "empty" }, empty) : empty);
    return root;
  }

  // prune selection of tabs that no longer exist (splits, deletions, sync, close)
  const valid = new Set();
  if (st.selected.size > 0) for (const g of groups) {
    if (Array.isArray(g.windows)) g.windows.forEach((w, wi) => {
      for (let i = 0; i < w.refs.length; i += 1) valid.add(rowKeyW(g.id, wi, i));
    });
    else for (let i = 0; i < rowCountOf(g); i += 1) valid.add(keyFor(g, i));
  }
  for (const k of [...st.selected]) if (!valid.has(k)) st.selected.delete(k);
  root.classList.toggle("has-multiple-selection", st.selected.size > 1);

  // U6: every selectable row's KEY, in render order — multi-window groups
  // (sessions) yield composite keys; immutable groups (snapshots) yield none.
  const eachSelectable = (fn) => {
    if (selectable !== "tab") return;
    for (const g of displayGroups) {
      if (isImmutableGroup(g, immutable)) continue;
      if (Array.isArray(g.windows)) g.windows.forEach((w, wi) => w.refs.forEach((_, i) => fn(rowKeyW(g.id, wi, i))));
      else for (let i = 0; i < rowCountOf(g); i += 1) {
        if (visibleAt(g, i) && selectionSelectableAt(g, i)) fn(keyFor(g, i));
      }
    }
  };
  const totalSelectable = selectionCount
    ? groups.reduce((count, group) => count + Number(selectionCount(group) || 0), 0)
    : (() => { let count = 0; eachSelectable(() => count++); return count; })();
  // N14: shift+click selects the visual range from the anchor (the last row
  // selected on its own) to the clicked row — standard list-selection idiom.
  // Keys are collected in render order, so the range IS the visual range.
  let orderedKeys = null;
  const currentOrderedKeys = () => {
    if (orderedKeys) return orderedKeys;
    orderedKeys = [];
    eachSelectable((key) => orderedKeys.push(key));
    return orderedKeys;
  };
  if (st.anchor || st.rangeEnd) currentOrderedKeys();
  const initialOrderedKeys = orderedKeys ?? [];
  if (st.anchor && !initialOrderedKeys.includes(st.anchor)) st.anchor = null;
  if (st.rangeEnd && !initialOrderedKeys.includes(st.rangeEnd)) st.rangeEnd = null;
  const noteKeeperTrigger = () => {
    st.keeperMotionAllowed = !document.activeElement?.matches?.(":focus-visible");
  };
  const rangeTo = (key) => {
    const keys = currentOrderedKeys();
    const a = keys.indexOf(st.anchor ?? "");
    const b = keys.indexOf(key);
    if (a < 0 || b < 0) return false;
    const span = keys.slice(Math.min(a, b), Math.max(a, b) + 1);
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
    commitSelectionDom();
    return true;
  };
  const selection = () => {
    const out = [];
    for (const g of displayGroups) {
      if (Array.isArray(g.windows)) {
        // U6: multi-window groups (sessions) report per-window picks
        const picks = g.windows
          .map((w, wi) => ({ windowIndex: wi,
            indexes: w.refs.map((_, i) => i).filter((i) => st.selected.has(rowKeyW(g.id, wi, i))) }))
          .filter((p) => p.indexes.length);
        if (picks.length) out.push({ group: g, picks });
      } else {
        const indexes = [];
        for (let i = 0; i < rowCountOf(g); i += 1) {
          if (visibleAt(g, i) && st.selected.has(keyFor(g, i))) indexes.push(i);
        }
        if (indexes.length) out.push({ group: g, indexes });
      }
    }
    return out;
  };
  /** Tabs in a selection entry, flat or per-window. */
  const entryCount = (s) =>
    (s.indexes?.length ?? 0) + (s.picks?.reduce((n, p) => n + p.indexes.length, 0) ?? 0);
  const clear = () => {
    st.selected.clear();
    commitSelectionDom();
    // `clear` is handed to completed bulk mutations as well as selection UI.
    // Their underlying tabs/records may have changed, so retain the canonical
    // data reconciliation after the immediate local selection commit.
    onChange();
  };
  /** Resolve fresh definitions; visibility and per-row predicates stay with rendering. */
  function resolveGroupActionSets(group) {
    return {
      row: resolveActions(rowActions, group),
      group: resolveActions(groupActions, group),
      window: resolveActions(windowActions, group)
    };
  }
  // Shortcut discovery and the first render share definitions. Later card
  // renders resolve again so changed group data and localized copy stay fresh.
  const initialActionSets = new Map();
  const shortcutByActionId = new Map();
  for (const group of displayGroups) {
    const actions = resolveGroupActionSets(group);
    initialActionSets.set(group, actions);
    for (const action of [
      ...actions.row, ...actions.group, ...actions.window
    ]) {
      if (action?.id && action?.key && !shortcutByActionId.has(action.id)) {
        shortcutByActionId.set(action.id, action.key);
      }
    }
  }
  const firstShortcut = (...ids) => ids.map((id) => shortcutByActionId.get(id)).find(Boolean);
  if (!shortcutByActionId.has("inbox")) {
    shortcutByActionId.set("inbox", firstShortcut("dump", "dump-window"));
  }
  if (!shortcutByActionId.has("restore")) {
    shortcutByActionId.set("restore",
      firstShortcut("restore-tab", "restore-all", "open-all", "switch", "wake"));
  }
  if (!shortcutByActionId.has("session")) {
    shortcutByActionId.set("session", firstShortcut("save-session", "add-session") ?? "t");
  }
  if (!shortcutByActionId.has("label")) {
    shortcutByActionId.set("label", firstShortcut("label-window", "label-session", "label-all"));
  }
  if (!shortcutByActionId.has("snooze")) {
    shortcutByActionId.set("snooze", firstShortcut("snooze-window", "snooze-session"));
  }
  if (!shortcutByActionId.has("delete")) {
    shortcutByActionId.set("delete", firstShortcut("delete-all", "remove", "unlabel", "cancel"));
  }
  const prepareBulkAction = (node, panel) => {
    if (!(node instanceof HTMLElement)) return node;
    const target = node.matches("button,[role='button']")
      ? node
      : node.querySelector("[data-action-id],button,[role='button']");
    if (!(target instanceof HTMLElement)) return node;
    const id = node.dataset.bulkAction || target.dataset.bulkAction ||
      node.dataset.actionId || target.dataset.actionId;
    if (!id) return node;
    if (!target.dataset.bulkAction) target.dataset.bulkAction = id;
    const key = shortcutByActionId.get(id);
    if (key) decorateShortcutTip(target, key);
    // Bulk controls can be invoked while focus sits on a card header or body.
    // Capture the visible control before its handler builds a palette so the
    // palette never falls back to the card or page position.
    target.addEventListener("click", () => panel?.anchor(target), true);
    return node;
  };

  /* ---- bulk bar (ListShell) ---- */
  let bulkSelection = [];
  let bulkCount = 0;
  let headerBulkGroupId = null;
  /** @type {TabListGroupSelectionOwner[]} */
  const groupSelectionOwners = [];
  /** @type {TabListWindowSelectionOwner[]} */
  const windowSelectionOwners = [];
  let keeperNodes = [];

  const refreshBulkState = () => {
    if (selectable !== "tab" || !bulkActions) return;
    bulkSelection = selection();
    bulkCount = bulkSelection.reduce((n, s) => n + entryCount(s), 0);
    headerBulkGroupId = bulkCount > 0 && bulkSelection.length === 1
      ? bulkSelection[0].group.id
      : null;
  };

  const buildKeeper = () => {
    if (selectable !== "tab" || !bulkActions) return [];
    const keeperVisible = bulkCount > 0 && !headerBulkGroupId;
    const keeperEntering = keeperVisible && !st.keeperVisible && st.keeperMotionAllowed;
    st.keeperVisible = keeperVisible;
    st.keeperMotionAllowed = false;
    const master = el("input", { type: "checkbox", class: "tip",
      "aria-label": msg("list_select_all_none"), title: msg("list_select_all_none") });
    master.checked = bulkCount > 0 && bulkCount === totalSelectable;
    master.indeterminate = bulkCount > 0 && bulkCount < totalSelectable;
    master.addEventListener("change", () => {
      noteKeeperTrigger();
      if (master.checked) eachSelectable((key) => st.selected.add(key));
      else st.selected.clear();
      commitSelectionDom();
    });
    // F29: the keeper's panel slot is identified by its OWN marker, never by
    // "the div after a .bulk-bar". A static section toolbar may also carry
    // .bulk-bar (Duplicates, Smart views, Data), and sibling-shape matching
    // used to fix the first following block to the viewport.
    const panelSlot = el("div", { class: "keeper-panel-slot" });
    const bar = el("div", {
      class: `bulk-bar${keeperVisible ? " has-selection" : " is-empty"}${keeperEntering ? " keeper-enter" : ""}`,
      role: "toolbar",
      "aria-label": bulkCount > 0
        ? msg("list_selection_actions", [selectionSummary(bulkCount, bulkSelection.length)])
        : bulkHint
    }, master,
      el("span", { class: "keeper-count" }, bulkCount === 0 ? bulkHint : selectionSummary(bulkCount, bulkSelection.length)));
    if ((bulkCount > 0 && !headerBulkGroupId) || bulkAlways) {
      const ctx = { selection: bulkSelection, count: bulkCount, clear, rerender: onChange, panel: slotPanel(panelSlot) };
      for (const n of bulkActions(ctx)) if (n) bar.append(prepareBulkAction(n, ctx.panel));
    }
    return [bar, panelSlot];
  };

  /** @param {TabListGroupSelectionOwner} owner */
  const buildGroupActionLane = (owner) => {
    const { g, grpActs, gctx, grpFocus, grpSlot } = owner;
    const lane = el("span", { class: "gacts" });
    if (headerBulkGroupId === g.id) {
      lane.classList.add("header-bulk-actions");
      lane.setAttribute("role", "toolbar");
      lane.setAttribute("aria-label", msg("list_selected_tabs_actions", [String(bulkCount)]));
      lane.append(el("span", { class: "header-bulk-count" },
        msg("list_selected_count", [String(bulkCount)])));
      const bulkCtx = {
        selection: bulkSelection, count: bulkCount, clear, rerender: onChange,
        panel: slotPanel(grpSlot)
      };
      for (const node of bulkActions(bulkCtx)) {
        if (node) lane.append(prepareBulkAction(node, bulkCtx.panel));
      }
    } else {
      for (const action of grpActs) lane.append(groupActionNode(action, gctx, grpFocus));
    }
    return lane;
  };

  /** @param {TabListWindowSelectionOwner} owner */
  const buildWindowActionLane = (owner) => {
    const { g, w, wi, winActs } = owner;
    const lane = el("span", { class: "gacts" });
    for (const action of winActs) {
      lane.append(groupActionNode(action, {
        group: g, window: w, windowIndex: wi, rerender: onChange
      }));
    }
    return lane;
  };

  /**
   * @param {TabListSelectionHeaderOwner} owner
   * @param {HTMLElement} next
   */
  const replaceActionLane = (owner, next) => {
    if (owner.actionLane?.isConnected || owner.actionLane?.parentNode) {
      if (next.childNodes.length) owner.actionLane.replaceWith(next);
      else owner.actionLane.remove();
    } else if (next.childNodes.length) {
      owner.head.append(next);
    }
    owner.actionLane = next.childNodes.length ? next : null;
  };

  const selectedCountFor = (keys) => {
    let count = 0;
    for (const key of keys) if (st.selected.has(key)) count += 1;
    return count;
  };

  /**
   * @param {TabListSelectionHeaderOwner} owner
   * @param {boolean} [isBulk]
   */
  const updateHeaderLaneAvailability = (owner, isBulk = false) => {
    setActionLaneAvailability(owner.actionLane, st.selected.size <= 1 || isBulk);
  };

  const reconcileSelectionHeadersAndKeeper = () => {
    refreshBulkState();
    const active = document.activeElement;
    const keeperFocus = keeperNodes[0]?.contains?.(active)
      ? (active?.dataset?.bulkAction ? `[data-bulk-action="${active.dataset.bulkAction}"]` : 'input[type="checkbox"]')
      : null;
    const previousKeeperNodes = keeperNodes;
    keeperNodes = buildKeeper();
    if (previousKeeperNodes.length === keeperNodes.length) {
      previousKeeperNodes.forEach((node, index) => node.replaceWith(keeperNodes[index]));
    } else {
      previousKeeperNodes.forEach((node) => node.remove());
      root.append(...keeperNodes);
    }
    if (keeperFocus) keeperNodes[0]?.querySelector(keeperFocus)?.focus({ preventScroll: true });

    for (const owner of groupSelectionOwners) {
      if (owner.checkbox) {
        const count = selectedCountFor(owner.keys);
        owner.checkbox.checked = count > 0 && count === owner.total;
        owner.checkbox.indeterminate = count > 0 && count < owner.total;
      }
      const shouldBulk = headerBulkGroupId === owner.g.id;
      // A local one-window toolbar stays in the same position as selection
      // grows, but its callbacks must receive the NEW selection. Rebuild only
      // that one small lane; every row and unaffected header remains mounted.
      if (shouldBulk || owner.isBulk !== shouldBulk) {
        replaceActionLane(owner, buildGroupActionLane(owner));
        owner.isBulk = shouldBulk;
      }
      updateHeaderLaneAvailability(owner, shouldBulk);
    }
    for (const owner of windowSelectionOwners) {
      if (owner.checkbox) {
        const count = selectedCountFor(owner.keys);
        owner.checkbox.checked = count > 0 && count === owner.keys.length;
        owner.checkbox.indeterminate = count > 0 && count < owner.keys.length;
      }
      updateHeaderLaneAvailability(owner);
    }
  };

  refreshBulkState();
  keeperNodes = buildKeeper();
  if (keeperNodes.length) root.append(...keeperNodes);

  /* ---- groups ---- */
  const shownGroups = st.sectionExpanded ? displayGroups : displayGroups.slice(0, groupCap);
  const visibleRowCaps = allocateInitialRowCaps(shownGroups, rowCap, initialRowBudget);
  for (const g of shownGroups) {
    root.append(renderGroup(g, initialActionSets.get(g)));
    if (betweenZone) {
      const z = betweenZone(g);
      if (z) {
        // The visible destination is absolutely positioned inside this
        // zero-height boundary anchor. Revealing it can never push later
        // cards, while its centre remains exactly between the two groups.
        root.append(el("div", { class: "drop-zone-new-anchor" }, z));
      }
    }
  }
  // Do not retain unused definitions for capped groups in later fold handlers.
  initialActionSets.clear();
  if (displayGroups.length > groupCap) {
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
        : msg("list_show_all_items", [String(displayGroups.length)]))));
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

  if (config.openPlacement === true) OPEN_PLACEMENT_OWNERS.set(root, (nextGroups) => {
    if (!root.isConnected || anchoredPanelOpenWithin(root) || rowVisible || shownGroups.length !== groups.length ||
        nextGroups.length !== groups.length || groups.length === 0) return false;
    const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const without = (value, keys) => Object.fromEntries(Object.entries(value)
      .filter(([key]) => !keys.includes(key)));
    const plans = [];
    const now = Date.now();
    let changed = false;
    const seen = new Set();
    for (let n = 0; n < groups.length; n += 1) {
      const group = groups[n], next = nextGroups[n];
      if (group.kind !== "openwindow" || next.kind !== "openwindow" ||
          group.windows || next.windows || group.loose || next.loose ||
          st.folded.has(group.id) || !Array.isArray(group.data?.tabs) || !Array.isArray(next.data?.tabs) ||
          group.live.length !== next.live.length ||
          !equal(without(group, ["refs", "live", "searchText", "data"]),
            without(next, ["refs", "live", "searchText", "data"])) ||
          !equal(without(group.data, ["tabs"]), without(next.data, ["tabs"]))) return false;
      const oldIndexes = new Map(group.live.map((live, index) => [live.tabId, index]));
      const oldTabs = new Map(group.data.tabs.map(tab => [tab.id, tab]));
      if (oldIndexes.size !== group.live.length || oldTabs.size !== group.live.length ||
          next.data.tabs.length !== next.live.length) return false;
      const pairs = [];
      for (let index = 0; index < next.live.length; index += 1) {
        const live = next.live[index], oldIndex = oldIndexes.get(live.tabId);
        if (seen.has(live.tabId) || oldIndex === undefined || live.tabGroup || group.live[oldIndex].tabGroup) return false;
        seen.add(live.tabId);
        const key = keyFor(group, oldIndex), pair = placementRows.get(key);
        const raw = next.data.tabs[index], oldRaw = oldTabs.get(live.tabId);
        if (!pair || !root.contains(pair.row) || pair.row.parentNode !== pair.body ||
            pair.slot.parentNode !== pair.body || pair.row._tlRow.ctx.group !== group ||
            key !== keyFor(next, index) || raw?.id !== live.tabId ||
            !equal(without(group.live[oldIndex], ["chromeIndex"]), without(live, ["chromeIndex"])) ||
            !equal(without(oldRaw, ["index"]), without(raw, ["index"])) ||
            !equal(group.refs[oldIndex], next.refs[index]) ||
            group.searchText?.[oldIndex] !== next.searchText?.[index]) return false;
        // Unchanged timestamps can cross a display boundary. Let a fresh
        // render update derived copy rather than retaining an obsolete age.
        if (pair.recency && pair.recency.textContent !== compactRelativeAge(rowRecencyTimestamp(pair.row._tlRow.ctx), now)) return false;
        changed ||= oldIndex !== index;
        pairs.push({ ...pair, raw: oldRaw, index, live, ref: next.refs[index] });
      }
      plans.push({ group, next, pairs });
    }
    // Every preflight above precedes mutation. Caps, live groups, folds and
    // structural changes use the normal render rather than a partial update.
    const active = document.activeElement;
    for (const { group, next, pairs } of plans) {
      const data = group.data;
      for (const pair of pairs) pair.raw.index = next.data.tabs[pair.index].index;
      data.tabs = pairs.map(pair => pair.raw);
      Object.assign(group, next, { data });
      for (const { row, index, live, ref } of pairs) Object.assign(row._tlRow.ctx, { index, live, ref });
      const body = pairs[0]?.body;
      if (!body) continue;
      let position = 0;
      for (const { row, slot } of pairs) for (const node of [row, slot]) {
        if (body.childNodes[position] !== node) body.insertBefore(node, body.childNodes[position] ?? null);
        position += 1;
      }
    }
    if (changed) {
      orderedKeys = null;
      if (st.selected.size > 0) commitSelectionDom();
    }
    if (active && root.contains(active) && document.activeElement !== active) active.focus({ preventScroll: true });
    return true;
  });

  return root;

  /** @param {TabListGroup} g @param {TabListActionSets} [actions] */
  function renderGroup(g, actions = resolveGroupActionSets(g)) {
    const isImm = isImmutableGroup(g, immutable);
    // action sets may be a static array or a per-group function (e.g. Inbox:
    // window bundles and loose tabs get different header actions).
    const rowActs = rowActionsFor(actions.row, isImm);
    const grpActs = visibleGroupActions(actions.group, isImm);
    const winActs = visibleGroupActions(actions.window, isImm);
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
        const block = renderWindowBlock(g, w, wi, rowActs, winActs, sel);
        const shell = el("div", { class: "window-block-shell" }, block);
        if (windowEndZone && !isImm) {
          const end = windowEndZone(g, w, wi);
          if (end) block.append(el("div", { class: "drop-zone-window-end-anchor" }, end));
        }
        if (windowGap && !isImm) {
          const z = windowGap(g, wi);
          if (z) {
            shell.append(el("div", { class: "drop-zone-new-anchor" }, z));
          }
        }
        body.append(shell);
      });
    } else {
      const initialCap = visibleRowCaps.get(g.id) ?? rowCap;
      const expanded = st.expanded.has(g.id);
      const matchingIndexes = visibleIndexes(g);
      const shown = expanded ? matchingIndexes.length : Math.min(initialCap, matchingIndexes.length);
      const shownIndexes = matchingIndexes.slice(0, shown);
      const rowGroups = new Map();
      const rowGroupCounts = new Map();
      if (rowGroup) {
        for (const i of matchingIndexes) {
          const descriptor = normalizeRowGroup(rowGroup(g, i));
          if (!descriptor) continue;
          rowGroups.set(i, descriptor);
          rowGroupCounts.set(descriptor.key, (rowGroupCounts.get(descriptor.key) ?? 0) + 1);
        }
      }
      for (let position = 0; position < shownIndexes.length; position += 1) {
        const i = shownIndexes[position];
        const descriptor = rowGroups.get(i) ?? null;
        const previous = position > 0 ? rowGroups.get(shownIndexes[position - 1]) : null;
        const next = position + 1 < shownIndexes.length
          ? rowGroups.get(shownIndexes[position + 1])
          : null;
        if (descriptor && descriptor.key !== previous?.key) {
          body.append(buildOpenTabGroupHead(descriptor, rowGroupCounts.get(descriptor.key) ?? 1));
        }
        const slot = el("div", {});
        const ctx = rowCtx(g, null, null, i, g.refs[i], slot, sel);
        const on = sel === "tab" && selectableAt(g, i);
        const row = buildTabRow(ctx, keyFor(g, i), rowActs, on, sel === "tab" && !on);
        if (descriptor) {
          decorateOpenTabGroupNode(row, descriptor);
          decorateOpenTabGroupNode(slot, descriptor);
          slot.classList.add("open-tab-group-slot");
          if (descriptor.key !== next?.key) {
            row.setAttribute("data-live-tab-group-end", "");
            slot.setAttribute("data-live-tab-group-end", "");
          }
        }
        if (placementRows) placementRows.set(keyFor(g, i), { row, slot, body, recency: row.querySelector(".row-recency") });
        body.append(row, slot);
      }
      if (!folded && !isImm && groupEndZone) {
        endZone = groupEndZone(g);
        if (endZone) body.append(endZone);
      }
      if (matchingIndexes.length > initialCap) {
        body.append(moreBtn(g.id, matchingIndexes.length - initialCap, expanded, body));
      }
    }

    if (g.loose) return body; // bare rows, no card wrapper

    const head = el("div", { class: "item-head" });
    /* F47r (MH's pick, option D): the card's own name area IS the fold control,
     * so no glyph is added to a header that already carries a checkbox and an
     * action lane. Folding COMPRESSES rather than hides: a folded card shows
     * its tabs' favicons, so it still answers "what is in here". Past the strip
     * cap the count says it in words instead, which is option B's wording.
     * Only this explicit disclosure animates; ordinary list renders stay instant. */
    const toggleFold = () => {
      const before = head.getBoundingClientRect().top;
      const fromHeight = card.getBoundingClientRect().height;
      const restoreFocus = card.contains(document.activeElement);
      const closing = !st.folded.has(g.id);
      const outgoing = closing ? card.querySelector(".item-body-frame")?.cloneNode(true) : null;
      finishDisclosure(card);
      closing ? st.folded.add(g.id) : st.folded.delete(g.id);
      let next;
      try { next = renderGroup(g); }
      catch (error) {
        closing ? st.folded.delete(g.id) : st.folded.add(g.id);
        throw error;
      }
      card.replaceWith(next);
      // The old body is a visual copy only. Remove duplicate identities and
      // immediately exclude it from pointer, keyboard, and assistive access.
      if (outgoing) {
        outgoing.inert = true;
        outgoing.setAttribute("aria-hidden", "true");
        outgoing.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
        outgoing.style.position = "absolute";
        outgoing.style.top = `${next.querySelector(".item-head-shell").offsetHeight}px`;
        outgoing.style.insetInline = "0";
        outgoing.style.pointerEvents = "none";
        next.append(outgoing);
      }
      animateDisclosure(next, () => {}, {
        fromHeight,
        afterFinish: () => {
          outgoing?.remove();
          if (next.isConnected) holdCardInPlace(g.id, before);
        }
      });
      if (restoreFocus) next.querySelector(".item-head-toggle")?.focus({ preventScroll: true });
      holdCardInPlace(g.id, before);
    };
    // group select-all reflects only the SELECTABLE rows (Open tabs: http tabs).
    // U6: on a multi-window group (session card) it spans every window's rows.
    let selCnt = 0, selTotal = 0;
    let groupKeys = null;
    const getGroupKeys = () => {
      if (groupKeys) return groupKeys;
      groupKeys = [];
      if (multiWin) g.windows.forEach((w, wi) => {
        for (let i = 0; i < w.refs.length; i += 1) groupKeys.push(rowKeyW(g.id, wi, i));
      });
      else for (let i = 0; i < rowCountOf(g); i += 1) {
        if (visibleAt(g, i) && selectionSelectableAt(g, i)) groupKeys.push(keyFor(g, i));
      }
      return groupKeys;
    };
    if (sel === "tab") {
      selTotal = !multiWin && selectionCount && !rowVisible
        ? Number(selectionCount(g) || 0)
        : getGroupKeys().length;
      if (st.selected.size > 0) {
        for (const k of getGroupKeys()) if (st.selected.has(k)) selCnt++;
      }
    }
    let toggleGroup = null;
    let headCb = null;
    if (sel === "tab" && selTotal > 0) {
      headCb = el("input", { type: "checkbox", "aria-label": msg("list_select_all_named", [g.title]) });
      headCb.checked = selCnt > 0 && selCnt === selTotal;
      headCb.indeterminate = selCnt > 0 && selCnt < selTotal;
      toggleGroup = () => {
        noteKeeperTrigger();
        const all = selectedCountFor(getGroupKeys()) === selTotal;
        for (const k of getGroupKeys()) all ? st.selected.delete(k) : st.selected.add(k);
        commitSelectionDom();
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
    const groupSupplementNode = groupSupplement ? groupSupplement(g) : null;
    if (groupSupplementNode) head.append(groupSupplementNode);

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
    const selectionOwner = {
      g, head, checkbox: headCb, keys: getGroupKeys(), total: selTotal,
      grpActs, gctx, grpFocus, grpSlot, actionLane: null,
      isBulk: headerBulkGroupId === g.id
    };
    const grpActionLane = buildGroupActionLane(selectionOwner);
    selectionOwner.actionLane = grpActionLane.childNodes.length ? grpActionLane : null;
    updateHeaderLaneAvailability(selectionOwner, selectionOwner.isBulk);
    if (grpActionLane.childNodes.length) head.append(grpActionLane);
    groupSelectionOwners.push(selectionOwner);
    installHeaderFocusWalk(head);

    // group-level drag drop socket (e.g. drop a tab onto a window header)
    if (onGroupDrop) {
      head.addEventListener("dragover", (e) => onGroupDragOver?.(g, e));
      head.addEventListener("dragleave", (e) => onGroupDragLeave?.(g, e));
      head.addEventListener("drop", (e) => onGroupDrop(g, e));
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
    const windowKeys = w.refs.map((_, i) => rowKeyW(g.id, wi, i));
    let wCb = null;
    // U6: per-window select-all (sessions) — mirrors the flat group-header one
    if (sel === "tab") {
      const selCnt = selectedCountFor(windowKeys);
      wCb = el("input", { type: "checkbox", "aria-label": msg("list_select_all_named", [w.meta]) });
      wCb.checked = selCnt > 0 && selCnt === w.refs.length;
      wCb.indeterminate = selCnt > 0 && selCnt < w.refs.length;
      wCb.addEventListener("change", () => {
        noteKeeperTrigger();
        const all = selectedCountFor(windowKeys) === windowKeys.length;
        for (const rowKey of windowKeys) all ? st.selected.delete(rowKey) : st.selected.add(rowKey);
        commitSelectionDom();
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
    const selectionOwner = {
      g, w, wi, head: wHead, checkbox: wCb, keys: windowKeys, winActs, actionLane: null
    };
    const winActionLane = buildWindowActionLane(selectionOwner);
    selectionOwner.actionLane = winActionLane.childNodes.length ? winActionLane : null;
    updateHeaderLaneAvailability(selectionOwner);
    if (winActionLane.childNodes.length) wHead.append(winActionLane);
    windowSelectionOwners.push(selectionOwner);
    installHeaderFocusWalk(wHead);
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
      "data-disclosure-key": key,
      "aria-expanded": expanded ? "true" : "false",
      onclick: () => {
        const before = expanded ? btn.getBoundingClientRect().top : null;
        expanded ? st.expanded.delete(key) : st.expanded.add(key);
        const changed = onChange();
        if (before != null) {
          Promise.resolve(changed).then(() =>
            holdDisclosureInPlace(section, key, before));
        }
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
        commitSelectionDom();
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
    const visibleActs = rowActs.filter((a) => !a.when || a.when(ctx));
    // P2g-2r: `hidden` actions keep their keyboard binding (byKey below) but
    // render no button — for verbs the title click already performs.
    // Keep controls mounted through a refresh while selection suppresses them.
    // Local deselection restores availability without another data refresh.
    const shownActs = visibleActs.filter((a) => !a.hidden);
    const rowMetaNode = rowMeta
      ? el("span", { class: "item-meta" }, rowMeta(ref, ctx.group, ctx.index))
      : null;
    const row = el("div", { class: `trow${isSel ? " sel" : ""}${withCheckbox ? " selrow" : ""}`, "data-tablist-row": key },
      el("span", { class: "row-select-slot" }, cb),
      tabFavicon(ref),
      el("span", { class: "row-copy" },
        el("span", { class: "t" },
          ...(badges || []),
          el("a", { href: ref.url, target: "_blank", rel: "noreferrer",
            onclick: rowOpen ? (e) => { e.preventDefault(); rowOpen(ctx); } : null }, ref.title || ref.url)),
        el("span", { class: "row-subline" },
          ctx.live?.currentSurface ? el("span", {
            class: "surface-tab-state",
            title: msg("list_this_tab_title"),
            "data-tip": msg("list_this_tab_title")
          }, msg("list_this_tab")) : null,
          ref.pinned ? el("span", { class: "pinned-state", title: msg("list_pinned_tab"),
            "data-tip": msg("list_pinned_tab") }, msg("list_pinned")) : null,
          rowSessionMembershipsNode(ctx),
          el("span", { class: "host" }, host),
          rowMetaNode,
          rowRecencyNode(ctx),
          rowSupplement ? rowSupplement(ctx) : null)),
      // chips sit OUTSIDE .t — its ellipsis overflow would clip them after any
      // long title (the 0.8.22 "chips only show on short titles" bug)
      el("span", { class: "row-chip-slot" }, rowChipsNode(ctx, key)),
      el("span", { class: "tacts" },
        ...shownActs.map((a) => rowActionNode(a, ctx, markRowFocus)))
    );
    setActionLaneAvailability(row.querySelector(".tacts"), st.selected.size <= 1);
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
    // actions). Escape returns from an action lane to the row entry control.
    row.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Escape") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
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

  function normalizeRowGroup(group) {
    if (!group || group.id == null) return null;
    const suppliedTitle = typeof group.title === "string" ? group.title.trim() : "";
    return {
      key: String(group.id),
      title: suppliedTitle || msg("list_group_fallback"),
      named: Boolean(suppliedTitle)
    };
  }

  function decorateOpenTabGroupNode(node, group) {
    node.setAttribute("data-live-tab-group", group.key);
  }

  function buildOpenTabGroupHead(group, count) {
    const heading = group.named
      ? msg("list_tab_group_named", [group.title])
      : group.title;
    const supplement = rowGroupSupplement ? rowGroupSupplement(group) : null;
    const head = el("div", { class: "open-tab-group-head" },
    el("span", {
      class: "open-tab-group-copy",
      role: "heading",
      "aria-level": "3",
      "aria-label": msg("list_group_chip_count", [group.title, String(count)])
    },
      el("span", { class: "open-tab-group-name" }, heading),
      el("span", { class: "open-tab-group-count" }, listUnit("tab", count))),
    supplement);
    decorateOpenTabGroupNode(head, group);
    return head;
  }

  function rowRecencyTimestamp(ctx) {
    const data = ctx.group?.data ?? {};
    return ctx.live?.lastAccessed ?? ctx.ref?.modifiedAt ??
      data.modifiedAt ?? data.archivedAt ?? data.createdAt ?? data.dueAt;
  }

  function rowRecencyNode(ctx) {
    const ts = rowRecencyTimestamp(ctx);
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
      ".row-select-slot input:not([disabled]), .row-copy a[href], .row-copy button:not([disabled]), " +
      ".row-chip-slot button:not([disabled]), .row-chip-slot a[href], " +
      ".tacts button:not([disabled])"
    )].filter((node) => node.offsetParent !== null && node.tabIndex !== -1);
  }

  /** Headers use the same left-to-right keyboard grammar as tab rows. */
  function installHeaderFocusWalk(head) {
    const targets = () => [...head.querySelectorAll(
      'input:not([disabled]), button:not([disabled]), a[href]'
    )].filter((node) => node.offsetParent !== null && node.tabIndex !== -1);
    head.addEventListener("keydown", (event) => {
      if (isComposingKey(event)) return;
      if (!["ArrowRight", "ArrowLeft", "Escape"].includes(event.key) ||
          event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const controls = targets();
      const index = controls.indexOf(event.target);
      if (index < 0) return;
      if (event.key === "Escape") {
        if (index > 0) {
          event.preventDefault();
          event.stopPropagation();
          controls[0].focus({ preventScroll: true });
        }
        return;
      }
      const next = controls[index + (event.key === "ArrowRight" ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      next.focus({ preventScroll: true });
    });
  }

  /**
   * P2g-2 (N11): per-tab label chips on the row — ALWAYS visible. The CSS
   * container tier shows 2/3/4/6/8 named labels as room grows, with the matching
   * real "+N" button. Expanding remains an explicit per-row choice.
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
    const shown = open ? labels : labels.slice(0, ROW_CHIP_MAX);
    const tabName = ctx.ref.title || ctx.ref.url;
    const span = el("span", { class: `chips rowchips${open ? " is-expanded" : ""}` });
    for (const [index, name] of shown.entries()) {
      const chip = el("span", {
        class: "chip", "data-chip-index": String(index + 1)
      }, chipText(name));
      if (onRowChipRemove && !isImm) {
        chip.append(el("button", { class: "x", type: "button",
          "aria-label": msg("list_remove_label_from_tab", [name, tabName]),
          onclick: (e) => { e.stopPropagation(); onRowChipRemove(ctx, name); } }, "×"));
      }
      span.append(chip);
    }
    if (labels.length > ROW_CHIP_CAPS[0]) {
      const appendToggle = (className, cap, text, first = false) => {
        const toggle = el("button", {
        class: `chip more ${className}`, type: "button",
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
        } }, text);
        first ? span.prepend(toggle) : span.append(toggle);
      };
      if (open) {
        appendToggle("collapse-labels", labels.length, "−", true);
      } else {
        for (const cap of ROW_CHIP_CAPS) {
          if (labels.length <= cap) continue;
          appendToggle(`more-at-${cap}`, cap, `+${labels.length - cap}`);
        }
      }
    }
    return span;
  }

  /** Session membership is row context, like Pinned and This tab, rather than
   * a label chip. Keep the stable Session id on the link while the compact
   * visual copy remains one readable metadata phrase. */
  function rowSessionMembershipsNode(ctx) {
    const sessions = (ctx.ref?.sessionMemberships ?? [])
      .filter((entry) => entry?.id && entry?.name);
    if (!sessions.length) return null;
    const membership = el("span", {
      class: "session-memberships",
      title: sessions.map((entry) => entry.name).join(", ")
    }, el("span", { class: "session-membership-prefix" },
      msg(sessions.length === 1 ? "list_in_session" : "list_in_sessions")));
    sessions.forEach((entry, index) => {
      if (index) membership.append(document.createTextNode(", "));
      membership.append(onSessionOpen
        ? el("button", { class: "session-membership-link", type: "button",
          "aria-label": msg("list_show_session", [entry.name]),
          onclick: (event) => { event.stopPropagation(); onSessionOpen(entry.id); } }, entry.name)
        : el("span", { class: "session-membership-name" }, entry.name));
    });
    return membership;
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
 * @param {string} cardId
 * @param {number} before viewport top before the render
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

/** Keep a collapsing Show fewer control on the same viewport axis. */
function holdDisclosureInPlace(section, key, before) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const root = [...document.querySelectorAll("[data-tablist]")]
    .find((node) => node.getAttribute("data-tablist") === section);
  const button = [...(root?.querySelectorAll("[data-disclosure-key]") ?? [])]
    .find((node) => node.getAttribute("data-disclosure-key") === key);
  if (!button) return;
  const delta = button.getBoundingClientRect().top - before;
  if (Math.abs(delta) > 0.5) window.scrollBy(0, delta);
}

/** F47r: how many favicons a folded card shows before it says it in words. */
const FOLD_STRIP_CAP = 8;

/** A meaningful, scheme-aware identity remains if Chrome has no cached icon. */
function faviconFallback(ref) {
  let protocol = "";
  let host = "";
  try {
    const parsed = new URL(ref.url);
    protocol = parsed.protocol;
    host = parsed.hostname.replace(/^www\./i, "");
  } catch { /* the generic browser fallback below remains valid */ }

  if (protocol === "http:" || protocol === "https:") {
    const initial = (host.match(/[\p{L}\p{N}]/u)?.[0] ?? ref.title?.trim()?.[0] ?? "?")
      .toLocaleUpperCase();
    return el("span", {
      class: "fv-placeholder fv-site",
      "data-fallback-kind": "site",
      "aria-hidden": "true"
    }, initial);
  }
  if (protocol === "file:") {
    return el("span", {
      class: "fv-placeholder",
      "data-fallback-kind": "file",
      "aria-hidden": "true"
    }, icon("file", 14));
  }
  return el("span", {
    class: "fv-placeholder",
    "data-fallback-kind": "browser",
    "aria-hidden": "true"
  }, icon("open", 14));
}

/** Prefer captured identity, then Chrome's cache, then the local fallback. */
function tabFavicon(ref) {
  const fallback = faviconFallback(ref);
  const cachedSource = cachedFaviconUrl(ref.url);
  const source = faviconSource(ref);
  if (!source) return fallback;
  let canTryCache = Boolean(source && cachedSource && source !== cachedSource);
  const image = el("img", {
    class: "fv",
    src: source,
    alt: "",
    "data-favicon-source": source === cachedSource ? "cache" : "captured",
    onerror: () => {
      if (canTryCache) {
        canTryCache = false;
        image.dataset.faviconSource = "cache";
        image.src = cachedSource;
        return;
      }
      image.replaceWith(fallback);
    }
  });
  return image;
}

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
    strip.append(tabFavicon(ref));
  }
  return el("span", { class: "fold-summary" }, strip,
    el("span", { class: "fold-count" }, listUnit("tab", refs.length)));
}

/* =============================== rendering bits =============================== */

function rowActionNode(a, ctx, onAct = null) {
  if (a.render) {
    const rendered = a.render(ctx);
    if (a.id && rendered instanceof HTMLElement && !rendered.dataset.actionId) {
      rendered.dataset.actionId = a.id;
    }
    if (a.key) decorateShortcutTip(rendered, a.key);
    return rendered;
  }
  const short = shortActionLabel(a);
  const accessibleLabel = a.title ?? a.label;
  const tip = shortcutTip(accessibleLabel, a.key);
  return el("button", { class: `mini ${a.danger ? "danger" : "iconbtn"}`, title: tip, "aria-label": accessibleLabel,
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
    if (a.id && rendered instanceof HTMLElement && !rendered.dataset.actionId) {
      rendered.dataset.actionId = a.id;
    }
    if (a.key) decorateShortcutTip(rendered, a.key);
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
  const accessibleLabel = a.title ?? a.label;
  const tip = shortcutTip(accessibleLabel, a.key);
  return el("button", { class: `mini${a.danger ? " danger" : ""}`, title: tip, "aria-label": accessibleLabel,
    "data-action-id": a.id,
    // Window headers have direct actions but no anchored panel slot. Capture an
    // anchor when that owner exists; never prevent a panel-free action such as
    // Restore window from reaching its domain operation.
    onclick: (event) => { ctx.panel?.anchor?.(event.currentTarget); onAct?.(); a.run(ctx); } },
    el("span", { class: "action-icon" },
      compactIcon.icon ? icon(compactIcon.icon, 14) : compactIcon.glyph),
    el("span", { class: "action-label" }, a.shortLabel ?? a.label));
}

function shortcutTip(label, key) {
  return key ? `${label} (${String(key).toLocaleUpperCase()})` : label;
}

function decorateShortcutTip(node, key) {
  if (!(node instanceof HTMLElement) || !key) return node;
  const target = node.matches("button,[role='button']")
    ? node
    : node.querySelector("button,[role='button']") ?? node;
  const label = target.getAttribute("title") || target.getAttribute("aria-label") || target.textContent.trim();
  if (!label) return node;
  target.setAttribute("title", shortcutTip(label, key));
  target.classList.add("tip");
  target.dataset.shortcutKey = String(key).toLocaleLowerCase();
  return node;
}

function groupActionIcon(a) {
  if (a.icon) return { icon: a.icon };
  const mapped = {
    "dump-window": "inbox", "save-session": "sessions", session: "sessions",
    "add-session": "sessions",
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
let activePanelOpener = null;
let panelEventsInstalled = false;
const panelChangeListeners = new Set();

/** Shared scroll policy kept pure so nested and page scrolling stay testable. */
export function shouldRepositionAnchoredPanelOnScroll(panelOwnsTarget) {
  return !panelOwnsTarget;
}

/** A workflow can claim one action and dismiss its anchored panel immediately. */
export const ANCHORED_PANEL_COMMIT_EVENT = "everytab-anchored-panel-commit";

/** True only when the shared palette is anchored inside this live subtree. */
export function anchoredPanelOpenWithin(root) {
  return Boolean(activePanelOpener?.isConnected && root?.contains?.(activePanelOpener));
}

/** Subscribe to shared palette open/close changes. Returns an unsubscribe. */
export function subscribeAnchoredPanelChange(listener) {
  panelChangeListeners.add(listener);
  return () => panelChangeListeners.delete(listener);
}

function publishAnchoredPanelChange() {
  for (const listener of panelChangeListeners) listener();
}

/** Close the one shared top-layer action panel without restoring its opener. */
export function dismissAnchoredPanel() {
  activePanelController?.close();
}

function rectsOverlapOnAxis(a, b, axis) {
  return axis === "x"
    ? Math.min(a.right, b.right) > Math.max(a.left, b.left)
    : Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
}

/** Pick the nearest visible control in the arrow's physical direction. */
function spatialPanelButton(current, buttons, key) {
  const horizontal = key === "ArrowLeft" || key === "ArrowRight";
  const forward = key === "ArrowRight" || key === "ArrowDown";
  const axis = horizontal ? "x" : "y";
  const crossAxis = horizontal ? "y" : "x";
  const currentRect = current.getBoundingClientRect();
  const currentCenter = {
    x: currentRect.left + currentRect.width / 2,
    y: currentRect.top + currentRect.height / 2
  };
  return buttons
    .filter((button) => button !== current)
    .map((button) => {
      const rect = button.getBoundingClientRect();
      const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const primary = (center[axis] - currentCenter[axis]) * (forward ? 1 : -1);
      return {
        button,
        primary,
        cross: Math.abs(center[crossAxis] - currentCenter[crossAxis]),
        aligned: rectsOverlapOnAxis(currentRect, rect, horizontal ? "y" : "x")
      };
    })
    .filter(({ primary }) => primary > 1)
    .sort((a, b) => Number(b.aligned) - Number(a.aligned) ||
      a.primary - b.primary || a.cross - b.cross)[0]?.button ?? null;
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
    if (shouldRepositionAnchoredPanelOnScroll(activePanelController.owns(event.target))) {
      activePanelController.position();
    }
  }, true);
}

export function createAnchoredPanel(slotEl, { copy: panelCopy = listPanelCopy } = {}) {
  let open = null;
  let opener = null;
  let anchorHint = null;
  let popover = null;
  let observer = null;
  let resizeObserver = null;
  let source = null;
  let positionFrame = 0;
  let largestOpenHeight = 0;

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
    let panel = popover.getBoundingClientRect();
    // A suggestion ledger is one stable surface for the life of its picker.
    // Filtering may remove most of its rows, but it must not shrink, flip sides,
    // or make the user's pointer chase it around the page. Keep the largest
    // footprint reached by this invocation; close() resets it for the next one.
    largestOpenHeight = Math.min(window.innerHeight - edge * 2,
      Math.max(largestOpenHeight, panel.height));
    popover.style.minHeight = `${Math.ceil(largestOpenHeight)}px`;
    panel = popover.getBoundingClientRect();
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

  function schedulePosition() {
    if (positionFrame || !popover) return;
    positionFrame = requestAnimationFrame(() => {
      positionFrame = 0;
      positionPopover();
    });
  }

  function close({ restore = false } = {}) {
    const trigger = opener;
    observer?.disconnect();
    observer = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (positionFrame) cancelAnimationFrame(positionFrame);
    positionFrame = 0;
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
    largestOpenHeight = 0;
    if (activePanelController === controller) {
      activePanelController = null;
      activePanelOpener = null;
      publishAnchoredPanelChange();
    }
    if (restore && trigger instanceof HTMLElement && document.contains(trigger)) {
      trigger.focus({ preventScroll: true });
    }
  }

  function onKeydown(e) {
    if (isComposingKey(e)) return;
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
      spatialPanelButton(btns[i], btns, e.key)?.focus({ preventScroll: true });
    }
  }

  function openPopover(panel, name) {
    installPanelEvents();
    const copy = panelCopy(name);
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
    if (slotEl.closest("[data-compact]") || opener?.closest?.("[data-compact]")) {
      popover.dataset.compact = "";
    }
    for (const node of popover.querySelectorAll("[title]")) {
      const detail = node.getAttribute("title");
      if (detail && !node.hasAttribute("aria-description")) {
        node.setAttribute("aria-description", detail);
      }
      node.removeAttribute("title");
    }
    popover.addEventListener("keydown", onKeydown);
    popover.addEventListener(ANCHORED_PANEL_COMMIT_EVENT, () => close());
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
    activePanelOpener = opener;
    observer = new MutationObserver(() => {
      if (!slotEl.isConnected || !opener?.isConnected) close();
      else schedulePosition();
    });
    observer.observe(popover, { childList: true, subtree: true, characterData: true });
    resizeObserver = new ResizeObserver(schedulePosition);
    resizeObserver.observe(popover);
    publishAnchoredPanelChange();
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
    close({ restore = false } = {}) { close({ restore }); }
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
/* Roving ↑/↓ stays in dashboard.js. This listener adds configured single-key
 * actions to focused rows and cards, including the two-step danger behavior.
 * It is installed once and remains inert in DOM-free tests. */

let keyboardInstalled = false;

function activateShortcutButton(button) {
  // A programmatic click does not transfer focus. Anchored palettes use the
  // focused control as their fallback opener, so keyboard activation must make
  // the visible action the owner before its click handler builds the panel.
  button.focus({ preventScroll: true });
  button.click();
}

function installKeyboard() {
  if (keyboardInstalled || typeof document === "undefined") return;
  keyboardInstalled = true;
  document.addEventListener("keydown", (e) => {
    if (isComposingKey(e) || e.metaKey || e.ctrlKey || e.altKey || isTextEntry(e.target)) return;
    if (e.key === "Enter" && !e.repeat &&
        e.target instanceof HTMLInputElement && e.target.type === "checkbox" &&
        e.target.closest("[data-tablist]") && !e.target.disabled) {
      e.preventDefault();
      e.stopPropagation();
      e.target.click();
      return;
    }
    const rowEl = e.target.closest?.("[data-tablist-row]");
    const cardEl = e.target.closest?.("[data-tablist-card]");
    const meta = (rowEl && rowEl._tlRow) || (cardEl && cardEl._tlCard);
    if (!meta) {
      // Clicking a checkbox replaces the list tree. During that handoff focus
      // can briefly land on <body>, but the visible selected-set toolbar is
      // still the unambiguous keyboard owner.
      const key = String(e.key || "").toLocaleLowerCase();
      const candidates = [...document.querySelectorAll(
        `[data-tablist] [data-bulk-action][data-shortcut-key="${CSS.escape(key)}"]`
      )].filter((node) => node instanceof HTMLElement && !node.disabled && node.offsetParent !== null);
      if (candidates.length === 1) {
        e.preventDefault();
        activateShortcutButton(candidates[0]);
      }
      return;
    }
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

    // A visible selected-set toolbar owns its advertised shortcut regardless
    // of whether focus currently sits on a row, card header, or one of the
    // toolbar controls. This prevents a whole-card action from winning merely
    // because a palette restored focus into the header after it closed.
    if (st?.selected?.size) {
      const key = String(e.key || "").toLocaleLowerCase();
      const bulkActions = [...root.querySelectorAll(
        `[data-bulk-action][data-shortcut-key="${CSS.escape(key)}"]`
      )].filter((node) => node instanceof HTMLElement && !node.disabled && node.offsetParent !== null);
      if (bulkActions.length === 1) {
        e.preventDefault();
        activateShortcutButton(bulkActions[0]);
        return;
      }
    }
    if (st?.selected?.size > 1) return;

    const isDel = e.key === "Delete" || e.key === "Backspace";
    const action = meta.byKey.get(e.key) || (isDel ? meta.del : null);
    if (!action) return;
    if (action.danger && e.repeat) {
      e.preventDefault();
      return;
    }
    // Rendered actions such as the Session picker own their behavior through
    // the real button. The shortcut activates that same control rather than
    // duplicating its panel and anchoring logic.
    if (typeof action.run !== "function") {
      const renderedButton = action.id
        ? (rowEl || cardEl).querySelector(`[data-action-id="${CSS.escape(action.id)}"]`)
        : null;
      if (renderedButton instanceof HTMLElement && !renderedButton.disabled) {
        e.preventDefault();
        activateShortcutButton(renderedButton);
      }
      return;
    }
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
