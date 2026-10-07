/** Production Open surface/list behavior with synthetic Chrome and a minimal DOM; no layout timing claim. */
import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDomFixture } from './dom-fixture.mjs';
import { createInterleavableStorage, createMockLockManager } from './e2-mocks.mjs';
import { createChromeI18nMock } from './message-fixture.mjs';

const fixture = installDomFixture();
const storage = createInterleavableStorage({});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: createMockLockManager() } });
globalThis.CSS = { escape: String };
globalThis.matchMedia = window.matchMedia = () => ({ matches: true });
globalThis.requestAnimationFrame = () => 1;
globalThis.HTMLInputElement = class {};
window.addEventListener = () => {};
window.scrollBy = () => {};
const createElement = document.createElement.bind(document);
document.createElement = tag => {
  const node = createElement(tag), getAttribute = node.getAttribute.bind(node);
  node.getAttribute = name => name.startsWith('data-')
    ? node.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] ?? null : getAttribute(name);
  node.hasAttribute = name => node.getAttribute(name) != null;
  node.click = () => node.dispatch('click');
  node.cloneNode = deep => {
    const clone = document.createElement(tag);
    for (const [key, value] of node.attributes) clone.setAttribute(key, value);
    if (deep) for (const child of node.childNodes) clone.append(child.nodeType === 3 ? child.textContent : child.cloneNode(true));
    return clone;
  };
  // Native insertion removes a moved focused subtree; the runtime must restore focus.
  node.insertBefore = (child, before) => {
    if (child === before) return child;
    child.parentNode?.removeChild(child);
    node.append(child);
    node.childNodes.pop();
    const index = before == null ? node.childNodes.length : node.childNodes.indexOf(before);
    assert.ok(index >= 0);
    node.childNodes.splice(index, 0, child);
    return child;
  };
  return node;
};
const tab = (id, windowId, index) => ({ id, windowId, index, pinned: false, groupId: -1,
  title: `Fixture ${id}`, url: `https://fixture.test/${id}` });
const seed = () => [{ id: 1, type: 'normal', incognito: false, tabs: [11, 12, 13].map((id, i) => tab(id, 1, i)) },
  { id: 2, type: 'normal', incognito: false, tabs: [21, 22].map((id, i) => tab(id, 2, i)) }];
let windows = seed();
const sent = [];
globalThis.chrome = {
  i18n: createChromeI18nMock(), storage: { local: storage.local, onChanged: storage.onChanged },
  runtime: { getURL: path => `chrome-extension://fixture/${path}`, onMessage: { addListener() {} } },
  tabs: { getCurrent: async () => null, get: async id => structuredClone(windows.flatMap(w => w.tabs).find(t => t.id === id)) },
  windows: { getAll: async () => structuredClone(windows), getCurrent: async () => ({ id: 1 }) },
  permissions: { contains: async () => false }
};
const { installBrowserMapStorageAuthority } = await import('./storage-authority-fixture.mjs');
installBrowserMapStorageAuthority();
const { createOpenSurface } = await import('../js/ui/open-surface.js');
const { clearSelection } = await import('../js/ui/tablist.js');
const noop = () => {};
function surface(overrides = {}) {
  return createOpenSurface({ msg: async message => { sent.push(structuredClone(message)); return { ok: true }; },
    rerender: noop, shouldRenderBody: () => true, canReconcilePlacement: () => true,
    sectionActionHost: document.createElement('div'), getFlashAnchor: () => document.body,
    showNotice: noop, flashNote: noop, mark: node => node, cardLabelPanel: () => document.createElement('div'),
    sessionComboboxButton: label => { const b = document.createElement('button'); b.textContent = label; return b; },
    copyRefs: noop, renderArchive: noop, renderLabels: noop, goToLabel: noop, ...overrides });
}
async function mount(owner) { const result = await owner.render(); document.body.replaceChildren(result.node); return result.node; }
function reorder(ids = [13, 11, 12]) {
  const byId = new Map(windows[0].tabs.map(t => [t.id, t]));
  windows[0].tabs = ids.map((id, index) => ({ ...byId.get(id), index }));
}
const rows = root => [...root.querySelectorAll('[data-tablist-row]')];
const ids = root => rows(root).map(row => row._tlRow.ctx.live.tabId);
afterEach(() => { clearSelection('open'); document.body.replaceChildren(); windows = seed(); sent.length = 0; });
after(() => fixture.restore());

