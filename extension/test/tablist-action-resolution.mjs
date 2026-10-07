/** Real tab-list factories, action routing and selection owners; no browser layout proof. */
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";

const saved = new Map(["chrome", "CSS", "matchMedia", "requestAnimationFrame", "HTMLInputElement"]
  .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const dom = installDomFixture();
globalThis.chrome = { i18n: createChromeI18nMock(), runtime: { getURL: path => `chrome-extension://fixture/${path}` } };
globalThis.CSS = { escape: value => String(value) };
globalThis.matchMedia = window.matchMedia = () => ({ matches: true });
globalThis.requestAnimationFrame = () => 1;
globalThis.HTMLInputElement = class {};
window.addEventListener = () => {};
window.scrollBy = () => {};
// Supply native operations missing from the shared minimal DOM. Real list
// listeners still own action routing, selection reconciliation and folding.
const createElement = document.createElement.bind(document);
document.createElement = tag => {
  const node = createElement(tag), getAttribute = node.getAttribute.bind(node);
  node.getAttribute = name => name.startsWith("data-")
    ? node.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] ?? null
    : getAttribute(name);
  node.click = () => node.dispatch("click");
  node.cloneNode = deep => {
    const clone = document.createElement(tag);
    for (const [key, value] of node.attributes) clone.setAttribute(key, value);
    if (deep) for (const child of node.childNodes) clone.append(child.nodeType === 3 ? child.textContent : child.cloneNode(true));
    return clone;
  };
  return node;
};
const { createTabList } = await import("../js/ui/tablist.js");
let serial = 0;
afterEach(() => document.body.replaceChildren());
after(() => {
  dom.restore();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
});
const ref = n => ({ title: `Fixture ${n}`, url: `https://fixture.example/${n}`, labels: [] });
const group = (id, nested = false) => nested
  ? { id, title: id, windows: [{ meta: "Window 1", refs: [ref(1), ref(2)] }] }
  : { id, title: id, refs: [ref(1), ref(2), ref(3)] };
function factories() {
  const calls = [], runs = [];
  let version = "initial";
  const make = (kind, key) => g => {
    const token = `${kind}:${g.id}:${calls.length}:${version}`;
    calls.push({ kind, id: g.id, token });
    return [{ id: kind, key, label: token, run: ctx => runs.push({ token, ctx }) }];
  };
  return { calls, runs, rowActions: make("row", "r"), groupActions: make("group", "g"), windowActions: make("window", "w"),
    setVersion(value) { version = value; } };
}
function mount(config) {
  const root = createTabList({ section: `action-resolution-${++serial}`, ...config });
  document.body.replaceChildren(root);
  return root;
}
async function key(target, value) {
  target.focus();
  const event = await document.dispatch("keydown", { target, key: value });
  assert.equal(event.defaultPrevented, true, `shortcut ${value} must be handled`);
}

test("initial visible and capped groups resolve each action family once", () => {
  const actions = factories(), groups = [group("flat"), group("nested", true), group("capped")];
  const root = mount({ groups, ...actions, groupCap: 2 });
  assert.equal(root.querySelectorAll("[data-tablist-card]").length, 2);
  for (const g of groups) for (const kind of ["row", "group", "window"]) {
    assert.equal(actions.calls.filter(call => call.id === g.id && call.kind === kind).length, 1, `${g.id}/${kind}`);
  }
});

test("initial descriptors supply visible labels and the same pointer and keyboard callbacks", async () => {
  const actions = factories(), g = group("nested", true);
  const root = mount({ groups: [g], ...actions });
  const row = root.querySelector("[data-tablist-row]"), card = root.querySelector("[data-tablist-card]");
  for (const [kind, anchor, shortcut] of [["row", row, "r"], ["group", card, "g"]]) {
    const button = anchor.querySelector(`[data-action-id="${kind}"]`);
    const initial = actions.calls.find(call => call.kind === kind).token;
    assert.equal(button.getAttribute("aria-label"), initial, "UI must use the initial factory descriptor");
    await button.dispatch("click"); await key(anchor, shortcut);
    assert.deepEqual(actions.runs.slice(-2).map(run => run.token), [initial, initial]);
    assert.equal(actions.runs.at(-1).ctx.group, g);
  }
  const windowButton = root.querySelector('[data-action-id="window"]');
  await windowButton.dispatch("click");
  assert.equal(actions.runs.at(-1).token, actions.calls.find(call => call.kind === "window").token);
  assert.equal(actions.runs.at(-1).ctx.window, g.windows[0]);
  assert.equal(actions.runs.at(-1).ctx.windowIndex, 0);
});

test("folding and unfolding resolve fresh factories, and a new list never caches a reused group object", async () => {
  const actions = factories(), g = group("folded");
  const root = mount({ groups: [g], ...actions, foldable: true });
  for (const [version, rows] of [["fold", 0], ["unfold", 3]]) {
    actions.setVersion(version);
    const previous = actions.calls.length;
    await root.querySelector(".item-head-toggle").dispatch("click");
    assert.equal(actions.calls.length - previous, 3);
    assert.equal(root.querySelectorAll("[data-tablist-row]").length, rows);
    const button = root.querySelector('[data-action-id="group"]');
    assert.ok(button.getAttribute("aria-label").endsWith(`:${version}`));
    await button.dispatch("click");
    assert.ok(actions.runs.at(-1).token.endsWith(`:${version}`));
  }
  actions.setVersion("new-list");
  const next = mount({ groups: [g], ...actions });
  assert.ok(next.querySelector('[data-action-id="row"]').getAttribute("aria-label").endsWith(":new-list"));
});

