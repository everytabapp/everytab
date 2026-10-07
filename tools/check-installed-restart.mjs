// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Installed-profile restart/reload acceptance. Synthetic localhost pages only.
 * Owns a newly created temporary profile; never accepts an existing profile path.
 * Run with CHROME_BIN. Headless native APIs do not prove visible OS banners.
 */
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnOwnedChrome, terminateOwnedChrome } from '../extension/test/chrome-test-process.mjs';
import { CdpClient, attachTarget, chromeBin, extensionRoot, debuggingUrl, detectExtension, evaluate, createTarget, prepareSession } from './capture-store-screenshots.mjs';
import { assertOccurrences, fixtureTabs } from './testing/restart-occurrences.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceVersion = JSON.parse(await readFile(path.join(extensionRoot, 'manifest.json'), 'utf8')).version;
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.join(path.resolve(process.env.EVERYTAB_RESTART_EVIDENCE_DIR || path.join(projectRoot, `review-evidence/installed-acceptance-${sourceVersion}/restart`)), runId);
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'everytab-installed-restart-'));
const receipt = { kind: 'disposable installed restart and runtime.reload acceptance',
  version: sourceVersion,
  platform: process.platform, node: process.version, headless: true, snapshots: [],
  limitations: ['Headless CDP is not human UI acceptance or OS notification-banner proof.',
    'Browser.close is graceful browser-process shutdown, not an operating-system restart.',
    'No personal browser profile, external website, Vault or package used.'] };
