// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Atomic commit boundary for parsed third-party imports. */
import { ARCHIVE_OVERLAY_KEY, STORE_KEYS } from "./types.js";
import { newMeta, mutateNamedSessionStores, mutateStores } from "./store.js";
import { LABEL_META_KEY, touchedLabelMeta } from "./label-meta.js";
import { JOURNAL_KEY, makeJournalEntry, appendedJournal } from "./journal.js";
import { importCounts } from "./import-formats.js";
import { importDefaultSessionName, importJournalDescription } from "./import-copy.js";

const DESTINATIONS = new Set(["inbox", "archive", "session"]);

function preparedTabs(group, keepLabels) {
  return (group?.tabs ?? [])
    .filter((tab) => /^https?:/i.test(String(tab?.url ?? "")))
    .map((tab) => {
      const copy = structuredClone(tab);
      if (!keepLabels) delete copy.labels;
      return copy;
    });
}

/**
 * Persist a complete parsed import and its one inverse as a single storage set.
 * All record metadata is prepared before the lock; the mutator either writes
 * every destination record plus Journal/label recency, or writes nothing.
 *
 * @param {{name?:string,source?:string,groups?:{name?:string,tabs?:import("./types.js").TabRef[]}[]}} parsed
 * @param {{destination:"inbox"|"archive"|"session",keepLabels?:boolean}} options
 * @returns {Promise<{ok:boolean,reason:"imported"|"empty"|"invalid-destination"|"collision",entry:import("./types.js").JournalEntry|null,createdCount:number,tabCount:number}>}
 */
export async function commitParsedImport(parsed, {
  destination,
  keepLabels = true
} = {}) {
  if (!DESTINATIONS.has(destination)) {
    return { ok: false, reason: "invalid-destination", entry: null, createdCount: 0, tabCount: 0 };
  }
  const groups = (parsed?.groups ?? [])
    .map((group) => ({ name: String(group?.name ?? ""), tabs: preparedTabs(group, keepLabels) }))
    .filter((group) => group.tabs.length > 0);
  const counts = importCounts(groups);
  if (counts.tabs === 0) {
    return { ok: false, reason: "empty", entry: null, createdCount: 0, tabCount: 0 };
  }

  const records = [];
  if (destination === "session") {
    records.push({
      ...(await newMeta()),
      name: String(parsed?.name ?? "").trim() || importDefaultSessionName(),
      auto: false,
      windows: groups.map((group) => group.tabs),
      labels: []
    });
  } else {
    for (const group of groups) {
      records.push({
        ...(await newMeta()),
        kind: group.tabs.length > 1 ? "window" : "tab",
        tabs: group.tabs,
        source: "manual",
        labels: []
      });
    }
  }

  const store = destination === "session"
    ? STORE_KEYS.sessions
    : destination === "archive" ? STORE_KEYS.archive : STORE_KEYS.inbox;
  const labels = [...new Set(groups.flatMap((group) =>
    group.tabs.flatMap((tab) => tab.labels ?? [])))];
  const now = Date.now();
  if (destination === "archive") {
    for (const record of records) record.archivedAt = now;
  }
  const created = records.map((record) => ({ store, id: record.id }));
  const entry = makeJournalEntry(
    importJournalDescription(counts.tabs, parsed?.source),
    { dels: created }
  );
  let result = {
    ok: false, reason: "collision", entry: null, createdCount: 0, tabCount: 0
  };
  const keys = [store, JOURNAL_KEY, ...(labels.length ? [LABEL_META_KEY] : []),
    ...(destination === "archive" ? [ARCHIVE_OVERLAY_KEY] : [])];
  const commit = destination === "session" ? mutateNamedSessionStores : mutateStores;
  await commit(keys, (maps) => {
    const current = maps[store] ?? {};
    if (records.some((record) => Object.hasOwn(current, record.id))) return null;

    const written = Object.fromEntries(records.map((record) => [record.id, {
      ...record,
      modifiedAt: now
    }]));
    const sets = {
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry),
      ...(labels.length ? {
        [LABEL_META_KEY]: touchedLabelMeta(maps[LABEL_META_KEY], labels, now)
      } : {})
    };
    if (destination === "archive") {
      sets[ARCHIVE_OVERLAY_KEY] = { ...(maps[ARCHIVE_OVERLAY_KEY] ?? {}), ...written };
    } else {
      sets[store] = { ...current, ...written };
    }
    result = {
      ok: true,
      reason: "imported",
      entry,
      createdCount: records.length,
      tabCount: counts.tabs
    };
    return sets;
  });
  return result;
}
