/** Production controller + Open surface. Synthetic DOM verifies layout-read ordering, not browser timings. */
import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDomFixture } from './dom-fixture.mjs';
import { createInterleavableStorage, createMockLockManager } from './e2-mocks.mjs';
import { createChromeI18nMock } from './message-fixture.mjs';

const dom = installDomFixture();
const savedStyle = globalThis.getComputedStyle;
const frames = [], events = [], watched = new Map(), opacities = new Map();
let recording = false;
const hovered = new WeakSet(), focusVisible = new WeakSet();
globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
globalThis.CSS = { escape: String };
globalThis.matchMedia = window.matchMedia = () => ({ matches: false });
globalThis.HTMLInputElement = class {};
window.addEventListener = () => {};
window.scrollBy = () => {};
const createElement = document.createElement.bind(document);
document.createElement = tag => {
  const node = createElement(tag), attr = node.getAttribute.bind(node);
  const matches = node.matches.bind(node);
  // This fixture owns only these native pseudo-states; structural selectors use
  // the shared DOM matcher. Native Chrome owns the actual style/fade oracle.
  node.matches = selector => {
    if (selector === ':hover') return hovered.has(node);
    if (selector === ':focus-within') return node.contains(document.activeElement);
    if (selector === ':focus-visible') return focusVisible.has(node);
    return matches(selector);
  };
  node.getAttribute = name => name.startsWith('data-')
    ? node.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] ?? null : attr(name);
  node.hasAttribute = name => node.getAttribute(name) !== null;
  node.getClientRects = () => node.isConnected ? [node.getBoundingClientRect()] : [];
  for (const [owner, method] of [[node, 'setAttribute'], [node.classList, 'add'], [node.style, 'setProperty']]) {
    const original = owner[method].bind(owner);
    owner[method] = (...args) => {
      if (recording && watched.has(node) && node.isConnected) events.push(['write', watched.get(node)]);
      return original(...args);
    };
  }
  const removeChild = node.removeChild.bind(node);
  node.removeChild = child => {
    if (recording && watched.has(child) && child.isConnected) events.push(['detach', watched.get(child)]);
    return removeChild(child);
  };
  return node;
};
globalThis.getComputedStyle = node => {
  if (recording && watched.has(node)) events.push(['read', watched.get(node)]);
  return { ...savedStyle(node), opacity: String(opacities.get(node) ?? 1) };
};
const now = 10_000_000;
const tabs = () => [11, 12, 13, 14].map((id, index) => ({ id, windowId: 1, index,
  pinned: false, active: false, groupId: -1, title: `Synthetic ${id}`, url: `https://fixture.test/${id}` }));
let windows = [{ id: 1, type: 'normal', tabs: tabs() }];
const storage = createInterleavableStorage({ settings: {
  autoArchiveEnabled: true, autoDumpAfterMinutes: 1440, suspendEnabled: false,
  autoSaveMaxTabs: 0, suspendMaxTabs: 0
}, tabActivity: Object.fromEntries(tabs().map(tab => [tab.id, now - 3_600_000])) });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: createMockLockManager() } });
globalThis.chrome = {
  i18n: createChromeI18nMock(), storage: { local: storage.local, onChanged: storage.onChanged },
  runtime: { getURL: path => `chrome-extension://fixture/${path}`, onMessage: { addListener() {} } },
  windows: { getAll: async () => structuredClone(windows), getCurrent: async () => ({ id: 1 }) },
  tabs: { getCurrent: async () => null }, permissions: { contains: async () => false }
};
const { installBrowserMapStorageAuthority } = await import('./storage-authority-fixture.mjs');
installBrowserMapStorageAuthority();
const { createAutomationAwareness } = await import('../js/ui/automation-awareness.js');
const { createOpenSurface } = await import('../js/ui/open-surface.js');
const { clearSelection, createTabList } = await import('../js/ui/tablist.js');
const noop = () => {};
const owners = [];
function controller(overrides = {}) {
  const owner = createAutomationAwareness({ openSettings: noop, now: () => now, schedule: () => 1, cancel: noop, ...overrides });
  owners.push(owner); return owner;
}
function surface(awareness) {
  return createOpenSurface({ automationAwareness: awareness, msg: async () => ({ ok: true }),
    rerender: noop, shouldRenderBody: () => true, sectionActionHost: document.createElement('div'),
    getFlashAnchor: () => document.body, showNotice: noop, flashNote: noop, mark: node => node,
    cardLabelPanel: () => document.createElement('div'), sessionComboboxButton: () => document.createElement('button'),
    copyRefs: noop, renderArchive: noop, renderLabels: noop, goToLabel: noop });
}
const buttons = root => [...root.querySelectorAll('.automation-awareness-row')];
function watch(nodes) { nodes.forEach((node, i) => { watched.set(node, i); opacities.set(node, [0, .5, 1, .2][i]); const row = node.closest(".trow"); if (row) hovered.add(row); }); }
afterEach(() => {
  recording = false; for (const owner of owners.splice(0)) owner.close();
  document.body.replaceChildren(); clearSelection('open'); frames.length = 0; events.length = 0;
  watched.clear(); opacities.clear(); windows = [{ id: 1, type: 'normal', tabs: tabs() }];
});
after(() => dom.restore());

