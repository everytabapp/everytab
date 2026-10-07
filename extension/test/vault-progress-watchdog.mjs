/** Production protocol + inactivity watchdog, synthetic files and virtual time. */
import assert from 'node:assert/strict';
import { createLibraryStore } from '../js/lib/storage/library-store.js';
import { createRecoveryStore } from '../js/lib/storage/recovery-store.js';
import { LIBRARY_SCHEMA, RECOVERY_SCHEMA } from '../js/lib/storage/schema.js';
import { syncVault, inspectVaultRoot } from '../js/vault/protocol-sync.js';
import { entries, seal } from '../js/vault/protocol-io.js';
import { runVaultSyncWithDeadline } from '../js/ui/vault-sync-watchdog.js';
import { createMemoryIndexedDbAdapter } from './memory-indexeddb-adapter.mjs';
import { createMockLockManager } from './e2-mocks.mjs';

class File {
  kind = 'file';
  constructor(name) { this.name = name; this.content = ''; this.onRead = () => {}; this.onClose = () => {}; }
  async getFile() { await this.onRead(); const text = this.content; return { text: async () => text }; }
  async createWritable() {
    let text = '';
    return { write: async value => { text += value; }, close: async () => { await this.onClose(); this.content = text; } };
  }
}
class Directory {
  kind = 'directory';
  constructor(name) { this.name = name; this.children = new Map(); this.onEntry = () => {}; this.onDirectory = () => {}; this.onFile = () => {}; }
  async getDirectoryHandle(name, { create = false } = {}) { await this.onDirectory(name); return this.child(name, create, Directory); }
  async getFileHandle(name, { create = false } = {}) { const file = this.child(name, create, File); this.onFile(file); return file; }
  child(name, create, Type) {
    if (!this.children.has(name) && create) this.children.set(name, new Type(name));
    const result = this.children.get(name);
    if (!result) throw new DOMException('Synthetic missing entry', 'NotFoundError');
    if (!(result instanceof Type)) throw new DOMException('Synthetic entry type mismatch', 'TypeMismatchError');
    return result;
  }
  async *entries() { for (const entry of this.children) { await this.onEntry(); yield entry; } }
  async removeEntry(name) { this.children.delete(name); }
}
function virtualClock() {
  let now = 0, timerId = 0;
  const timers = new Map();
  return {
    get now() { return now; }, timers,
    setTimer(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } }
  };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function fixture({ initialize = true } = {}) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: createMockLockManager() } });
  const root = new Directory('private-fixture-folder');
  const library = createLibraryStore({ adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA), deviceId: 'private-local-device', createId: () => 'private-local-source', now: () => 1000 });
  const recovery = createRecoveryStore({ adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA), now: () => 1000 });
  const options = { library, recovery, now: 1000, createId: () => 'private-fixture-vault' };
  if (initialize) await syncVault(root, options);
  const clock = virtualClock(), progress = [];
  let underlying;
  return {
    root, options, clock, progress,
    get underlying() { return underlying; },
    run() {
      return runVaultSyncWithDeadline({
        setTimer: clock.setTimer, clearTimer: clock.clearTimer, timeoutMs: 30_000,
        onProgress: value => progress.push(value),
        sync: heartbeat => (underlying = syncVault(root, { ...options, onProgress: heartbeat }))
      });
    }
  };
}
async function addPeers(f, count) {
  const devices = await f.root.getDirectoryHandle('devices');
  const { vaultId } = JSON.parse((await f.root.getFileHandle('format.json')).content);
  const manifests = [];
  for (let i = 0; i < count; i++) {
    const deviceId = `private-peer-${i}`;
    const directory = await devices.getDirectoryHandle(deviceId, { create: true });
    await directory.getDirectoryHandle('transactions', { create: true });
    const file = await directory.getFileHandle('manifest.json', { create: true });
    file.content = JSON.stringify(await seal({ app: 'everytab', kind: 'vault-v2-device-manifest', formatVersion: 1,
      vaultId, deviceId, sourceId: `private-source-${i}`, baseSequence: 0, throughSequence: 0, chunks: [], updatedAt: 1000 }));
    manifests.push(file);
  }
  return { devices, manifests };
}
async function succeedsBeyondDeadline(f) {
  const result = await f.run();
  assert.equal(result.skipped, undefined);
  assert.ok(f.clock.now > 30_000, 'healthy cumulative work exceeded inactivity threshold');
  assert.equal(f.clock.timers.size, 0);
  assert.equal(f.progress.at(-1).stage, 'complete');
  const early = f.progress.filter(value => ['scanning', 'reading', 'connecting'].includes(value.stage));
  assert.ok(early.length);
  assert.equal(JSON.stringify(early).includes('private-'), false, 'progress contains no names or device identities');
  for (const value of early) {
    assert.ok(['vault', 'format', 'library', 'assets'].includes(value.target));
    assert.ok(Object.keys(value).every(key => ['stage', 'target', 'completed', 'total'].includes(key)));
  }
}
async function stalls(f, install, { underlyingRejects = true } = {}) {
  const reached = deferred(), blocked = deferred();
  install(() => { reached.resolve(); return blocked.promise; });
  const watched = f.run();
  await reached.promise;
  let settled = false;
  watched.then(() => { settled = true; }, () => { settled = true; });
  const count = f.progress.length;
  f.clock.advance(29_999);
  await Promise.resolve();
  assert.equal(settled, false, 'deadline begins at most recent completed work');
  assert.equal(f.progress.length, count, 'no progress emitted while filesystem operation is blocked');
  f.clock.advance(1);
  await assert.rejects(watched, { name: 'VaultSyncTimeoutError' });
  assert.equal(f.clock.timers.size, 0);
  assert.equal(f.progress.some(value => value.stage === 'complete'), false);
  // The watchdog does not cancel filesystem work. Release the synthetic operation
  // with a failure and await its actual protocol owner before moving to another case.
  blocked.reject(new Error('Synthetic filesystem failure'));
  if (underlyingRejects) await assert.rejects(f.underlying);
  else await f.underlying;
  assert.equal(f.progress.length, count, 'settled watchdog ignores any late underlying progress');
}
const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS: ${name}`); }
try {
  await test('root enumeration with successful entries exceeds the inactivity deadline', async () => {
    const f = await fixture();
    for (let i = 0; i < 8; i++) await f.root.getFileHandle(`private-extra-${i}.txt`, { create: true });
    f.root.onEntry = () => f.clock.advance(5_000);
    await succeedsBeyondDeadline(f);
  });
  await test('device enumeration reports each completed entry', async () => {
    const f = await fixture(), { devices } = await addPeers(f, 8);
    devices.onEntry = () => f.clock.advance(5_000);
    await succeedsBeyondDeadline(f);
  });
  await test('validated manifest reads report cumulative progress', async () => {
    const f = await fixture(), { manifests } = await addPeers(f, 8);
    manifests.forEach(file => { file.onRead = () => f.clock.advance(5_000); });
    await succeedsBeyondDeadline(f);
    assert.ok(f.progress.some(value => value.stage === 'reading' && value.target === 'library' && value.completed === 9 && value.total === 9));
  });
  await test('completed format and early directory opens renew the deadline', async () => {
    const f = await fixture();
    (await f.root.getFileHandle('format.json')).onRead = () => f.clock.advance(20_000);
    f.root.onDirectory = name => { if (['devices', 'assets'].includes(name)) f.clock.advance(20_000); };
    await succeedsBeyondDeadline(f);
  });
  await test('root iterator stall after completed entries still times out', async () => {
    const f = await fixture();
    let calls = 0;
    await stalls(f, block => { f.root.onEntry = () => { if (++calls === 3) return block(); f.clock.advance(5_000); }; });
    assert.equal(f.clock.now, 40_000);
    assert.deepEqual(f.progress.filter(value => value.stage === 'scanning').map(value => value.completed), [1, 2]);
  });
  await test('device iterator stall still times out', async () => {
    const f = await fixture(), { devices } = await addPeers(f, 1);
    await stalls(f, block => { devices.onEntry = block; });
  });
  await test('format file read stall still times out', async () => {
    const f = await fixture(), file = await f.root.getFileHandle('format.json');
    await stalls(f, block => { file.onRead = block; });
  });
  await test('manifest read stall still times out without claiming a completed read', async () => {
    const f = await fixture(), { manifests } = await addPeers(f, 2);
    manifests[0].onRead = () => f.clock.advance(5_000);
    // Another device's unreadable manifest is skipped and counted, so the
    // released protocol owner completes instead of failing every sync.
    await stalls(f, block => { manifests[1].onRead = block; }, { underlyingRejects: false });
    assert.deepEqual((await f.underlying).quarantined,
      [{ code: 'vault-foreign-manifest-unreadable', kind: 'manifest', count: 1 }]);
    assert.deepEqual(f.progress.filter(value => value.stage === 'reading' && value.target === 'library').map(value => value.completed), [1, 2]);
  });
  await test('unsettled initial write does not publish ready format or success', async () => {
    const f = await fixture({ initialize: false });
    await stalls(f, block => { f.root.onFile = file => { if (file.name === 'format.json') file.onClose = block; }; });
    assert.equal(f.root.children.get('format.json').content, '');
    assert.equal(f.progress.some(value => value.stage === 'initializing'), false);
  });
  await test('invalid format and manifest bytes are not reported as successful reads', async () => {
    const f = await fixture(), format = await f.root.getFileHandle('format.json');
    const original = format.content, progress = [];
    format.content = '{}';
    assert.equal((await inspectVaultRoot(f.root, { onProgress: value => progress.push(value) })).state, 'invalid');
    assert.equal(progress.some(value => value.stage === 'reading'), false);
    format.content = original;
    const { manifests } = await addPeers(f, 1);
    manifests[0].content = '{}';
    // Another device's invalid manifest is skipped and counted; the sync still
    // completes, and the skipped device is reported as processed, not read.
    const result = await f.run();
    assert.deepEqual(result.quarantined, [{ code: 'vault-foreign-manifest-unreadable', kind: 'manifest', count: 1 }]);
    assert.deepEqual(f.progress.filter(value => value.stage === 'reading' && value.target === 'library').map(value => value.completed), [1, 2]);
    assert.equal(f.progress.some(value => value.stage === 'complete'), true);
    assert.equal(f.clock.timers.size, 0);
  });
  await test('entries defaults and read-only inspection retain their public results', async () => {
    const directory = new Directory('private-folder'), progress = [];
    const file = await directory.getFileHandle('private-name', { create: true });
    assert.deepEqual(await entries(directory), [{ name: 'private-name', handle: file }]);
    assert.deepEqual(await entries(directory, value => progress.push(value)), [{ name: 'private-name', handle: file }]);
    assert.deepEqual(progress, [{ completed: 1 }]);
    const f = await fixture();
    assert.deepEqual(await inspectVaultRoot(f.root), await inspectVaultRoot(f.root, { onProgress() {} }));
  });
  console.log(`${passed} Vault progress watchdog cases passed`);
} finally {
  if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
  else delete globalThis.navigator;
}
