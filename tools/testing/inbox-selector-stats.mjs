// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";

const LIMIT = 100_000;
const finite = value => Number.isFinite(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const safeFile = value => typeof value === "string" && value.length <= 512 &&
  /^css\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.css$/.test(value);
const safeSelector = value => typeof value === "string" && value.length > 0 && value.length <= 8192 &&
  !/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/.test(value) && value.trim().length > 0;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const MARKERS = new Set(["inbox:departure", "inbox:injected"]);

/**
 * CSSOM selectorText entries must come only from caller-verified owned stylesheets.
 * Match exact CSSOM selectors, never substrings or comma-split fragments.
 * Internal whitespace can be meaningful in quoted values and escaped names.
 * SelectorStats totals describe the preceding same-thread UpdateLayoutTree pass;
 * the stats event itself measures serialization overhead. Include only complete
 * passes inside the marker interval. Do not prorate crossing passes or infer
 * individual timings from grouped rules that do not match the allowlist.
 * Only allowlisted strings and validated numbers are retained after accept().
 * @param {{selectors:Array<{file:string,selector:string}>}} options
 * @returns {{accept:(events:object[])=>void,read:()=>object}}
 */
export function createInboxSelectorStats({ selectors }) {
  assert.ok(Array.isArray(selectors) && selectors.length > 0 && selectors.length <= 20_000,
    "Selector statistics require a bounded static selector allowlist");
  const allowed = new Map();
  for (const entry of selectors) {
    assert.ok(entry && safeFile(entry.file) && safeSelector(entry.selector), "Selector allowlist entry is invalid");
    const selector = entry.selector;
    const files = allowed.get(selector) ?? new Set();
    files.add(entry.file);
    allowed.set(selector, files);
  }
  const markers = new Map(), layouts = [], stats = [];
  let invalidMarkers = false, invalidEvents = 0, retainedRows = 0;
  function accept(events) {
    assert.ok(Array.isArray(events) && events.length <= LIMIT, "Selector trace event batch is invalid");
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      const { name, ph, pid, tid, ts, dur } = event;
      const validIdentity = count(pid) && count(tid) && finite(ts);
      if (MARKERS.has(name)) {
        if (!validIdentity || !["R", "I", "i"].includes(ph) || markers.has(name)) invalidMarkers = true;
        else markers.set(name, { pid, tid, ts });
        continue;
      }
      if (name !== "SelectorStats" && name !== "UpdateLayoutTree") continue;
      if (!validIdentity || ph !== "X" || !finite(dur) || !Number.isFinite(ts + dur)) {
        invalidEvents++; continue;
      }
      assert.ok(layouts.length + stats.length < LIMIT, "Selector trace event capacity exceeded");
      if (name === "UpdateLayoutTree") { layouts.push({ pid, tid, ts, end: ts + dur }); continue; }
      const rows = event.args?.selector_stats?.selector_timings;
      if (!Array.isArray(rows)) { invalidEvents++; continue; }
      retainedRows += rows.length;
      assert.ok(retainedRows <= LIMIT, "Selector trace row capacity exceeded");
      const entry = { pid, tid, ts, rows: [], invalidRows: 0, unknownSelectorRows: 0, unknownElapsedUs: 0 };
      for (const row of rows) {
        if (!row || !safeSelector(row.selector) || !finite(row["elapsed (us)"]) ||
            ![row.match_attempts, row.fast_reject_count, row.match_count].every(count)) {
          entry.invalidRows++; continue;
        }
        const selector = row.selector;
        if (!allowed.has(selector)) {
          entry.unknownSelectorRows++;
          entry.unknownElapsedUs += row["elapsed (us)"];
          assert.ok(Number.isFinite(entry.unknownElapsedUs), "Selector statistics total is invalid");
          continue;
        }
        entry.rows.push({ selector, elapsedUs: row["elapsed (us)"], matchAttempts: row.match_attempts,
          fastRejectCount: row.fast_reject_count, matchCount: row.match_count });
      }
      stats.push(entry);
    }
  }
  function read() {
    const start = markers.get("inbox:departure"), end = markers.get("inbox:injected");
    assert.ok(!invalidMarkers && start && end && start.pid === end.pid && start.tid === end.tid && end.ts >= start.ts,
      "Selector trace requires one ordered marker pair on the same renderer thread");
    const excluded = { invalidEvents, wrongThreadEvents: 0, unpairedStatsEvents: 0,
      ambiguousStatsEvents: 0, outsideIntervalEvents: 0, invalidRows: 0, unknownSelectorRows: 0, unknownElapsedUs: 0 };
    const ownLayouts = layouts.filter(layout => layout.pid === start.pid && layout.tid === start.tid);
    const pairs = new Map();
    for (const event of stats) {
      if (event.pid !== start.pid || event.tid !== start.tid) { excluded.wrongThreadEvents++; continue; }
      const preceding = ownLayouts.filter(layout => layout.end <= event.ts).sort((a, b) => b.end - a.end);
      if (!preceding.length) { excluded.unpairedStatsEvents++; continue; }
      if ((preceding[1] && preceding[1].end === preceding[0].end) ||
          ownLayouts.some(layout => layout.ts <= event.ts && layout.end > event.ts)) {
        excluded.ambiguousStatsEvents++; continue;
      }
      const layout = preceding[0];
      const entries = pairs.get(layout) ?? [];
      entries.push(event); pairs.set(layout, entries);
    }
    const totals = new Map();
    let includedStatsEvents = 0;
    for (const [layout, entries] of pairs) {
      if (entries.length !== 1) { excluded.ambiguousStatsEvents += entries.length; continue; }
      const event = entries[0];
      if (layout.ts < start.ts || layout.end > end.ts || layout.ts >= end.ts || event.ts >= end.ts) {
        excluded.outsideIntervalEvents++; continue;
      }
      includedStatsEvents++;
      excluded.invalidRows += event.invalidRows;
      excluded.unknownSelectorRows += event.unknownSelectorRows;
      excluded.unknownElapsedUs += event.unknownElapsedUs;
      assert.ok(Number.isFinite(excluded.unknownElapsedUs), "Selector statistics total is invalid");
      for (const row of event.rows) {
        const total = totals.get(row.selector) ?? { selector: row.selector, files: [...allowed.get(row.selector)].sort(compare),
          elapsedUs: 0, matchAttempts: 0, fastRejectCount: 0, matchCount: 0, samples: 0 };
        total.elapsedUs += row.elapsedUs;
        for (const field of ["matchAttempts", "fastRejectCount", "matchCount"]) total[field] += row[field];
        total.samples++;
        assert.ok(finite(total.elapsedUs) && [total.matchAttempts, total.fastRejectCount, total.matchCount, total.samples].every(count),
          "Selector statistics total is invalid");
        totals.set(row.selector, total);
      }
    }
    return { intervalMs: (end.ts - start.ts) / 1000, observedStatsEvents: stats.length, includedStatsEvents,
      selectors: [...totals.values()].sort((a, b) => b.elapsedUs - a.elapsedUs || compare(a.selector, b.selector)), excluded };
  }
  return { accept, read };
}