test('full Open rebuild reads all connected reveal states before any awareness paint or reparent', async () => {
  const awareness = controller(), owner = surface(awareness);
  const first = (await owner.render()).node; document.body.append(first);
  const original = buttons(first); assert.equal(original.length, 4); watch(original);
  first.querySelector('[data-tablist-row]')._tlRow.ctx.toggleSelect();
  windows[0].tabs = [windows[0].tabs[1], windows[0].tabs[0], windows[0].tabs[3], windows[0].tabs[2]]
    .map((tab, index) => ({ ...tab, index }));
  recording = true;
  const next = (await owner.render()).node;
  recording = false;
  const firstWrite = events.findIndex(([kind]) => kind !== 'read');
  const readPositions = events.flatMap(([kind], index) => kind === 'read' ? [index] : []);
  assert.equal(readPositions.length, 4);
  assert.ok(readPositions.every(index => index < firstWrite), 'all opacity reads must precede the first connected write/reparent');
  assert.deepEqual(buttons(next), [original[1], original[0], original[3], original[2]], 'cached buttons retain identity');
  assert.deepEqual(original.map(node => node.classList.contains('is-rejoining')), [false, true, true, false]);
  document.body.replaceChildren(next);
  assert.equal(next.querySelector('[data-tablist-row="t11"] input').checked, true, 'selection survives full list rebuild');
  assert.ok(original.every(node => node.classList.contains('has-meter')));
});

const timed = (afterMs = 3_600_000) => ({ display: 'timed', action: 'save', state: 'running',
  awayAt: now - 900_000, afterMs, progress: .25, settingsGroup: 'autosave' });
function mountRows(owner, count = 2) {
  const nodes = Array.from({ length: count }, (_, index) => owner.row(timed(), index));
  for (const node of nodes) { const row = document.createElement('div'); row.classList.add('trow'); row.append(node); document.body.append(row); }
  watch(nodes); return nodes;
}
function frame() { const pending = frames.splice(0); for (const callback of pending) callback(); }

test('each batch observes current opacity and retains the two-frame continuity release', () => {
  const owner = controller(), [node] = mountRows(owner, 1);
  opacities.set(node, .2);
  owner.withRowRender(() => assert.ok(owner.row(timed(), 0) === node));
  assert.equal(node.classList.contains('is-rejoining'), false);
  opacities.set(node, .8);
  owner.withRowRender(() => owner.row(timed(), 0));
  assert.equal(node.classList.contains('is-rejoining'), true);
  frame(); assert.equal(node.classList.contains('is-rejoining'), true);
  frame(); assert.equal(node.classList.contains('is-rejoining'), false);
  opacities.set(node, .1);
  owner.withRowRender(() => owner.row(timed(), 0));
  assert.equal(node.classList.contains('is-rejoining'), false);
});

test('nested synchronous builds share initial reads even after reuse writes and a caught inner failure', () => {
  const owner = controller(), [one, two] = mountRows(owner);
  opacities.set(one, 1); opacities.set(two, 1); recording = true;
  const result = owner.withRowRender(() => {
    owner.row(timed(), 0);
    assert.throws(() => owner.withRowRender(() => { throw new Error('fixture'); }), /fixture/);
    return owner.withRowRender(() => owner.row(timed(), 1));
  });
  recording = false;
  assert.ok(result === two);
  assert.deepEqual(events.filter(([kind]) => kind === 'read'), [['read', 0], ['read', 1]]);
  assert.ok(events.slice(0, 2).every(([kind]) => kind === 'read'));
});

