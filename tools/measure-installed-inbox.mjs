// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Full installed Dashboard reads/rendering, with synthetic saved data in an owned profile.
 * Emits JSON after cleanup. Timings are observations, never hardware-sensitive pass thresholds.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
import path from "node:path";
import { spawnOwnedChrome, terminateOwnedChrome } from "../extension/test/chrome-test-process.mjs";
import { chromeBin, extensionRoot, debuggingUrl, detectExtension, createTarget,
  CdpClient, evaluate, prepareSession, waitFor } from "./capture-store-screenshots.mjs";
import { createInboxSelectorStats } from "./testing/inbox-selector-stats.mjs";
import { createInboxDepartureTrace, validateInboxDepartureCompletion } from "./testing/inbox-departure-trace.mjs";
import { createInboxStartupNetwork } from "./testing/inbox-startup-network.mjs";
import { captureInboxDocumentRoot, navigateInboxTrial } from "./testing/inbox-navigation.mjs";
import { validateInboxTrial } from "./testing/installed-inbox-receipt.mjs";
import { summarizeInboxCpuProfile } from "./testing/inbox-cpu-profile.mjs";
import { cleanupInboxMeasurement } from "./testing/inbox-measurement-cleanup.mjs";
import { installInboxWorkProbes, assertInboxWorkReceipt } from "./testing/inbox-work-probes.mjs";

import { installInboxMessageCallers, assertInboxMessageCallersReceipt } from "./testing/inbox-message-callers.mjs";

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && ['--trace', '--work', '--messages', '--startup', '--departure', '--departure-open', '--selectors', '--selectors-pre-focus'].includes(args[0])),
  'Use no arguments for baseline measurements, --trace for CPU diagnostics or --work for boundary counters or --messages for caller attribution or --startup for loading milestones or --departure/--departure-open for outgoing-page trace comparisons or --selectors/--selectors-pre-focus for CSS attribution after/before fixture focus setup');
const traceMode = args[0] === '--trace';
const selectorPreFocus = args[0] === '--selectors-pre-focus';
const selectorMode = args[0] === '--selectors' || selectorPreFocus;
const departureMode = args[0] === '--departure' || args[0] === '--departure-open' || selectorMode;
const departureFromOpen = args[0] === '--departure-open';
const startupMode = args[0] === '--startup' || departureMode;
const messageMode = args[0] === '--messages';
const workMode = args[0] === '--work' || messageMode;

async function sourceHashes() {
  const entries = await readdir(extensionRoot, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile() &&
    !path.relative(extensionRoot, entry.parentPath).split(path.sep).includes("test"));
  const hashes = {};
  for (const entry of files.sort((a, b) => path.join(a.parentPath, a.name).localeCompare(path.join(b.parentPath, b.name)))) {
    const file = path.join(entry.parentPath, entry.name);
    hashes[path.relative(extensionRoot, file)] = createHash("sha256").update(await readFile(file)).digest("hex");
  }
  return hashes;
}