let browser, browserClient, worker, page;
const clients = new Set();
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://fixture.invalid').pathname;
  response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  response.end(`<!doctype html><title>Restart fixture ${pathname.replace(/[^a-z0-9/-]/gi, '')}</title><p>Synthetic restart fixture</p>`);
});
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let value, lastError;
  while (Date.now() < deadline) {
    try { value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ''}`);
}
async function attachWorker(debug, extensionId, priorTargetId = null) {
  const target = await until(async () => {
    const { targetInfos } = await browserClient.send('Target.getTargets');
    return targetInfos.find(t => t.type === 'service_worker' &&
      t.url === `chrome-extension://${extensionId}/js/background.js` && t.targetId !== priorTargetId);
  }, 'current extension worker');
  worker = await attachTarget(debug, target.targetId);
  clients.add(worker.client);
  await worker.send('Runtime.enable');
  await until(() => evaluate(worker, 'typeof chrome?.tabs?.query === "function"'), 'worker API ready');
  return target.targetId;
}
async function launch(restore = false) {
  browser = spawnOwnedChrome(chromeBin, [
    '--headless=new', '--disable-gpu', '--remote-debugging-port=0',
    '--no-first-run', '--disable-background-networking', '--disable-component-update',
    '--enable-unsafe-extension-debugging',
    ...(process.env.EVERYTAB_CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    `--user-data-dir=${profile}`,
    ...(restore ? ['--restore-last-session'] : ['about:blank'])
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const debug = await debuggingUrl(browser);
  browserClient = new CdpClient(debug);
  clients.add(browserClient);
  receipt.browser ??= await browserClient.send('Browser.getVersion');
  if (!restore) {
    // Persist a normal unpacked installation in this owned profile. Repeating
    // --load-extension on restart fires onInstalled and invalidates this check.
    const manager = await createTarget(debug, 'chrome://extensions');
    clients.add(manager.client);
    await prepareSession(manager);
    await evaluate(manager, 'chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })');
    receipt.installation = await browserClient.send('Extensions.loadUnpacked', { path: extensionRoot });
  }
  const extensionId = restore ? receipt.extensionId : await detectExtension(debug);
  await createController({ debug, extensionId });
  receipt.controllerState = await evaluate(page, '({ href: location.href, title: document.title, runtimeId: chrome?.runtime?.id ?? null, body: document.body?.innerText?.slice(0, 300) })');
  const workerId = await attachWorker(debug, extensionId);
  return { debug, extensionId, workerId };
}
async function createController(context) {
  page = await createTarget(context.debug, `chrome-extension://${context.extensionId}/popup.html`);
  clients.add(page.client);
  await prepareSession(page);
  await until(() => evaluate(page, 'document.readyState === "complete"'), 'controller loaded');
}
const snapshotExpression = `(async () => {
  const store = await import(chrome.runtime.getURL('js/lib/store.js'));
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs.map(({ id, windowId, index, url, pendingUrl, status, discarded }) => ({ id, windowId, index, url, pendingUrl, status, discarded })),
    registry: await store.readStoreMap('suspendedRegistry'),
    graceUntil: await store.readStoreValue('suspendRecoveryGraceUntil') ?? 0,
    cycle: await store.readStoreValue('suspendRecoveryCycle') ?? null,
    session: await chrome.storage.session.get('suspendRecoverySessionClaim'),
    notifications: Object.keys(await chrome.notifications.getAll()),
    notificationPermission: await chrome.notifications.getPermissionLevel(),
    recentlyClosed: await chrome.sessions.getRecentlyClosed({ maxResults: 25 })
  };
})()`;
async function capture(stage) {
  const value = await evaluate(page, snapshotExpression);
  receipt.snapshots.push({ stage, at: new Date().toISOString(), ...value });
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(`Captured ${stage}: ${value.tabs.length} tabs, ${Object.keys(value.registry).length} registry entries, cycle ${value.cycle?.notificationState ?? 'none'}`);
  return value;
}
function relevantRecentlyClosed(snapshot, origin) {
  return snapshot.recentlyClosed.flatMap(entry => entry.window?.tabs || (entry.tab ? [entry.tab] : []))
    .map(tab => tab.url || '').filter(url => url.startsWith(origin + '/') || url.includes('/suspend.html?'));
}
const autoSaveSettings = { autoArchiveEnabled: true, autoDumpAfterMinutes: 1, autoSaveMaxTabs: 1 };
async function readAutoSaveState() {
  return evaluate(page, `(async () => {
    const store = await import(chrome.runtime.getURL('js/lib/store.js'));
    const settings = await store.getFreshSettings();
    return { inbox: await store.readFreshStoreMap('inbox'),
      settings: { autoArchiveEnabled: settings.autoArchiveEnabled,
        autoDumpAfterMinutes: settings.autoDumpAfterMinutes, autoSaveMaxTabs: settings.autoSaveMaxTabs },
      graceActive: Date.now() < (await store.readStoreValue('suspendRecoveryGraceUntil') ?? 0) };
  })()`);
}
async function assertAutoSaveProtected(snapshot, guard, expected, origin) {
  assertOccurrences(snapshot, expected, origin);
  const current = await readAutoSaveState();
  assert.deepEqual(current.settings, autoSaveSettings, 'both Auto-save policies remain enabled during reload');
  assert.ok(current.graceActive, 'reload protection is active throughout the observed recovery tail');
  // Compare complete records privately; failure output must not print saved payloads.
  assert.ok(isDeepStrictEqual(current.inbox, guard.inbox), 'reload with Auto-save enabled leaves Inbox unchanged');
  guard.samples += 1;
}
async function enableEligibleAutoSave(expected) {
  const baseline = await readAutoSaveState();
  const eligibility = await evaluate(page, `(async () => {
    const store = await import(chrome.runtime.getURL('js/lib/store.js'));
    const { tabActivity } = await import(chrome.runtime.getURL('js/lib/tab-activity.js'));
    const { isArchiveExempt } = await import(chrome.runtime.getURL('js/lib/archive.js'));
    const { readTabProtections } = await import(chrome.runtime.getURL('js/lib/automation-protection.js'));
    const { TEMPORARY_AUTOMATION_EXEMPTIONS_KEY } = await import(chrome.runtime.getURL('js/lib/tabs.js'));
    const controller = await chrome.tabs.getCurrent();
    await chrome.tabs.update(controller.id, { active: true });
    await chrome.windows.update(controller.windowId, { focused: true });
    await tabActivity.initialize();
    const ids = new Set(${JSON.stringify(expected.map(tab => tab.id))});
    const old = Date.now() - 60 * 60_000;
    await store.mutateStores(['tabActivity', 'suspendedRegistry'], maps => {
      const activity = { ...maps.tabActivity }, registry = { ...maps.suspendedRegistry };
      for (const id of ids) {
        activity[id] = old;
        if (registry[id]) registry[id] = { ...registry[id], awayAt: old };
      }
      return { tabActivity: activity, suspendedRegistry: registry };
    });
    const tabs = (await chrome.tabs.query({})).filter(tab => ids.has(tab.id));
    const settings = await store.getFreshSettings();
    const exemptions = await store.readStoreValue(TEMPORARY_AUTOMATION_EXEMPTIONS_KEY);
    const protections = await readTabProtections();
    const eligible = tabs.filter(tab => !tab.active &&
      !isArchiveExempt(tab, settings.archiveWhitelist, exemptions, Date.now(), protections));
    const map = await store.readStoreValue('tabActivity');
    const graceRemainingMs = (await store.readStoreValue('suspendRecoveryGraceUntil') ?? 0) - Date.now();
    return { total: tabs.length, inactiveEligible: eligible.length,
      awakeEligible: eligible.filter(tab => !tab.url.includes('/suspend.html?')).length,
      suspendedEligible: eligible.filter(tab => tab.url.includes('/suspend.html?')).length,
      allEligibleOld: eligible.every(tab => map[tab.id] < Date.now() - 60_000),
      capSurplus: tabs.length - ${autoSaveSettings.autoSaveMaxTabs}, graceRemainingMs };
  })()`);
  assert.equal(eligibility.total, expected.length);
  assert.ok(eligibility.awakeEligible > 0 && eligibility.suspendedEligible > 0,
    'both awake and suspended synthetic tabs are genuine Auto-save candidates');
  assert.ok(eligibility.allEligibleOld && eligibility.capSurplus > 0,
    'idle timer and positive max-open cap are independently eligible');
  assert.ok(eligibility.graceRemainingMs > 20_000, 'real install grace protects eligible setup');
  await evaluate(page, `(async () => {
    const store = await import(chrome.runtime.getURL('js/lib/store.js'));
    await store.patchSettings(${JSON.stringify(autoSaveSettings)});
  })()`);
  return { inbox: baseline.inbox, samples: 0, eligibility };
}
async function verifyReload(context, before, expected, origin, stage, autoSaveGuard = null) {
  // Execute the real extension lifecycle command, then attach only to its new worker.
  await evaluate(worker, 'setTimeout(() => chrome.runtime.reload(), 0); true');
  const previousWorkerId = context.workerId;
  context.workerId = await attachWorker(context.debug, context.extensionId, previousWorkerId);
  await createController(context);
  await until(async () => {
    const current = await evaluate(page, snapshotExpression);
    return current.cycle?.id !== before.cycle?.id && current.cycle?.complete &&
      current.cycle.notificationState === 'notified' &&
      current.notifications.includes(`suspend-recovered:${current.cycle.id}`);
  }, 'extension reload recovery completed and final notification accepted');
  const immediate = await capture(`${stage}-completion`);
  if (autoSaveGuard) {
    await assertAutoSaveProtected(immediate, autoSaveGuard, expected, origin);
    const tailUntil = Date.now() + 9_000;
    while (Date.now() < tailUntil) {
      await delay(Math.min(500, tailUntil - Date.now()));
      await assertAutoSaveProtected(await evaluate(page, snapshotExpression), autoSaveGuard, expected, origin);
    }
  } else await delay(9_000);
  const reloaded = await capture(`${stage}-tail`);
  if (autoSaveGuard) await assertAutoSaveProtected(reloaded, autoSaveGuard, expected, origin);
  assertOccurrences(reloaded, expected, origin);
  assert.notEqual(reloaded.cycle?.id, before.cycle?.id, 'runtime.reload creates its own reconstruction cycle');
  assert.equal(reloaded.session.suspendRecoverySessionClaim, reloaded.cycle.id, 'reload cycle has session authority');
  assert.equal(new Set(reloaded.cycle.recoveredOccurrenceIds).size, reloaded.cycle.recoveredOccurrenceIds.length, 'receipt counts recovered occurrences once');
  const outcome = { total: reloaded.cycle.total, notificationState: reloaded.cycle.notificationState,
    nativeNotificationIds: reloaded.notifications, recentlyClosed: relevantRecentlyClosed(reloaded, origin),
    observedAtCompletion: immediate.cycle.total };
  assert.ok(reloaded.cycle.total > 0, 'real reload repaired invalidated suspended pages');
  const affected = expected.filter(tab => tab.suspended).map(tab => tab.occurrence).sort();
  assert.equal(reloaded.cycle.total, affected.length, 'all affected occurrences reported once');
  assert.deepEqual([...reloaded.cycle.recoveredOccurrenceIds].sort(), affected,
    'recovery receipt names exactly the remaining suspended occurrences');
  assert.equal(reloaded.cycle.notificationState, 'notified', 'Chrome accepted the final recovery notification');
  const finalId = `suspend-recovered:${reloaded.cycle.id}`;
  const startingId = `suspend-recovering:${reloaded.cycle.id}`;
  assert.ok(immediate.notifications.includes(finalId), 'Chrome retains the final notification at completion');
  assert.ok(reloaded.notifications.includes(finalId), 'Chrome retains the final notification through the recovery tail');
  // The starting banner is cleared once the receipt settles, so completion
  // retains only the final notification under its own identity.
  assert.ok(!immediate.notifications.includes(startingId), 'starting banner is cleared once the final receipt is retained');
  assert.ok(!reloaded.notifications.includes(startingId), 'starting banner stays cleared through the recovery tail');
  outcome.startingClearedFinalRetained = true;
  return outcome;
}
// Controlled production-owner composition after real reload acceptance. These
// pages are explicitly adopted in the controller module realm; this is not another reload.
async function verifyAlreadyReadySummary(expected, origin) {
  const before = await capture('before-ready-summary');
  const cycleId = await evaluate(page, `(async () => {
    const store = await import(chrome.runtime.getURL('js/lib/store.js'));
    const domain = await import(chrome.runtime.getURL('js/lib/suspend.js'));
    const { createSuspendRecoveryOwner } = await import(chrome.runtime.getURL('js/background/suspend-recovery-owner.js'));
    await domain.markRecoveryGrace();
    // Service workers prohibit dynamic import. Compose the actual modules in
    // this extension page and explicitly establish the ready-before-pass state.
    for (const tab of await chrome.tabs.query({})) {
      if (tab.url?.startsWith(chrome.runtime.getURL('suspend.html?'))) {
        if (!await domain.adoptSuspendedPage(tab)) throw new Error('Ready fixture adoption failed');
      }
    }
    const owner = createSuspendRecoveryOwner({ mutateStore: store.mutateStores,
      readStore: store.readStoreValue, recover: domain.queueRecovery,
      repairMetadata: domain.queueSuspendMetadataRepair });
    return owner.start({ recoveringReload: true });
  })()`);
  await until(async () => {
    const current = await evaluate(page, snapshotExpression);
    return current.cycle?.id === cycleId && current.cycle.complete &&
      current.cycle.notificationState === 'notified' &&
      current.notifications.includes('suspend-recovered:' + cycleId);
  }, 'already-ready summary accepted');
  await delay(9_000);
  const after = await capture('after-ready-summary-tail');
  assertOccurrences(after, expected, origin);
  const readyIds = expected.filter(tab => tab.suspended).map(tab => tab.occurrence).sort();
  assert.equal(after.cycle.total, 0, 'ready pages require no repairs');
  assert.equal(after.cycle.summaryTotal, readyIds.length, 'summary includes all already-ready occurrences');
  assert.deepEqual([...after.cycle.alreadyReadyOccurrenceIds].sort(), readyIds);
  assert.ok(after.notifications.includes('suspend-recovered:' + cycleId), 'ready summary remains retained through the tail');
  const identity = snapshot => fixtureTabs(snapshot, origin)
    .map(({ id, windowId, index, url, pendingUrl }) => ({ id, windowId, index, url, pendingUrl }))
    .sort((a, b) => a.id - b.id);
  assert.ok(isDeepStrictEqual(identity(before), identity(after)), 'ready summary preserves exact native tabs and URLs');
  assert.ok(isDeepStrictEqual(before.recentlyClosed, after.recentlyClosed), 'ready summary creates no Recently closed churn');
  return { controlledOwnerStart: true, actualReload: false, repairs: after.cycle.total,
    summaryTotal: after.cycle.summaryTotal, nativeTabsUnchanged: true,
    recentlyClosedUnchanged: true, finalNotificationRetained: true };
}
async function gracefulClose() {
  const child = browser;
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Graceful Browser.close did not exit in 15 seconds')), 15_000);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  await browserClient.send('Browser.close').catch(() => {});
  const outcome = await exited;
  assert.equal(outcome.code, 0, 'Chrome exits cleanly rather than being killed for restart');
  assert.equal(outcome.signal, null);
  for (const client of clients) client.close();
  clients.clear();
  await terminateOwnedChrome(child);
  browser = null;
  receipt.gracefulExit = outcome;
  receipt.persistedInstallation = [];
  for (const filename of ['Preferences', 'Secure Preferences']) {
    try {
      const preferences = JSON.parse(await readFile(path.join(profile, 'Default', filename), 'utf8'));
      const entry = preferences.extensions?.settings?.[receipt.extensionId];
      if (entry) receipt.persistedInstallation.push({ file: filename, location: entry.location,
        state: entry.state, path: entry.path, disableReasons: entry.disable_reasons });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let context = await launch();
  receipt.extensionId = context.extensionId;
  await evaluate(page, `(async () => {
    const store = await import(chrome.runtime.getURL('js/lib/store.js'));
    await store.patchSettings({ suspendEnabled: false, suspendLazyReload: true,
      autoArchiveEnabled: false, autoSaveMaxTabs: 0, dedupAutoClose: false,
      snapshotEveryMinutes: 0 });
    const existing = await chrome.tabs.query({});
    const controller = await chrome.tabs.getCurrent();
    const first = await chrome.windows.create({ url: ${JSON.stringify([origin+'/awake-a',origin+'/shared',origin+'/sleep-a'])}, focused: false });
    const second = await chrome.windows.create({ url: ${JSON.stringify([origin+'/awake-b',origin+'/shared',origin+'/sleep-b'])}, focused: false });
    await chrome.tabs.move(controller.id, { windowId: first.id, index: -1 });
    for (const tab of existing) if (tab.id !== controller.id) await chrome.tabs.remove(tab.id);
    return [first.id, second.id];
  })()`);
  await until(async () => {
    const tabs = (await evaluate(page, 'chrome.tabs.query({})')).filter(tab => tab.url?.startsWith(origin));
    return tabs.length === 6 && tabs.every(tab => tab.status === 'complete' && !tab.pendingUrl);
  }, 'all six synthetic pages committed');
  const suspendResults = await evaluate(page, `(async () => {
    const results = [];
    for (const tab of await chrome.tabs.query({})) {
      if (tab.url?.startsWith(${JSON.stringify(origin)}) && !tab.url.includes('/awake-')) results.push({ id: tab.id, ok: (await chrome.runtime.sendMessage({ type: 'suspend-tab', tabId: tab.id })).ok });
    }
    return results;
  })()`);
  assert.equal(suspendResults.length, 4);
  assert.ok(suspendResults.every(result => result.ok), 'all four production suspensions confirmed');
  await delay(9_000); // Include the complete 8-second install recovery tail before the restart baseline.
  const before = await capture('before-extension-reload');
  const expected = fixtureTabs(before, origin);
  assert.equal(expected.length, 6);
  assert.equal(expected.filter(t => t.suspended).length, 4);
  assert.equal(new Set(expected.filter(t => t.suspended).map(t => t.occurrence)).size, 4);
  assert.equal(relevantRecentlyClosed(before, origin).length, 0);
  console.log('Enabling eligible idle timer and max-open cap for the first real extension reload');
  const autoSaveGuard = await enableEligibleAutoSave(expected);
  await assertAutoSaveProtected(await evaluate(page, snapshotExpression), autoSaveGuard, expected, origin);
  receipt.reloadRecovery = await verifyReload(context, before, expected, origin, 'after-extension-reload', autoSaveGuard);
  receipt.autoSaveReload = { settings: autoSaveSettings, eligibility: autoSaveGuard.eligibility,
    preservationSamples: autoSaveGuard.samples, recoveryTailMs: 9_000,
    inboxRecordCount: Object.keys(autoSaveGuard.inbox).length, inboxUnchanged: true,
    exactOccurrencesAndWindowsPreserved: true, settingsRetained: true };
  await evaluate(page, `(async () => {
    const store = await import(chrome.runtime.getURL('js/lib/store.js'));
    await store.patchSettings({ autoArchiveEnabled: false, autoSaveMaxTabs: 0 });
  })()`);
  const disabled = await readAutoSaveState();
  assert.equal(disabled.settings.autoArchiveEnabled, false);
  assert.equal(disabled.settings.autoSaveMaxTabs, 0, 'later restart cases have Auto-save disabled');
  receipt.reloadPassed = true;
  const restartBaseline = await capture('before-browser-restart-after-reload');
  await gracefulClose();
  context = await launch(true);
  assert.equal(context.extensionId, receipt.extensionId, 'same unpacked extension restored');
  await until(async () => fixtureTabs(await evaluate(page, snapshotExpression), origin).length >= 6, 'Chrome restored fixture tabs');
  await delay(9_000); // Observe the interval when a mistaken extension recovery tail would run.
  const restarted = await capture('after-browser-restart');
  assertOccurrences(restarted, expected, origin);
  assert.equal(restarted.cycle?.id, restartBaseline.cycle?.id, 'browser restart never starts extension reconstruction');
  assert.equal(restarted.session.suspendRecoverySessionClaim, undefined, 'browser restart clears the session-only recovery authority');
  // Chrome renumbers session IDs across process starts. Compare individual-tab URL
  // multiplicity to the reload baseline; graceful shutdown also records whole windows.
  const individualClosed = snapshot => relevantRecentlyClosed({
    recentlyClosed: snapshot.recentlyClosed.filter(entry => entry.tab)
  }, origin).sort();
  assert.deepEqual(individualClosed(restarted), individualClosed(restartBaseline),
    'restart creates no additional individual fixture-tab Recently closed entries');
  receipt.restartIndividualClosedBefore = individualClosed(restartBaseline).length;
  receipt.restartIndividualClosedAfter = individualClosed(restarted).length;
  receipt.restartClosedWindows = restarted.recentlyClosed.filter(entry => entry.window).length;
  assert.ok(!restarted.notifications.some(id => id.startsWith('suspend-recovered:') && !restartBaseline.notifications.includes(id)), 'restart adds no recovery notification');
  receipt.postRestartReloadRecovery = await verifyReload(context, restarted, expected, origin, 'after-post-restart-reload');
  receipt.postRestartReloadPassed = true;
  // Keep the complete restart/reload case above intact. A second ordinary restart
  // creates adopted aliases, then a native close outside grace must retire only
  // that occurrence. Wait for the real 60-second grace to expire; never clear it.
  await gracefulClose();
  context = await launch(true);
  await until(async () => fixtureTabs(await evaluate(page, snapshotExpression), origin).length >= 6,
    'second restart restored fixture tabs');
  console.log('Waiting for real reload grace to expire before the native close');
  receipt.closeOutsideGrace = await until(async () => {
    const timing = await evaluate(page, `(async () => {
      const store = await import(chrome.runtime.getURL('js/lib/store.js'));
      return { now: Date.now(), graceUntil: await store.readStoreValue('suspendRecoveryGraceUntil') ?? 0 };
    })()`);
    return timing.now >= timing.graceUntil ? timing : false;
  }, 'real reload grace expired after normal restart', 65_000);
  const beforeClose = await capture('after-second-browser-restart-before-native-close');
  assertOccurrences(beforeClose, expected, origin);
  const closing = fixtureTabs(beforeClose, origin).find(tab => tab.suspended && tab.original === origin + '/shared');
  assert.ok(closing, 'close fixture contains a suspended shared-URL occurrence');
  const aliases = Object.entries(beforeClose.registry)
    .filter(([, value]) => value.recoveryOccurrenceId === closing.occurrence);
  assert.ok(aliases.length >= 2, 'normal restart leaves old and adopted records for the closed occurrence');
  assert.ok(aliases.some(([id]) => Number(id) === closing.id), 'the live adopted tab has a registry entry');
  await evaluate(page, `chrome.tabs.remove(${closing.id})`);
  await until(async () => {
    const current = await evaluate(page, snapshotExpression);
    return !current.tabs.some(tab => tab.id === closing.id) && !current.registry[closing.id];
  }, 'native close and retained registry cleanup completed');
  const remaining = expected.filter(tab => tab.occurrence !== closing.occurrence);
  const afterClose = await capture('after-native-close-before-reload');
  assertOccurrences(afterClose, remaining, origin);
  receipt.closedOccurrence = { id: closing.occurrence, priorRegistryAliases: aliases.map(([id]) => id) };
  receipt.postCloseReloadRecovery = await verifyReload(context, afterClose, remaining, origin, 'after-post-close-reload');
  receipt.postCloseReloadPassed = true;
  receipt.readySummary = await verifyAlreadyReadySummary(remaining, origin);
  receipt.passed = true;
  console.log('PASS: restart/reload preserves exact occurrence and window membership; closing one adopted occurrence outside grace prevents its resurrection on the next reload');
} catch (error) {
  receipt.passed = false;
  receipt.failure = { name: error.name, message: error.message };
  throw error;
} finally {
  for (const client of clients) client.close();
  if (browser) await terminateOwnedChrome(browser);
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
  receipt.cleanedDisposableProfile = true;
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
}
