import assert from "node:assert/strict";

function chromeEvent() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { listeners.forEach((listener) => listener(...args)); }
  };
}

const onChanged = chromeEvent();
globalThis.chrome = { storage: { onChanged } };

const { installSettingsChangeOwner } = await import(
  "../js/background/settings-change-owner.js"
);

const calls = [];
let rejectSnapshot = false;
let rejectInbox = false;
installSettingsChangeOwner({
  recordStorageChange(changes, area) {
    calls.push({ type: "record", changes, area });
  },
  ensureSnapshotAlarm() {
    calls.push({ type: "snapshot" });
    return rejectSnapshot ? Promise.reject(new Error("snapshot failed")) : Promise.resolve();
  },
  ensureArchiveAlarm() { calls.push({ type: "archive" }); },
  ensureSchemeRotationAlarm() { calls.push({ type: "rotation" }); },
  refreshBadge() { calls.push({ type: "badge" }); },
  scheduleAutoSaveCapSweep() { calls.push({ type: "auto-save-cap" }); },
  sweepInboxExpiry() {
    calls.push({ type: "inbox-expiry" });
    return rejectInbox ? Promise.reject(new Error("expiry failed")) : Promise.resolve();
  },
  focusRulesChanged() { calls.push({ type: "focus-rules" }); },
  uiLanguageChanged() { calls.push({ type: "ui-language" }); }
});

const callTypes = () => calls.map(({ type }) => type);
const reset = () => { calls.length = 0; };

onChanged.emit({ settings: { newValue: {} } }, "sync");
assert.deepEqual(callTypes(), ["record"],
  "non-local Settings changes are recorded but never run local maintenance");

reset();
onChanged.emit({ inbox: { newValue: {} } }, "local");
assert.deepEqual(callTypes(), ["record"],
  "unrelated local changes are recorded but never run Settings maintenance");

reset();
const logicalSettingsChange = {};
onChanged.emit({
  storageV2Revision: {
    newValue: {
      changedKeys: ["settings"],
      logicalChanges: { settings: logicalSettingsChange }
    }
  }
}, "local");
assert.deepEqual(callTypes(), [
  "record", "snapshot", "archive", "rotation", "badge",
  "auto-save-cap", "inbox-expiry", "focus-rules", "ui-language"
], "a value-free Settings pulse takes every safe repair path");
assert.equal(calls[0].changes.settings, logicalSettingsChange,
  "diagnostics receive the expanded logical Settings change");

reset();
onChanged.emit({
  settings: {
    oldValue: {
      snapshotEveryMinutes: 15,
      autoSaveMaxTabs: 50,
      inboxExpiryDays: 30,
      uiScheme: "ink"
    },
    newValue: {
      snapshotEveryMinutes: 15,
      autoSaveMaxTabs: 50,
      inboxExpiryDays: 30,
      uiScheme: "cream"
    }
  }
}, "local");
assert.deepEqual(callTypes(), ["record", "archive", "rotation", "badge", "focus-rules"],
  "an unrelated preference does not restart Snapshot or threshold work");

reset();
onChanged.emit({
  settings: {
    oldValue: { snapshotEveryMinutes: 15, autoSaveMaxTabs: 50, inboxExpiryDays: 30, uiLanguage: "system" },
    newValue: { snapshotEveryMinutes: 15, autoSaveMaxTabs: 50, inboxExpiryDays: 30, uiLanguage: "fr" }
  }
}, "local");
assert.deepEqual(callTypes(), ["record", "archive", "rotation", "badge", "focus-rules", "ui-language"],
  "a changed interface language reinstalls the worker's message lookup");

reset();
onChanged.emit({
  settings: {
    oldValue: { snapshotEveryMinutes: 60, autoSaveMaxTabs: 50, inboxExpiryDays: 30 },
    newValue: { snapshotEveryMinutes: 5, autoSaveMaxTabs: 51, inboxExpiryDays: 31 }
  }
}, "local");
assert.deepEqual(callTypes(), [
  "record", "snapshot", "archive", "rotation", "badge",
  "auto-save-cap", "inbox-expiry", "focus-rules"
], "each changed schedule or threshold runs its immediate repair");

reset();
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args);
rejectSnapshot = true;
rejectInbox = true;
onChanged.emit({ settings: {} }, "local");
await new Promise((resolve) => setTimeout(resolve, 0));
console.warn = originalWarn;
assert.deepEqual(callTypes(), [
  "record", "snapshot", "archive", "rotation", "badge",
  "auto-save-cap", "inbox-expiry", "focus-rules", "ui-language"
]);
assert.equal(warnings.length, 2,
  "Snapshot and Inbox repair failures are contained and reported");

console.log("PASS: one background owner routes Settings changes");
