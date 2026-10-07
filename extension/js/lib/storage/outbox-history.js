// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Bounded replication history. All mutations share the caller's Library transaction. */
import { LIBRARY_STORES } from "./schema.js";
import { canonicalJson } from "./canonical.js";

export const OUTBOX_MAX_ENTRIES = 256;
export const OUTBOX_MAX_BYTES = 8 * 1024 * 1024;
const HISTORY_KEY = "outbox-history";
const PAGE_SIZE = 128;
const encoder = new TextEncoder();

function entryBytes(entry) {
  return encoder.encode(canonicalJson(entry)).length;
}

function exceedsBudget(history) {
  return history.entries > OUTBOX_MAX_ENTRIES || history.byteLength > OUTBOX_MAX_BYTES;
}

async function readHistory(transaction) {
  const row = await transaction.get(LIBRARY_STORES.meta, HISTORY_KEY);
  if (!row) return null;
  const history = row.value;
  if (!history || ![history.entries, history.byteLength, history.compactedThroughSequence]
    .every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("The Library change-history counters are invalid");
  }
  const sequence = (await transaction.get(LIBRARY_STORES.meta, "sequence"))?.value ?? 0;
  if (!Number.isSafeInteger(sequence) || sequence < history.compactedThroughSequence) {
    throw new Error("The Library change-history watermark is ahead of its local sequence");
  }
  return history;
}

async function readPage(transaction, deviceId, afterSequence, throughSequence) {
  return transaction.getAllByKeyRange(LIBRARY_STORES.outbox, {
    lower: [deviceId, afterSequence], upper: [deviceId, throughSequence], lowerOpen: true
  }, PAGE_SIZE);
}

async function measureExistingHistory(transaction, deviceId) {
  const history = { entries: 0, byteLength: 0, compactedThroughSequence: 0 };
  let cursor = 0;
  while (true) {
    const page = await readPage(transaction, deviceId, cursor, Number.MAX_SAFE_INTEGER);
    if (page.length === 0) return history;
    for (const entry of page) {
      history.entries += 1;
      history.byteLength += entryBytes(entry);
    }
    // Once over budget, the caller will clear the history. Avoid measuring it all.
    if (exceedsBudget(history)) return history;
    cursor = page.at(-1).sequence;
  }
}

async function removeThrough(transaction, { deviceId, throughSequence, measureBytes = true }) {
  const removed = { entries: 0, byteLength: 0 };
  let cursor = 0;
  while (cursor < throughSequence) {
    const page = await readPage(transaction, deviceId, cursor, throughSequence);
    if (page.length === 0) break;
    for (const entry of page) {
      await transaction.delete(LIBRARY_STORES.outbox, [deviceId, entry.sequence]);
      removed.entries += 1;
      if (measureBytes) removed.byteLength += entryBytes(entry);
    }
    cursor = page.at(-1).sequence;
  }
  return removed;
}

/** Append a committed change set; trim only its redundant history, never entities. */
export async function recordOutboxChanges(transaction, { deviceId, changes }) {
  if (changes.length === 0) return;
  const history = await readHistory(transaction) ?? await measureExistingHistory(transaction, deviceId);
  for (const { sequence, entity } of changes) {
    const entry = { deviceId, sequence, committedAt: entity.version.wallTime, entity };
    await transaction.put(LIBRARY_STORES.outbox, entry);
    history.entries += 1;
    history.byteLength += entryBytes(entry);
  }
  if (exceedsBudget(history)) {
    const sequence = changes.at(-1).sequence;
    await removeThrough(transaction, { deviceId, throughSequence: sequence, measureBytes: false });
    history.entries = 0;
    history.byteLength = 0;
    history.compactedThroughSequence = sequence;
  }
  await transaction.put(LIBRARY_STORES.meta, { key: HISTORY_KEY, value: history });
}

/** Acknowledgement and counter updates are atomic; deliberate trimming is separate. */
export async function acknowledgeOutboxHistory(transaction, { deviceId, throughSequence }) {
  const history = await readHistory(transaction);
  const removed = await removeThrough(transaction, {
    deviceId, throughSequence, measureBytes: Boolean(history)
  });
  if (history) {
    history.entries -= removed.entries;
    history.byteLength -= removed.byteLength;
    if (history.entries < 0 || history.byteLength < 0) {
      throw new Error("The Library change-history counters do not match its entries");
    }
    await transaction.put(LIBRARY_STORES.meta, { key: HISTORY_KEY, value: history });
  }
  return removed.entries;
}

/** Read in the same transaction as a batch so concurrent trimming cannot hide a gap. */
export async function readCompactedSequence(transaction) {
  return (await readHistory(transaction))?.compactedThroughSequence ?? 0;
}
