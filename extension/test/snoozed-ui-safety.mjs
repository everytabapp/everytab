import assert from "node:assert/strict";
import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

const fixture = installDomFixture();
const storage = createInterleavableStorage({ deviceId: "snoozed-ui-test" });
const opened = [];
globalThis.chrome = {
  i18n: createChromeI18nMock(),
  runtime: { getURL: (path) => `chrome-extension://test/${path}` },
  storage: { local: storage.local, onChanged: storage.onChanged },
  alarms: { async create() {}, async clear() {} },
  tabs: { async create(options) {
    opened.push(options.url); return { id: 10 + opened.length, ...options };
  } },
  windows: { async create(options) {
    opened.push(...options.url);
    return { id: 20, tabs: options.url.map((url, index) => ({ id: 30 + index, url })) };
  } }
};
Object.defineProperty(globalThis, "navigator", {
  configurable: true, value: { locks: createMockLockManager() }
});
installBrowserMapStorageAuthority();
const { buildSnoozedListConfig, buildSessionListConfig } = await import("../js/ui/list-configs.js");
const snooze = {
  id: "snooze-one", createdAt: 1, modifiedAt: 1, schemaVersion: 1,
  deviceId: "snoozed-ui-test", dueAt: Date.now() + 3_600_000, url: "",
  title: "Two saved tabs", tabs: [
    { url: "https://one.example", title: "One" },
    { url: "https://two.example", title: "Two" }
  ]
};
const group = { id: snooze.id, data: snooze, refs: snooze.tabs };
let rendered = 0, cleared = 0;
const notices = [], messages = [];
let wakeResult = { ok: false, status: "stale" };
let selectedResult = null;
const config = buildSnoozedListConfig({
  data: { groups: [group] },
  renderSnoozes: () => { rendered += 1; }, renderSessions() {}, copyRefs() {},
  showNotice: (message) => notices.push(message),
  msg: async (message) => {
    messages.push(message);
    if (message.type !== "wake-snooze-tabs") return wakeResult;
    if (selectedResult) return selectedResult;
    const { wakeSnoozeSelections } = await import("../js/lib/snooze-delivery.js");
    const result = await wakeSnoozeSelections(message.selections);
    return { ...result, ok: result.status === "delivered" };
  }
});
try {
  const emptyBulkActions = config.bulkActions({ selection: [], clear() {} });
  assert.equal(emptyBulkActions[0].getAttribute("title"),
    "Open the selected tabs now. A partial selection splits the Snooze.",
  "Snoozed Wake retains its scope-specific partial-selection explanation");
  for (const button of emptyBulkActions) {
    assert.ok(button.querySelector('.action-icon'), 'Snoozed bulk controls have an icon in icons-only mode');
    assert.ok(button.querySelector('.action-label'), 'Snoozed bulk controls retain their optional visible label');
    assert.ok(button.getAttribute('aria-label'), 'icon-only actions retain an accessible name');
  }
  await config.groupActions.find((action) => action.id === "wake").run({ group });
  assert.deepEqual(messages[0], { type: "wake-snooze", id: snooze.id, expected: snooze },
    "whole-card Wake sends the displayed Snooze, not just its numeric target");
  assert.equal(rendered, 0, "a refused Wake does not refresh as a successful action");
  assert.ok(notices[0]?.length > 0, "a refused Wake has visible feedback");
  wakeResult = { ok: true, status: "delivered" };
  await config.groupActions.find((action) => action.id === "wake").run({ group });
  assert.equal(rendered, 1);
  wakeResult = { ok: false, status: "interrupted" };
  await config.groupActions.find((action) => action.id === "wake").run({ group });
  assert.match(notices.at(-1), /already be open/,
    "uncertain delivery asks users to inspect open tabs instead of blindly retrying");

  const stale = { ...snooze, title: "Changed elsewhere", deletedAt: 2, modifiedAt: 2 };
  const reset = async (value) => {
    await storage.local.set({ snoozes: { [snooze.id]: value }, journal: [],
      snoozeDeliveryReceipts: {}, snoozePlacements: {}, counters: {} });
    rendered = cleared = 0; opened.length = notices.length = 0;
  };
  for (const action of ["restore", "delete"]) {
    await reset(stale);
    const button = config.bulkActions({ selection: [{ group, indexes: [0] }],
      clear: () => { cleared += 1; } }).find((node) =>
      node.getAttribute("data-bulk-action") === action);
    await button.dispatch("click");
    assert.equal(cleared, 0, "a refused bulk action retains its selection");
    assert.deepEqual(opened, []);
    assert.deepEqual(storage.snapshot().snoozes[snooze.id], stale);
    assert.ok(notices[0]?.length > 0);
    assert.equal(button.disabled, false);
  }
  await reset(stale);
  await config.groupActions.find((action) => action.id === "cancel").run({ group });
  assert.deepEqual(storage.snapshot().snoozes[snooze.id], stale);
  assert.equal(rendered, 0);
  assert.ok(notices[0]?.length > 0);

  const sessionConfig = buildSessionListConfig({
    section: "sessions", sessions: [],
    extra: { sessionSnoozes: new Map([["session-one", snooze]]) },
    rerender: () => { rendered += 1; }, renderSnoozes: () => { rendered += 1; },
    showNotice: (message) => notices.push(message)
  });
  const sessionCancel = sessionConfig.groupActions.find((action) =>
    action.id === "snooze-session").render({ group: { id: "session-one" } });
  await sessionCancel.dispatch("click");
  assert.equal(rendered, 0, "a refused Session-card Cancel does not claim success");
  assert.equal(sessionCancel.disabled, false);
  assert.deepEqual(storage.snapshot().snoozes[snooze.id], stale);
  await reset(snooze);
  await sessionCancel.dispatch("click");
  assert.equal(rendered, 2, "successful Session-card Cancel refreshes both views");
  assert.ok(storage.snapshot().snoozes[snooze.id].deletedAt);

  await reset(snooze);
  selectedResult = { ok: false, status: "uncertain", opened: 1 };
  const partialWake = config.bulkActions({ selection: [{ group, indexes: [0] }],
    clear: () => { cleared += 1; rendered += 1; } }).find((node) =>
    node.getAttribute("data-bulk-action") === "restore");
  await partialWake.dispatch("click");
  assert.equal(cleared, 1, "partial completion invalidates old selected indexes");
  assert.equal(rendered, 1);
  assert.equal(partialWake.disabled, false);
  assert.match(notices.at(-1), /already be open/);
  assert.deepEqual(messages.at(-1), { type: "wake-snooze-tabs",
    selections: [{ snooze, indexes: [0] }] }, "bulk Wake uses the worker boundary");
  selectedResult = null;
  await reset(stale);

  let panel;
  config.groupActions.find((action) => action.id === "reschedule").run({
    group, panel: { toggle: (make) => { panel = make(); } }
  });
  const input = panel.querySelector("input");
  input.value = "2099-01-01T10:00";
  const save = panel.querySelector("button");
  await save.dispatch("click");
  assert.equal(rendered, 0);
  assert.deepEqual(storage.snapshot().snoozes[snooze.id], stale);
  assert.ok(panel.querySelector('[role="alert"]').textContent.length > 0);

  await reset(snooze);
  await save.dispatch("click");
  assert.equal(rendered, 1, "a successful reschedule refreshes once");
  assert.equal(save.disabled, false);
} finally {
  fixture.restore();
}
console.log("PASS: real Snoozed callbacks retain refused selections and require success");