test('throwing construction releases its snapshot so subsequent direct calls read current state', () => {
  const owner = controller(), [node] = mountRows(owner, 1);
  opacities.set(node, 1);
  assert.throws(() => owner.withRowRender(() => { throw new Error('fixture'); }), /fixture/);
  opacities.set(node, 0); recording = true;
  assert.ok(owner.row(timed(), 0) === node);
  recording = false;
  assert.deepEqual(events.filter(([kind]) => kind === 'read'), [['read', 0]]);
  assert.equal(node.classList.contains('is-rejoining'), false);
});

test('unbatched row and Inbox consumers retain direct continuity reads and current policy painting', () => {
  const owner = controller(), [row] = mountRows(owner, 1);
  const inboxView = { display: 'rule', afterMs: 86_400_000, afterDays: 1, settingsGroup: 'autosave' };
  const inbox = owner.inbox(inboxView, 'saved'), item = document.createElement('div');
  item.classList.add('item'); item.append(inbox); document.body.append(item); hovered.add(item);
  watched.set(inbox, 9); opacities.set(inbox, .9); opacities.set(row, .9);
  const previousLabel = row.getAttribute('aria-label'); recording = true;
  assert.ok(owner.row(timed(7_200_000), 0) === row);
  assert.ok(owner.inbox(inboxView, 'saved') === inbox);
  recording = false;
  assert.deepEqual(events.filter(([kind]) => kind === 'read'), [['read', 0], ['read', 9]]);
  assert.notEqual(row.getAttribute('aria-label'), previousLabel);
  assert.equal(row.style.getPropertyValue('--automation-awareness-progress'), '13%');
  assert.equal(row.classList.contains('is-rejoining'), true);
  assert.equal(inbox.classList.contains('is-rejoining'), true);
});

test('first-mount and disconnected cached buttons never read computed reveal state', () => {
  const owner = controller();
  const detached = owner.row(timed(), 1); watched.set(detached, 1);
  recording = true;
  const result = owner.withRowRender(() => [owner.row(timed(), 1), owner.row(timed(), 2)]);
  recording = false;
  assert.ok(result[0] === detached);
  assert.deepEqual(events, []);
  assert.ok(result.every(node => !node.classList.contains('is-rejoining')));
});

test('retained picker trigger keeps its expanded state, details and focused control across a batch mount', async () => {
  const previousMutation = globalThis.MutationObserver, previousResize = globalThis.ResizeObserver;
  globalThis.MutationObserver = globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  window.innerWidth = 1000; window.innerHeight = 800;
  try {
    const owner = controller(), [trigger] = mountRows(owner, 1);
    await trigger.dispatch('click');
    const details = document.querySelector('.action-popover'), focused = document.activeElement;
    assert.ok(details); assert.ok(details.contains(focused));
    const next = owner.withRowRender(() => {
      const host = document.createElement('div'); host.append(owner.row(timed(), 0)); return host;
    });
    document.body.append(next); owner.sync();
    assert.ok(next.children[0] === trigger);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.ok(document.querySelector('.action-popover') === details);
    assert.ok(document.activeElement === focused);
  } finally { globalThis.MutationObserver = previousMutation; globalThis.ResizeObserver = previousResize; }
});

test('a previously hidden cached trigger suppresses remount transitions without forcing reveal', () => {
  const owner = controller(), [trigger] = mountRows(owner, 1);
  opacities.set(trigger, 0);
  owner.withRowRender(() => owner.row(timed(), 0));
  assert.equal(trigger.classList.contains('is-remounting'), true,
    'the row moving under a stationary pointer must not restart its reveal transition');
  assert.equal(trigger.classList.contains('is-rejoining'), false, 'unhovered rows must remain hidden');
  frame(); assert.equal(trigger.classList.contains('is-remounting'), true);
  frame(); assert.equal(trigger.classList.contains('is-remounting'), false, 'ordinary pointer fades resume after handoff');
});

