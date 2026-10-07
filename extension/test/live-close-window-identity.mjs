import assert from "node:assert/strict";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";

Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});
const storage = createInterleavableStorage({ deviceId: "window-close-identity", journal: [] });
let liveWindow = null;
let removed = 0;
let tabGetCalls = 0;
let afterWindowGet = null;

globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://test/${path}` },
  storage: { local: storage.local, onChanged: storage.onChanged },
  windows: {
    async get(id) {
      if (!liveWindow || liveWindow.id !== id) throw new Error("gone");
      const snapshot = structuredClone(liveWindow);
      const hook = afterWindowGet;
      afterWindowGet = null;
      if (hook) queueMicrotask(hook);
      return snapshot;
    },
    async remove(id) {
      if (!liveWindow || liveWindow.id !== id) throw new Error("gone");
      removed += 1;
      liveWindow = null;
    }
  },
  tabs: {
    async get() {
      tabGetCalls += 1;
      throw new Error("whole-window success must use its explicit close ledger");
    }
  }
};

const { installBrowserMapStorageAuthority } = await import(
  "./storage-authority-fixture.mjs"
);
installBrowserMapStorageAuthority();
const { closeWindowSafely, windowFingerprint } = await import("../js/lib/close-window.js");
const { listActions } = await import("../js/lib/journal.js");

const makeWindow = (id, url) => ({
  id, type: "normal", incognito: false,
  tabs: [{ id: id * 10, windowId: id, index: 0, url, title: url,
    pinned: false, incognito: false }]
});

// A recoverable window navigation during the pending-receipt commit refuses
// the callback explicitly, leaves the window open, and creates no phantom Undo.
liveWindow = makeWindow(4, "https://reviewed.example/");
let navigateOnPending = true;
const nativeSet = storage.local.set;
chrome.storage.local.set = async (values) => {
  await nativeSet(values);
  if (navigateOnPending && values.journal?.some((entry) =>
    entry.forwardReceipt?.status === "pending")) {
    navigateOnPending = false;
    liveWindow.tabs[0].url = "https://valuable-replacement.example/form";
  }
};
const refused = await closeWindowSafely(4, windowFingerprint(liveWindow.tabs));
assert.equal(refused.reason, "changed");
assert.equal(removed, 0);
assert.equal(liveWindow.tabs[0].url, "https://valuable-replacement.example/form");
assert.equal((await listActions()).length, 0);
chrome.storage.local.set = nativeSet;

// The zero-recoverable branch also distinguishes an exact-identity refusal
// from a successful close even though it has no journal receipt.
liveWindow = makeWindow(5, "chrome://settings");
afterWindowGet = () => { liveWindow.tabs[0].url = "chrome://downloads"; };
const internalRefused = await closeWindowSafely(5, windowFingerprint(liveWindow.tabs));
assert.equal(internalRefused.reason, "changed");
assert.equal(removed, 0);
assert.equal(liveWindow.tabs[0].url, "chrome://downloads");

// A successful whole-window remove returns an explicit ledger. Settlement
// therefore does not probe every old numeric id and cannot widen its receipt.
liveWindow = makeWindow(6, "https://closed.example/");
tabGetCalls = 0;
const successful = await closeWindowSafely(6, windowFingerprint(liveWindow.tabs));
assert.equal(successful.ok, true);
assert.equal(removed, 1);
assert.equal(tabGetCalls, 0);
assert.deepEqual((await listActions())[0].forwardReceipt.tabs.map(({ tabId }) => tabId), [60]);

console.log("PASS: whole-window close revalidates identity and settles from an explicit ledger");
