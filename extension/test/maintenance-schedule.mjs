import assert from "node:assert/strict";
import { createMaintenanceSchedule } from "../js/background/maintenance-schedule.js";
import { ARCHIVE_ALARM, SUSPEND_ALARM } from "../js/background/alarm-owner.js";
import { SNAPSHOT_ALARM } from "../js/lib/snapshot-schedule.js";

const creates = [];
const warnings = [];
const scheduled = [];
const cancelled = [];
let settings = { snapshotEveryMinutes: 30, autoSaveMaxTabs: 50 };
let sweeps = 0;
const owner = createMaintenanceSchedule({
  alarms: {
    async get() { return null; },
    async create(name, options) { creates.push([name, options]); }
  },
  async readSettings() { return settings; },
  async archiveSweep() { sweeps += 1; },
  schedule(callback, delay) {
    const handle = { callback, delay, id: scheduled.length + 1 };
    scheduled.push(handle);
    return handle;
  },
  cancel: (handle) => cancelled.push(handle),
  warn: (...args) => warnings.push(args)
});

assert.equal(await owner.ensureSnapshotAlarm(), true);
await owner.ensureSuspendAlarm();
await owner.ensureArchiveAlarm();
assert.deepEqual(creates, [
  [SNAPSHOT_ALARM, { periodInMinutes: 30 }],
  [SUSPEND_ALARM, { periodInMinutes: 5 }],
  [ARCHIVE_ALARM, { periodInMinutes: 15 }]
], "each maintenance task keeps its exact production cadence");

owner.scheduleAutoSaveCapSweep();
owner.scheduleAutoSaveCapSweep();
assert.equal(scheduled.length, 2);
assert.deepEqual(cancelled, [scheduled[0]], "a burst retains only the newest cap timer");
assert.equal(scheduled[1].delay, 900);
await scheduled[1].callback();
assert.equal(sweeps, 1, "an enabled tab cap runs one Archive sweep");

settings = { autoSaveMaxTabs: 0 };
owner.scheduleAutoSaveCapSweep();
await scheduled.at(-1).callback();
assert.equal(sweeps, 1, "a disabled tab cap performs no Archive work");

settings = { autoSaveMaxTabs: 10 };
const failed = createMaintenanceSchedule({
  alarms: { async get() { return null; }, async create() {} },
  async readSettings() { return settings; },
  async archiveSweep() { throw Object.create(null, {
    name: { get() { throw new Error("private name getter"); } },
    code: { get() { throw new Error("private code getter"); } },
    message: { get() { throw new Error("private message getter"); } }
  }); },
  schedule(callback) { scheduled.push({ callback, id: "failure" }); return "failure"; },
  cancel() {},
  warn: (...args) => warnings.push(args)
});
failed.scheduleAutoSaveCapSweep();
await scheduled.at(-1).callback();
assert.deepEqual(warnings.at(-1), ["EveryTab: maximum-open-tabs Auto-save failed [name:UnknownError]"],
  "injected warning sink receives one bounded line even for hostile error getters");

console.log("PASS: maintenance schedules own exact cadences and one debounced cap sweep");
