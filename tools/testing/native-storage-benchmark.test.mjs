// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { externalizeEmbeddedFavicons } from "../../extension/js/lib/storage/assets.js";
import { makeFixture, verifyRows, verifyCheckpointRows, summarize } from "../../extension/test/native-storage-benchmark-page.mjs";

const fixture = makeFixture({ records: 12, icons: 3 });
assert.equal(new Set(fixture.map(value => value.id)).size, 12);
assert.equal(new Set(fixture.map(value => value.tabs[0].favIconUrl)).size, 3);
assert.equal(new Set(makeFixture({ records: 12, icons: 12 }).map(value => value.tabs[0].favIconUrl)).size, 12);
for (const invalid of [{ records: 0, icons: 1 }, { records: 2, icons: 3 }, { records: 2.5, icons: 1 }]) {
  assert.throws(() => makeFixture(invalid));
}
const rows = fixture.map(value => ({ family: "inbox", lifecycle: "live", id: value.id, value }));
verifyRows([...rows].reverse(), fixture);
for (const damage of [
  values => values.pop(),
  values => { values[1] = values[0]; },
  values => { values[0].value.tabs[0].favIconUrl = "missing"; },
  values => { values[0].value.labels.push("unexpected"); },
  values => { values[0].lifecycle = "deleted"; },
  values => { values[0].family = "sessions"; },
  values => { values[0].value.extra = true; }
]) {
  const corrupted = structuredClone(rows); damage(corrupted);
  assert.throws(() => verifyRows(corrupted, fixture));
}
const edited = structuredClone(fixture);
edited[0].labels.push("new-label");
// These checkpoints are internally plausible but stale or wrong for this workload.
assert.throws(() => verifyCheckpointRows({ entities: rows, assets: [] }, edited));
const substituted = structuredClone(rows);
substituted[0].id = "replacement";
assert.throws(() => verifyCheckpointRows({ entities: substituted, assets: [] }, fixture));
verifyCheckpointRows({ entities: rows, assets: [] }, fixture);
const encoded = await externalizeEmbeddedFavicons(rows);
const encodedCheckpoint = { entities: encoded.value, assets: encoded.assets };
assert.equal(encodedCheckpoint.entities[0].value.tabs[0].favIconUrl, undefined);
verifyCheckpointRows(encodedCheckpoint, fixture);
assert.throws(() => verifyCheckpointRows(encodedCheckpoint, edited));
const wrongAsset = structuredClone(encodedCheckpoint);
wrongAsset.assets[0].dataUrl = "data:image/svg+xml,wrong";
assert.throws(() => verifyCheckpointRows(wrongAsset, fixture));
assert.deepEqual(summarize([10, 1, 4, 3]), { samples: [10, 1, 4, 3], count: 4, minMs: 1, maxMs: 10, medianMs: 3.5 });
assert.equal(summarize([7, 1, 3]).medianMs, 3);
for (const invalid of [[], [NaN], [Infinity], [-1]]) assert.throws(() => summarize(invalid));
console.log("PASS native measurement fixture, corruption oracles and raw-sample summaries");
