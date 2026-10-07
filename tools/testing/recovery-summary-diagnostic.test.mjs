// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../recovery-summary-diagnostic.js', import.meta.url), 'utf8');
const privateText = 'PRIVATE-url-title-id-error-substitution';
const fixtureCycle = () => ({
  id: privateText, complete: true, total: 1, summaryTotal: 3,
  initialOccurrenceIds: [privateText, privateText, privateText],
  alreadyReadyOccurrenceIds: [privateText, privateText],
  notificationState: 'notified', notificationAttempts: 2
});

async function run(options = {}) {
  const calls = { imports: [], reads: [], notifications: 0, logs: [] };
  const chrome = {
    runtime: {
      getURL: () => options.url ?? 'chrome-extension://fixture-extension/js/lib/store.js',
      getManifest: () => {
        if (options.manifestError) throw options.manifestError;
        return { version: options.version ?? '0.8.653' };
      }
    },
    notifications: options.noNotifications ? undefined : {
      getAll: async () => {
        calls.notifications++;
        if (options.notificationsError) throw options.notificationsError;
        return Object.hasOwn(options, 'notifications') ? options.notifications : {
          [`suspend-recovered:${privateText}`]: { title: privateText },
          [privateText]: { message: privateText }
        };
      }
    },
    get storage() { throw new Error('Diagnostic must use the authoritative Store owner'); }
  };
  const context = vm.createContext({
    URL, document: options.worker ? undefined : {},
    location: { protocol: options.webPage ? 'https:' : 'chrome-extension:', host: 'fixture-extension' },
    chrome: options.noRuntime ? {} : chrome,
    console: { log: (...args) => calls.logs.push(args) }
  });
  const script = new vm.Script(source, {
    importModuleDynamically: async specifier => {
      calls.imports.push(specifier);
      if (options.importError) throw options.importError;
      const module = new vm.SyntheticModule(['readStoreValue'], function () {
        this.setExport('readStoreValue', options.noReader ? undefined : async key => {
          calls.reads.push(key);
          if (options.readError) throw options.readError;
          return Object.hasOwn(options, 'cycle') ? options.cycle : fixtureCycle();
        });
      }, { context });
      await module.link(() => { throw new Error('Unexpected nested import'); });
      await module.evaluate();
      return module;
    }
  });
  assert.equal(await script.runInContext(context), undefined, 'fulfilled undefined is normal');
  assert.equal(calls.logs.length, 1, 'exactly one console receipt');
  assert.equal(calls.logs[0].length, 1);
  assert.equal(typeof calls.logs[0][0], 'string', 'one JSON string, no live private object');
  assert.ok(!calls.logs[0][0].includes(privateText), 'no private input reaches output');
  return { result: JSON.parse(calls.logs[0][0]), calls };
}

test('actual pasteable IIFE reads authoritative cycle and emits only the fixed safe schema', async () => {
  const { result, calls } = await run();
  assert.deepEqual(calls.imports, ['chrome-extension://fixture-extension/js/lib/store.js']);
  assert.deepEqual(calls.reads, ['suspendRecoveryCycle']);
  assert.equal(calls.notifications, 1);
  assert.deepEqual(result, {
    diagnostic: 'complete', context: { document: true, extensionProtocol: true, runtime: true },
    version: '0.8.653',
    steps: Object.fromEntries(['context', 'version', 'import', 'storeRead', 'notifications'].map(key => [key, { status: 'ok' }])),
    cycle: { hasCycle: true, complete: true, repaired: 1, summary: 3, initiallySuspended: 3,
      alreadyReady: 2, state: 'notified', attempts: 2 },
    retained: { final: true, starting: false }
  });
});

test('worker, ordinary page and missing runtime stop before dynamic import', async () => {
  for (const options of [{ worker: true }, { webPage: true }, { noRuntime: true }]) {
    const { result, calls } = await run(options);
    assert.equal(result.diagnostic, 'wrong-context');
    assert.equal(result.steps.context.status, 'wrong-context');
    assert.equal(result.steps.import.status, 'skipped');
    assert.deepEqual(calls.imports, []);
    assert.deepEqual(calls.reads, []);
    assert.equal(calls.notifications, 0);
  }
});

test('import, Store read and missing reader produce distinct step failures', async () => {
  const imported = await run({ importError: new TypeError(privateText) });
  assert.deepEqual(imported.result.steps.import, { status: 'failed', error: 'TypeError' });
  assert.equal(imported.result.steps.storeRead.status, 'skipped');
  assert.equal(imported.result.steps.notifications.status, 'ok');
  assert.deepEqual(imported.result.retained, { final: null, starting: null });
  const read = await run({ readError: { name: 'SecurityError', message: privateText } });
  assert.equal(read.result.steps.import.status, 'ok');
  assert.deepEqual(read.result.steps.storeRead, { status: 'failed', error: 'SecurityError' });
  assert.equal(read.result.cycle, null);
  assert.equal((await run({ noReader: true })).result.steps.storeRead.status, 'unavailable');
});

