import assert from "node:assert/strict";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";
import { createMockLockManager } from "./e2-mocks.mjs";

Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});

let mode, liveTabs, snapshot, updates, nextCreateModes;
globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://test/${path}` },
  storage: { local: {
    get: async () => ({ sessions: { snapshot } }),
    set: async () => { if (mode === "binding-failed") throw new Error("binding unavailable"); }
  } },
  tabs: {
    query: async ({ windowId } = {}) => {
      if (windowId !== undefined && mode.startsWith("query-failed")) throw new Error("query unavailable");
      return structuredClone(liveTabs);
    },
    update: async (id, patch) => {
      updates.push(id);
      if (mode === "pin-failed" && id === 11) throw new Error("pin unavailable");
      return { id, ...patch };
    }
  },
  windows: { create: async ({ url }) => {
    if (nextCreateModes.length) mode = nextCreateModes.shift();
    liveTabs = url.map((href, index) => ({ id: 11 + index, windowId: 10, index, url: href }));
    if (mode === "create-rejected") throw new Error("create acknowledgement unavailable");
    if (mode === "create-invalid-id") return { tabs: structuredClone(liveTabs) };
    if (mode === "partial") liveTabs.shift();
    if (mode === "duplicate" || mode === "query-failed-partial-payload") liveTabs.pop();
    return { id: 10, ...(mode === "query-failed-no-payload" ? {} : { tabs: structuredClone(liveTabs) }) };
  } }
};
installBrowserMapStorageAuthority();
const { recoverMissingSnapshotTabs } = await import("../js/lib/snapshot-recovery.js");
const { restoreWindowRefs, restoreWindowRefsWithReceipt } = await import("../js/lib/sessions.js");
function reset(nextMode) {
  mode = nextMode;
  liveTabs = [];
  updates = [];
  nextCreateModes = [];
  snapshot = { id: "snapshot", auto: true, createdAt: 1, modifiedAt: 1,
    windows: [[{ url: "https://first.example/", pinned: true },
      { url: mode === "duplicate" ? "https://first.example/" : "https://second.example/", pinned: true }]] };
}

// Exact public shapes matter: the per-window receipt always carries every field,
// while Snapshot recovery omits zero uncertain/degraded counts for compatibility.
const completeWindow = {
  windowId: 10, restored: 2, failed: 0, uncertain: 0, degraded: false, error: null
};
const completeRecovery = {
  ok: true, requested: 2, restored: 2, windows: 1, unavailable: 0, failed: 0
};
const outcomeCases = [
  { mode: "healthy", window: completeWindow, recovery: completeRecovery },
  { mode: "partial",
    window: { ...completeWindow, restored: 1, failed: 1 },
    recovery: { ...completeRecovery, ok: false, restored: 1, failed: 1 } },
  { mode: "duplicate",
    window: { ...completeWindow, restored: 1, failed: 1 },
    recovery: { ...completeRecovery, ok: false, restored: 1, failed: 1 } },
  { mode: "pin-failed",
    window: { ...completeWindow, degraded: true, error: "pin unavailable" },
    recovery: { ...completeRecovery, ok: false, degraded: 1 } },
  { mode: "query-failed-with-payload",
    window: { ...completeWindow, error: "query unavailable" },
    recovery: completeRecovery },
  { mode: "query-failed-partial-payload",
    window: { ...completeWindow, restored: 1, uncertain: 1, error: "query unavailable" },
    recovery: { ...completeRecovery, ok: false, restored: 1, uncertain: 1 } },
  { mode: "query-failed-no-payload",
    window: { ...completeWindow, restored: 0, uncertain: 2, error: "query unavailable" },
    recovery: { ...completeRecovery, ok: false, restored: 0, uncertain: 2 } },
  { mode: "create-rejected",
    window: { ...completeWindow, windowId: null, restored: 0, uncertain: 2,
      error: "create acknowledgement unavailable" },
    recovery: { ...completeRecovery, ok: false, restored: 0, windows: 0, uncertain: 2 } },
  { mode: "create-invalid-id",
    window: { ...completeWindow, windowId: null, restored: 0, uncertain: 2 },
    recovery: { ...completeRecovery, ok: false, restored: 0, windows: 0, uncertain: 2 } }
];
for (const outcome of outcomeCases) {
  reset(outcome.mode);
  const receipt = await restoreWindowRefsWithReceipt(snapshot.windows[0]);
  assert.deepEqual({ ...receipt, error: receipt.error?.message ?? receipt.error }, outcome.window,
    `${outcome.mode}: exact per-window accounting and error presence`);
  reset(outcome.mode);
  assert.deepEqual(await recoverMissingSnapshotTabs("snapshot", ["0:0", "0:1"]), outcome.recovery,
    `${outcome.mode}: exact aggregate accounting and optional-field presence`);
}

