import assert from "node:assert/strict";
import { createChromeI18nMock } from "./message-fixture.mjs";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});
let storage, partialCreate = false;
const windows = [], notifications = [], alarms = [];
globalThis.chrome = {
  storage: { local: {} },
  runtime: { getURL: (path) => `chrome-extension://test/${path}` },
  windows: { create: async ({ url }) => {
    const id = 10 + windows.length;
    const created = { id, tabs: url.map((href, index) => ({ id: id * 10 + index, windowId: id, url: href })) };
    if (partialCreate) created.tabs.pop();
    windows.push(created);
    return created;
  } },
  tabs: { query: async ({ windowId }) => structuredClone(windows.find((win) => win.id === windowId)?.tabs ?? []) },
  alarms: { create: async (...args) => alarms.push(args) },
  i18n: createChromeI18nMock(),
  notifications: { create: async (...args) => notifications.push(args) },
  action: { setBadgeText: async () => { throw new Error("badge disabled in fixture"); } }
};
installBrowserMapStorageAuthority();
const { fireSnooze } = await import("../js/lib/snooze-delivery.js");
const { sweepOverdueSnoozes } = await import("../js/lib/snooze.js");
const refs = [{ url: "https://restored.example/", title: "Restored" }];

for (const recurrence of [undefined, "daily"]) {
  for (const source of [undefined, { deletedAt: 1, windows: [refs] },
    { windows: [] }, { windows: [[]] }, { windows: [[{ url: "chrome://settings/" }]] },
    { windows: [[{ url: "https://" }]] }]) {
    const snooze = { id: "snooze", sessionId: "session", title: "Session", deviceId: "test-device",
      createdAt: 1, modifiedAt: 1, dueAt: 1, ...(recurrence ? { recurrence } : {}) };
    storage = createInterleavableStorage({ deviceId: "test-device", snoozes: { snooze },
      sessions: source ? { session: { id: "session", ...source } } : {} });
    chrome.storage.local = storage.local;
    windows.length = notifications.length = alarms.length = 0;
    for (const manual of [false, true]) {
      const result = await fireSnooze(snooze.id, { manual });
      assert.equal(result.status, "unavailable", "an unavailable Session cannot claim a successful wake");
      assert.deepEqual(storage.snapshot().snoozes.snooze, snooze, "retain the Snooze and recurring due time");
      assert.equal(storage.snapshot().snoozeDeliveryReceipts?.snooze, undefined,
        "a confirmed no-effect attempt must not block a safe retry");
      assert.equal(storage.snapshot().counters?.snoozesFired, undefined);
      assert.equal(windows.length + notifications.length + alarms.length, 0);
    }
    await sweepOverdueSnoozes();
    assert.equal(alarms.length, 0, "overdue unavailable sources are not rearmed into an alarm retry loop");
    await storage.local.set({ sessions: { session: { id: "session", windows: [refs] } } });
    assert.equal((await fireSnooze(snooze.id)).status, "delivered", "repairing the Session permits retry");
    assert.equal(windows.length, 1);
    assert.equal(notifications.length, 1);
    assert.equal(storage.snapshot().counters.snoozesFired, 1);
  }
}

for (const partial of [false, true]) {
  partialCreate = partial;
  windows.length = notifications.length = alarms.length = 0;
  const snooze = { id: "mixed", sessionId: "session", title: "Mixed Session", deviceId: "test-device",
    createdAt: 1, modifiedAt: 1, dueAt: 1 };
  storage = createInterleavableStorage({ deviceId: "test-device", snoozes: { mixed: snooze },
    sessions: { session: { id: "session", windows: [[], null, [{ url: "chrome://settings/" }],
      [...refs, { url: "https://" }, { url: "https://second.example/" }]] } } });
  chrome.storage.local = storage.local;
  const result = await fireSnooze(snooze.id);
  assert.equal(windows.length, 1, "only the mixed window's valid pages reach browser creation");
  if (!partial) {
    assert.equal(result.status, "delivered");
    assert.deepEqual(windows[0].tabs.map((tab) => tab.url), [refs[0].url, "https://second.example/"]);
    assert.equal(notifications.length, 1);
  } else {
    assert.equal(result.status, "interrupted", "partial linked-Session confirmation cannot report full delivery");
    assert.deepEqual(storage.snapshot().snoozes.mixed, snooze);
    assert.equal(storage.snapshot().snoozeDeliveryReceipts.mixed.opened, 1);
    assert.equal(storage.snapshot().snoozeDeliveryReceipts.mixed.phase, "incomplete");
    assert.equal(storage.snapshot().counters?.snoozesFired, undefined);
    assert.equal(notifications.length, 0);
    assert.equal((await fireSnooze(snooze.id)).status, "interrupted");
    assert.equal(windows.length, 1, "an uncertain partial effect is not replayed");
  }
}
console.log("PASS: unavailable Session Snoozes retain their schedule without false delivery or blocked retries");
