/**
 * M6 — labels as THE organizing concept (user decision: collections merged
 * away). Items stay where they live (Inbox / Archive); labels organize
 * across them. The old "file to collection" flow becomes "label & archive":
 * tag the item, move it to the searchable Archive.
 */
import { STORE_KEYS, ARCHIVE_OVERLAY_KEY } from "./types.js";
import { getDeviceId, listItems, upsertItem, newMeta, mutateStores } from "./store.js";
import { JOURNAL_KEY, makeJournalEntry, appendedJournal } from "./journal.js";
import { mapWithTabsRemoved } from "./actions.js";
import { pspan } from "./perf.js";
import {
  LABEL_META_KEY, touchedLabelMeta, renamedLabelMeta, touchLabels, getLabelMeta
} from "./label-meta.js";
import {
  deleteOrganizationMembershipsForMember, renameLabelOrganizationMemberships
} from "./organization.js";

/**
 * E2-0c — one-record commit helper: write the updated record + its undo entry
 * in ONE atomic set (upsertItem semantics: fresh map, caller's record, fresh
 * modifiedAt). Every single-record journaled label op goes through here.
 * F21: when `bumpLabels` is given, the label-recency bump for those labels rides
 * in the SAME atomic commit (grow-only max), so recency can't desync from the
 * label write. Removal ops pass nothing (removal is not "use").
 * @param {string} store @param {object} record the full record to write
 * @param {string} label journal label @param {object} inverse journal inverse
 * @param {string[]} [bumpLabels] labels to mark used in the same commit
 */
