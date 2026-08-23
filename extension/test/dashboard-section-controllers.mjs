import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createArchiveSurface } from "../js/ui/archive-surface.js";
import {
  createDuplicatesSurface, DUPLICATE_KEEP_RULE
} from "../js/ui/duplicates-surface.js";
import { createStatsSurface } from "../js/ui/stats-surface.js";
import {
  activityDayLabel, createActivitySurface
} from "../js/ui/activity-surface.js";
import { createDataSurface } from "../js/ui/data-surface.js";
import { createSnapshotsSurface } from "../js/ui/snapshots-surface.js";
import { createSnoozedSurface } from "../js/ui/snoozed-surface.js";
import { createVaultSurface } from "../js/ui/vault-surface.js";

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => {} }
});

const noop = () => {};
const common = { getBody: noop, setHeading: noop };

assert.deepEqual(Object.keys(createArchiveSurface({
  ...common, renderLabels: noop, goToLabel: noop, copyRefs: noop
})), ["render"], "Archive exposes one narrow render interface");
assert.deepEqual(Object.keys(createDuplicatesSurface({
  ...common, msg: noop
})), ["render"], "Duplicates exposes one narrow render interface");
assert.deepEqual(Object.keys(createStatsSurface(common)), ["render"],
  "Stats exposes one narrow render interface");
assert.deepEqual(Object.keys(createActivitySurface({
  ...common,
  getHeading: noop,
  showNotice: noop,
  queueRefresh: noop,
  download: noop
})), ["render"], "Activity exposes one narrow render interface");
assert.deepEqual(Object.keys(createDataSurface({
  ...common, onChanged: noop
})), ["render"], "Data exposes one narrow render interface");
assert.deepEqual(Object.keys(createSnapshotsSurface({
  ...common,
  renderLabels: noop,
  renderSnoozes: noop,
  goToLabel: noop,
  showNotice: noop
})), ["render"], "Snapshots exposes one narrow render interface");
assert.deepEqual(Object.keys(createSnoozedSurface({
  ...common, showNotice: noop
})), ["render"], "Snoozed exposes one narrow render interface");
assert.deepEqual(Object.keys(createVaultSurface({
  ...common,
  getBanner: noop,
  onStateChange: noop,
  showNotice: noop,
  goToVault: noop
})), ["render", "pillState", "start", "schedule"],
"Vault exposes only its render, pill projection, and sync lifecycle");

if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
else delete globalThis.localStorage;

const noon = (day) => new Date(2026, 7, day, 12).getTime();
assert.equal(activityDayLabel(noon(22), noon(22)), "Today");
assert.equal(activityDayLabel(noon(21), noon(22)), "Yesterday");
assert.ok(activityDayLabel(noon(20), noon(22)).length > 0,
  "older Activity buckets retain a localized date label");
assert.match(DUPLICATE_KEEP_RULE, /Pinned tabs are never closed\.$/,
  "the Duplicates controller owns the complete survivor explanation");

const dashboardSource = readFileSync(
  new URL("../js/ui/dashboard.js", import.meta.url),
  "utf8"
);
for (const factory of [
  "createArchiveSurface", "createDuplicatesSurface", "createStatsSurface", "createActivitySurface",
  "createDataSurface", "createSnapshotsSurface", "createSnoozedSurface", "createVaultSurface"
]) {
  assert.match(dashboardSource, new RegExp(`${factory}\\(`),
    `Dashboard composes ${factory}`);
}
for (const moduleName of [
  "archive-surface", "duplicates-surface", "stats-surface", "activity-surface",
  "data-surface", "snapshots-surface", "snoozed-surface", "vault-surface"
]) {
  assert.match(dashboardSource, new RegExp(`import\\("\\./${moduleName}\\.js"\\)`),
    `${moduleName} stays outside the Open-tabs static module graph`);
  assert.doesNotMatch(dashboardSource,
    new RegExp(`^import .+ from ["']\\./${moduleName}\\.js["'];`, "m"),
    `${moduleName} is not a cold Dashboard dependency`);
}
assert.match(dashboardSource,
  /const primaryPaintReady = primaryOpenReady\.then[\s\S]*requestAnimationFrame\(afterFrame\);[\s\S]*setTimeout\(afterFrame, 250\);[\s\S]*primaryPaintReady\.then\(\(\) => \{[\s\S]*surface\.start\(\)[\s\S]*3000/,
  "secondary controllers and Vault start only after the primary Open ledger receives a paint opportunity");
for (const formerOwner of [
  "renderArchiveInner", "renderDuplicatesInner", "renderStatsInner", "renderActivityInner",
  "renderDataSection", "renderSnapshotsInner", "renderSnoozesInner", "renderVaultInner", "runSync"
]) {
  assert.doesNotMatch(dashboardSource, new RegExp(`function ${formerOwner}\\(`),
    `Dashboard no longer owns ${formerOwner}`);
}
for (const domainImport of ["journal.js", "portable-state.js", "counters.js", "tabs.js"]) {
  assert.doesNotMatch(dashboardSource, new RegExp(`from ["'][^"']*${domainImport}`),
    `Dashboard no longer imports the ${domainImport} dependency owned by a controller`);
}

console.log("PASS: Dashboard section controllers expose narrow render-only interfaces");