test('same-window placement retains mounted root, every card/row, fresh index/raw contexts and focus', async () => {
  const owner = surface(), root = await mount(owner), oldRows = rows(root), cards = [...root.querySelectorAll('[data-tablist-card]')];
  const oldGroup = oldRows[0]._tlRow.ctx.group, oldWindow = oldGroup.data;
  const focus = oldRows[2].querySelector('input'); focus.focus();
  reorder();
  const result = await owner.render();
  assert.ok(result.node === root, 'same mounted root must survive a placement-only refresh');
  assert.equal(result.placementUpdated, true);
  assert.deepEqual(ids(root), [13, 11, 12, 21, 22]);
  assert.deepEqual([...root.querySelectorAll('[data-tablist-card]')], cards);
  for (const row of rows(root)) assert.ok(oldRows.includes(row));
  assert.equal(document.activeElement, focus);
  for (const [index, row] of rows(root).slice(0, 3).entries()) {
    const ctx = row._tlRow.ctx;
    assert.equal(ctx.index, index); assert.equal(ctx.live.chromeIndex, index);
    assert.equal(ctx.ref, ctx.group.refs[index]); assert.equal(ctx.live, ctx.group.live[index]);
    assert.equal(ctx.group, oldGroup); assert.equal(ctx.group.data, oldWindow);
    assert.equal(ctx.group.data.tabs[index].id, ctx.live.tabId);
    assert.equal(ctx.group.data.tabs[index].index, index);
  }
  const later = await owner.render();
  assert.equal(later.node, root, 'the delayed no-op refresh must retain the same root');
});

test('visual range selection and bulk copy follow the fresh order after a previously cached range', async () => {
  const copied = [], owner = surface({ copyRefs: refs => copied.push(refs.map(ref => ref.title)) });
  const root = await mount(owner), [one, two, three] = rows(root);
  one._tlRow.ctx.toggleSelect();
  three._tlRow.ctx.rangeTo(); // Populate the old ordered-key cache.
  three._tlRow.ctx.rangeTo(); // Remove that range, retain the anchor.
  one._tlRow.ctx.toggleSelect();
  reorder();
  assert.ok((await owner.render()).node === root);
  three._tlRow.ctx.rangeTo();
  assert.deepEqual(rows(root).filter(row => row.classList.contains('sel')).map(row => row._tlRow.ctx.live.tabId), [13, 11]);
  assert.equal(two.querySelector('input').checked, false);
  await root.querySelector('[data-bulk-action="copy"]').dispatch('click');
  assert.deepEqual(copied.at(-1), ['Fixture 13', 'Fixture 11']);
  const first = rows(root)[0];
  await first.querySelector('.t a').dispatch('click');
  assert.deepEqual(sent.at(-1), { type: 'focus-tab', tabId: 13, windowId: 1 });
  first.focus();
  await document.dispatch('keydown', { target: first, key: 'r' });
  assert.deepEqual(sent.at(-1), { type: 'focus-tab', tabId: 13, windowId: 1 });
});

test('window copy reads reordered refs and no-op refresh leaves selected toolbar nodes untouched', async () => {
  const copied = [], owner = surface({ copyRefs: refs => copied.push(refs.map(ref => ref.title)) });
  const root = await mount(owner);
  reorder(); await owner.render();
  await root.querySelector('[data-action-id="copy"]').dispatch('click');
  assert.deepEqual(copied.at(-1), ['Fixture 13', 'Fixture 11', 'Fixture 12']);
  rows(root)[0]._tlRow.ctx.toggleSelect();
  const action = root.querySelector('[data-bulk-action="copy"]');
  await owner.render();
  assert.ok(root.querySelector('[data-bulk-action="copy"]') === action);
});

