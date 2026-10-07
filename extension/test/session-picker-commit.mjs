import assert from "node:assert/strict";
import { commitSessionPick } from "../js/ui/session-picker-commit.js";

const existing = { id: "saved-session", name: "Research", isNew: false };
const plan = { mode: "replace", members: [{ key: existing.id,
  groupIds: ["work"], createNames: [] }] };
let organized = 0;
const organize = async () => { organized += 1; return { ok: true }; };
for (const outcome of [false, null, undefined]) {
  const result = await commitSessionPick(existing, plan, async () => outcome, organize);
  assert.equal(organized, 0, "A refused save must not apply Session organization");
  assert.equal(result, false);
}
await assert.rejects(commitSessionPick(existing, plan, async () => {
  throw new Error("storage failed");
}, organize), /storage failed/);
assert.equal(organized, 0);

const ordinaryWarn = console.warn;
const warnings = [];
console.warn = (...args) => { warnings.push(args); };
try {
  for (const fail of [async () => ({ ok: false }), async () => { throw new Error("group failed"); }]) {
    assert.equal(await commitSessionPick(existing, plan, async () => true, fail), true,
      "A later group failure must not misreport the committed save as failed");
  }
  assert.deepEqual(warnings, [
    ["EveryTab: Session group assignment failed [name:UnknownError]"],
    ["EveryTab: Session group assignment failed [name:Error]"]
  ], "post-save organization diagnostics preserve success without forwarding errors");
} finally { console.warn = ordinaryWarn; }

const calls = [];
assert.equal(await commitSessionPick(existing, plan, async (value) => {
  calls.push("save"); assert.deepEqual(value, existing); return true;
}, async (kind, actualPlan) => {
  calls.push("organize"); assert.equal(kind, "session"); assert.deepEqual(actualPlan, plan);
  return { ok: true };
}), true);
assert.deepEqual(calls, ["save", "organize"]);
assert.equal(await commitSessionPick(existing, null, async () => true, organize), true);
assert.equal(organized, 0);

for (const isSuccess of [false, true]) {
  let created;
  const value = { id: null, name: "New", isNew: true };
  assert.equal(await commitSessionPick(value, plan, async (input) => {
    created = input; return isSuccess;
  }, organize), isSuccess);
  assert.deepEqual(created.organization, { groupIds: ["work"], createNames: [] });
  assert.equal(organized, 0, "Only creation applies a new Session's organization");
}
console.log("PASS: Session picker gates organization on explicit primary success");

// Exercise the actual Inbox row/bulk callbacks, not just a synthetic save.
const { installDomFixture } = await import("./dom-fixture.mjs");
const { createChromeI18nMock } = await import("./message-fixture.mjs");
const { createInterleavableStorage, createMockLockManager } = await import("./e2-mocks.mjs");
const { installBrowserMapStorageAuthority } = await import("./storage-authority-fixture.mjs");
const fixture = installDomFixture();
const storage = createInterleavableStorage({ deviceId: "picker-test" });
globalThis.chrome = {
  i18n: createChromeI18nMock(),
  runtime: { getURL: (path) => `chrome-extension://test/${path}` },
  storage: { local: storage.local, onChanged: storage.onChanged }
};
Object.defineProperty(globalThis, "navigator", {
  configurable: true, value: { locks: createMockLockManager() }
});
installBrowserMapStorageAuthority();
const { buildInboxListConfig, buildOpenListConfig } = await import("../js/ui/list-configs.js");
const { createTabList, clearSelection } = await import("../js/ui/tablist.js");
const { readFreshStoreMap } = await import("../js/lib/store.js");
const { STORE_KEYS } = await import("../js/lib/types.js");
const meta = { deviceId: "picker-test", createdAt: 1, modifiedAt: 1, schemaVersion: 1 };
const source = { ...meta, id: "source", kind: "window", labels: [], tabs: [
  { url: "https://saved.example", title: "Saved" }
] };
const session = { ...meta, id: existing.id, name: existing.name, auto: false,
  windows: [[{ url: "https://existing.example", title: "Existing" }]], labels: [] };
