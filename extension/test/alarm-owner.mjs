import assert from "node:assert/strict";

function chromeEvent() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    async emit(...args) {
      await Promise.all(listeners.map((listener) => listener(...args)));
    }
  };
}

const onAlarm = chromeEvent();
globalThis.chrome = { alarms: { onAlarm } };

const {
  ARCHIVE_ALARM,
  DEDUP_GRACE_PREFIX,
  RECOVERY_ALARM,
  SUSPEND_ALARM,
  SUSPEND_METADATA_REPAIR_ALARM,
  installAlarmOwner
} = await import("../js/background/alarm-owner.js");

const calls = [];
let metadataRecovered = 0;
let dedupAutoClose = true;
let rejectSnapshot = false;
let collectAssets = async () => {};
let resolveSnoozeReady;
const snoozeReady = new Promise((resolve) => { resolveSnoozeReady = resolve; });

const call = (type, detail) => {
  calls.push(detail === undefined ? { type } : { type, detail });
};
const reset = () => { calls.length = 0; };

installAlarmOwner({
  assets: { async collect() { call("assets-collect"); await collectAssets(); } },
  snapshots: {
    async take() {
      call("snapshot");
      if (rejectSnapshot) throw new Error("snapshot unavailable");
    }
  },
  suspension: {
    async sweep() { call("suspend-sweep"); },
    async finishRecovery() { call("finish-recovery"); },
    async repairRecoveryMetadata() {
      call("repair-recovery-metadata", metadataRecovered);
    },
    async retryCloseCleanups() { call("retry-close-cleanups"); }
  },
  focus: {
    async endGuard() { call("focus-guard-end"); },
    async expireAccess() { call("focus-access-expiry"); }
  },
  archive: {
    async sweep() { call("archive-sweep"); },
    async expireInbox() { call("inbox-expiry"); }
  },
  rotation: { async rotate() { call("scheme-rotation"); } },
  snooze: {
    ready: snoozeReady,
    async fire(id, options) { call("snooze", { id, options }); }
  },
  duplicates: {
    ready: Promise.resolve().then(() => call("dedup-ready")),
    async readSettings() {
      call("read-settings");
      return { dedupAutoClose };
    },
    async close(options) { call("dedup-close", options); },
    refreshBadge() { call("badge"); }
  }
});

// Let the duplicate-recovery promise settle before observing alarm work.
await Promise.resolve();
reset();

await onAlarm.emit({ name: "unknown" });
assert.deepEqual(calls, [], "unknown alarms are inert");

await onAlarm.emit({ name: "auto-snapshot" });
assert.deepEqual(calls, [{ type: "snapshot" }]);

reset();
await onAlarm.emit({ name: SUSPEND_ALARM });
assert.deepEqual(calls, [{ type: "suspend-sweep" }],
  "the async suspend sweep is retained by the alarm listener");

reset();
await onAlarm.emit({ name: "focus-end" });
assert.deepEqual(calls, [], "the retired Focus alarm is inert");

reset();
await onAlarm.emit({ name: "focus-guard-end" });
await onAlarm.emit({ name: "focus-guard-expiry" });
assert.deepEqual(calls.map(({ type }) => type), [
  "focus-guard-end", "focus-access-expiry"
], "both current site-guard alarms remain distinct");

reset();
await onAlarm.emit({ name: RECOVERY_ALARM });
assert.deepEqual(calls, [{ type: "finish-recovery" }],
  "the alarm delegates the complete recovery tail to its state owner");

reset();
metadataRecovered = 0;
await onAlarm.emit({ name: SUSPEND_METADATA_REPAIR_ALARM });
assert.deepEqual(calls, [
  { type: "repair-recovery-metadata", detail: 0 }
], "the metadata alarm delegates the complete late-repair tail to its state owner");

reset();
metadataRecovered = 2;
await onAlarm.emit({ name: SUSPEND_METADATA_REPAIR_ALARM });
assert.deepEqual(calls, [{ type: "repair-recovery-metadata", detail: 2 }]);

reset();
await onAlarm.emit({ name: "suspend-close-cleanup" });
assert.deepEqual(calls, [{ type: "retry-close-cleanups" }]);

reset();
await onAlarm.emit({ name: ARCHIVE_ALARM });
assert.deepEqual(calls.map(({ type }) => type), ["archive-sweep", "inbox-expiry", "assets-collect"],
  "archive, Inbox expiry and due-only favicon cleanup share the durable sweep alarm");

let releaseCollection;
collectAssets = () => new Promise((resolve) => { releaseCollection = resolve; });
let maintenanceFinished = false;
const heldMaintenance = onAlarm.emit({ name: ARCHIVE_ALARM })
  .then(() => { maintenanceFinished = true; });
await Promise.resolve();
assert.equal(maintenanceFinished, false, "the alarm retains asynchronous collection work");
releaseCollection();
await heldMaintenance;
collectAssets = async () => {};

reset();
await onAlarm.emit({ name: "scheme-rotation" });
assert.deepEqual(calls, [{ type: "scheme-rotation" }]);

reset();
const snoozeDelivery = onAlarm.emit({ name: "snooze:snooze-one" });
await Promise.resolve();
assert.deepEqual(calls, [],
  "Snooze delivery cannot race interrupted-delivery recovery");
resolveSnoozeReady();
await snoozeDelivery;
assert.deepEqual(calls, [{
  type: "snooze",
  detail: { id: "snooze-one", options: { manual: false } }
}], "Snooze waits for recovery and fires only its alarm identity");

reset();
dedupAutoClose = false;
await onAlarm.emit({ name: `${DEDUP_GRACE_PREFIX}42` });
assert.deepEqual(calls, [{ type: "read-settings" }],
  "the duplicate grace alarm respects the current auto-close preference");

reset();
dedupAutoClose = true;
await onAlarm.emit({ name: `${DEDUP_GRACE_PREFIX}42` });
assert.deepEqual(calls, [
  { type: "read-settings" },
  { type: "dedup-close", detail: { tabId: 42, auto: true } },
  { type: "badge" }
], "duplicate grace uses the stale-guarded close path before refreshing the badge");

reset();
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args);
rejectSnapshot = true;
await onAlarm.emit({ name: "auto-snapshot" });
console.warn = originalWarn;
assert.deepEqual(calls, [{ type: "snapshot" }]);
assert.match(warnings[0]?.[0] ?? "", /automatic Snapshot failed/,
  "a domain failure is contained and named by the alarm owner");

reset();
collectAssets = async () => { throw new Error("expected collection failure"); };
console.warn = (...args) => warnings.push(args);
await onAlarm.emit({ name: ARCHIVE_ALARM });
console.warn = originalWarn;
assert.deepEqual(calls.map(({ type }) => type), ["archive-sweep", "inbox-expiry", "assets-collect"]);
assert.match(warnings.at(-1)?.[0] ?? "", /unused Library favicon cleanup failed/);

console.log("PASS: one background owner routes every alarm");
