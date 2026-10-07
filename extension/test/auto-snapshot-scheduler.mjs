/** Regression contract for the MV3 automatic-Snapshot scheduler. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SNAPSHOT_ALARM, reconcileSnapshotAlarm, snapshotCadenceChanged,
  snapshotPeriodMinutes
} from "../js/lib/snapshot-schedule.js";

assert.equal(snapshotPeriodMinutes({ snapshotEveryMinutes: 5 }), 5);
assert.equal(snapshotPeriodMinutes({ snapshotEveryMinutes: 1 }), 5);
assert.equal(snapshotPeriodMinutes({}), 15);
assert.equal(snapshotCadenceChanged({
  oldValue: { snapshotEveryMinutes: 5, uiScheme: "ink" },
  newValue: { snapshotEveryMinutes: 5, uiScheme: "aladdin" }
}), false, "an unrelated Settings change cannot postpone the Snapshot alarm");
assert.equal(snapshotCadenceChanged({
  oldValue: { snapshotEveryMinutes: 60 },
  newValue: { snapshotEveryMinutes: 5 }
}), true, "a cadence change repairs the Snapshot alarm immediately");
assert.equal(snapshotCadenceChanged({}), true,
  "an old revision pulse without logical values takes the safe repair path");

let currentAlarm = null;
const creates = [];
const alarms = {
  get: async (name) => name === SNAPSHOT_ALARM ? currentAlarm : null,
  create: async (name, options) => {
    creates.push({ name, options });
    currentAlarm = { name, ...options };
  }
};
assert.equal(await reconcileSnapshotAlarm({
  alarms, readSettings: async () => ({ snapshotEveryMinutes: 5 })
}), true);
assert.deepEqual(creates, [{
  name: SNAPSHOT_ALARM, options: { periodInMinutes: 5 }
}]);
assert.equal(await reconcileSnapshotAlarm({
  alarms, readSettings: async () => ({ snapshotEveryMinutes: 5 })
}), false, "repair preserves the current scheduled time when cadence is already correct");
assert.equal(creates.length, 1);

const alarmOwner = readFileSync(
  new URL("../js/background/alarm-owner.js", import.meta.url), "utf8"
);
const settingsOwner = readFileSync(
  new URL("../js/background/settings-change-owner.js", import.meta.url), "utf8"
);

assert.match(settingsOwner,
  /if \(snapshotCadenceChanged\(changes\.settings\)\) \{[\s\S]{0,80}void ensureSnapshotAlarm\(\)/,
  "unrelated Settings writes must not postpone the next automatic Snapshot");
assert.match(alarmOwner,
  /if \(name === SNAPSHOT_ALARM\) \{[\s\S]{0,120}await runAlarm\("automatic Snapshot", snapshots\.take\)/,
  "the alarm event must retain ownership until the automatic Snapshot is durable");
console.log("auto-snapshot scheduler regression contract passed");