reset("healthy");
assert.deepEqual(await restoreWindowRefsWithReceipt([{ url: "chrome://settings/" }]), {
  windowId: null, restored: 0, failed: 1, uncertain: 0, degraded: false, error: null
}, "invalid references are failed occurrences without a browser effect");
assert.deepEqual(await recoverMissingSnapshotTabs("snapshot", ["invalid"]), {
  ok: false, requested: 0, restored: 0, windows: 0, unavailable: 0, failed: 0
}, "invalid picks preserve the empty unsuccessful receipt");
snapshot.auto = false;
assert.deepEqual(await recoverMissingSnapshotTabs("snapshot", ["0:0", "0:1"]), {
  ok: false, requested: 2, restored: 0, windows: 0, unavailable: 2, failed: 0
}, "an unavailable recovery source differs from already-open selected tabs");

reset("healthy");
liveTabs = snapshot.windows[0].map((ref, index) => ({ id: index + 1, windowId: 1, ...ref }));
assert.deepEqual(await recoverMissingSnapshotTabs("snapshot", ["0:0", "0:1"]), {
  ok: true, requested: 2, restored: 0, windows: 0, unavailable: 2, failed: 0
}, "already-open occurrences are unavailable to this operation without making it fail");

reset("healthy");
snapshot.windows = Array.from({ length: 4 }, () => structuredClone(snapshot.windows[0]));
nextCreateModes = ["healthy", "pin-failed", "query-failed-no-payload", "partial"];
assert.deepEqual(await recoverMissingSnapshotTabs("snapshot",
  ["0:0", "0:1", "1:0", "1:1", "2:0", "2:1", "3:0", "3:1"]), {
  ok: false, requested: 8, restored: 5, windows: 4, unavailable: 0, failed: 1,
  uncertain: 2, degraded: 1
}, "mixed windows conserve occurrence counts and count degraded windows separately");

reset("partial");
snapshot.windows[0][0].pinned = false;
let result = await recoverMissingSnapshotTabs("snapshot", ["0:0", "0:1"]);
assert.equal(result.restored, 1, "count only the created occurrence actually confirmed by Chrome");
assert.equal(result.failed, 1);
assert.equal(result.ok, false);
assert.deepEqual(updates, [12], "pinning follows the matched reference rather than shifted position");

reset("duplicate");
result = await recoverMissingSnapshotTabs("snapshot", ["0:0", "0:1"]);
assert.equal(result.restored, 1, "duplicate URLs are counted by occurrence");
assert.equal(result.failed, 1);

reset("pin-failed");
result = await recoverMissingSnapshotTabs("snapshot", ["0:0", "0:1"]);
assert.equal(result.restored, 2, "a pin failure does not erase successful browser opens");
assert.equal(result.failed, 0);
assert.equal(result.degraded, 1, "report one window with incomplete saved settings");
assert.deepEqual(updates, [11, 12], "one pin failure does not stop independent pins");

reset("query-failed-with-payload");
result = await recoverMissingSnapshotTabs("snapshot", ["0:0", "0:1"]);
assert.equal(result.restored, 2, "retain exact creation evidence when the later query fails");
assert.equal(result.failed, 0);

reset("query-failed-no-payload");
result = await recoverMissingSnapshotTabs("snapshot", ["0:0", "0:1"]);
assert.equal(result.restored, 0);
assert.equal(result.failed, 0, "lack of confirmation cannot claim that creation failed");
assert.equal(result.uncertain, 2);
assert.equal(result.windows, 1);
assert.equal(result.ok, false);
const repeated = await recoverMissingSnapshotTabs("snapshot", ["0:0", "0:1"]);
assert.equal(repeated.unavailable, 2, "the next live replan does not duplicate unconfirmed but open tabs");

reset("create-rejected");
result = await recoverMissingSnapshotTabs("snapshot", ["0:0", "0:1"]);
assert.equal(result.restored, 0);
assert.equal(result.failed, 0);
assert.equal(result.uncertain, 2, "a rejected create acknowledgement is not proof that no browser effect happened");
assert.equal((await recoverMissingSnapshotTabs("snapshot", ["0:0", "0:1"])).unavailable, 2);

reset("binding-failed");
result = await restoreWindowRefsWithReceipt(snapshot.windows[0], { sessionId: "named", windowIndex: 0 });
assert.equal(result.windowId, 10);
assert.equal(result.restored, 2, "binding failure retains the actual browser window and its opened references");
assert.equal(result.failed, 0);
assert.equal(result.degraded, true);
assert.match(result.error.message, /binding unavailable/);

reset("healthy");
assert.equal(await restoreWindowRefs(snapshot.windows[0]), 10, "existing callers retain numeric window IDs");
assert.equal(await restoreWindowRefs([{ url: "chrome://settings/" }]), null);
reset("pin-failed");
await assert.rejects(restoreWindowRefs(snapshot.windows[0]), /pin unavailable/,
  "legacy callers retain their setup error contract");
console.log("PASS: Snapshot recovery counts confirmed occurrences and preserves post-create partial outcomes");