test('placement restores nonzero scroll after native-style insertion anchoring', async () => {
  const owner = surface(), root = await mount(owner), body = rows(root)[0].parentNode;
  const insert = body.insertBefore.bind(body), corrections = [];
  window.scrollY = 475;
  window.scrollTo = (x, y) => { corrections.push([x, y]); window.scrollY = y; };
  body.insertBefore = (...args) => { const result = insert(...args); window.scrollY = 25; return result; };
  reorder(); await owner.render();
  assert.deepEqual(corrections, [[0, 475]]);
  assert.equal(window.scrollY, 475);
});

test('opt-in is required and a gate raised during fresh reads prevents mounted mutations', async () => {
  let permitted = true;
  const owner = surface({ canReconcilePlacement: () => permitted }), root = await mount(owner);
  reorder();
  const getAll = chrome.windows.getAll;
  chrome.windows.getAll = async () => { permitted = false; return structuredClone(windows); };
  const result = await owner.render();
  chrome.windows.getAll = getAll;
  assert.notEqual(result.placementUpdated, true);
  assert.deepEqual(ids(root), [11, 12, 13, 21, 22]);
  assert.ok(result.node !== root);
  const legacy = surface({ canReconcilePlacement: undefined }), legacyRoot = await mount(legacy);
  assert.ok((await legacy.render()).node !== legacyRoot);
});

for (const [name, change] of [
  ['title', () => { windows[0].tabs[0].title = 'Changed fixture'; }],
  ['navigation', () => { windows[0].tabs[0].url = 'https://fixture.test/changed'; }],
  ['pinning', () => { windows[0].tabs[0].pinned = true; }],
  ['live groups', () => { windows[0].tabs[0].groupId = 10; }],
  ['new tab', () => { windows[0].tabs.push(tab(14, 1, 3)); }],
  ['cross-window move', () => { const moved = windows[0].tabs.pop(); windows[1].tabs.push({ ...moved, windowId: 2, index: 2 }); }]
]) test(`${name} uses the full fresh render without partially mutating the old root`, async () => {
  const owner = surface(), root = await mount(owner);
  const before = ids(root); change();
  const result = await owner.render();
  assert.ok(result.node !== root); assert.notEqual(result.placementUpdated, true);
  assert.deepEqual(ids(root), before);
});

test('capped rows and active filters keep the full render path', async () => {
  const capped = surface({ rowCap: 1 }), cappedRoot = await mount(capped);
  reorder(); assert.ok((await capped.render()).node !== cappedRoot);
  const filterHost = document.createElement('div'), owner = surface({ filterHost });
  const root = await mount(owner);
  const input = filterHost.querySelector('input'); input.value = 'fixture 1'; await input.dispatch('input');
  const result = await owner.render();
  assert.ok(result.node !== root);
  assert.deepEqual(ids(result.node), [13, 11, 12]);
});

test('hidden render never mutates an attached list', async () => {
  let visible = true;
  const owner = surface({ shouldRenderBody: () => visible }), root = await mount(owner);
  visible = false; reorder();
  assert.equal((await owner.render()).node, null);
  assert.deepEqual(ids(root), [11, 12, 13, 21, 22]);
});


test('saved-label invalidation declines reuse until fresh enrichment can be rendered', async () => {
  const owner = surface(), root = await mount(owner);
  owner.invalidateSavedLabels(); reorder();
  assert.ok((await owner.render()).node !== root);
  assert.deepEqual(ids(root), [11, 12, 13, 21, 22]);
});

test('unchanged automation observations are compared by tab identity, not Chrome enumeration order', async () => {
  const owner = surface({ automationAwareness: { row: () => null } }), root = await mount(owner);
  reorder();
  assert.ok((await owner.render()).node === root, 'reordering the same per-tab observations must allow placement');
});

test('crossing a relative-age boundary uses fresh displayed copy', async () => {
  const originalNow = Date.now, originalTimer = globalThis.setTimeout;
  let now = 1_000_000;
  Date.now = () => now;
  globalThis.setTimeout = () => 1; // Idle header's long boundary timer is outside this synchronous test.
  try {
    windows[0].tabs[0].lastAccessed = now - 50_000;
    const owner = surface(), root = await mount(owner);
    assert.equal(rows(root)[0].querySelector('.row-recency').textContent, 'just now');
    now += 20_000;
    const result = await owner.render();
    assert.equal(rows(result.node)[0].querySelector('.row-recency').textContent, '1m ago');
  } finally { Date.now = originalNow; globalThis.setTimeout = originalTimer; }
});