async function commitRecordWithJournal(store, record, label, inverse, bumpLabels) {
  const entry = makeJournalEntry(label, inverse);
  const now = Date.now();
  const touch = bumpLabels && bumpLabels.length > 0;
  const keys = touch ? [store, JOURNAL_KEY, LABEL_META_KEY] : [store, JOURNAL_KEY];
  await mutateStores(keys, (maps) => ({
    [store]: { ...(maps[store] ?? {}), [record.id]: { ...record, modifiedAt: now } },
    [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry),
    ...(touch ? { [LABEL_META_KEY]: touchedLabelMeta(maps[LABEL_META_KEY], bumpLabels, now) } : {})
  }));
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
function collectLabelsFromSnapshots(inbox, archive, sessions, meta) {
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

async function readLabelSnapshots() {
  // These four snapshots are independent. Starting them together matters on a
  // cold label picker/nav refresh, while getMap's exact invalidation still
  // supplies an isolated clone for each store read.
  const [inbox, archive, sessions, meta] = await Promise.all([
    listItems(STORE_KEYS.inbox),
    listItems(STORE_KEYS.archive),
    listItems(STORE_KEYS.sessions),
    getLabelMeta()
  ]);
  return {
    archive,
    sessions,
    labelGroups: collectLabelsFromSnapshots(inbox, archive, sessions, meta)
  };
}

export async function collectLabels() {
  return (await readLabelSnapshots()).labelGroups;
}

/**
 * Read the shared immutable saved-library snapshot used by Dashboard
 * navigation. Counts and label aggregation are derived from one set of store
 * reads, so large Archive and Session maps are never cloned twice per refresh.
 */
export async function readLabelNavigationSnapshot() {
  const { archive, sessions, labelGroups } = await readLabelSnapshots();
  return {
    archiveCount: archive.length,
    labelGroups,
    namedSessions: sessions.filter((session) => !session.auto),
    snapshotCount: sessions.filter((session) => session.auto).length
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
  if (!l || (item.labels ?? []).includes(l)) return;
  await upsertItem(store, { ...item, labels: [...(item.labels ?? []), l] });
  await touchLabels([l]); // F21: mark the label used (post-write; upsertItem isn't a mutateStores)
}

/** @param {string|string[]|undefined} labels */
function normalizeLabels(labels) {
  const arr = Array.isArray(labels) ? labels : labels ? [labels] : [];
  return [...new Set(arr.map((l) => String(l).trim()).filter(Boolean))];
}

const mergeLabels = (a, b) => [...new Set([...(a ?? []), ...b])];

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
  const tabs = item.tabs.map((t) => ({ ...t, labels: mergeLabels(t.labels, add) }));
  // E2-0c: record + undo entry in ONE atomic commit. F21: + the recency bump.
  await commitRecordWithJournal(store, { ...item, tabs },
    `Labeled ${tabs.length} tab${tabs.length === 1 ? "" : "s"}`, { puts: [{ store, item }] }, add);
  return tabs.length;
}

/**
 * Remove a label from an item — BOTH grains: the item-level label and every
 * ref that carries it. Journaled (P2g-2: chip × is one click, Undo must exist).
 * @param {string} store @param {object} item @param {string} label
 */
export async function removeLabel(store, item, label) {
  const tabs = item.tabs.map((t) =>
    t.labels?.includes(label) ? { ...t, labels: t.labels.filter((x) => x !== label) } : t);
  await commitRecordWithJournal(store,
    { ...item, labels: (item.labels ?? []).filter((x) => x !== label), tabs },
    `Removed label “${label}”`, { puts: [{ store, item }] });
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
  const fromItemGrain = (item.labels ?? []).includes(label);
  const tabs = item.tabs.map((t, i) => {
    if (i === index) return { ...t, labels: (t.labels ?? []).filter((x) => x !== label) };
    return fromItemGrain ? { ...t, labels: mergeLabels(t.labels, [label]) } : t;
  });
  const itemLabels = fromItemGrain ? (item.labels ?? []).filter((x) => x !== label) : item.labels;
  await commitRecordWithJournal(store, { ...item, labels: itemLabels, tabs },
    `Removed label “${label}” from a tab`, { puts: [{ store, item }] });
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
  let labeled = 0;
  const windows = session.windows.map((w, wi) =>
    w.map((t, i) => {
      if (!hit(wi, i)) return t;
      labeled += 1;
      return { ...t, labels: mergeLabels(t.labels, add) };
    })
  );
  if (labeled === 0) return 0;
  await commitRecordWithJournal(STORE_KEYS.sessions, { ...session, windows },
    `Labeled ${labeled} tab${labeled === 1 ? "" : "s"} in “${session.name}”`,
    { puts: [{ store: STORE_KEYS.sessions, item: session }] }, add); // F21: recency bump
  return labeled;
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
  const windows = session.windows.map((w, wi) => w.map((t, i) => {
    if (where && (wi !== where.wi || i !== where.i)) return t;
    if (!t.labels?.includes(label)) return t;
    return { ...t, labels: t.labels.filter((x) => x !== label) };
  }));
  await commitRecordWithJournal(STORE_KEYS.sessions, { ...session, windows },
    `Removed label “${label}”${where ? " from a tab" : ""} in “${session.name}”`,
    { puts: [{ store: STORE_KEYS.sessions, item: session }] });
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
  await mutateStores(
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
  await mutateStores(
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
  if (items.length === 0) return 0;
  const add = normalizeLabels(labels);
  const now = Date.now();
  const puts = [];
  const dels = [];
  /** @type {object[]} archive records, built OUTSIDE the lock (async newMeta) */
  const created = [];
  for (const item of items) {
    puts.push({ store: STORE_KEYS.inbox, item });
    if (add.length > 0 && item.kind === "window" && item.tabs.length > 1) {
      for (const t of item.tabs) {
        created.push({
          ...(await newMeta()),
          kind: "tab",
          tabs: [t],
          source: item.source,
          labels: mergeLabels(item.labels, add),
          archivedAt: now
        });
      }
    } else {
      created.push({ ...item, labels: mergeLabels(item.labels, add), archivedAt: now });
    }
  }
  for (const c of created) dels.push({ store: STORE_KEYS.archive, id: c.id });
  // E2-0c: every archive record + every inbox tombstone + the undo entry are
  // ONE atomic commit — the "label & archive" move can no longer half-apply.
  const entry = makeJournalEntry(
    `Archived ${items.length} item${items.length === 1 ? "" : "s"}`, { puts, dels }
  );
  // F21: this is an apply path only when labels were typed; bump those in-commit.
  const touchKeys = add.length > 0 ? [LABEL_META_KEY] : [];
  await mutateStores([STORE_KEYS.inbox, STORE_KEYS.archive, JOURNAL_KEY, ...touchKeys], (maps) => {
    const inbox = { ...(maps[STORE_KEYS.inbox] ?? {}) };
    const archive = { ...(maps[STORE_KEYS.archive] ?? {}) };
    for (const c of created) archive[c.id] = { ...c, modifiedAt: now };
    for (const item of items) {
      const cur = inbox[item.id];
      if (cur) inbox[item.id] = { ...cur, deletedAt: now, modifiedAt: now };
    }
    return {
      [STORE_KEYS.inbox]: inbox,
      [STORE_KEYS.archive]: archive,
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry),
      ...(add.length > 0 ? { [LABEL_META_KEY]: touchedLabelMeta(maps[LABEL_META_KEY], add, now) } : {})
    };
  });
  return items.length;
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
  const puts = [];
  const updated = [];
  let labeled = 0;
  for (const { item, indexes } of sources) {
    const want = new Set(indexes.filter((i) => item.tabs[i]));
    if (want.size === 0) continue;
    puts.push({ store, item });
    const tabs = item.tabs.map((t, i) => (want.has(i) ? { ...t, labels: mergeLabels(t.labels, add) } : t));
    updated.push({ ...item, tabs });
    labeled += want.size;
  }
  if (labeled === 0) return 0;
  // E2-0c: every updated record + the undo entry in ONE atomic commit.
  // F21: + the recency bump for the applied labels, in the same commit.
  const entry = makeJournalEntry(`Labeled ${labeled} tab${labeled === 1 ? "" : "s"}`, { puts });
  const now = Date.now();
  await mutateStores([store, JOURNAL_KEY, LABEL_META_KEY], (maps) => {
    const map = { ...(maps[store] ?? {}) };
    for (const u of updated) map[u.id] = { ...u, modifiedAt: now };
    return {
      [store]: map,
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry),
      [LABEL_META_KEY]: touchedLabelMeta(maps[LABEL_META_KEY], add, now)
    };
  });
  return labeled;
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
  const now = Date.now();
  const puts = [];
  const dels = [];
  const created = [];
  const applied = [];
  let archived = 0;
  for (const { item, indexes } of sources) {
    const refs = indexes.map((i) => item.tabs[i]).filter(Boolean);
    if (refs.length === 0) continue;
    puts.push({ store: STORE_KEYS.inbox, item });
    if (add.length > 0) {
      for (const t of refs) {
        created.push({
          ...(await newMeta()), kind: "tab", tabs: [t], source: item.source,
          labels: mergeLabels(item.labels, add), archivedAt: now
        });
      }
    } else {
      created.push({
        ...(await newMeta()), kind: refs.length > 1 ? "window" : "tab", tabs: refs,
        source: item.source, labels: [...(item.labels ?? [])], archivedAt: now
      });
    }
    applied.push({ item, indexes });
    archived += refs.length;
  }
  if (archived === 0) return 0;
  for (const c of created) dels.push({ store: STORE_KEYS.archive, id: c.id });
  // E2-0c: every created archive record + every inbox split + the undo entry
  // are ONE atomic commit — the tab-grain archive exit can no longer half-apply.
  const entry = makeJournalEntry(
    `Archived ${archived} tab${archived === 1 ? "" : "s"}`, { puts, dels }
  );
  // F21: only an apply path when labels were typed; bump those in-commit.
  const touchKeys = add.length > 0 ? [LABEL_META_KEY] : [];
  await mutateStores([STORE_KEYS.inbox, STORE_KEYS.archive, JOURNAL_KEY, ...touchKeys], (maps) => {
    let inbox = maps[STORE_KEYS.inbox] ?? {};
    const archive = { ...(maps[STORE_KEYS.archive] ?? {}) };
    for (const c of created) archive[c.id] = { ...c, modifiedAt: now };
    for (const { item, indexes } of applied) inbox = mapWithTabsRemoved(inbox, item, indexes, now);
    return {
      [STORE_KEYS.inbox]: inbox,
      [STORE_KEYS.archive]: archive,
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry),
      ...(add.length > 0 ? { [LABEL_META_KEY]: touchedLabelMeta(maps[LABEL_META_KEY], add, now) } : {})
    };
  });
  return archived;
}

/**
 * One-time migration: every live collection becomes an archived bundle
 * labeled with the collection's name. Idempotent (collections are
 * tombstoned as they convert; tombstones sync). Runs at worker startup.
 * @returns {Promise<number>} collections migrated
 */
export async function migrateCollectionsToLabels() {
  /** @type {import("./types.js").Collection[]} */
  const collections = await listItems(STORE_KEYS.collections);
  if (collections.length === 0) return 0;
  const now = Date.now();
  const created = [];
  for (const c of collections) {
    if (c.tabs?.length) {
      created.push({
        ...(await newMeta()),
        kind: c.tabs.length > 1 ? "window" : "tab",
        tabs: c.tabs,
        source: "manual",
        labels: [...new Set([c.name, ...(c.labels ?? [])])],
        archivedAt: now
      });
    }
  }
  // E2-0c: the whole migration commits atomically — archived bundles + every
  // collection tombstone in ONE set (idempotency via tombstones preserved).
  await mutateStores([STORE_KEYS.archive, STORE_KEYS.collections], (maps) => {
    const archive = { ...(maps[STORE_KEYS.archive] ?? {}) };
    for (const item of created) archive[item.id] = { ...item, modifiedAt: now };
    const colls = { ...(maps[STORE_KEYS.collections] ?? {}) };
    for (const c of collections) {
      const cur = colls[c.id];
      if (cur) colls[c.id] = { ...cur, deletedAt: now, modifiedAt: now };
    }
    return { [STORE_KEYS.archive]: archive, [STORE_KEYS.collections]: colls };
  });
  return collections.length;
}