test('a newer remount survives the preceding handoff callback and releases on its own second frame', () => {
  const owner = controller(), [trigger] = mountRows(owner, 1);
  owner.withRowRender(() => owner.row(timed(), 0));
  frame();
  owner.withRowRender(() => owner.row(timed(), 0));
  frame();
  assert.equal(trigger.classList.contains('is-remounting'), true, 'old token must not finish the new handoff');
  frame();
  assert.equal(trigger.classList.contains('is-remounting'), false);
  assert.equal(trigger.classList.contains('is-rejoining'), false);
});

test('nested reuse and a failed build do not leave remount suppression behind', () => {
  const owner = controller(), [trigger] = mountRows(owner, 1);
  opacities.set(trigger, 1);
  assert.throws(() => owner.withRowRender(() => {
    owner.row(timed(), 0);
    owner.withRowRender(() => owner.row(timed(), 0));
    throw new Error('fixture');
  }), /fixture/);
  assert.equal(trigger.classList.contains('is-rejoining'), true, 'the visible bridge remains intact');
  assert.equal(trigger.classList.contains('is-remounting'), true);
  frame(); frame();
  assert.equal(trigger.classList.contains('is-remounting'), false);
  assert.equal(trigger.classList.contains('is-rejoining'), false);
});

test('genuinely new triggers keep ordinary reveal transitions on their first mount', () => {
  const owner = controller();
  const fresh = owner.withRowRender(() => owner.row(timed(), 'fresh'));
  document.body.append(fresh);
  assert.equal(fresh.classList.contains('is-remounting'), false);
  assert.equal(fresh.classList.contains('is-rejoining'), false);
  assert.equal(frames.length, 0);
});

test('hidden-document fallback still releases remount classes after two scheduled turns', () => {
  const scheduled = [], previousHidden = document.hidden;
  document.hidden = true;
  try {
    const owner = controller({ schedule: (callback, delay) => { scheduled.push({ callback, delay }); return 1; } });
    const [trigger] = mountRows(owner, 1);
    owner.withRowRender(() => owner.row(timed(), 0));
    assert.equal(frames.length, 0);
    assert.equal(scheduled[0].delay, 16);
    scheduled.shift().callback();
    assert.equal(trigger.classList.contains('is-remounting'), true);
    scheduled.shift().callback();
    assert.equal(trigger.classList.contains('is-remounting'), false);
  } finally { document.hidden = previousHidden; }
});


test('a fading Open trigger without current reveal intent cannot brighten on remount', () => {
  const owner = controller(), [trigger] = mountRows(owner, 1);
  const row = trigger.closest('.trow');
  hovered.delete(row);
  for (const opacity of [.54, 1]) {
    opacities.set(trigger, opacity);
    owner.withRowRender(() => owner.row(timed(), 0));
    assert.equal(trigger.classList.contains('is-rejoining'), false,
      'residual fade opacity is not a current reveal request');
    assert.equal(trigger.classList.contains('is-remounting'), true);
    frame(); frame();
  }
});

test('a fading Inbox trigger without current card reveal intent cannot brighten on remount', () => {
  const owner = controller(), view = { display: 'rule', afterMs: 86_400_000, settingsGroup: 'autosave' };
  const trigger = owner.inbox(view, 'saved'), item = document.createElement('div');
  item.classList.add('item'); item.append(trigger); document.body.append(item);
  opacities.set(trigger, .54);
  assert.ok(owner.inbox(view, 'saved') === trigger);
  assert.equal(trigger.classList.contains('is-rejoining'), false);
  assert.equal(trigger.classList.contains('is-remounting'), true);
});

for (const intent of ['hover', 'focus-within', 'kbd-reveal', 'focus-visible', 'is-protected', 'is-expired']) {
  test(`Open ${intent} retains a revealed cached trigger`, () => {
    const owner = controller(), [trigger] = mountRows(owner, 1), row = trigger.closest('.trow');
    hovered.delete(row);
    if (intent === 'hover') hovered.add(row);
    else if (intent === 'focus-within') {
      const input = document.createElement('input'); row.append(input); input.focus();
    } else if (intent === 'focus-visible') focusVisible.add(trigger);
    else (intent === 'kbd-reveal' ? row : trigger).classList.add(intent);
    opacities.set(trigger, .54);
    owner.withRowRender(() => owner.row(timed(), 0));
    assert.equal(trigger.classList.contains('is-rejoining'), true);
    frame(); frame();
    assert.equal(trigger.classList.contains('is-rejoining'), false);
    assert.equal(trigger.classList.contains('is-remounting'), false);
  });
}
for (const intent of ['hover', 'focus-within', 'palette-source']) {
  test(`Inbox ${intent} retains a revealed cached trigger`, () => {
    const owner = controller(), view = { display: 'rule', afterMs: 86_400_000, settingsGroup: 'autosave' };
    const trigger = owner.inbox(view, 'saved'), item = document.createElement('div');
    item.classList.add('item'); item.append(trigger); document.body.append(item);
    if (intent === 'hover') hovered.add(item);
    else if (intent === 'focus-within') {
      const button = document.createElement('button'); item.append(button); button.focus();
    } else item.classList.add('palette-source');
    opacities.set(trigger, .54);
    owner.inbox(view, 'saved');
    assert.equal(trigger.classList.contains('is-rejoining'), true);
  });
}

