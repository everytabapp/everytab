import assert from "node:assert/strict";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

const ref = (name) => ({ url: `https://${name}.example/page`, title: name.toUpperCase() });
const snapshot = {
  id: "snapshot-before-loss",
  name: "Snapshot before loss",
  auto: true,
  createdAt: 100,
  modifiedAt: 200,
  windows: [
    [ref("a"), ref("b"), ref("b")],
    [ref("c"), ref("d"), {
      url: "file:///Users/example/irreplaceable.html",
      title: "Irreplaceable local page",
      pinned: false
    }]
  ],
  labels: []
};
const sessions = {
  [snapshot.id]: snapshot,
  named: { ...snapshot, id: "named", name: "Named", auto: false, modifiedAt: 300 },
  deleted: { ...snapshot, id: "deleted", deletedAt: 400, modifiedAt: 400 }
};
const storedValues = { sessions };

let nextWindowId = 50;
let nextTabId = 500;
const createdWindows = [];
const liveTabs = [
  { id: 1, windowId: 1, index: 0, url: ref("a").url, title: "A" },
  { id: 2, windowId: 1, index: 1, url: ref("b").url, title: "B" },
  { id: 3, windowId: 2, index: 0, url: ref("c").url, title: "C" }
];

globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://test-ext/${path}` },
  storage: {
    local: {
      get: async (keys) => Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys])
          .filter((key) => Object.hasOwn(storedValues, key))
          .map((key) => [key, structuredClone(storedValues[key])])
      )
    }
  },
  tabs: {
    query: async (query = {}) => liveTabs
      .filter((tab) => query.windowId === undefined || tab.windowId === query.windowId)
      .map((tab) => ({ ...tab })),
    update: async (id, patch) => ({ id, ...patch })
  },
  windows: {
    create: async ({ url }) => {
      const windowId = nextWindowId++;
      const urls = Array.isArray(url) ? url : [url];
      const tabs = urls.map((href, index) => ({
        id: nextTabId++, windowId, index, url: href, title: href, pinned: false
      }));
      liveTabs.push(...tabs);
      createdWindows.push({ windowId, urls: [...urls] });
      return { id: windowId, tabs };
    }
  }
};

installBrowserMapStorageAuthority();
const {
  inspectSnapshotRecovery,
  planMissingSnapshotTabs,
  recoverMissingSnapshotTabs,
  reviewSnapshotRecovery,
  snapshotRecoveryLimits
} = await import("../js/lib/snapshot-recovery.js");

const plan = planMissingSnapshotTabs(snapshot, liveTabs);
assert.equal(plan.tabCount, 6);
assert.equal(plan.windowCount, 2);
assert.deepEqual(plan.candidates.map((item) => item.key), ["0:2", "1:1", "1:2"],
  "multiset comparison exposes missing web and local-file occurrences");

const inspected = await inspectSnapshotRecovery();
assert.equal(inspected.ok, true);
assert.equal(inspected.snapshots.length, 1, "named and deleted Sessions are not recovery sources");
assert.deepEqual(inspected.snapshots[0], {
  snapshotId: snapshot.id,
  name: snapshot.name,
  createdAt: 100,
  modifiedAt: 200,
  tabCount: 6,
  windowCount: 2,
  missingCount: 3
});

const reviewed = await reviewSnapshotRecovery(snapshot.id);
assert.equal(reviewed.ok, true);
assert.deepEqual(reviewed.candidates.map((item) => item.key), ["0:2", "1:1", "1:2"]);
assert.ok(reviewed.candidates.every((item) => !("url" in item) && !("ref" in item)),
  "the review message must not expose saved URLs when title and domain are enough");

const recovered = await recoverMissingSnapshotTabs(snapshot.id, ["1:2", "1:1", "0:2", "0:2"]);
assert.deepEqual(recovered, {
  ok: true, requested: 3, restored: 3, windows: 2, unavailable: 0, failed: 0
});
assert.deepEqual(createdWindows.map((window) => window.urls), [[ref("b").url], [
  ref("d").url, "file:///Users/example/irreplaceable.html"
]],
  "selected missing tabs reopen in their source-window groups and source order");

const repeated = await recoverMissingSnapshotTabs(snapshot.id, ["0:2", "1:1", "1:2"]);
assert.deepEqual(repeated, {
  ok: true, requested: 3, restored: 0, windows: 0, unavailable: 3, failed: 0
}, "a second recovery replans and cannot duplicate tabs that are already live");
assert.equal(createdWindows.length, 2);

assert.deepEqual(await reviewSnapshotRecovery("named"), {
  ok: false, reason: "snapshot-unavailable", snapshot: null, candidates: []
});
assert.deepEqual(snapshotRecoveryLimits, { snapshots: 50, tabs: 1000 });

console.log("PASS: automatic Snapshot recovery reviews and reopens only missing occurrences");