test('warmed Organize rereads current raw tab positions after retained placement', async () => {
  const { dismissAnchoredPanel } = await import('../js/ui/tablist.js');
  const oldMutation = globalThis.MutationObserver, oldResize = globalThis.ResizeObserver;
  globalThis.MutationObserver = globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  window.innerWidth = 1000; window.innerHeight = 800;
  try {
    const owner = surface(), root = await mount(owner), raw = rows(root)[0]._tlRow.ctx.group.data.tabs[0];
    let index = raw.index, reads = 0;
    Object.defineProperty(raw, 'index', { enumerable: true, configurable: true,
      get() { reads++; return index; }, set(value) { index = value; } });
    const organize = root.querySelector('[data-action-id="organize"]');
    await organize.dispatch('click');
    assert.ok(reads > 0, 'first open prepares organization projection');
    dismissAnchoredPanel(); reorder();
    assert.ok((await owner.render()).node === root);
    reads = 0;
    await organize.dispatch('click');
    assert.ok(reads > 0, 'reopening recomputes from the original retained window owner');
    assert.equal(index, 1);
  } finally {
    dismissAnchoredPanel();
    globalThis.MutationObserver = oldMutation; globalThis.ResizeObserver = oldResize;
  }
});

test('changed automation policy forces fresh controls instead of retaining an old observation', async () => {
  const owner = surface({ automationAwareness: { row: () => null } }), root = await mount(owner);
  await storage.local.set({ settings: { autoSaveMaxTabs: 2 } });
  const result = await owner.render();
  assert.ok(result.node !== root);
  await storage.local.set({ settings: {} });
});

test('changed Session identity and binding refresh titles and ownership through the full render', async () => {
  const owner = surface(), root = await mount(owner);
  await storage.local.set({
    sessionIdentityIndex: { version: 2, sessionsById: { named: { id: 'named', name: 'Fresh name', windowUrls: [[]] } } },
    sessionWindows: { 1: { sessionId: 'named', windowIndex: 0 } }
  });
  const result = await owner.render();
  assert.ok(result.node !== root);
  assert.equal(rows(result.node)[0]._tlRow.ctx.group.title, 'Fresh name');
  await storage.local.set({ sessionIdentityIndex: { version: 2, sessionsById: {} }, sessionWindows: {} });
});

test('multi-window selected keeper resolves fresh indexes without changing selection totals', async () => {
  const copied = [], owner = surface({ copyRefs: refs => copied.push(refs.map(ref => ref.title)) });
  const root = await mount(owner);
  rows(root)[0]._tlRow.ctx.toggleSelect(); rows(root)[3]._tlRow.ctx.toggleSelect();
  reorder(); assert.ok((await owner.render()).node === root);
  await root.querySelector('.bulk-bar [data-bulk-action="copy"]').dispatch('click');
  assert.deepEqual(copied.at(-1), ['Fixture 11', 'Fixture 21']);
  assert.equal(rows(root).filter(row => row.querySelector('input').checked).length, 2);
});

for (const [name, count, tabs] of [['section group cap', 21, 1], ['initial row budget', 8, 40]]) {
  test(`${name} cannot reconcile a partially rendered placement model`, async () => {
    windows = Array.from({ length: count }, (_, i) => ({ id: i + 1, type: 'normal', incognito: false,
      tabs: Array.from({ length: tabs }, (_, n) => tab(i * 100 + n + 1, i + 1, n)) }));
    const owner = surface(), root = await mount(owner), before = ids(root);
    assert.ok(before.length < count * tabs);
    const result = await owner.render();
    assert.ok(result.node !== root); assert.deepEqual(ids(root), before);
  });
}

test('folded windows reject placement without changing the existing folded owner', async () => {
  const owner = surface(), root = await mount(owner);
  await root.querySelector('.item-head-toggle').dispatch('click');
  assert.deepEqual(ids(root), [21, 22]);
  reorder();
  assert.ok((await owner.render()).node !== root);
  assert.deepEqual(ids(root), [21, 22]);
  await root.querySelector('.item-head-toggle').dispatch('click'); // Clear shared section fold state.
});