test('a previous bridge or Open palette source alone cannot authorize another reveal', () => {
  const owner = controller(), [trigger] = mountRows(owner, 1), row = trigger.closest('.trow');
  opacities.set(trigger, 1);
  owner.withRowRender(() => owner.row(timed(), 0));
  assert.equal(trigger.classList.contains('is-rejoining'), true);
  hovered.delete(row); row.classList.add('palette-source');
  owner.withRowRender(() => owner.row(timed(), 0));
  assert.equal(trigger.classList.contains('is-rejoining'), false,
    'Open palette-source does not reveal awareness in CSS, unlike Inbox');
  frame(); frame();
  assert.equal(trigger.classList.contains('is-remounting'), false);
});

// Root handoff is a real list lifecycle, independent of cached indicator state.
function mountList(section = 'open') {
  const root = createTabList({ section, selectable: 'none', groups: [{
    id: 'mount-fixture', title: 'Synthetic window',
    refs: [{ title: 'Synthetic page', url: 'https://fixture.test/mount', labels: [] }]
  }] });
  document.body.append(root);
  assert.equal(root.querySelectorAll('[data-tablist-row]').length, 1);
  return root;
}

test('Open list root suppresses mount transitions immediately and releases after two frames', () => {
  const root = mountList();
  assert.equal(root.classList.contains('is-mounting'), true);
  frame();
  assert.equal(root.classList.contains('is-mounting'), true, 'the first frame still belongs to the handoff');
  frame();
  assert.equal(root.classList.contains('is-mounting'), false);
  assert.equal(root.querySelectorAll('[data-tablist-row]').length, 1, 'cleanup preserves rendered rows');
});

test('non-Open list roots retain their ordinary transition lifecycle', () => {
  const roots = ['inbox', 'archive', 'sessions', 'snoozed'].map(mountList);
  assert.ok(roots.every(root => !root.classList.contains('is-mounting')));
  frame(); frame();
  assert.ok(roots.every(root => !root.classList.contains('is-mounting')));
});

test('overlapping Open roots release only their own mount handoff', () => {
  const first = mountList();
  frame();
  const second = mountList();
  assert.notEqual(first, second);
  assert.ok(first.classList.contains('is-mounting') && second.classList.contains('is-mounting'));
  frame();
  assert.equal(first.classList.contains('is-mounting'), false);
  assert.equal(second.classList.contains('is-mounting'), true, 'earlier root cleanup cannot release the newer root');
  frame();
  assert.equal(second.classList.contains('is-mounting'), false);
});

test('hidden Open list mount releases through timer turns without a frame callback', () => {
  const previousHidden = document.hidden, previousTimeout = globalThis.setTimeout;
  const scheduled = [];
  document.hidden = true;
  globalThis.setTimeout = (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; };
  const turn = () => {
    const pending = scheduled.splice(0);
    assert.ok(pending.length, 'hidden handoff schedules a bounded timer turn');
    for (const { callback, delay } of pending) {
      assert.equal(delay, 16);
      callback();
    }
  };
  try {
    const root = mountList();
    assert.equal(root.classList.contains('is-mounting'), true);
    assert.equal(frames.length, 0);
    turn();
    assert.equal(root.classList.contains('is-mounting'), true);
    turn();
    assert.equal(root.classList.contains('is-mounting'), false);
    assert.equal(scheduled.length, 0);
    assert.equal(frames.length, 0);
  } finally {
    document.hidden = previousHidden;
    globalThis.setTimeout = previousTimeout;
  }
});