test('native notification failure or missing API preserves successful cycle counts', async () => {
  for (const options of [
    { notificationsError: { name: 'NotAllowedError', message: privateText } },
    { noNotifications: true }, { notifications: [] }
  ]) {
    const { result } = await run(options);
    assert.equal(result.diagnostic, 'partial');
    assert.equal(result.steps.storeRead.status, 'ok');
    assert.equal(result.cycle.summary, 3);
    assert.equal(result.cycle.repaired, 1);
    assert.deepEqual(result.retained, { final: null, starting: null });
  }
  assert.deepEqual((await run({ notificationsError: new Error(privateText) })).result.steps.notifications,
    { status: 'failed', error: 'Error' });
});

test('manifest failure and invalid versions remain separate from successful counts', async () => {
  for (const options of [{ version: privateText }, { version: '65536.1' },
    { version: '1.2.3.4.5' }, { manifestError: new Error(privateText) }]) {
    const { result } = await run(options);
    assert.equal(result.version, null);
    assert.equal(result.diagnostic, 'partial');
    assert.equal(result.cycle.summary, 3);
    assert.equal(result.steps.storeRead.status, 'ok');
  }
});

test('hostile cycle metadata is sanitized without coercion, serialization or private field reads', async () => {
  const cycle = {
    ...fixtureCycle(), total: NaN, summaryTotal: -1, complete: privateText,
    initialOccurrenceIds: privateText, alreadyReadyOccurrenceIds: [privateText],
    notificationState: privateText, notificationAttempts: Number.MAX_SAFE_INTEGER + 1,
    get title() { throw new Error(privateText); },
    toJSON() { throw new Error(privateText); }
  };
  const { result } = await run({ cycle });
  assert.deepEqual(result.cycle, { hasCycle: true, complete: false, repaired: null, summary: null,
    initiallySuspended: null, alreadyReady: 1, state: 'unknown', attempts: null });
  Object.defineProperty(cycle, 'total', { get() { throw new Error(privateText); } });
  assert.equal((await run({ cycle })).result.cycle.repaired, null);
  for (const invalid of [privateText, 7, [], false]) {
    const malformed = (await run({ cycle: invalid })).result;
    assert.equal(malformed.steps.storeRead.status, 'invalid');
    assert.equal(malformed.cycle, null);
  }
  const absent = (await run({ cycle: null })).result;
  assert.equal(absent.steps.storeRead.status, 'ok');
  assert.equal(absent.cycle.hasCycle, false);
  assert.equal(absent.cycle.summary, null);
  assert.deepEqual(absent.retained, { final: null, starting: null });
});

test('error name allowlist never exposes unknown names, messages, stacks or coercions', async () => {
  const hostile = {
    name: privateText,
    get message() { throw new Error('must not read message'); },
    get stack() { throw new Error('must not read stack'); },
    toString() { throw new Error('must not coerce error'); },
    toJSON() { throw new Error('must not serialize error'); }
  };
  assert.deepEqual((await run({ readError: hostile })).result.steps.storeRead,
    { status: 'failed', error: 'unknown' });
  Object.defineProperty(hostile, 'name', { get() { throw new Error(privateText); } });
  assert.deepEqual((await run({ importError: hostile })).result.steps.import,
    { status: 'failed', error: 'unknown' });
});

test('native identity lookup uses exact own keys without enumerating or reading payloads', async () => {
  const notifications = new Proxy(Object.create({ [`suspend-recovered:${privateText}`]: true }), {
    ownKeys() { throw new Error('must not enumerate notifications'); },
    get(_target, key) {
      if (key === 'then') return undefined; // Async fixture Promise assimilation.
      throw new Error('must not read notification payloads');
    }
  });
  const { result } = await run({ notifications });
  assert.equal(result.steps.notifications.status, 'ok');
  assert.deepEqual(result.retained, { final: false, starting: false });
  const broken = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(privateText); } });
  const failed = (await run({ notifications: broken })).result;
  assert.equal(failed.steps.notifications.status, 'failed');
  assert.equal(failed.cycle.summary, 3);
  assert.deepEqual(failed.retained, { final: null, starting: null });
});

test('only exact owned Store URL can reach dynamic import', async () => {
  for (const url of [
    `https://fixture-extension/js/lib/store.js`,
    `chrome-extension://other-extension/js/lib/store.js`,
    `chrome-extension://fixture-extension/js/lib/other.js`,
    `chrome-extension://fixture-extension/js/lib/store.js?${privateText}`,
    `chrome-extension://fixture-extension/js/lib/store.js#${privateText}`
  ]) {
    const { result, calls } = await run({ url });
    assert.equal(result.steps.import.status, 'invalid');
    assert.deepEqual(calls.imports, []);
    assert.deepEqual(calls.reads, []);
  }
});
