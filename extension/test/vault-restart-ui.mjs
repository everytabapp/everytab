/** Mounted Restart control with a synthetic stalled retained-handle read.
 * Exercises the production surface; no personal folder or browser is used.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { installDomFixture } from './dom-fixture.mjs';
import { createChromeI18nMock } from './message-fixture.mjs';
import { createMockLockManager } from './e2-mocks.mjs';
import { installBrowserMapStorageAuthority } from './storage-authority-fixture.mjs';

const dom = installDomFixture();
const previousIndexedDB = globalThis.indexedDB;
const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
Object.defineProperty(globalThis, 'navigator', {
  value: { locks: createMockLockManager() }, configurable: true
});
const { createVaultSurface } = await import('../js/ui/vault-surface.js');

async function fixture({ control = "inline", ownerTabId = 47, currentTabId = 47 } = {}) {
  let stalledPermission = null;
  let permissionReads = 0;
  const reloads = [];
  const notices = [];
  const events = [];
  let reloadFailure = null, fallbackFailure = null, reloadPending = null;
  let fallbackCount = 0;
  let changes = 0;
  const mem = { vaultMetaV2: { ok: false, lastSyncAt: 123, failureCode: 'timeout', ...(ownerTabId == null ? {} : { ownerTabId }) } };
  const handle = { name: 'Synthetic Vault', kind: 'directory', async queryPermission() {
    permissionReads++;
    events.push("folder-read");
    return stalledPermission ?? 'granted';
  } };
  globalThis.indexedDB = { open() {
    const opening = {};
    queueMicrotask(() => {
      opening.result = { close() {}, transaction() {
        const tx = { objectStore() { return { get() {
          const request = {};
          queueMicrotask(() => { request.result = handle; request.onsuccess(); tx.oncomplete?.(); });
          return request;
        } }; } };
        return tx;
      } };
      opening.onsuccess();
    });
    return opening;
  } };
  Object.defineProperty(globalThis, "location", { configurable: true, value: { reload() {
    events.push("fallback"); fallbackCount++;
    if (fallbackFailure) throw fallbackFailure;
  } } });
  globalThis.chrome = {
    i18n: createChromeI18nMock(),
    tabs: { async getCurrent() { return { id: currentTabId }; }, async reload(id) {
      events.push("reload"); reloads.push(id);
      if (reloadPending) await reloadPending;
      if (reloadFailure) throw reloadFailure;
    } },
    storage: { local: {
      async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
        .filter(key => key in mem).map(key => [key, structuredClone(mem[key])])); },
      async set(values) { Object.assign(mem, structuredClone(values)); }
    } }
  };
  installBrowserMapStorageAuthority();
  const body = document.createElement('div'), banner = document.createElement('div');
  document.body.replaceChildren(banner, body);
  const surface = createVaultSurface({ getBody: () => body, getBanner: () => banner,
    setHeading() {}, onStateChange() { changes++; }, showNotice: (...args) => notices.push(args), goToVault() {} });
  await surface.render();
  const inline = [...body.querySelectorAll('button')].find(node => node.textContent === 'Restart sync');
  const hero = [...banner.querySelectorAll('button')].find(node => node.textContent === 'Restart sync');
  const button = control === "hero" ? hero : inline;
  assert.ok(button, 'the production timeout state offers Restart sync');
  return { button, inline, hero, body, banner, reloads, notices, mem, surface, events,
    fallbackCount: () => fallbackCount, changes: () => changes,
    failReload(error) { reloadFailure = error; }, failFallback(error) { fallbackFailure = error; },
    holdReload() { let release; reloadPending = new Promise(resolve => { release = resolve; }); return release; },
    stallPermission() {
      let release;
      stalledPermission = new Promise(resolve => { release = resolve; });
      return () => { release('granted'); stalledPermission = null; };
    }, permissionReads: () => permissionReads };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(predicate) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await settle();
  }
  assert.fail('synthetic continuation did not settle');
}

try {
  for (const control of ['inline', 'hero']) {
    await test(`${control} Restart reaches the same owner without folder reads and guards both controls`, async () => {
      const f = await fixture({ control });
      const originalMeta = structuredClone(f.mem.vaultMetaV2);
      const releaseFolder = f.stallPermission(), releaseReload = f.holdReload();
      const before = f.permissionReads();
      const click = f.button.dispatch('click');
      for (const button of [f.inline, f.hero]) {
        assert.equal(button.disabled, true, 'feedback is synchronous on both controls');
        assert.equal(button.textContent, 'Restarting…');
      }
      await Promise.all([f.inline.dispatch('click'), f.hero.dispatch('click')]);
      await until(() => f.reloads.length === 1);
      assert.deepEqual(f.reloads, [47]);
      assert.equal(f.permissionReads(), before);
      releaseReload(); await click;
      assert.deepEqual(f.mem.vaultMetaV2, originalMeta, 'restart is not a sync receipt');
      assert.equal(f.changes(), 0, 'restart must not trigger host status reads before page replacement');
      assert.ok(f.inline.disabled && f.hero.disabled);
      assert.equal(f.notices.length, 0);
      releaseFolder();
    });

    await test(`${control} Restart reloads a remote owner before the existing local continuation`, async () => {
      const f = await fixture({ control, ownerTabId: 88 });
      const release = f.stallPermission();
      f.events.length = 0;
      await f.button.dispatch('click');
      await until(() => f.events.includes('folder-read'));
      assert.deepEqual(f.reloads, [88]);
      assert.ok(f.events.indexOf('reload') < f.events.indexOf('folder-read'));
      assert.equal(f.inline.textContent, 'Syncing…');
      release();
      // This synthetic read authority cannot replicate a Vault; allow the real
      // existing continuation to finish its bounded unavailable-authority result.
      await until(() => f.changes() >= 2);
      assert.equal(f.mem.vaultMetaV2.ok, false);
      assert.notEqual(f.mem.vaultMetaV2.lastSyncAt, 123);
    });

    for (const missing of [false, true]) await test(`${control} Restart uses current-page fallback when owner ${missing ? 'is absent' : 'cannot reload'}`, async () => {
      const f = await fixture({ control, ownerTabId: missing ? null : 47 });
      const release = f.stallPermission();
      const before = f.permissionReads();
      if (!missing) f.failReload(new Error('private fixture failure /unshared/path'));
      await f.button.dispatch('click');
      assert.deepEqual(f.reloads, missing ? [] : [47]);
      assert.equal(f.fallbackCount(), 1);
      assert.equal(f.permissionReads(), before);
      assert.ok(f.inline.disabled && f.hero.disabled);
      assert.equal(f.notices.length, 0);
      release();
    });

    await test(`${control} failed reload/fallback stays retryable with safe feedback while folder remains stalled`, async () => {
      const f = await fixture({ control });
      const beforeMeta = structuredClone(f.mem.vaultMetaV2);
      const release = f.stallPermission();
      const before = f.permissionReads();
      const error = new Error('private fixture failure /unshared/path');
      f.failReload(error); f.failFallback(error);
      await assert.doesNotReject(f.button.dispatch('click'));
      assert.equal(f.permissionReads(), before);
      assert.deepEqual(f.reloads, [47]); assert.equal(f.fallbackCount(), 1);
      for (const button of [f.inline, f.hero]) {
        assert.equal(button.disabled, false); assert.equal(button.textContent, 'Restart sync');
      }
      assert.equal(f.notices.length, 1);
      assert.equal(f.notices[0][0], 'Vault sync could not restart: Unknown error');
      assert.match(f.body.textContent, /Vault sync could not restart: Unknown error/);
      assert.doesNotMatch(f.body.textContent + f.banner.textContent + JSON.stringify(f.notices), /unshared|private fixture/);
      assert.deepEqual(f.mem.vaultMetaV2, beforeMeta, 'failed restart must not overwrite the sync receipt');
      assert.equal(f.changes(), 0);
      f.failReload(null); f.failFallback(null);
      await f.button.dispatch('click');
      assert.deepEqual(f.reloads, [47, 47]);
      assert.equal(f.permissionReads(), before);
      assert.ok(f.inline.disabled && f.hero.disabled);
      release();
    });
  }
} finally {
  if (previousIndexedDB === undefined) delete globalThis.indexedDB;
  else globalThis.indexedDB = previousIndexedDB;
  if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
  else delete globalThis.location;
  dom.restore();
}