const sources = await sourceHashes();
const allowedMessagePaths = Object.keys(sources).map(file => file.split(path.sep).join("/")).filter(file => file.startsWith("js/") && file.endsWith(".js"));
const profile = await mkdtemp(path.join(tmpdir(), "everytab-installed-inbox-"));
let browser;
let client;
const sessions = [];
const trials = [];
let browserVersion;
let detachStartupNetwork = () => {};
let detachDepartureTrace = () => {};
try {
  browser = spawnOwnedChrome(chromeBin, ["--headless=new", "--disable-gpu",
    "--remote-debugging-port=0", "--enable-unsafe-extension-debugging",
    "--force-prefers-reduced-motion",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows", "--disable-background-networking",
    ...(process.env.EVERYTAB_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
    `--user-data-dir=${profile}`, "--no-first-run", "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const debug = await debuggingUrl(browser);
  client = new CdpClient(debug);
  browserVersion = (await client.send("Browser.getVersion")).product;
  const manager = await createTarget(debug, "chrome://extensions");
  sessions.push(manager);
  await prepareSession(manager);
  await evaluate(manager, "chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })");
  await client.send("Extensions.loadUnpacked", { path: extensionRoot });
  console.error('STAGE: installed');
  const id = await detectExtension(debug);
  const page = await createTarget(debug, `chrome-extension://${id}/dashboard.html#inbox`);
  sessions.push(page);
  // Check before this target receives CDP media overrides. Otherwise the
  // override could hide a conflicting browser default during frame replacement.
  const nativeReducedMotion = await evaluate(page, "matchMedia('(prefers-reduced-motion: reduce)').matches");
  assert.equal(nativeReducedMotion, true, "Inbox browser must start with native reduced motion");
  await prepareSession(page);
  const startupNetwork = startupMode ? createInboxStartupNetwork({
    extensionOrigin: `chrome-extension://${id}`, allowedPaths: Object.keys(sources).map(file => file.split(path.sep).join("/"))
  }) : null;
  if (startupNetwork) {
    const listener = ({ data }) => {
      const event = JSON.parse(data);
      if (event.sessionId === page.sessionId) startupNetwork.accept(event.method, event.params);
    };
    page.client.socket.addEventListener("message", listener);
    detachStartupNetwork = () => page.client.socket.removeEventListener("message", listener);
    await page.send("Network.enable");
  }
  if (traceMode) await page.send('Profiler.enable');
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evaluate(page, `(async () => {
    const store = await import(chrome.runtime.getURL('js/lib/store.js'));
    await chrome.storage.local.set({ onboardingDone: true });
    await store.patchSettings({ suspendEnabled: false, suspendMaxTabs: 0, oneNewTabPerWindow: false });
  })()`);

  for (const count of [250, 1000]) {
    console.error(`STAGE: seed ${count}`);
    // Seed from a fresh Dashboard showing Open, so the outgoing large Inbox
    // does not rebuild while its replacement dataset is being committed.
    await page.send('Page.navigate', { url: `chrome-extension://${id}/dashboard.html?seed=${count}#open` });
    await prepareSession(page);
    await evaluate(page, `window.inboxSeedPromise = (async () => {
      const store = await import(chrome.runtime.getURL('js/lib/store.js'));
      const now = Date.now();
      const deviceId = await store.getDeviceId();
      const items = Object.fromEntries(Array.from({ length: ${count} }, (_, index) => {
        const suffix = String(index).padStart(4, '0');
        const id = 'inbox-fixture-' + suffix;
        const icon = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="hsl(' + (index % 64) * 5 + ',50%,50%)"/></svg>');
        return [id, { id, deviceId, createdAt: now - index * 1000, modifiedAt: now - index * 1000,
          schemaVersion: 1, kind: 'tab', source: 'manual', labels: [],
          tabs: [{ title: 'Inbox fixture ' + suffix, url: 'https://inbox-fixture.invalid/item/' + suffix,
            favIconUrl: icon, labels: [] }] }];
      }));
      await store.mutateStores(['inbox'], () => ({ inbox: items }));
      if ((await store.listItems('inbox')).length !== ${count}) throw new Error('Fixture seed count mismatch');
    })()`);
    for (let trial = 1; trial <= 3; trial++) {
      console.error(`STAGE: navigate ${count}/${trial}`);
      const token = `${count}/${trial}`;
      if (departureFromOpen) {
        const departureUrl = `chrome-extension://${id}/dashboard.html?departure=${encodeURIComponent(token)}#open`;
        const prepared = await page.send('Page.navigate', { url: departureUrl });
        assert.ok(prepared.loaderId && !prepared.errorText, 'Open departure preparation must navigate');
        await waitFor(page, `location.href === ${JSON.stringify(departureUrl)} && document.readyState === 'complete' && !document.body.classList.contains('booting') && document.querySelector('#app')?.childElementCount > 0`, 'Open departure preparation');
        assert.equal(await evaluate(page, `document.querySelectorAll('[data-tablist="inbox"] [data-tablist-row]').length`), 0,
          'Open departure must not contain an Inbox ledger');
      }
      let departureCollector, departureCompleted, outgoing, selectorCollector, outgoingRootNodeId;
      let traceProcessingFailed = false;
      const beforeNavigate = departureMode ? async () => {
        outgoing = await evaluate(page, `({ inboxRows: document.querySelectorAll('[data-tablist="inbox"] [data-tablist-row]').length,
          elements: document.querySelectorAll('*').length,
          selectedRows: document.querySelectorAll('[data-tablist="inbox"] [data-tablist-row].sel').length,
          focusedCheckbox: document.activeElement?.matches('input[type="checkbox"]') ?? false,
          booting: document.body.classList.contains('booting'),
          starredOpen: Boolean(document.querySelector('.starred-edge.is-open')),
          schemeTransition: document.documentElement.dataset.schemeTransition === 'true' })`);
        if (selectorMode) {
          outgoingRootNodeId = await captureInboxDocumentRoot(page);
          const selectors = await evaluate(page, `(() => {
            const allowed = new Set(${JSON.stringify(Object.keys(sources).filter(file => file.startsWith('css/') && file.endsWith('.css')))});
            const selectors = [];
            const prefix = chrome.runtime.getURL('');
            const visit = (rules, file) => {
              for (const rule of rules) {
                if (typeof rule.selectorText === 'string') selectors.push({ file, selector: rule.selectorText });
                if (rule.cssRules) visit(rule.cssRules, file);
              }
            };
            for (const sheet of document.styleSheets) {
              if (!sheet.href?.startsWith(prefix)) continue;
              const file = sheet.href.slice(prefix.length);
              if (allowed.has(file)) visit(sheet.cssRules, file);
            }
            return selectors;
          })()`);
          assert.ok(selectors.length > 0, 'Owned stylesheet selectors must be available');
          selectorCollector = createInboxSelectorStats({ selectors });
        }
        assert.equal(outgoing.inboxRows, departureFromOpen || trial === 1 ? 0 : count,
          'Outgoing document must match the declared departure comparison');
        departureCollector = createInboxDepartureTrace(selectorMode ? { extensionOrigin: `chrome-extension://${id}`, sourcePaths: allowedMessagePaths } : undefined);
        let complete;
        departureCompleted = new Promise(resolve => { complete = resolve; });
        const listener = ({ data }) => {
          try {
            const event = JSON.parse(data);
            if (event.method === 'Tracing.dataCollected' && !traceProcessingFailed) {
              departureCollector.accept(event.params.value);
              selectorCollector?.accept(event.params.value);
            }
            if (event.method === 'Tracing.tracingComplete') complete(event.params);
          } catch {
            // Collectors can reject malformed or over-capacity events. Defer the
            // fixed failure to the awaited path so owned Chrome cleanup still runs.
            traceProcessingFailed = true;
          }
        };
        client.socket.addEventListener('message', listener);
        detachDepartureTrace = () => client.socket.removeEventListener('message', listener);
        await client.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing,toplevel' + (selectorMode ? ',disabled-by-default-blink.debug,disabled-by-default-devtools.timeline.invalidationTracking,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack' : ''), transferMode: 'ReportEvents' });
        await evaluate(page, `(() => {
          if (${selectorMode}) {
            const rootObserver = new MutationObserver(records => {
              for (const record of records) performance.mark(record.attributeName === 'style'
                ? 'inbox:root-style-change' : 'inbox:root-attribute-change');
            });
            rootObserver.observe(document.documentElement, { attributes: true });
            const bodyObserver = new MutationObserver(() => performance.mark('inbox:body-class-change'));
            bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
            window.addEventListener('pagehide', () => { rootObserver.disconnect(); bodyObserver.disconnect(); }, { once: true });
          }
          performance.mark('inbox:departure');
        })()`);
      } : undefined;
      // Inject before module evaluation. The navigation clock includes startup,
      // authority reads and list construction in the real Dashboard.
      const { identifier } = await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
        if (${departureMode}) performance.mark('inbox:injected');
        history.scrollRestoration = 'manual';
        ${workMode ? `(${installInboxWorkProbes.toString()})();` : ''}
        ${messageMode ? `(${installInboxMessageCallers.toString()})(${JSON.stringify(allowedMessagePaths)});` : ''}
        const result = window.inboxMeasurement = { token: ${JSON.stringify(token)}, timing: {}, done: false,
          motion: { nativeDefault: ${nativeReducedMotion},
            injected: matchMedia('(prefers-reduced-motion: reduce)').matches, frame: null } };
        if (${startupMode}) {
          result.startup = { injectedMs: performance.now(), bootLoadedMs: null,
            interactiveMs: null, appInsertedMs: null, moduleLoadedMs: null,
            domContentLoadedMs: null, loadMs: null };
          document.addEventListener('readystatechange', () => {
            if (document.readyState === 'interactive') result.startup.interactiveMs = performance.now();
          });
          document.addEventListener('DOMContentLoaded', () => { result.startup.domContentLoadedMs = performance.now(); }, { once: true });
          window.addEventListener('load', () => { result.startup.loadMs = performance.now(); }, { once: true });
          document.addEventListener('load', event => {
            if (event.target.tagName !== 'SCRIPT') return;
            if (event.target.getAttribute('src') === 'js/boot.js') result.startup.bootLoadedMs = performance.now();
            if (event.target.getAttribute('src') === './js/ui/dashboard.js') result.startup.moduleLoadedMs = performance.now();
          }, true);
        }
        if (${traceMode}) {
          performance.setResourceTimingBufferSize(2000);
          result.resourceBufferFull = false;
          performance.addEventListener('resourcetimingbufferfull', () => { result.resourceBufferFull = true; });
          result.longTasks = [];
          const tasks = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) result.longTasks.push({ at: entry.startTime, ms: entry.duration });
          });
          tasks.observe({ type: 'longtask', buffered: true });
        }
        const observer = new MutationObserver(() => {
          if (${startupMode} && result.startup.appInsertedMs === null && document.querySelector('#app')?.childElementCount) {
            result.startup.appInsertedMs = performance.now();
          }
          const rows = document.querySelectorAll('[data-tablist="inbox"] [data-tablist-row]');
          if (rows.length && result.timing.firstRowsMs === undefined) result.timing.firstRowsMs = performance.now();
          if (rows.length !== ${count} || result.timing.allRowsMs !== undefined) return;
          result.timing.allRowsMs = performance.now();
          observer.disconnect();
          const timeout = setTimeout(() => { result.error = 'No animation frame'; }, 3000);
          requestAnimationFrame(() => {
            clearTimeout(timeout);
            result.timing.nextFrameMs = performance.now();
            result.motion.frame = matchMedia('(prefers-reduced-motion: reduce)').matches;
            const geometryStart = performance.now();
            const rect = rows[0].getBoundingClientRect();
            result.geometry = { startMs: geometryStart, endMs: performance.now() };
            if (${workMode}) result.work = window.__inboxWorkProbe.read();
            if (${messageMode}) result.messageCallers = window.__inboxMessageCallers.read();
            result.visible = { width: innerWidth, height: innerHeight, firstRowHeight: rect.height,
              firstRowTop: rect.top, firstRowBottom: rect.bottom, viewportHeight: innerHeight,
              documentVisible: document.visibilityState === 'visible', focused: document.hasFocus() };
            result.done = true;
          });
        });
        observer.observe(document, { childList: true, subtree: true });
      })()` });
      startupNetwork?.reset(token);
      if (selectorPreFocus) await beforeNavigate();
      const navigation = await navigateInboxTrial({ page, evaluate, profile: traceMode, beforeNavigate: selectorPreFocus ? undefined : beforeNavigate,
        url: `chrome-extension://${id}/dashboard.html?inboxTrial=${encodeURIComponent(token)}${traceMode || startupMode ? '&perf=1' : ''}#inbox` });
      {
        await waitFor(page, `window.inboxMeasurement?.token === ${JSON.stringify(token)} && (inboxMeasurement.done || inboxMeasurement.error)`, "full Inbox render", 15000);
        startupNetwork?.assertNavigation(navigation.loaderId, navigation.frameId);
        const network = startupNetwork?.read();
        if (startupMode) {
          for (const file of ['dashboard.html', 'js/boot.js', 'js/ui/dashboard.js']) {
            const resource = network.files.find(entry => entry.file === file);
            assert.ok(resource && resource.responseMs !== null && resource.endMs !== null && !resource.failed,
              'Startup diagnostics require completed document and entry scripts');
          }
        }
        let departure;
        if (departureMode) {
          await client.send('Tracing.end');
          let timeout, completion;
          try {
            completion = validateInboxDepartureCompletion(await Promise.race([departureCompleted, new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error('Departure tracing did not finish')), 15_000);
            })]));
            assert.equal(completion.dataLossOccurred, false, 'Departure trace requires confirmed absence of data loss');
          } finally { clearTimeout(timeout); }
          detachDepartureTrace();
          assert.equal(traceProcessingFailed, false, 'Departure trace event processing failed');
          // Capture after the trace ends: these protocol calls cannot contribute
          // events to the measured interval. IDs stay private to the collector.
          const rootIdentities = selectorMode ? {
            outgoingRootNodeId, incomingRootNodeId: await captureInboxDocumentRoot(page)
          } : undefined;
          departure = { includesFocusSetup: selectorPreFocus, from: departureFromOpen ? 'open' : 'previous', outgoing, ...completion, ...departureCollector.read(rootIdentities),
            ...(selectorMode ? { selectors: selectorCollector.read() } : {}) };
        }
        // Stop before row extraction and pointer checks. Sampling still includes
        // the fixture's navigation/polling overhead and is diagnostic only.
        const profile = traceMode ? (await page.send('Profiler.stop')).profile : null;
        console.error(`STAGE: observe ${token}`);
        const measured = await evaluate(page, `(() => {
          if (inboxMeasurement.error) throw new Error(inboxMeasurement.error);
          return { ...inboxMeasurement, rows: [...document.querySelectorAll('[data-tablist="inbox"] [data-tablist-row]')].map(row => ({
            key: row.dataset.tablistRow, title: row.querySelector('.t a').textContent,
            url: row.querySelector('.t a').href })),
            disclosures: document.querySelectorAll('[data-tablist="inbox"] [data-disclosure-key]').length };
        })()`);
        assert.equal(measured.token, token, 'Receipt belongs to current navigation');
        const trace = traceMode || startupMode ? await evaluate(page, `(() => {
          const navigation = performance.getEntriesByType('navigation')[0];
          const end = inboxMeasurement.timing.nextFrameMs;
          const scripts = performance.getEntriesByType('resource').filter(entry =>
            entry.initiatorType === 'script' && entry.responseEnd <= end);
          return {
            capturedAtMs: performance.now(), frameMs: end,
            geometry: inboxMeasurement.geometry,
            spans: (window.__etPerf?.entries ?? []).filter(entry => entry.ms !== null && entry.at + entry.ms <= end),
            longTasks: ${traceMode} ? inboxMeasurement.longTasks.filter(entry => entry.at + entry.ms <= end) : null,
            navigation: { startTime: navigation.startTime, unloadStart: navigation.unloadEventStart,
              unloadEnd: navigation.unloadEventEnd, requestStart: navigation.requestStart,
              responseStart: navigation.responseStart, responseEnd: navigation.responseEnd, domInteractive: navigation.domInteractive,
              domContentLoaded: navigation.domContentLoadedEventEnd, load: navigation.loadEventEnd },
            scripts: { count: scripts.length, bufferFull: inboxMeasurement.resourceBufferFull ?? null,
              available: scripts.length > 0,
              firstStartMs: scripts.length ? Math.min(...scripts.map(entry => entry.startTime)) : null,
              lastEndMs: scripts.length ? Math.max(...scripts.map(entry => entry.responseEnd)) : null,
              summedDurationMs: scripts.reduce((total, entry) => total + entry.duration, 0) }
          };
        })()`) : null;
        if (traceMode) {
          assert.ok(trace.spans.some(span => span.name === 'boot:inbox'), 'Inbox boot timing must be active');
          assert.equal(trace.scripts.bufferFull, false, 'Resource timing buffer must retain all entries');
          trace.cpu = summarizeInboxCpuProfile(profile, `chrome-extension://${id}`);
          assert.ok(trace.cpu.sampleCount > 0 && trace.cpu.files.length > 0,
            'CPU profile must include owned script samples');
        }
        // Select opposite ends through CDP pointer events after measured rendering.
        // Scrolling is necessary: the entire queue is mounted, not simultaneously onscreen.
        for (const index of [0, count - 1]) {
          const point = await evaluate(page, `(() => {
            const box = document.querySelectorAll('[data-tablist="inbox"] [data-tablist-row]')[${index}].querySelector('input[type="checkbox"]');
            box.scrollIntoView({ block: 'center', behavior: 'instant' });
            const rect = box.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            if (hit !== box) throw new Error('Fixture checkbox is obscured');
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          })()`);
          await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
          await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
          await waitFor(page, `document.querySelectorAll('[data-tablist="inbox"] [data-tablist-row]')[${index}].querySelector('input[type="checkbox"]').checked`, 'clicked checkbox selected');
        }
        const selected = await evaluate(page, `(() => {
          const rows = [...document.querySelectorAll('[data-tablist="inbox"] [data-tablist-row]')];
          if (rows.length !== ${count} || rows.some((row, index) => row.dataset.tablistRow !== 'inbox-fixture-' + String(index).padStart(4, '0') + '::0')) throw new Error('Selection changed the full list');
          const selected = row => row.classList.contains('sel') && row.querySelector('input[type="checkbox"]').checked;
          return { first: selected(rows[0]), last: selected(rows.at(-1)), count: rows.filter(selected).length,
            classKeys: rows.filter(row => row.classList.contains('sel')).map(row => row.dataset.tablistRow),
            checkedKeys: rows.filter(row => row.querySelector('input[type="checkbox"]').checked).map(row => row.dataset.tablistRow) };
        })()`);
        const receipt = { count, trial, token: measured.token, rows: measured.rows, timing: measured.timing,
          visible: measured.visible, motion: measured.motion, selected, disclosures: measured.disclosures,
          ...(workMode ? { work: measured.work, geometry: measured.geometry } : {}),
          ...(messageMode ? { messageCallers: measured.messageCallers } : {}),
          ...(trace ? { trace } : {}),
          ...(startupMode ? { startup: measured.startup, network } : {}),
          ...(departureMode ? { departure } : {}) };
        validateInboxTrial(receipt);
        if (workMode) assertInboxWorkReceipt(receipt.work);
        if (messageMode) {
          assertInboxMessageCallersReceipt(receipt.messageCallers, allowedMessagePaths);
          assert.equal(receipt.messageCallers.calls, receipt.work.messages.calls, "Message probes must share the same capture boundary");
        }
        trials.push(receipt);
        console.error(`PASS: ${count} Inbox rows, trial ${trial}, next frame ${Math.round(receipt.timing.nextFrameMs)}ms`);
        await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
      }
    }
  }
  assert.deepEqual(await sourceHashes(), sources, "extension source unchanged during measurement");
} finally {
  detachStartupNetwork();
  detachDepartureTrace();
  try {
    await cleanupInboxMeasurement({ sessions, client, browser, profile }, {
      terminateOwnedChrome, removeProfile: folder => rm(folder, { recursive: true, force: true })
    });
  } catch {
    // Native close errors may carry addresses. Keep terminal diagnostics fixed.
    throw new Error("Inbox measurement cleanup failed");
  }
}
console.log(JSON.stringify({ schemaVersion: 1, navigationProtocol: "focus-before-navigation-native-motion-v3", runtime: JSON.parse(await readFile(path.join(extensionRoot, 'manifest.json'))).version,
  mode: selectorMode ? (selectorPreFocus ? 'instrumented-selectors-pre-focus' : 'instrumented-selectors') : departureMode ? (departureFromOpen ? 'instrumented-departure-open' : 'instrumented-departure') : startupMode ? 'instrumented-startup' : traceMode ? 'instrumented-trace' : messageMode ? 'instrumented-messages' : workMode ? 'instrumented-work' : 'baseline',
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, browser: browserVersion },
  method: 'Fresh installed Dashboard navigation, same owned profile and worker; focus setup before navigation; 64 synthetic icons; single-tab cards; native reduced motion verified before CDP override; effective preference rechecked at injection/frame; first/all DOM insertion and subsequent real animation frame. Frame callback is not proof of compositor paint. Selection is measured separately after scrolling.',
  ...(traceMode ? { traceLimits: 'CPU sampling and existing perf spans add overhead. Samples are approximate exclusive attribution; overlapping boot/resource durations must not be summed as a wall-clock decomposition. Profiler commands bracket navigation and milestone detection, with fixture polling overhead; focus setup completes before profiling/navigation; the separate CPU clock does not establish complete navigation coverage. No raw profile URLs or function names are retained.' } : {}),
  ...(selectorMode ? { selectorLimits: "CSS statistics add substantial overhead; use matching counts and relative attribution, not baseline latency. Only selectors equal to the current owned stylesheet CSSOM allowlist survive, with private IDs and raw trace arguments discarded. Unknown selectors remain excluded. Costs come from complete paired UpdateLayoutTree passes within the same-thread departure interval. The stats dump must start before injection but may finish after it. File lists are matching catalogue candidates, not definitive executing stylesheet identity. Same-thread events alone do not establish document identity. Only PropertyRegistration observations receive root-ownership labels from private outgoing/incoming backend identities; unknown nodes remain unassigned." } : {}),
  ...(departureMode ? { departureLimits: `Diagnostic browser tracing brackets an outgoing marker ${selectorPreFocus ? "before fixture focus setup (included in this interval)" : "after focus"} and an incoming marker before module evaluation. Fixed event names, numeric costs and optional allowlisted invalidation reasons/source locations on that renderer thread survive. Same-thread events do not establish document identity. Nested/overlapping durations are not additive. The Open comparison adds an unmeasured Dashboard navigation and waits for its boot to settle; it changes departure state/warmup and is not the normal baseline. No runtime speed claim follows.` } : {}),
  ...(startupMode ? { startupLimits: "Lifecycle timestamps use the new document performance clock. appInsertedMs is observer delivery, not the append instant. CDP network deltas use a separate main-request clock; the snapshot is taken at frame detection, not exactly at the frame callback. Source paths are allowlisted and loader/frame identity is checked; raw URLs and request IDs are not retained. Response and completion timestamps are independent observations; completion can predate response, so their difference is not a latency. Focus setup finishes before navigation. Long tasks and buffer saturation are not monitored in this mode and are null." } : {}),
  ...(workMode ? { workLimits: 'Boundary wrappers add timing overhead. Counts include document startup through the first geometry read. The startup-counter probe eagerly reads the same transform used immediately by its caller; it is diagnostic only. No lookup keys, options, results or page text are retained.' } : {}),
  ...(messageMode ? { messageLimits: "Capturing every lookup stack adds substantial overhead: this mode attributes call counts, not speed. Only exact current-origin allowlisted source paths, line numbers and aggregate counts survive; raw stacks, function names, keys and substitutions are discarded." } : {}),
  cleanup: { browser: true, profile: true }, sources, trials }, null, 2));
