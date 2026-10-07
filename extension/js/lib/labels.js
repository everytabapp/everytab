// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Label editing, aggregation, and saved-item organization across Inbox and Archive. */
import { STORE_KEYS, ARCHIVE_OVERLAY_KEY } from "./types.js";
import {
  getDeviceId, listItems, listNamedSessions, readSessionNavigationData,
  newMeta, mutateStores,
  mutateNamedSessionStores
} from "./store.js";
import { JOURNAL_KEY, makeJournalEntry, appendedJournal } from "./journal.js";
import { mapWithTabsRemoved } from "./actions.js";
import { pspan } from "./perf.js";
import {
  LABEL_META_KEY, touchedLabelMeta, renamedLabelMeta, getLabelMeta
} from "./label-meta.js";
import { canonicalJson } from "./storage/canonical.js";
import {
  deleteOrganizationMembershipsForMember, renameLabelOrganizationMemberships
} from "./organization.js";
import {
  canUseCurrentSavedCarrier, groupSavedItems, groupSavedTabSelections
} from "./saved-selection-safety.js";

const tabIdentity = (ref) => {
  const copy = { ...(ref ?? {}) };
  delete copy.labels;
  return canonicalJson(copy);
};

const tabLayout = (record) => Array.isArray(record?.tabs)
  ? record.tabs.map(tabIdentity)
  : Array.isArray(record?.windows)
    ? record.windows.map((window) => window.map(tabIdentity))
    : null;

const fullTabLayout = (record) => Array.isArray(record?.tabs)
  ? record.tabs
  : Array.isArray(record?.windows) ? record.windows : null;

function sameCarrierIdentity(expected, current) {
  return expected?.id === current?.id &&
    expected?.createdAt === current?.createdAt &&
    expected?.deviceId === current?.deviceId;
}

function sameOccurrenceLayout(expected, current) {
  const before = tabLayout(expected);
  const now = tabLayout(current);
  return before !== null && now !== null && canonicalJson(before) === canonicalJson(now);
}

function hasAmbiguousOccurrences(record) {
  const refs = Array.isArray(record?.tabs) ? record.tabs : (record?.windows ?? []).flat();
  const identities = refs.map(tabIdentity);
  return new Set(identities).size !== identities.length;
}

function indexedOccurrencesUnambiguous(expected, current) {
  if (!hasAmbiguousOccurrences(current)) return true;
  return canonicalJson(fullTabLayout(expected)) === canonicalJson(fullTabLayout(current));
}

/**
 * Commit label-only edits against current records under the store lock. The UI
 * snapshot supplies identity and layout only; every mutation and Undo prestate
 * comes from the fresh record. Missing, deleted, automatic-Snapshot, changed-
 * layout, and ambiguous indexed targets are conservative no-ops.
 * @param {string} store
 * @param {{expected:object,indexed?:boolean,edit:(current:object)=>({record:object,count:number}|null)}[]} requests
 * @param {{describe?:(count:number,records:object[])=>string,bumpLabels?:string[]}} [options]
 */
async function commitLabelEdits(store, requests, { describe, bumpLabels = [] } = {}) {
  const journaled = typeof describe === "function";
  const touch = bumpLabels.length > 0;
  const keys = [store, ...(journaled ? [JOURNAL_KEY] : []), ...(touch ? [LABEL_META_KEY] : [])];
  const commit = store === STORE_KEYS.sessions ? mutateNamedSessionStores : mutateStores;
  let changed = 0;
  await commit(keys, (maps) => {
    const map = { ...(maps[store] ?? {}) };
    const puts = [];
    const edited = [];
    const now = Date.now();
    for (const request of requests) {
      const expected = request.expected;
      const current = map[expected?.id];
      if (!current || current.deletedAt ||
          (store === STORE_KEYS.sessions && current.auto) ||
          !sameCarrierIdentity(expected, current) ||
          !sameOccurrenceLayout(expected, current) ||
          (request.indexed && !indexedOccurrencesUnambiguous(expected, current))) continue;
      const result = request.edit(current);
      if (!result || !Number.isInteger(result.count) || result.count <= 0) continue;
      puts.push({ store, item: current });
      edited.push(current);
      map[current.id] = { ...result.record, modifiedAt: now };
      changed += result.count;
    }
    if (puts.length === 0) return null;
    const sets = { [store]: map };
    if (journaled) {
      const entry = makeJournalEntry(describe(changed, edited), { puts });
      sets[JOURNAL_KEY] = appendedJournal(maps[JOURNAL_KEY], entry);
    }
    if (touch) sets[LABEL_META_KEY] = touchedLabelMeta(maps[LABEL_META_KEY], bumpLabels, now);
    return sets;
  });
  return changed;
}

/**
 * P2g-2: effective labels of ONE tab — the item-level labels (legacy grain,
 * they apply to every tab of the item) ∪ the ref's own per-tab labels.
 * @param {{labels?: string[]}|null} item @param {import("./types.js").TabRef} ref
 */
export function tabLabels(item, ref) {
  return [...new Set([...(item?.labels ?? []), ...(ref?.labels ?? [])])];
}

/**
 * @typedef {{store: string, item: any, tabs: {wi: number|null, i: number, ref: import("./types.js").TabRef}[]}} LabelEntry
 *   `wi` = window index for session entries, null for Inbox/Archive items.
 * @typedef {{label: string, entries: LabelEntry[], tabs: number}} LabelGroup
 */