const group = { id: source.id, data: source, refs: source.tabs };
let rendered = 0;
let cleared = 0;
const config = buildInboxListConfig({
  data: { groups: [group] }, renderInbox: () => { rendered += 1; },
  renderLabels() {}, showToast() {},
  sessionComboboxButton: (_label, options) => options
});
try {
  for (const stale of [true, false]) {
    for (const kind of ["row", "bulk"]) {
      await storage.local.set({ inbox: { [source.id]: stale ? {
        ...source, tabs: [...source.tabs, { url: "https://new.example", title: "New" }]
      } : source }, sessions: { [session.id]: session }, journal: [] });
      rendered = cleared = organized = 0;
      const picker = kind === "row"
        ? config.rowActions.find((action) => action.id === "session").render({ group, index: 0 })
        : config.bulkActions({ selection: [{ group, indexes: [0] }],
          clear: () => { cleared += 1; } })[0];
      assert.equal(await commitSessionPick(existing, plan, picker.onPick, organize), !stale);
      assert.equal(organized, stale ? 0 : 1);
      if (stale) assert.equal(rendered + cleared, 0,
        "A refused Inbox move retains its selection and does not rerender as success");
      if (!stale) assert.equal(kind === "row" ? rendered : cleared, 1);
    }
  }

  await storage.local.set({ sessions: { [session.id]: session }, journal: [] });
  const openGroup = {
    id: "open-window", title: "Open window", meta: "2 tabs", loose: false,
    data: { id: 91 },
    refs: [
      { title: "Open one", url: "https://open-one.example/" },
      { title: "Open two", url: "https://open-two.example/" }
    ],
    live: [
      { tabId: 911, windowId: 91, chromeIndex: 0, selectable: true },
      { tabId: 912, windowId: 91, chromeIndex: 1, selectable: true }
    ],
    selectableCount: 2
  };
  const openConfig = buildOpenListConfig({
    data: {
      groups: [openGroup], bindings: {}, sessionsById: new Map([[session.id, session]]),
      simpleWindows: [], groupsUnpreserved: false, currentWindowId: 91, browserWindowCount: 1
    },
    rowCap: 10, initialRowBudget: 300,
    msg: async () => ({}), renderOpen() {}, renderArchive() {}, renderLabels() {},
    goToLabel() {}, goToSession() {}, mark: (node) => node,
    cardLabelPanel: () => document.createElement("div"),
    buildOpenSnooze: () => document.createElement("div"),
    buildProtectionPanel: () => document.createElement("div"),
    idleNudge: null,
    sessionComboboxButton: (label, options = {}) => {
      const button = document.createElement("button");
      button.textContent = label;
      if (options.actionId) button.setAttribute("data-action-id", options.actionId);
      button._sessionOptions = options;
      return button;
    },
    copyRefs() {}, buildOrganizePanel: () => document.createElement("div"),
    driftBanner: () => null, groupAccessAction: () => null,
    openRowDrag: {}, newWindowZone: () => null, endWindowZone: () => null,
    flashNote() {}, showNotice() {}
  });
  clearSelection("open");
  const openList = createTabList(openConfig);
  document.body.append(openList);
  let openRows = openList.querySelectorAll(".trow");
  await openRows[0].dispatch("click");
  openRows = openList.querySelectorAll(".trow");
  await openRows[1].dispatch("click");
  const openSessionButton = openList.querySelector('.header-bulk-actions [data-action-id="session"]');
  assert.ok(openSessionButton?._sessionOptions?.onPick,
    "the mounted Open selection exposes its real Session picker callback");
  assert.equal(await openSessionButton._sessionOptions.onPick(existing), true);
  const updatedSession = (await readFreshStoreMap(STORE_KEYS.sessions))[session.id];
  assert.deepEqual(updatedSession.windows.at(-1), openGroup.refs,
    "the mounted Open Session action appends every currently selected tab");
} finally {
  fixture.restore();
}
console.log("PASS: real Inbox and mounted Open Session pickers preserve complete selections");
