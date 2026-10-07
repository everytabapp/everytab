/** Real list builders and mounted rows; synthetic DOM does not prove browser layout. */
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";
import { setStorageAuthorityForTests } from "../js/lib/storage/authority-runtime.js";

const saved = new Map(["chrome", "navigator", "CSS", "matchMedia", "requestAnimationFrame", "HTMLInputElement"]
  .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const dom = installDomFixture();
const storage = createInterleavableStorage({ inbox: {}, sessions: {}, starred: {}, journal: [] });
globalThis.chrome = { i18n: createChromeI18nMock(), runtime: { getURL: path => `chrome-extension://fixture/${path}` },
  storage: { local: storage.local, onChanged: storage.onChanged } };
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: createMockLockManager() } });
globalThis.CSS = { escape: value => String(value) };
globalThis.matchMedia = window.matchMedia = () => ({ matches: true });
globalThis.requestAnimationFrame = () => 1;
globalThis.HTMLInputElement = class {};
window.addEventListener = () => {};
window.scrollBy = () => {};
const createElement = document.createElement.bind(document);
document.createElement = tag => {
  const node = createElement(tag), getAttribute = node.getAttribute.bind(node);
  node.getAttribute = name => name.startsWith("data-")
    ? node.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] ?? null
    : getAttribute(name);
  node.cloneNode = deep => {
    const clone = document.createElement(tag);
    for (const [key, value] of node.attributes) clone.setAttribute(key, value);
    if (deep) for (const child of node.childNodes) clone.append(child.nodeType === 3 ? child.textContent : child.cloneNode(true));
    return clone;
  };
  return node;
};
installBrowserMapStorageAuthority();
const { createTabList, fromInboxItems } = await import("../js/ui/tablist.js");
const { buildInboxListConfig, buildSessionListConfig } = await import("../js/ui/list-configs.js");
const { listItems } = await import("../js/lib/store.js");
const { listActions, undoActionResult } = await import("../js/lib/journal.js");
const noop = () => {}, node = () => document.createElement("button");
const common = { renderInbox: noop, renderLabels: noop, renderSnoozes: noop, rerender: noop,
  goToLabel: noop, goToSession: noop, buildSnooze: node, newBundleZone: node, inboxDrag: () => null,
  copyRefs: noop, sessionComboboxButton: node, cardLabelPanel: node, confirmDelete: node,
  msg: async () => ({}), copySession: noop, buildSnoozePanel: node };
const ref = (url, title = "Fixture") => ({ url, title, labels: [] });
const metadata = { createdAt: 1, modifiedAt: 1, deviceId: "fixture", schemaVersion: 1 };
const item = (id, tabs) => ({ ...metadata, id, kind: "window", labels: [], tabs });
const session = (id, windows, auto = false) => ({ ...metadata, id, name: id, windows, auto });
const inboxConfig = (items, extra = {}) => buildInboxListConfig({ ...common, data: { groups: fromInboxItems(items) }, ...extra });
const sessionConfig = sessions => buildSessionListConfig({ ...common, section: "sessions", sessions });
function mount(config) {
  const root = createTabList(config);
  document.body.replaceChildren(root);
  return root;
}
const rows = root => [...root.querySelectorAll("[data-tablist-row]")];
const marked = root => rows(root).filter(row => row.querySelector(".saved-duplicate-badge"))
  .map(row => row.getAttribute("data-tablist-row"));
afterEach(async () => { document.body.replaceChildren(); await new Promise(resolve => setImmediate(resolve)); });
after(() => {
  setStorageAuthorityForTests(null);
  dom.restore();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
});

test("Inbox marks all exact occurrences across bundles with visible and accessible copy, without mutating refs", () => {
  const same = "https://fixture.example/same?a=1#part";
  const items = [item("bundle-a", [ref(same, "First"), ref("https://fixture.example/unique")]),
    item("bundle-b", [ref(same, "Second"), ref(same, "Third")])];
  const before = structuredClone(items), config = inboxConfig(items);
  const root = mount(config);
  assert.deepEqual(marked(root), ["bundle-a::0", "bundle-b::0", "bundle-b::1"]);
  const badges = [...root.querySelectorAll(".saved-duplicate-badge")];
  assert.equal(new Set(badges).size, 3, "each occurrence owns its badge node");
  for (const badge of badges) {
    assert.equal(badge.getAttribute("title"), "Same address saved more than once");
    assert.equal(badge.querySelector('span[aria-hidden="true"]').textContent, "Duplicate");
    assert.equal(badge.querySelector(".sr-only").textContent.trim(), "Same address saved more than once");
  }
  assert.deepEqual(items, before);
  assert.equal(config.groups[0].refs[0], items[0].tabs[0]);
});