function bulkButton(ctx, invoked, id = "group") {
  const button = document.createElement("button");
  button.dataset.bulkAction = id;
  button.setAttribute("aria-label", "Selected fixture action");
  button.addEventListener("click", () => invoked.push(ctx.selection.map(entry => ({ id: entry.group.id, indexes: [...entry.indexes] }))));
  return button;
}
test("selection changes keep rows mounted and bulk callbacks receive the current selection without resolving factories", async () => {
  const actions = factories(), invoked = [], g = group("select");
  const root = mount({ groups: [g], ...actions, selectable: "tab", bulkActions: ctx => [bulkButton(ctx, invoked)] });
  const rows = root.querySelectorAll("[data-tablist-row]"), initialCalls = actions.calls.length;
  await key(rows[0], "x"); await key(rows[1], "x");
  await key(rows[1], "g");
  assert.deepEqual(invoked.at(-1), [{ id: g.id, indexes: [0, 1] }]);
  await key(rows[2], "x");
  await root.querySelector('[data-bulk-action="group"]').dispatch("click");
  assert.deepEqual(invoked.at(-1), [{ id: g.id, indexes: [0, 1, 2] }]);
  await key(rows[0], "x"); await key(rows[1], "x"); await key(rows[2], "x");
  assert.equal(root.querySelector("[data-tablist-row]"), rows[0]);
  assert.equal(actions.calls.length, initialCalls);
  await key(rows[0], "r");
  assert.equal(actions.runs.at(-1).ctx.ref, g.refs[0]);
});

test("raw shortcuts from capped immutable groups still decorate and activate bulk actions", async () => {
  const invoked = [], calls = [], visible = group("visible"), hidden = group("hidden");
  const root = mount({ groups: [visible, hidden], selectable: "tab", groupCap: 1,
    immutable: g => g === hidden,
    rowActions: g => { calls.push(g.id); return g === hidden ? [{ id: "hidden-action", key: "h", label: "Hidden mutation", run: () => assert.fail("raw action must not run") }] : []; },
    bulkActions: ctx => [bulkButton(ctx, invoked, "hidden-action")] });
  assert.equal(calls.filter(id => id === hidden.id).length, 1);
  assert.equal(root.querySelector('[data-tablist-card="hidden"]'), null);
  const rows = root.querySelectorAll("[data-tablist-row]");
  await key(rows[0], "x"); await key(rows[1], "x"); await key(rows[0], "h");
  assert.deepEqual(invoked, [[{ id: visible.id, indexes: [0, 1] }]]);
});

test("bulk shortcuts retain first raw ID discovery across action families and group order before filtering", async () => {
  const immutable = group("first-immutable"), mutable = group("second-mutable"), invoked = [];
  const descriptor = shortcut => [{ id: "shared", key: shortcut, label: "Fixture action",
    run: () => assert.fail("selected-set shortcut must invoke the bulk control") }];
  const root = mount({ groups: [immutable, mutable], selectable: "tab", immutable: g => g === immutable,
    rowActions: g => descriptor(g === immutable ? "r" : "a"),
    groupActions: g => descriptor(g === immutable ? "g" : "b"),
    windowActions: g => descriptor(g === immutable ? "w" : "c"),
    bulkActions: ctx => [bulkButton(ctx, invoked, "shared")] });
  const cards = root.querySelectorAll("[data-tablist-card]");
  assert.equal(cards[0].querySelector('[data-action-id="shared"]'), null,
    "the winning raw descriptor is filtered from immutable controls");
  const rows = cards[1].querySelectorAll("[data-tablist-row]");
  await key(rows[0], "x"); await key(rows[1], "x");
  const bulk = root.querySelector('[data-bulk-action="shared"]');
  assert.equal(bulk.getAttribute("data-shortcut-key"), "r");
  await key(rows[0], "r");
  assert.deepEqual(invoked, [[{ id: mutable.id, indexes: [0, 1] }]]);
  for (const shortcut of ["g", "w", "a", "b", "c"]) {
    const event = await document.dispatch("keydown", { target: rows[0], key: shortcut });
    assert.equal(event.defaultPrevented, false, `later shortcut ${shortcut} must not replace the first raw key`);
  }
  assert.equal(invoked.length, 1);
});

test("distinct group objects sharing an ID retain separate factories, callbacks and row buttons", async () => {
  // Duplicate IDs are not a supported selection identity: this probes only
  // initial action resolution with selection explicitly disabled.
  const first = group("same-id"), second = group("same-id");
  first.title = "First fixture"; second.title = "Second fixture";
  const calls = [], invoked = [];
  const root = mount({ groups: [first, second], selectable: "none",
    rowActions: g => {
      calls.push(g);
      return [{ id: "owned", key: "o", label: g.title,
        run: ctx => invoked.push({ factoryGroup: g, contextGroup: ctx.group, ref: ctx.ref }) }];
    } });
  assert.deepEqual(calls, [first, second]);
  const cards = root.querySelectorAll("[data-tablist-card]");
  assert.equal(cards.length, 2);
  for (const [index, g] of [first, second].entries()) {
    const rows = cards[index].querySelectorAll("[data-tablist-row]");
    const buttons = rows.map(row => row.querySelector('[data-action-id="owned"]'));
    assert.equal(new Set(buttons).size, g.refs.length, "each row owns a distinct rendered control");
    assert.ok(buttons.every(button => button.getAttribute("aria-label") === g.title));
    await buttons[0].dispatch("click"); await key(rows[1], "o");
    assert.deepEqual(invoked.slice(-2).map(result => result.ref), [g.refs[0], g.refs[1]]);
    for (const result of invoked.slice(-2)) {
      assert.equal(result.factoryGroup, g);
      assert.equal(result.contextGroup, g);
    }
  }
});
