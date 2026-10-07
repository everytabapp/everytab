import assert from "node:assert/strict";
import { createNewTabSingletonOwner } from
  "../js/background/new-tab-singleton-owner.js";

const base = "chrome-extension://everytab-test/";
const newTab = (id, overrides = {}) => ({
  id,
  windowId: 4,
  url: `${base}newtab.html`,
  active: false,
  pinned: false,
  incognito: false,
  ...overrides
});

let enabled = true;
let windowFailure = false;
let windowTabs = [];
const liveTabs = new Map();
const reads = [];
const removals = [];
const failedRemovals = new Set();
globalThis.chrome = {
  runtime: { getURL: (path) => `${base}${path}` },
  windows: {
    async get(windowId, options) {
      reads.push(["window", windowId, options]);
      if (windowFailure) throw new Error("window unavailable");
      return { id: windowId, type: "normal", tabs: windowTabs };
    }
  },
  tabs: {
    async get(tabId) {
      reads.push(["tab", tabId]);
      if (!liveTabs.has(tabId)) throw new Error("tab unavailable");
      return liveTabs.get(tabId);
    },
    async remove(tabId) {
      removals.push(tabId);
      if (failedRemovals.has(tabId)) throw new Error("remove unavailable");
    }
  }
};

let settingsReads = 0;
const owner = createNewTabSingletonOwner({
  async readSettings() {
    settingsReads += 1;
    return { oneNewTabPerWindow: enabled };
  }
});

assert.deepEqual(await owner.retireOlder({ id: "bad", windowId: 4 }), {
  ok: false,
  reason: "missing-tab"
});
assert.equal(settingsReads, 0, "invalid mounted identities cannot read policy or mutate Chrome");

enabled = false;
assert.deepEqual(await owner.retireOlder({ id: 3, windowId: 4 }), {
  ok: true,
  reason: "disabled"
});
assert.deepEqual(reads, [], "an explicit Off policy does not inspect a Chrome window");

enabled = true;
windowFailure = true;
assert.deepEqual(await owner.retireOlder({ id: 3, windowId: 4 }), {
  ok: true,
  reason: "window-gone"
});
windowFailure = false;

owner.recordCreation({ id: 1 });
owner.recordCreation({ id: 2 });
owner.recordCreation({ id: 3 });
windowTabs = [newTab(1), newTab(2), newTab(3, { active: true })];
liveTabs.set(1, newTab(1));
liveTabs.set(2, newTab(2));
assert.deepEqual(await owner.retireOlder(newTab(3, { active: true })), {
  ok: true,
  reason: "retired",
  retired: 2
});
assert.deepEqual(removals, [1, 2], "the newest mounted page retires every live eligible peer");

removals.length = 0;
owner.recordCreation({ id: 4 });
owner.recordCreation({ id: 5 });
windowTabs = [newTab(4, { active: true }), newTab(5)];
assert.deepEqual(await owner.retireOlder(newTab(4, { active: true })), {
  ok: true,
  reason: "no-change"
}, "an older tracked page cannot win while a newer page is mounting");
assert.deepEqual(removals, []);

owner.resetCreationOrder();
windowTabs = [newTab(6), newTab(7), newTab(8, { active: true })];
liveTabs.set(6, newTab(6));
liveTabs.set(7, newTab(7));
assert.deepEqual(await owner.retireOlder(newTab(8, { active: true })), {
  ok: true,
  reason: "retired",
  retired: 2
}, "an active mounted page remains a safe keeper after browser-start rank reset");

removals.length = 0;
owner.resetCreationOrder();
for (let id = 10; id <= 17; id += 1) owner.recordCreation({ id });
windowTabs = [
  newTab(10), newTab(11), newTab(12), newTab(13),
  newTab(14), newTab(15), newTab(16), newTab(17, { active: true })
];
liveTabs.clear();
liveTabs.set(10, newTab(10));
liveTabs.set(11, newTab(11, { pinned: true }));
liveTabs.set(12, newTab(12, { windowId: 9 }));
liveTabs.set(13, newTab(13, { active: true }));
liveTabs.set(14, newTab(14, { incognito: true }));
liveTabs.set(15, newTab(15, { url: "https://example.com/changed" }));
liveTabs.set(16, newTab(16));
failedRemovals.add(16);
assert.deepEqual(await owner.retireOlder(newTab(17, { active: true })), {
  ok: true,
  reason: "retired",
  retired: 1
});
assert.deepEqual(removals, [10, 16],
  "only targets still eligible immediately before removal reach Chrome");
assert.equal(reads.some(([kind, id]) => kind === "tab" && id === 11), true,
  "every planned target is re-read even when its live state changed");

removals.length = 0;
failedRemovals.clear();
owner.forget(17);
owner.recordCreation({ id: 18 });
windowTabs = [newTab(17), newTab(18, { active: true })];
assert.deepEqual(await owner.retireOlder(newTab(17)), {
  ok: true,
  reason: "no-change"
}, "forgetting a closed identity prevents stale creation order from authorizing it");

console.log("PASS: mounted New Tab singleton policy has one directly tested owner");