test("raw byte equality keeps query/hash/case variants distinct and ignores empty or malformed addresses", () => {
  const urls = ["https://fixture.example/path", "https://fixture.example/path?a=1", "https://fixture.example/path#part",
    "https://FIXTURE.example/path", "https://fixture.example:443/path", "file:///fixture/report.txt", "file:///fixture/report.txt",
    "", "", "   ", "   ", "not a url", "not a url", null, null, 42, 42, undefined, undefined];
  const config = inboxConfig([item("edge", urls.map(url => ref(url)))]);
  const flags = config.groups[0].refs.map((ref, index) => config.rowBadges({ group: config.groups[0], ref, index }).length > 0);
  assert.deepEqual(flags, urls.map((_, index) => index === 5 || index === 6));
});

test("Named Sessions count across windows within one Session, excluding Snapshots and other Sessions", () => {
  const url = "https://fixture.example/repeat", other = "https://fixture.example/only-in-other-sessions";
  const sessions = [session("named-a", [[ref(url), ref(other)], [ref(url)]]),
    session("named-b", [[ref(other)]]), session("snapshot", [[ref(url), ref(url)]], true)];
  const before = structuredClone(sessions), config = sessionConfig(sessions), root = mount(config);
  assert.deepEqual(marked(root), ["named-a::w0::0", "named-a::w1::0"]);
  assert.deepEqual(sessions, before);
  assert.equal(config.groups[0].windows[1].refs[0], sessions[0].windows[1][0]);
  const snapshotRows = rows(root).filter(row => row.getAttribute("data-tablist-row").startsWith("snapshot::"));
  assert.ok(snapshotRows.every(row => !row.querySelector('[data-action-id="remove"]')));
  assert.ok(rows(root)[0].querySelector('[data-action-id="remove"]'), "existing Named Session removal remains visible");
});

test("filtering preserves global Inbox duplicate scope and the clicked source index; delete and Undo still work", async () => {
  const url = "https://fixture.example/filter";
  const items = [item("filtered", [ref("https://fixture.example/keep", "Keep"), ref(url, "Remove this occurrence")]),
    item("hidden", [ref(url, "Hidden matching occurrence")])];
  await storage.local.set({ inbox: Object.fromEntries(items.map(value => [value.id, value])), journal: [] });
  const config = inboxConfig(items, { rowVisible: ({ group, index }) => group.id === "filtered" && index === 1 });
  const root = mount(config);
  assert.deepEqual(marked(root), ["filtered::1"]);
  assert.equal(rows(root).length, 1);
  assert.deepEqual(storage.snapshot().inbox, Object.fromEntries(items.map(value => [value.id, value])), "render never deletes copies");
  await rows(root)[0].querySelector('[data-action-id="delete"]').dispatch("click");
  await new Promise(resolve => setImmediate(resolve)); // Public click starts an async domain action.
  assert.deepEqual(storage.snapshot().inbox.filtered.tabs, [items[0].tabs[0]]);
  assert.deepEqual(storage.snapshot().inbox.hidden.tabs, items[1].tabs);
  assert.deepEqual(marked(mount(inboxConfig(await listItems("inbox")))), [], "fresh render removes obsolete badges");
  await undoActionResult((await listActions())[0].id);
  assert.deepEqual((await listItems("inbox")).find(value => value.id === "filtered").tabs, items[0].tabs);
});

test("Session remove acts on the chosen window occurrence and preserves existing Undo", async () => {
  const url = "https://fixture.example/session-remove";
  const saved = session("removable", [[ref(url, "Keep")], [ref(url, "Remove"), ref("https://fixture.example/stays")]]);
  await storage.local.set({ sessions: { [saved.id]: saved }, namedSessionRecords: {}, journal: [] });
  const root = mount(sessionConfig([saved]));
  assert.deepEqual(marked(root), ["removable::w0::0", "removable::w1::0"]);
  await rows(root)[1].querySelector('[data-action-id="remove"]').dispatch("click");
  await new Promise(resolve => setImmediate(resolve));
  const remaining = (await listItems("sessions")).find(value => value.id === saved.id);
  assert.deepEqual(remaining.windows, [[saved.windows[0][0]], [saved.windows[1][1]]]);
  assert.deepEqual(marked(mount(sessionConfig([remaining]))), []);
  await undoActionResult((await listActions())[0].id);
  assert.deepEqual((await listItems("sessions")).find(value => value.id === saved.id).windows, saved.windows);
});