/**
 * Aggregate all labels at TAB grain across Inbox + Archive + named sessions
 * (U9; snapshots excluded — immutable), alphabetical. An item-level label
 * counts for every tab of its item (legacy grain); a per-tab label counts for
 * its tab. Entries record WHERE each labeled tab lives, so the Labels section
 * can open/unlabel precisely.
 * @returns {LabelGroup[]}
 */
export function collectLabelsFromSnapshots(inbox, archive, sessions, meta) {
  /** @type {Map<string, {label: string, entries: Map<string, LabelEntry>, tabs: number}>} */
  const out = new Map();
  const touch = (label, store, item, wi, i, ref) => {
    const g = out.get(label) ?? { label, entries: new Map(), tabs: 0 };
    const key = `${store}:${item.id}`;
    const e = g.entries.get(key) ?? { store, item, tabs: [] };
    e.tabs.push({ wi, i, ref });
    g.entries.set(key, e);
    g.tabs += 1;
    out.set(label, g);
  };
  for (const [store, items] of [
    [STORE_KEYS.inbox, inbox],
    [STORE_KEYS.archive, archive]
  ]) {
    for (const item of items) {
      item.tabs.forEach((ref, i) => {
        for (const label of tabLabels(item, ref)) touch(label, store, item, null, i, ref);
      });
    }
  }
  for (const s of sessions) {
    if (s.auto) continue; // snapshots are immutable — never labeled
    s.windows.forEach((w, wi) => w.forEach((ref, i) => {
      for (const label of ref.labels ?? []) touch(label, STORE_KEYS.sessions, s, wi, i, ref);
    }));
  }
  // F21: attach each label's precise recency from the labelMeta register, falling
  // back to the modifiedAt proxy for any label not yet in the register (fresh
  // install, or never re-applied since upgrade). This is the ONE read that makes
  // "recent" accurate; sortLabelGroups stays pure and reads group.lastUsedAt.
  return [...out.values()]
    .map((g) => {
      const group = { label: g.label, entries: [...g.entries.values()], tabs: g.tabs };
      group.lastUsedAt = meta[g.label] ?? labelLastUsedAt(group);
      return group;
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * @param {{inboxItems?: () => Promise<import("./types.js").InboxItem[]>}} [reads]
 *   A refresh that already lists the Inbox can share that clone here.
 */
async function readLabelSnapshots(reads = {}) {
  // These four snapshots are independent. Starting them together matters on a
  // cold label picker/nav refresh, while getMap's exact invalidation still
  // supplies an isolated clone for each store read.
  const [inbox, archive, sessionNavigation, meta] = await Promise.all([
    reads.inboxItems?.() ?? listItems(STORE_KEYS.inbox),
    listItems(STORE_KEYS.archive),
    readSessionNavigationData(),
    getLabelMeta()
  ]);
  const sessions = sessionNavigation.namedSessions;
  return {
    archive,
    sessions,
    snapshotCount: sessionNavigation.snapshotCount,
    labelGroups: collectLabelsFromSnapshots(inbox, archive, sessions, meta)
  };
}

export async function collectLabels() {
  return (await readLabelSnapshots()).labelGroups;
}

/**
 * Project the exact saved-tab occurrences shared by every selected label.
 * Identity includes store, carrier record, Session window, and row index: two
 * copies of the same URL in different saved records remain two independent
 * things and can never manufacture a false intersection.
 * @param {LabelGroup[]} groups
 * @param {string[]} selectedLabels
 * @returns {{labels:string[], refs:import("./types.js").TabRef[],
 *   locs:{store:string,item:any,wi:number|null,i:number}[]}}
 */
export function intersectLabelGroups(groups, selectedLabels) {
  const byName = new Map((groups ?? []).map((group) => [
    String(group.label).toLocaleLowerCase(), group
  ]));
  const labels = [];
  const selected = [];
  const seen = new Set();
  for (const raw of selectedLabels ?? []) {
    const group = byName.get(String(raw).trim().toLocaleLowerCase());
    const key = group?.label?.toLocaleLowerCase();
    if (!group || seen.has(key)) continue;
    seen.add(key);
    labels.push(group.label);
    selected.push(group);
  }
  if (!selected.length) return { labels: [], refs: [], locs: [] };

  const occurrenceKey = (entry, tab) =>
    `${entry.store}:${entry.item.id}:${tab.wi ?? "-"}:${tab.i}`;
  const occurrences = selected.map((group) => {
    const map = new Map();
    for (const entry of group.entries ?? []) {
      for (const tab of entry.tabs ?? []) {
        map.set(occurrenceKey(entry, tab), {
          ref: tab.ref,
          loc: { store: entry.store, item: entry.item, wi: tab.wi ?? null, i: tab.i }
        });
      }
    }
    return map;
  });
  const [first, ...rest] = occurrences;
  const refs = [];
  const locs = [];
  for (const [key, value] of first) {
    if (!rest.every((map) => map.has(key))) continue;
    refs.push(value.ref);
    locs.push(value.loc);
  }
  return { labels, refs, locs };
}

/**
 * Read the shared immutable saved-library snapshot used by Dashboard
 * navigation. Counts and label aggregation are derived from one set of store
 * reads, so large Archive and Session maps are never cloned twice per refresh.
 */
export async function readLabelNavigationSnapshot(reads = {}) {
  const { archive, sessions, snapshotCount, labelGroups } = await readLabelSnapshots(reads);
  return {
    archiveCount: archive.length,
    labelGroups,
    namedSessions: sessions,
    snapshotCount
  };
}

/**
 * L-nav — the "first applied" proxy for a label: `min(item.createdAt)` across
 * its entries (the oldest tab carrying it). Stable — reusing an old label on a
 * new tab doesn't change it. Missing timestamps count as 0 (oldest).
 * @param {{entries: {item: {createdAt?: number}}[]}} group
 */
export function labelCreatedAt(group) {
  let min = Infinity;
  for (const e of group.entries) {
    const c = e.item?.createdAt ?? 0;
    if (c < min) min = c;
  }
  return min === Infinity ? 0 : min;
}

/**
 * L-nav-5 — a label's "latest usage": `max(item.modifiedAt)` across its carrier
 * items. Applying/renaming a label (or touching any tab that carries it)
 * re-upserts that item with a fresh `modifiedAt`, so the label rises on use;
 * cross-device usage syncs free through the item vault merge. No new store.
 * Missing timestamps count as 0.
 * @param {{entries: {item: {modifiedAt?: number}}[]}} group
 */
export function labelLastUsedAt(group) {
  let max = 0;
  for (const e of group.entries) {
    const m = e.item?.modifiedAt ?? 0;
    if (m > max) max = m;
  }
  return max;
}

/**
 * L-nav — sort label groups (the `collectLabels` shape) by mode; ties → A–Z.
 * Pure; returns a new array. "recent" = latest usage (L-nav-5). @param {any[]} groups
 * @param {"recent"|"count"|"az"} mode
 */
export function sortLabelGroups(groups, mode) {
  const az = (a, b) => a.label.localeCompare(b.label);
  // F21: precise recency = collectLabels' attached lastUsedAt (labelMeta), with
  // the L-nav-5 proxy as the fallback for hand-built groups (tests) or labels not
  // yet in the register.
  const recency = (g) => g.lastUsedAt ?? labelLastUsedAt(g);
  const arr = [...groups];
  if (mode === "count") return arr.sort((a, b) => b.tabs - a.tabs || az(a, b));
  if (mode === "recent") return arr.sort((a, b) => recency(b) - recency(a) || az(a, b));
  return arr.sort(az);
}

/**
 * L-nav — filter label groups by a case-insensitive substring of the label name.
 * Pure. @param {any[]} groups @param {string} text
 */
export function filterLabelGroups(groups, text) {
  const q = String(text ?? "").trim().toLowerCase();
  if (!q) return groups;
  return groups.filter((g) => g.label.toLowerCase().includes(q));
}

/** Add a label to an item in place. @param {string} store @param {object} item @param {string} label */
export async function addLabel(store, item, label) {
  const l = label.trim();
  if (!l) return;
  await commitLabelEdits(store, [{
    expected: item,
    edit(current) {
      if ((current.labels ?? []).includes(l)) return null;
      return { record: { ...current, labels: [...(current.labels ?? []), l] }, count: 1 };
    }
  }], { bumpLabels: [l] });
}

/** @param {string|string[]|undefined} labels */
function normalizeLabels(labels) {
  const arr = Array.isArray(labels) ? labels : labels ? [labels] : [];
  return [...new Set(arr.map((l) => String(l).trim()).filter(Boolean))];
}

const mergeLabels = (a, b) => [...new Set([...(a ?? []), ...b])];
const includesEveryLabel = (existing, wanted) =>
  wanted.every((label) => (existing ?? []).includes(label));

async function newMetadataBatch(count) {
  if (count <= 0) return [];
  const first = await newMeta();
  return [first, ...Array.from({ length: count - 1 }, () => ({
    ...first, id: crypto.randomUUID()
  }))];
}

/**
 * Save one or more open-tab refs as labeled Archive copies and bump label
 * recency at the same commit point. The old UI path performed one whole-Archive
 * upsert per ref, then a second locked labelMeta write; this preserves the
 * resulting records while making confirmation one atomic write.
 * @param {import("./types.js").TabRef[]} refs
 * @param {string|string[]} labels
 * @returns {Promise<import("./types.js").InboxItem[]>}
 */
export async function saveLabeledCopies(refs, labels) {
  const add = normalizeLabels(labels);
  const validRefs = (refs ?? []).filter(Boolean);
  if (add.length === 0 || validRefs.length === 0) return [];

  const endTotal = pspan("label:confirm-total");
  try {
    const endMetadata = pspan("label:metadata");
    const metas = await Promise.all(validRefs.map(() => newMeta()));
    endMetadata(`${validRefs.length} copies`);
    const now = Date.now();
    const records = validRefs.map((ref, i) => ({
      ...metas[i],
      kind: "tab",
      tabs: [{ ...ref }],
      source: "manual",
      labels: add,
      archivedAt: now
    }));

    /* N41: this creates records, so it owes the user an inverse. Without a
     * journal entry, labeling from Open tabs was the one label path with no
     * Undo chip. The entry rides the SAME atomic set as the records it undoes
     * (E2-0c), and `dels` tombstones each saved copy: `tombstoneItem` reads the
     * merged base+overlay Archive, so an overlay-only record is removed
     * correctly. The live tab is never touched, so there is nothing else to
     * reverse. */
    const entry = makeJournalEntry(
      `Saved ${records.length} labeled cop${records.length === 1 ? "y" : "ies"}`,
      { dels: records.map((record) => ({ store: STORE_KEYS.archive, id: record.id })) }
    );
    const endCommit = pspan("label:locked-commit");
    try {
      await mutateStores([ARCHIVE_OVERLAY_KEY, LABEL_META_KEY, JOURNAL_KEY], (maps) => {
        const overlay = { ...(maps[ARCHIVE_OVERLAY_KEY] ?? {}) };
        for (const record of records) {
          overlay[record.id] = { ...record, modifiedAt: now };
        }
        return {
          [ARCHIVE_OVERLAY_KEY]: overlay,
          [LABEL_META_KEY]: touchedLabelMeta(maps[LABEL_META_KEY], add, now),
          [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
        };
      });
    } finally {
      endCommit(`${validRefs.length} copies`);
    }
    return records;
  } finally {
    endTotal(`${validRefs.length} copies`);
  }
}

/**
 * P2g-2 (amended decision #8, N11): apply labels to EVERY tab of an item, IN
 * PLACE — labels belong to tabs, so they land on the refs; the bundle is never
 * split and the item keeps its id/kind. Journaled (Undo restores the pre-state).
 * @param {string} store @param {import("./types.js").InboxItem} item
 * @param {string|string[]} labels
 * @returns {Promise<number>} tabs labeled
 */
export async function applyLabels(store, item, labels) {
  const add = normalizeLabels(labels);
  if (add.length === 0) return 0;
  return commitLabelEdits(store, [{
    expected: item,
    edit(current) {
      let count = 0;
      const tabs = current.tabs.map((tab) => {
        if (includesEveryLabel(tab.labels, add)) return tab;
        count += 1;
        return { ...tab, labels: mergeLabels(tab.labels, add) };
      });
      return count > 0 ? { record: { ...current, tabs }, count } : null;
    }
  }], {
    describe: (count) => `Labeled ${count} tab${count === 1 ? "" : "s"}`,
    bumpLabels: add
  });
}

/**
 * Remove a label from an item — BOTH grains: the item-level label and every
 * ref that carries it. Journaled (P2g-2: chip × is one click, Undo must exist).
 * @param {string} store @param {object} item @param {string} label
 */
export async function removeLabel(store, item, label) {
  await commitLabelEdits(store, [{
    expected: item,
    edit(current) {
      const inItem = (current.labels ?? []).includes(label);
      const inTabs = current.tabs.some((tab) => tab.labels?.includes(label));
      if (!inItem && !inTabs) return null;
      return {
        record: {
          ...current,
          labels: (current.labels ?? []).filter((value) => value !== label),
          tabs: current.tabs.map((tab) => tab.labels?.includes(label)
            ? { ...tab, labels: tab.labels.filter((value) => value !== label) }
            : tab)
        },
        count: 1
      };
    }
  }], { describe: () => `Removed label “${label}”` });
}

/**
 * P2g-2 (row chip ×): remove a label from ONE tab of an item. Handles both
 * grains: a per-tab label is dropped from that ref; an item-level label is
 * first demoted to per-tab labels on all OTHER refs, then omitted from this
 * one — the other tabs keep the label, exactly as displayed. Journaled.
 * @param {string} store @param {import("./types.js").InboxItem} item
 * @param {number} index @param {string} label
 */
export async function removeLabelFromTab(store, item, index, label) {
  if (!item.tabs[index]) return;
  await commitLabelEdits(store, [{
    expected: item,
    indexed: true,
    edit(current) {
      const target = current.tabs[index];
      if (!target) return null;
      const fromItemGrain = (current.labels ?? []).includes(label);
      if (!fromItemGrain && !target.labels?.includes(label)) return null;
      const tabs = current.tabs.map((tab, i) => {
        if (i === index) {
          return { ...tab, labels: (tab.labels ?? []).filter((value) => value !== label) };
        }
        return fromItemGrain ? { ...tab, labels: mergeLabels(tab.labels, [label]) } : tab;
      });
      return {
        record: {
          ...current,
          labels: fromItemGrain
            ? (current.labels ?? []).filter((value) => value !== label)
            : current.labels,
          tabs
        },
        count: 1
      };
    }
  }], { describe: () => `Removed label “${label}” from a tab` });
}

/**
 * Remove the displayed labels from exact selected saved occurrences. Validate
 * the complete selection first, then commit all carriers and one Undo together.
 * @param {{store:string,item:object,wi?:number|null,i:number,label:string}[]} selections
 * @returns {Promise<{ok:boolean,count:number,reason?:string}>}
 */
export async function removeLabelsFromSelections(selections) {
  return commitSelectionLabels(selections);
}

/** Add labels to selected saved occurrences, with one atomic edit and Undo. */
export async function applyLabelsToSelections(selections, labels) {
  const add = normalizeLabels(labels);
  if (!add.length) return { ok: true, count: 0 };
  return commitSelectionLabels(selections, add);
}

/** Shared selection validation, carrier grouping, persistence and Undo. */
async function commitSelectionLabels(selections, addedLabels = null) {
  const adding = addedLabels !== null;
  const stale = { ok: false, reason: "stale", count: 0 };
  if (!Array.isArray(selections)) return stale;
  const groups = new Map();
  for (const source of structuredClone(selections)) {
    const { store, item, wi, i, label } = source ?? {};
    if (![STORE_KEYS.inbox, STORE_KEYS.archive, STORE_KEYS.sessions].includes(store) ||
        !item?.id || (!adding && (typeof label !== "string" || !label)) ||
        !Number.isInteger(i) || i < 0) return stale;
    const isSession = store === STORE_KEYS.sessions;
    if (isSession && (!Number.isInteger(wi) || wi < 0 || item.auto)) return stale;
    if (!(isSession ? item.windows?.[wi]?.[i] : item.tabs?.[i])) return stale;
    const key = `${store}:${item.id}`;
    const group = groups.get(key) ?? { store, id: item.id, views: new Set(), picks: new Map() };
    group.views.add(item);
    const position = isSession ? `${wi}:${i}` : String(i);
    const pick = group.picks.get(position) ?? { wi, i, labels: new Set() };
    for (const name of addedLabels ?? [label]) pick.labels.add(name);
    group.picks.set(position, pick);
    groups.set(key, group);
  }
  if (!groups.size) return { ok: true, count: 0 };
  const stores = [...new Set([...groups.values()].map(group => group.store))];
  const commit = stores.includes(STORE_KEYS.sessions) ? mutateNamedSessionStores : mutateStores;
  let result = stale;
  await commit([...stores, JOURNAL_KEY, ...(adding ? [LABEL_META_KEY] : [])], maps => {
    for (const group of groups.values()) {
      const current = maps[group.store]?.[group.id];
      if (!current || current.deletedAt || (group.store === STORE_KEYS.sessions && current.auto)) return null;
      for (const expected of group.views) {
        if (!sameCarrierIdentity(expected, current) || !sameOccurrenceLayout(expected, current) ||
            !indexedOccurrencesUnambiguous(expected, current)) return null;
      }
    }
    const sets = {}, puts = [];
    let count = 0;
    const now = Date.now();
    for (const group of groups.values()) {
      const current = maps[group.store][group.id];
      const isSession = group.store === STORE_KEYS.sessions;
      const demoted = isSession || adding ? [] : (current.labels ?? []).filter(label =>
        [...group.picks.values()].some(pick => pick.labels.has(label)));
      let touched = 0;
      const edit = (tab, i, wi) => {
        const pick = group.picks.get(isSession ? `${wi}:${i}` : String(i));
        const labels = mergeLabels(tab.labels, demoted);
        const remaining = !pick ? labels : adding
          ? mergeLabels(labels, [...pick.labels].filter(label =>
            isSession || !current.labels?.includes(label)))
          : labels.filter(label => !pick.labels.has(label));
        if (remaining.length !== labels.length) touched++;
        return remaining.length === (tab.labels ?? []).length &&
          remaining.every((label, index) => label === tab.labels[index])
          ? tab : { ...tab, labels: remaining };
      };
      const updated = isSession
        ? { ...current, windows: current.windows.map((window, wi) => window.map((tab, i) => edit(tab, i, wi))) }
        : { ...current, labels: (current.labels ?? []).filter(label => !demoted.includes(label)), tabs: current.tabs.map((tab, i) => edit(tab, i)) };
      if (!touched) continue;
      count += touched;
      puts.push({ store: group.store, item: current });
      sets[group.store] ??= { ...maps[group.store] };
      sets[group.store][group.id] = { ...updated, modifiedAt: now };
    }
    result = { ok: true, count };
    if (!puts.length) return null;
    const entry = makeJournalEntry(adding ? "Labeled selected tabs" : "Removed labels from selected tabs", { puts });
    sets[JOURNAL_KEY] = appendedJournal(maps[JOURNAL_KEY], entry);
    if (adding) sets[LABEL_META_KEY] = touchedLabelMeta(maps[LABEL_META_KEY], addedLabels, now);
    return sets;
  });
  return result;
}

/**
 * U9 — label tabs INSIDE a named session (per-tab grain on the session's refs).
 * `where` narrows the write: null = every window (card "Label session");
 * {wi} = one window; {wi, i} = one tab (row-level Label); an ARRAY of
 * {wi, i} = a bulk selection (P2g-3 U6). Snapshots refuse.
 * Journaled against the sessions store.
 * @param {import("./types.js").Session} session
 * @param {string|string[]} labels
 * @param {{wi?: number, i?: number}|Array<{wi: number, i: number}>|null} [where]
 * @returns {Promise<number>} tabs labeled
 */
export async function labelSessionTabs(session, labels, where = null) {
  const add = normalizeLabels(labels);
  if (add.length === 0 || session.auto) return 0; // snapshots are immutable
  // P2g-3 (U6): `where` may be an ARRAY of {wi, i} — a bulk selection.
  const picks = Array.isArray(where)
    ? where.reduce((m, p) => (m.get(p.wi)?.add(p.i) ?? m.set(p.wi, new Set([p.i])), m), new Map())
    : null;
  const hit = (wi, i) => picks
    ? !!picks.get(wi)?.has(i)
    : (where?.wi == null || wi === where.wi) && (where?.i == null || i === where.i);
  return commitLabelEdits(STORE_KEYS.sessions, [{
    expected: session,
    indexed: where !== null,
    edit(current) {
      let count = 0;
      const windows = current.windows.map((window, wi) => window.map((tab, i) => {
        if (!hit(wi, i)) return tab;
        if (includesEveryLabel(tab.labels, add)) return tab;
        count += 1;
        return { ...tab, labels: mergeLabels(tab.labels, add) };
      }));
      return count > 0 ? { record: { ...current, windows }, count } : null;
    }
  }], {
    describe: (count, records) =>
      `Labeled ${count} tab${count === 1 ? "" : "s"} in “${records[0].name}”`,
    bumpLabels: add
  });
}

/**
 * U9 — remove a label inside a session. `where` = {wi, i} for one tab (row
 * chip ×), or null to strip it from every ref (the card's union chip ×).
 * Journaled.
 * @param {import("./types.js").Session} session @param {string} label
 * @param {{wi: number, i: number}|null} [where]
 */
export async function removeSessionLabel(session, label, where = null) {
  if (session.auto) return;
  await commitLabelEdits(STORE_KEYS.sessions, [{
    expected: session,
    indexed: where !== null,
    edit(current) {
      let count = 0;
      const windows = current.windows.map((window, wi) => window.map((tab, i) => {
        if (where && (wi !== where.wi || i !== where.i)) return tab;
        if (!tab.labels?.includes(label)) return tab;
        count += 1;
        return { ...tab, labels: tab.labels.filter((value) => value !== label) };
      }));
      return count > 0 ? { record: { ...current, windows }, count } : null;
    }
  }], {
    describe: (_count, records) =>
      `Removed label “${label}”${where ? " from a tab" : ""} in “${records[0].name}”`
  });
}

/**
 * P2g-2 — rename a label EVERYWHERE (Inbox + Archive items, both grains, and
 * named sessions' refs). Renaming onto an existing label merges (set union).
 * One journal entry restores every touched record.
 * @param {string} from @param {string} to
 * @returns {Promise<number>} records touched
 */
export async function renameLabel(from, to) {
  const target = String(to ?? "").trim();
  if (!target || target === from) return 0;
  const renameIn = (arr) => (arr ?? []).includes(from)
    ? [...new Set(arr.map((x) => (x === from ? target : x)))]
    : arr;
  // E2-0c: read FRESH under the lock and commit every touched record across
  // all three stores + the one undo entry in ONE atomic set.
  const now = Date.now();
  const deviceId = await getDeviceId();
  let count = 0;
  await mutateNamedSessionStores(
    [STORE_KEYS.inbox, STORE_KEYS.archive, STORE_KEYS.sessions, LABEL_META_KEY,
      STORE_KEYS.organizationMemberships, JOURNAL_KEY],
    (maps) => {
      const puts = [];
      const sets = {};
      const live = (map) => Object.values(map ?? {})
        .filter((i) => !i.deletedAt)
        .sort((a, b) => b.modifiedAt - a.modifiedAt); // listItems order → same puts order
      for (const store of [STORE_KEYS.inbox, STORE_KEYS.archive]) {
        const next = { ...(maps[store] ?? {}) };
        let changed = false;
        for (const item of live(maps[store])) {
          const tabs = item.tabs.map((t) => (t.labels?.includes(from) ? { ...t, labels: renameIn(t.labels) } : t));
          const touched = (item.labels ?? []).includes(from) || tabs.some((t, i) => t !== item.tabs[i]);
          if (!touched) continue;
          puts.push({ store, item });
          next[item.id] = { ...item, labels: renameIn(item.labels), tabs, modifiedAt: now };
          changed = true;
        }
        if (changed) sets[store] = next;
      }
      const nextSessions = { ...(maps[STORE_KEYS.sessions] ?? {}) };
      let sessionsChanged = false;
      for (const s of live(maps[STORE_KEYS.sessions])) {
        if (s.auto) continue;
        let touched = false;
        const windows = s.windows.map((w) => w.map((t) => {
          if (!t.labels?.includes(from)) return t;
          touched = true;
          return { ...t, labels: renameIn(t.labels) };
        }));
        if (!touched) continue;
        puts.push({ store: STORE_KEYS.sessions, item: s });
        nextSessions[s.id] = { ...s, windows, modifiedAt: now };
        sessionsChanged = true;
      }
      if (sessionsChanged) sets[STORE_KEYS.sessions] = nextSessions;
      const organization = renameLabelOrganizationMemberships(
        maps[STORE_KEYS.organizationMemberships], from, target, { now, deviceId }
      );
      if (organization.changes.length > 0) {
        sets[STORE_KEYS.organizationMemberships] = organization.map;
      }
      if (puts.length === 0 && organization.changes.length === 0) return null;
      count = puts.length;
      const entry = makeJournalEntry(`Renamed label “${from}” → “${target}”`, {
        puts: [...puts, ...organization.inverse.puts],
        dels: organization.inverse.dels
      });
      sets[JOURNAL_KEY] = appendedJournal(maps[JOURNAL_KEY], entry);
      // F21: move recency from → target (target inherits max(from, target, now)).
      sets[LABEL_META_KEY] = renamedLabelMeta(maps[LABEL_META_KEY], from, target, now);
      return sets;
    }
  );
  return count;
}

/**
 * P2g-2 — delete a label EVERYWHERE (both grains, all stores + named
 * sessions). The tabs stay; only the label goes. One journal entry undoes it.
 * @param {string} label
 * @returns {Promise<number>} records touched
 */
export async function deleteLabelEverywhere(label) {
  const strip = (arr) => (arr ?? []).filter((x) => x !== label);
  // E2-0c: fresh read under the lock; every touched record + the undo entry
  // commit in ONE atomic set.
  const now = Date.now();
  let count = 0;
  await mutateNamedSessionStores(
    [STORE_KEYS.inbox, STORE_KEYS.archive, STORE_KEYS.sessions,
      STORE_KEYS.organizationMemberships, JOURNAL_KEY],
    (maps) => {
      const puts = [];
      const sets = {};
      const live = (map) => Object.values(map ?? {})
        .filter((i) => !i.deletedAt)
        .sort((a, b) => b.modifiedAt - a.modifiedAt);
      for (const store of [STORE_KEYS.inbox, STORE_KEYS.archive]) {
        const next = { ...(maps[store] ?? {}) };
        let changed = false;
        for (const item of live(maps[store])) {
          const inItem = (item.labels ?? []).includes(label);
          const inTabs = item.tabs.some((t) => t.labels?.includes(label));
          if (!inItem && !inTabs) continue;
          puts.push({ store, item });
          next[item.id] = {
            ...item,
            labels: strip(item.labels),
            tabs: item.tabs.map((t) => (t.labels?.includes(label) ? { ...t, labels: strip(t.labels) } : t)),
            modifiedAt: now
          };
          changed = true;
        }
        if (changed) sets[store] = next;
      }
      const nextSessions = { ...(maps[STORE_KEYS.sessions] ?? {}) };
      let sessionsChanged = false;
      for (const s of live(maps[STORE_KEYS.sessions])) {
        if (s.auto) continue;
        if (!s.windows.some((w) => w.some((t) => t.labels?.includes(label)))) continue;
        puts.push({ store: STORE_KEYS.sessions, item: s });
        nextSessions[s.id] = {
          ...s,
          windows: s.windows.map((w) => w.map((t) => (t.labels?.includes(label) ? { ...t, labels: strip(t.labels) } : t))),
          modifiedAt: now
        };
        sessionsChanged = true;
      }
      if (sessionsChanged) sets[STORE_KEYS.sessions] = nextSessions;
      const organization = deleteOrganizationMembershipsForMember(
        maps[STORE_KEYS.organizationMemberships], "label", label, { now }
      );
      if (organization.changes.length > 0) {
        sets[STORE_KEYS.organizationMemberships] = organization.map;
      }
      if (puts.length === 0 && organization.changes.length === 0) return null;
      count = puts.length;
      const entry = makeJournalEntry(`Deleted label “${label}” everywhere`, {
        puts: [...puts, ...organization.inverse.puts],
        dels: organization.inverse.dels
      });
      sets[JOURNAL_KEY] = appendedJournal(maps[JOURNAL_KEY], entry);
      return sets;
    }
  );
  return count;
}

/**
 * The triage action: optionally tag, then move Inbox → Archive.
 * With labels, window bundles SPLIT into per-tab archive items (labels belong
 * to tabs); without labels, bundles move whole (same id) — plain archiving
 * preserves window-ness.
 * @param {import("./types.js").InboxItem[]} items live inbox items
 * @param {string|string[]} [labels]
 * @returns {Promise<number>} items moved
 */
export async function labelAndArchive(items, labels) {
  const grouped = groupSavedItems(items);
  if (grouped.length === 0) return 0;
  const add = normalizeLabels(labels);
  const metadataCount = add.length > 0
    ? grouped.reduce((count, expected) =>
      count + (expected.tabs.length > 1 ? expected.tabs.length : 0), 0)
    : 0;
  const metadata = await newMetadataBatch(metadataCount);
  let metadataIndex = 0;
  const prepared = grouped.map((expected) => {
    const count = add.length > 0 && expected.tabs.length > 1 ? expected.tabs.length : 0;
    const metas = metadata.slice(metadataIndex, metadataIndex + count);
    metadataIndex += count;
    return { expected, metas };
  });
  // F21: this is an apply path only when labels were typed; bump those in-commit.
  const touchKeys = add.length > 0 ? [LABEL_META_KEY] : [];
  let moved = 0;
  await mutateStores([STORE_KEYS.inbox, STORE_KEYS.archive, JOURNAL_KEY, ...touchKeys], (maps) => {
    const inbox = { ...(maps[STORE_KEYS.inbox] ?? {}) };
    const archive = { ...(maps[STORE_KEYS.archive] ?? {}) };
    const puts = [];
    const dels = [];
    const now = Date.now();
    for (const { expected, metas } of prepared) {
      const current = maps[STORE_KEYS.inbox]?.[expected.id];
      if (!canUseCurrentSavedCarrier(expected, current)) continue;
      const destinations = add.length > 0 && current.kind === "window" && current.tabs.length > 1
        ? current.tabs.map((ref, index) => ({
          ...metas[index], kind: "tab", tabs: [ref], source: current.source,
          labels: mergeLabels(current.labels, add), archivedAt: now, modifiedAt: now
        }))
        : [{
          ...current, labels: mergeLabels(current.labels, add),
          archivedAt: now, modifiedAt: now
        }];
      const destinationIds = new Set(destinations.map((record) => record.id));
      const reusesWholeTombstone = destinations.length === 1 &&
        destinations[0].id === current.id && Number.isFinite(archive[current.id]?.deletedAt);
      if (destinationIds.size !== destinations.length ||
          destinations.some((record) => Object.hasOwn(archive, record.id)) &&
          !reusesWholeTombstone) continue;
      puts.push({ store: STORE_KEYS.inbox, item: current });
      for (const record of destinations) {
        archive[record.id] = record;
        dels.push({ store: STORE_KEYS.archive, id: record.id });
      }
      inbox[current.id] = { ...current, deletedAt: now, modifiedAt: now };
      moved += 1;
    }
    if (moved === 0) return null;
    const entry = makeJournalEntry(
      `Archived ${moved} item${moved === 1 ? "" : "s"}`, { puts, dels }
    );
    return {
      [STORE_KEYS.inbox]: inbox,
      [STORE_KEYS.archive]: archive,
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry),
      ...(add.length > 0 ? { [LABEL_META_KEY]: touchedLabelMeta(maps[LABEL_META_KEY], add, now) } : {})
    };
  });
  return moved;
}

/**
 * P2d, resworn by P2g-2 (N11, amended decision #8): label the selected tabs
 * IN PLACE — the labels land on the targeted refs (`TabRef.labels`, true tab
 * grain), the item is NEVER split, keeps its id/kind, and the bundle stays
 * intact. Splits happen on exits only (archive/restore/snooze/delete subsets).
 * Journal-backed: one entry, puts of every pre-state item.
 * `store` (P2e-1) defaults to the Inbox; the unified list passes
 * STORE_KEYS.archive to label tabs within the Archive.
 * @param {{item: import("./types.js").InboxItem, indexes: number[]}[]} sources
 * @param {string|string[]} labels
 * @param {string} [store] STORE_KEYS.* (default inbox)
 * @returns {Promise<number>} tabs labeled
 */
export async function labelTabsFromItems(sources, labels, store = STORE_KEYS.inbox) {
  const add = normalizeLabels(labels);
  if (add.length === 0) return 0;
  const grouped = new Map();
  for (const { item, indexes } of sources) {
    if (!item?.id) continue;
    const existing = grouped.get(item.id);
    if (existing && (!sameCarrierIdentity(existing.expected, item) ||
        canonicalJson(fullTabLayout(existing.expected)) !== canonicalJson(fullTabLayout(item)))) {
      existing.conflicting = true;
      continue;
    }
    const group = existing ?? { expected: item, indexes: new Set(), conflicting: false };
    for (const index of indexes ?? []) {
      if (Number.isInteger(index) && item.tabs[index]) group.indexes.add(index);
    }
    grouped.set(item.id, group);
  }
  const requests = [...grouped.values()]
    .filter((group) => !group.conflicting && group.indexes.size > 0)
    .map((group) => ({
      expected: group.expected,
      indexed: true,
      edit(current) {
        let count = 0;
        const tabs = current.tabs.map((tab, index) => {
          if (!group.indexes.has(index)) return tab;
          if (includesEveryLabel(tab.labels, add)) return tab;
          count += 1;
          return { ...tab, labels: mergeLabels(tab.labels, add) };
        });
        return count > 0 ? { record: { ...current, tabs }, count } : null;
      }
    }));
  return commitLabelEdits(store, requests, {
    describe: (count) => `Labeled ${count} tab${count === 1 ? "" : "s"}`,
    bumpLabels: add
  });
}

/**
 * P2d-1 — Archive exit at tab grain. Moves each source's selected tabs Inbox →
 * Archive, splitting the source item. With labels the subset splits into per-tab
 * archive items (labels belong to tabs); without, a source's subset archives as
 * one item. Journal-backed: Undo revives the pre-split Inbox items and tombstones
 * the archive items created.
 * @param {{item: import("./types.js").InboxItem, indexes: number[]}[]} sources
 * @param {string|string[]} [labels]
 * @returns {Promise<number>} tabs archived
 */
export async function archiveTabsFromItems(sources, labels) {
  const add = normalizeLabels(labels);
  const grouped = groupSavedTabSelections(sources);
  if (grouped.length === 0) return 0;
  const metadataCount = grouped.reduce((count, group) =>
    count + (add.length > 0 ? group.indexes.length : 1), 0);
  const metadata = await newMetadataBatch(metadataCount);
  let metadataIndex = 0;
  const prepared = grouped.map((group) => {
    const count = add.length > 0 ? group.indexes.length : 1;
    const metas = metadata.slice(metadataIndex, metadataIndex + count);
    metadataIndex += count;
    return { ...group, metas };
  });
  // F21: only an apply path when labels were typed; bump those in-commit.
  const touchKeys = add.length > 0 ? [LABEL_META_KEY] : [];
  let archived = 0;
  await mutateStores([STORE_KEYS.inbox, STORE_KEYS.archive, JOURNAL_KEY, ...touchKeys], (maps) => {
    let inbox = maps[STORE_KEYS.inbox] ?? {};
    const archive = { ...(maps[STORE_KEYS.archive] ?? {}) };
    const puts = [];
    const dels = [];
    const now = Date.now();
    for (const { expected, indexes, metas } of prepared) {
      const current = maps[STORE_KEYS.inbox]?.[expected.id];
      if (!canUseCurrentSavedCarrier(expected, current, { indexed: true })) continue;
      const refs = indexes.map((index) => current.tabs[index]);
      const destinations = add.length > 0
        ? refs.map((ref, index) => ({
          ...metas[index], kind: "tab", tabs: [ref], source: current.source,
          labels: mergeLabels(current.labels, add), archivedAt: now, modifiedAt: now
        }))
        : [{
          ...metas[0], kind: refs.length > 1 ? "window" : "tab", tabs: refs,
          source: current.source, labels: [...(current.labels ?? [])],
          ...(Object.hasOwn(current, "windowTitle") ? { windowTitle: current.windowTitle } : {}),
          archivedAt: now, modifiedAt: now
        }];
      const destinationIds = new Set(destinations.map((record) => record.id));
      if (destinationIds.size !== destinations.length ||
          destinations.some((record) => Object.hasOwn(archive, record.id))) continue;
      puts.push({ store: STORE_KEYS.inbox, item: current });
      for (const record of destinations) {
        archive[record.id] = record;
        dels.push({ store: STORE_KEYS.archive, id: record.id });
      }
      inbox = mapWithTabsRemoved(inbox, current, indexes, now);
      archived += refs.length;
    }
    if (archived === 0) return null;
    const entry = makeJournalEntry(
      `Archived ${archived} tab${archived === 1 ? "" : "s"}`, { puts, dels }
    );
    return {
      [STORE_KEYS.inbox]: inbox,
      [STORE_KEYS.archive]: archive,
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry),
      ...(add.length > 0 ? { [LABEL_META_KEY]: touchedLabelMeta(maps[LABEL_META_KEY], add, now) } : {})
    };
  });
  return archived;
}
