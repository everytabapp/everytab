// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Synthetic installed checks for Dashboard moves, refresh safety and saved duplicates. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnOwnedChrome, terminateOwnedChrome } from "../extension/test/chrome-test-process.mjs";
import { chromeBin, extensionRoot, debuggingUrl, detectExtension, createTarget,
  CdpClient, evaluate, prepareSession, waitFor } from "./capture-store-screenshots.mjs";
import { summarizeInboxCpuProfile } from "./testing/inbox-cpu-profile.mjs";
import { cleanupInboxMeasurement } from "./testing/inbox-measurement-cleanup.mjs";

const arguments_ = process.argv.slice(2);
assert.ok(new Set(arguments_).size === arguments_.length &&
  arguments_.every(value => ["--large-moves", "--normal-motion", "--profile-moves", "--stable-placements", "--dashboard-drag", "--timed-automation", "--grouped-profile", "--indicator-continuity"].includes(value)),
  "Use --large-moves, --normal-motion, --profile-moves --stable-placements --dashboard-drag --timed-automation --grouped-profile and/or --indicator-continuity");
const largeMoves = arguments_.includes("--large-moves");
const normalMotion = arguments_.includes("--normal-motion");
const profileMoves = arguments_.includes("--profile-moves");
const stablePlacements = arguments_.includes("--stable-placements");
const dashboardDrag = arguments_.includes("--dashboard-drag");
const timedAutomation = arguments_.includes("--timed-automation");
const groupedProfile = arguments_.includes("--grouped-profile");
const indicatorContinuity = arguments_.includes("--indicator-continuity");
assert.ok(!indicatorContinuity || (timedAutomation && !largeMoves), "Indicator continuity requires --timed-automation and excludes --large-moves");
assert.ok(!groupedProfile || !largeMoves, "Choose --grouped-profile or --large-moves");
assert.ok(!dashboardDrag || !stablePlacements, "Measure drag separately from synthetic retained-selection checks");

async function runtimeHashes() {
  const entries = await readdir(extensionRoot, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile() &&
    !path.relative(extensionRoot, entry.parentPath).split(path.sep).includes("test"));
  return Object.fromEntries(await Promise.all(files.map(async entry => {
    const file = path.join(entry.parentPath, entry.name);
    return [path.relative(extensionRoot, file), createHash("sha256").update(await readFile(file)).digest("hex")];
  })));
}

let navigationSequence = 0;
async function changeDocument(page, { url, reload = false }) {
  const token = `live-feedback-${++navigationSequence}`;
  if (!reload) {
    const destination = new URL(url);
    destination.searchParams.set("fixtureNavigation", token);
    url = destination.href; // A fragment-only command would reuse the old document.
  }
  const injection = await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `globalThis.fixtureDocumentToken = ${JSON.stringify(token)}`
  });
  try {
    if (reload) await page.send("Page.reload", { ignoreCache: false });
    else {
      const result = await page.send("Page.navigate", { url });
      assert.ok(result.loaderId && !result.errorText, "synthetic navigation must be accepted");
    }
    // A command response can precede context replacement. Poll only readiness;
    // never retry the navigation or accept the previous document's rows.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(page, `globalThis.fixtureDocumentToken === ${JSON.stringify(token)} &&
            location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`)) return;
      } catch { /* The outgoing execution context can disappear during replacement. */ }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.fail("fresh synthetic document did not become ready");
  } finally {
    await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injection.identifier });
  }
}

let fixtureStage = "setup";

async function main() {
  const sources = await runtimeHashes();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<!doctype html><title>Synthetic tab</title><p>Owned fixture</p>");
  });
  let browser, client, profile;
  const sessions = [];
  const receipt = { schemaVersion: 2, workload: groupedProfile ? "57 total tabs in eight windows with a live Chrome group" : largeMoves ? "164 fixture tabs in five windows" : "4 fixture tabs", normalMotion, profileMoves, stablePlacements, dashboardDrag, timedAutomation, groupedProfile, indicatorContinuity, moves: [], dashboardReload: null, duplicates: null };
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    profile = await mkdtemp(path.join(tmpdir(), "everytab-live-feedback-"));
    browser = spawnOwnedChrome(chromeBin, ["--headless=new", "--disable-gpu",
      "--remote-debugging-port=0", "--enable-unsafe-extension-debugging",
      ...(!normalMotion ? ["--force-prefers-reduced-motion"] : []), "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
      "--disable-background-networking", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const debug = await debuggingUrl(browser);
    client = new CdpClient(debug);
    receipt.browser = (await client.send("Browser.getVersion")).product;
    const manager = await createTarget(debug, "chrome://extensions");
    sessions.push(manager);
    await prepareSession(manager);
    await evaluate(manager, "chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })");
    await client.send("Extensions.loadUnpacked", { path: extensionRoot });
    const id = await detectExtension(debug);
    const page = await createTarget(debug, `chrome-extension://${id}/dashboard.html#open`);
    sessions.push(page);
    await prepareSession(page);
    receipt.runtime = await evaluate(page, "chrome.runtime.getManifest().version");
    const diagnosticSource = await readFile(new URL('./recovery-summary-diagnostic.js', import.meta.url), 'utf8');
    const diagnosticLogs = await evaluate(page, `(async () => {
      const logs = [], console = { log: value => logs.push(value) };
      ${diagnosticSource.replace('(async () => {', 'await (async () => {')}
      return logs;
    })()`);
    assert.equal(diagnosticLogs.length, 1, "pasteable diagnostic emits one receipt in real Dashboard context");
    receipt.recoveryDiagnostic = JSON.parse(diagnosticLogs[0]);
    assert.equal(receipt.recoveryDiagnostic.diagnostic, 'complete', "real Store import/read and native notification query succeed");
    if (normalMotion) await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }]
    });
    await evaluate(page, `(async () => {
      const store = await import(chrome.runtime.getURL('js/lib/store.js'));
      await chrome.storage.local.set({ onboardingDone: true });
      await store.patchSettings({ autoArchiveEnabled: false, autoSaveMaxTabs: 0,
        suspendEnabled: false, suspendMaxTabs: 0, dedupAutoClose: false, oneNewTabPerWindow: false });
      globalThis.fixtureTabIds = [];
      for (let i = 0; i < 4; i++) {
        const tab = await chrome.tabs.create({ url: ${JSON.stringify(origin)} + '/tab-' + i, active: false });
        fixtureTabIds.push(tab.id);
      }
      if (${largeMoves}) for (let windowIndex = 0; windowIndex < 4; windowIndex++) {
        await chrome.windows.create({ focused: false, url: Array.from({length:40}, (_, index) =>
          ${JSON.stringify(origin)} + '/load-' + windowIndex + '-' + index) });
      }
      if (${groupedProfile}) {
        for (let w = 0; w < 7; w++) await chrome.windows.create({ focused: false,
          url: Array.from({ length: w === 0 ? 8 : 7 }, (_, i) => ${JSON.stringify(origin)} + '/group-profile-' + w + '-' + i) });
        await chrome.tabs.group({ tabIds: fixtureTabIds });
      }
      const self = await chrome.tabs.getCurrent();
      await chrome.windows.update(self.windowId, { focused: true });
      await chrome.tabs.update(self.id, { active: true });
    })()`);
    const rows = `[...document.querySelectorAll('[data-tablist="open"] [data-tablist-row]')].map(row => row._tlRow?.ctx?.live?.tabId)`;
    await waitFor(page, `fixtureTabIds.every(id => ${rows}.includes(id))`, "synthetic Open rows");
    // All owned HTTP pages finish before timing; avoid measuring fixture network churn.
    for (let attempt = 0; attempt < 100; attempt++) {
      const complete = await evaluate(page, `(async () => (await chrome.tabs.query({})).every(tab => tab.status !== 'loading'))()`);
      if (complete) break;
      assert.ok(attempt < 99, "synthetic pages must finish loading");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await evaluate(page, "new Promise(resolve => setTimeout(resolve, 1000))");
    if (timedAutomation) {
      await evaluate(page, `(async () => {
        const store = await import(chrome.runtime.getURL('js/lib/store.js'));
        const tabs = (await chrome.tabs.query({})).filter(tab => tab.url?.startsWith(${JSON.stringify(origin)}));
        await store.mutateStores(['tabActivity'], maps => ({ tabActivity: {
          ...(maps.tabActivity ?? {}), ...Object.fromEntries(tabs.map(tab => [tab.id, Date.now() - 3600000]))
        } }));
        // A one-day threshold cannot act on the one-hour-old fixture.
        await store.patchSettings({ autoArchiveEnabled: true, autoDumpAfterMinutes: 1440 });
      })()`);
      await waitFor(page, `document.querySelectorAll('[data-tablist="open"] .automation-awareness.has-meter').length >= 4`, 'timed automation rows');
      await evaluate(page, 'new Promise(resolve => setTimeout(resolve, 500))');
      receipt.timedRows = await evaluate(page, `document.querySelectorAll('[data-tablist="open"] .automation-awareness.has-meter').length`);
    }
    receipt.renderedOpenRows = await evaluate(page, `${rows}.length`);
    if (groupedProfile) {
      const shape = await evaluate(page, `(async () => {
        const windows = await chrome.windows.getAll({ populate: true });
        return { windows: windows.length, tabs: windows.flatMap(w => w.tabs).length,
          groupedTabs: windows.flatMap(w => w.tabs).filter(t => t.groupId >= 0).length,
          renderedGroups: document.querySelectorAll('[data-live-tab-group]').length };
      })()`);
      assert.equal(shape.windows, 8); assert.equal(shape.tabs, 57); assert.equal(shape.groupedTabs, 4);
      receipt.groupedShape = shape;
    }
    // Fixture assertions must not enter the production scroll-read probe.
    await evaluate(page, `(() => {
      const getScroll = Object.getOwnPropertyDescriptor(window, 'scrollY').get;
      globalThis.readFixtureScroll = () => getScroll.call(window);
    })()`);
    if (stablePlacements) await evaluate(page, `(() => {
      const rowSelector = '[data-tablist-row]';
      const rootSelector = '[data-tablist="open"]';
      const liveId = row => row._tlRow?.ctx?.live?.tabId;
      const selectedIds = root => [...root.querySelectorAll(rowSelector)]
        .filter(row => row.classList.contains('sel')).map(liveId);
      const checkedIds = root => [...root.querySelectorAll(rowSelector)]
        .filter(row => row.querySelector('input[type="checkbox"]')?.checked).map(liveId);
      globalThis.prepareStablePlacement = () => {
        const root = document.querySelector(rootSelector);
        const allRows = [...root.querySelectorAll(rowSelector)];
        const fixtureRows = allRows.filter(row => fixtureTabIds.includes(liveId(row)));
        if (fixtureRows.length !== 4 || selectedIds(root).length || checkedIds(root).length)
          throw new Error('Placement fixture requires four unselected rows');
        const anchor = fixtureRows[0];
        anchor.querySelector('input[type="checkbox"]').click();
        globalThis.placementFixture = { root, anchorId: liveId(anchor),
          rows: new Map(allRows.map(row => [row.getAttribute('data-tablist-row'), row])) };
      };
      globalThis.readStablePlacement = expected => {
        const root = document.querySelector(rootSelector), before = placementFixture;
        const current = [...root.querySelectorAll(rowSelector)];
        const actual = current.map(liveId).filter(id => fixtureTabIds.includes(id));
        return { rootRetained: root === before.root,
          allRowIdentitiesRetained: current.length === before.rows.size && current.every(row =>
            before.rows.get(row.getAttribute('data-tablist-row')) === row),
          exactOrder: actual.join(',') === expected.join(','),
          anchorSelected: selectedIds(root).join(',') === String(before.anchorId) &&
            checkedIds(root).join(',') === String(before.anchorId),
          rowCount: current.length };
      };
      globalThis.checkPlacementInteractions = async (expected, expectedWindowId) => {
        const root = document.querySelector(rootSelector);
        const rowFor = id => [...root.querySelectorAll(rowSelector)].find(row => liveId(row) === id);
        const moved = rowFor(expected[0]);
        const checkbox = moved.querySelector('input[type="checkbox"]');
        checkbox.focus({ preventScroll: true });
        checkbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'X', shiftKey: true, bubbles: true, cancelable: true }));
        const range = expected.slice(0, 2).join(',');
        const rangeCorrect = selectedIds(root).join(',') === range && checkedIds(root).join(',') === range;
        for (const row of [...root.querySelectorAll(rowSelector)]) {
          const selected = row.querySelector('input[type="checkbox"]');
          if (selected?.checked) selected.click();
        }
        const selectionCleared = selectedIds(root).length === 0 && checkedIds(root).length === 0;
        const originalSend = chrome.runtime.sendMessage;
        const calls = [];
        chrome.runtime.sendMessage = function(message, ...args) {
          if (message?.type === 'focus-tab') {
            calls.push({ type: message.type, tabId: message.tabId, windowId: message.windowId });
            return Promise.resolve({ ok: true });
          }
          return originalSend.call(this, message, ...args);
        };
        try {
          moved.querySelector('.t a').click();
          const keyTarget = rowFor(expected[3]).querySelector('input[type="checkbox"]');
          keyTarget.focus({ preventScroll: true });
          keyTarget.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true }));
          await Promise.resolve();
          return { rangeCorrect, selectionCleared,
            clickTargetCorrect: calls.length === 2 && calls[0].tabId === expected[0] && calls[0].windowId === expectedWindowId,
            keyboardTargetCorrect: calls.length === 2 && calls[1].tabId === expected[3] && calls[1].windowId === expectedWindowId };
        } finally { chrome.runtime.sendMessage = originalSend; }
      };
    })()`);
    if (profileMoves) {
      await page.send("Profiler.enable");
      await evaluate(page, `(() => {
        const scroll = Object.getOwnPropertyDescriptor(window, 'scrollY');
        const replace = Element.prototype.replaceChildren;
        const target = document.querySelector('[data-tablist="open"]').parentElement;
        globalThis.openCommitProbe = [];
        Object.defineProperty(window, 'scrollY', { ...scroll, get() {
          const start = performance.now();
          const value = scroll.get.call(this);
          openCommitProbe.push({ kind: 'scroll-read', ms: performance.now() - start });
          return value;
        } });
        Element.prototype.replaceChildren = function(...nodes) {
          if (this !== target) return replace.apply(this, nodes);
          const start = performance.now();
          const result = replace.apply(this, nodes);
          openCommitProbe.push({ kind: 'open-replace', ms: performance.now() - start });
          return result;
        };
        globalThis.stopOpenCommitProbe = () => {
          Object.defineProperty(window, 'scrollY', scroll);
          Element.prototype.replaceChildren = replace;
        };
      })()`);
    }
    fixtureStage = "reorder";
    for (let trial = 0; trial < (largeMoves ? 5 : 4); trial++) {
      if (indicatorContinuity) {
        const point = await evaluate(page, `(() => {
          const row = [...document.querySelectorAll('[data-tablist="open"] [data-tablist-row]')]
            .find(row => fixtureTabIds.includes(row._tlRow?.ctx?.live?.tabId) && row.querySelector('.automation-awareness-row'));
          if (!row) throw new Error('Stationary indicator fixture unavailable');
          row.scrollIntoView({ block: 'center' });
          const rect = row.getBoundingClientRect();
          globalThis.continuityTabId = row._tlRow.ctx.live.tabId;
          globalThis.continuityPoint = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`);
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
        await evaluate(page, 'new Promise(resolve => setTimeout(resolve, 350))');
        await evaluate(page, `(() => {
          const row = [...document.querySelectorAll('[data-tablist="open"] [data-tablist-row]')]
            .find(row => row._tlRow?.ctx?.live?.tabId === continuityTabId);
          const button = row.querySelector('.automation-awareness-row');
          if (+getComputedStyle(button).opacity < .99) throw new Error('Stationary indicator was not revealed');
          const start = performance.now(), samples = [];
          globalThis.indicatorObservation = null;
          globalThis.finishIndicatorSampling = false;
          const sample = () => {
            const current = document.elementFromPoint(continuityPoint.x, continuityPoint.y)?.closest('[data-tablist-row]');
            const node = current?.querySelector('.automation-awareness-row');
            samples.push({ at: performance.now() - start, opacity: node ? +getComputedStyle(node).opacity : 0,
              sameButton: node === button, hovered: current?.matches(':hover') === true,
              rejoining: node?.classList.contains('is-rejoining') === true });
            if (!finishIndicatorSampling) requestAnimationFrame(sample);
            else globalThis.indicatorObservation = { samples, minimumOpacity: Math.min(...samples.map(s => s.opacity)) };
          };
          requestAnimationFrame(sample);
        })()`);
      }
      if (stablePlacements) await evaluate(page, 'prepareStablePlacement()');
      if (trial === 4) await evaluate(page, `new Promise(resolve => {
        window.scrollTo(0, 650);
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })`);
      await evaluate(page, "new Promise(resolve => setTimeout(resolve, 250))");
      if (profileMoves) {
        await evaluate(page, 'openCommitProbe = []');
        await page.send("Profiler.start");
      }
      await evaluate(page, `(async () => {
        const scrollBeforeMove = readFixtureScroll();
        if (${trial === 4}) {
          if (Math.abs(scrollBeforeMove - 650) >= 1) throw new Error('Synthetic Open list must start at 650 pixels');
        }
        const ids = fixtureTabIds;
        const tabs = (await chrome.tabs.query({ windowId: (await chrome.tabs.get(ids[0])).windowId }))
          .filter(tab => ids.includes(tab.id)).sort((a,b) => a.index-b.index);
        const moving = tabs.at(-1);
        const expected = [moving.id, ...tabs.slice(0,-1).map(tab => tab.id)];
        if (${stablePlacements}) globalThis.placementExpected = { order: expected, windowId: moving.windowId };
        globalThis.moveObservation = null;
        let started;
        let browserMovedMs = null;
        const onMoved = tabId => {
          if (tabId !== moving.id) return;
          browserMovedMs = performance.now() - started;
          chrome.tabs.onMoved.removeListener(onMoved);
        };
        chrome.tabs.onMoved.addListener(onMoved);
        setTimeout(() => chrome.tabs.onMoved.removeListener(onMoved), 15000);
        const observer = new MutationObserver(() => {
          const actual = ${rows}.filter(id => ids.includes(id));
          if (JSON.stringify(actual) === JSON.stringify(expected)) {
            observer.disconnect();
            const observation = { elapsedMs: performance.now()-started, exactOrder: true,
              reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches };
            requestAnimationFrame(() => requestAnimationFrame(() => {
              observation.twoFramesMs = performance.now()-started;
              observation.browserMovedMs = browserMovedMs;
              observation.browserToDomMs = browserMovedMs === null ? null : observation.elapsedMs - browserMovedMs;
              const finalOrder = ${rows}.filter(id => ids.includes(id));
              observation.exactOrderAtFrame2 = finalOrder.join(',') === expected.join(',');
              if (${stablePlacements}) observation.placementAtFrame2 = readStablePlacement(expected);
              observation.scrollPreserved = Math.abs(readFixtureScroll() - scrollBeforeMove) < 1;
              observation.scrolled = scrollBeforeMove > 0;
              observation.openAnimations = document.querySelector('[data-tablist="open"]').getAnimations({subtree:true}).length;
              globalThis.moveObservation = observation;
            }));
          }
        });
        observer.observe(document.querySelector('[data-tablist="open"]').parentElement,
          { childList: true, subtree: true });
        if (${dashboardDrag}) {
          const allRows = [...document.querySelectorAll('[data-tablist="open"] [data-tablist-row]')];
          const source = allRows.find(row => row._tlRow?.ctx?.live?.tabId === moving.id);
          const target = allRows.find(row => row._tlRow?.ctx?.live?.tabId === tabs[0].id);
          if (!source || !target || !source.draggable) throw new Error('Synthetic drag rows unavailable');
          const dataTransfer = new DataTransfer();
          started = performance.now();
          source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
          target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
          target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
          source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
        } else {
          started = performance.now();
          await chrome.tabs.move(moving.id, { index: tabs[0].index });
        }
      })()`);
      await waitFor(page, "moveObservation !== null", "Open order follows browser move");
      const cpu = profileMoves ? summarizeInboxCpuProfile((await page.send("Profiler.stop")).profile,
        `chrome-extension://${id}`, { includeLocations: true }) : null;
      const observation = await evaluate(page, "moveObservation");
      assert.ok(Number.isFinite(observation.browserMovedMs), "Dashboard observes the moved-tab Chrome event");
      assert.ok(observation.exactOrderAtFrame2, "exact Open order persists through subsequent frames");
      assert.ok(observation.scrollPreserved, "moving tabs preserves Dashboard scroll position");
      if (stablePlacements) {
        const assertPlacement = (state, checkpoint) => {
          if (!state.rootRetained || !state.allRowIdentitiesRetained || !state.exactOrder || !state.anchorSelected) {
            console.error(JSON.stringify({ kind: "stable-placement-failure", checkpoint,
              rootRetained: state.rootRetained === true,
              allRowIdentitiesRetained: state.allRowIdentitiesRetained === true,
              exactOrder: state.exactOrder === true, anchorSelected: state.anchorSelected === true,
              rowCount: Number.isSafeInteger(state.rowCount) ? state.rowCount : null }));
          }
          assert.ok(state.rootRetained, "same-window reorder retains the Open root");
          assert.ok(state.allRowIdentitiesRetained, "same-window reorder retains every rendered Open row");
          assert.ok(state.exactOrder, "retained rows match final browser order");
          assert.ok(state.anchorSelected, "selected occurrence and checked state survive placement");
        };
        assertPlacement(observation.placementAtFrame2, "frame2");
        // A quick correct patch followed by a trailing full rebuild must fail.
        await evaluate(page, 'new Promise(resolve => setTimeout(resolve, 220))');
        observation.placementAfterTrailingRefresh = await evaluate(page,
          'readStablePlacement(placementExpected.order)');
        assertPlacement(observation.placementAfterTrailingRefresh, "trailing-refresh");
        observation.placementInteractions = await evaluate(page,
          'checkPlacementInteractions(placementExpected.order, placementExpected.windowId)');
        for (const [name, valid] of Object.entries(observation.placementInteractions))
          assert.ok(valid, `retained placement interaction: ${name}`);
      }
      if (indicatorContinuity) {
        await evaluate(page, 'new Promise(resolve => setTimeout(resolve, 350))');
        await evaluate(page, 'finishIndicatorSampling = true');
        await waitFor(page, 'indicatorObservation !== null', 'stationary pointer opacity sampling');
        observation.indicator = await evaluate(page, 'indicatorObservation');
        if (observation.indicator.minimumOpacity < .95) console.error(JSON.stringify({ kind: 'indicator-blink', ...observation.indicator }));
        assert.ok(observation.indicator.samples.some(sample => !sample.sameButton), 'a different indicator moves under the pointer');
        assert.ok(observation.indicator.samples.every(sample => sample.hovered), 'pointer stays over a row throughout observation');
        assert.ok(observation.indicator.minimumOpacity >= .95, 'a stationary hovered indicator stays revealed through row refreshes');
        await evaluate(page, `(() => {
          globalThis.continuityFinalButton = document.elementFromPoint(continuityPoint.x, continuityPoint.y)
            .closest('[data-tablist-row]').querySelector('.automation-awareness-row');
          document.activeElement?.blur();
        })()`);
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
        await evaluate(page, 'new Promise(resolve => setTimeout(resolve, 350))');
        observation.indicator.afterLeave = await evaluate(page, `({
          opacity: +getComputedStyle(continuityFinalButton).opacity,
          bridge: continuityFinalButton.matches('.is-rejoining, .is-remounting'),
          hovered: continuityFinalButton.closest('[data-tablist-row]').matches(':hover')
        })`);
        assert.equal(observation.indicator.afterLeave.opacity, 0, 'pointer leave hides the indicator again');
        assert.equal(observation.indicator.afterLeave.bridge, false, 'remount bridge classes are cleaned');
        assert.equal(observation.indicator.afterLeave.hovered, false, 'pointer has left the row');
        await evaluate(page, 'continuityFinalButton.focus(); new Promise(resolve => setTimeout(resolve, 350))');
        observation.indicator.keyboardOpacity = await evaluate(page, '+getComputedStyle(continuityFinalButton).opacity');
        assert.equal(observation.indicator.keyboardOpacity, 1, 'keyboard focus reveals the indicator');
        await evaluate(page, 'continuityFinalButton.blur()');
      }
      receipt.moves.push({ kind: trial === 4 ? "scrolled-reorder" : "reorder", ...observation,
        ...(cpu ? { cpu, commitProbe: await evaluate(page, "openCommitProbe") } : {}) });
    }
    if (profileMoves) await evaluate(page, "stopOpenCommitProbe()");
    await evaluate(page, `new Promise(resolve => {
      window.scrollTo(0, 0);
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })`);
    assert.equal(await evaluate(page, "readFixtureScroll()"), 0, "cross-window measurement begins at the top");
    await evaluate(page, `(async () => {
      const source = await chrome.tabs.get(fixtureTabIds[0]);
      globalThis.fixtureSourceWindow = source.windowId;
      globalThis.fixtureOtherWindow = (await chrome.windows.create({
        url: ${JSON.stringify(origin)} + '/other-window', focused: false })).id;
    })()`);
    fixtureStage = "cross-window";
    for (const destination of ["fixtureOtherWindow", "fixtureSourceWindow"]) {
      await evaluate(page, "new Promise(resolve => setTimeout(resolve, 250))");
      await evaluate(page, `(async () => {
        const id = fixtureTabIds[0], windowId = ${destination};
        globalThis.moveObservation = null;
        const started = performance.now();
        const observer = new MutationObserver(() => {
          const contexts = [...document.querySelectorAll('[data-tablist="open"] [data-tablist-row]')]
            .map(row => row._tlRow?.ctx?.live).filter(live => live?.tabId === id);
          if (contexts.length === 1 && contexts[0].windowId === windowId) {
            observer.disconnect();
            globalThis.moveObservation = { elapsedMs: performance.now()-started, exactWindow: true, occurrences: 1 };
          }
        });
        observer.observe(document.querySelector('[data-tablist="open"]').parentElement,
          { childList: true, subtree: true });
        await chrome.tabs.move(id, { windowId, index: -1 });
      })()`);
      await waitFor(page, "moveObservation !== null", "Open membership follows cross-window move");
      receipt.moves.push({ kind: "cross-window", ...await evaluate(page, "moveObservation") });
    }
    // Preserve only synthetic IDs privately across page reload; receipt contains counts.
    const ids = await evaluate(page, "fixtureTabIds");
    if (timedAutomation) await evaluate(page, `(async () => {
      const store = await import(chrome.runtime.getURL('js/lib/store.js'));
      await store.patchSettings({ autoArchiveEnabled: false });
    })()`);
    fixtureStage = "dashboard-reload";
    const before = await evaluate(page, `(async () => {
      const store = await import(chrome.runtime.getURL('js/lib/store.js'));
      return { inbox: await store.listItems('inbox'), tabs: (await chrome.tabs.query({})).filter(t => ${JSON.stringify(ids)}.includes(t.id)).map(t => ({id:t.id,url:t.url})) };
    })()`);
    await changeDocument(page, { url: `chrome-extension://${id}/dashboard.html#open`, reload: true });
    await waitFor(page, `document.readyState === 'complete' && ${JSON.stringify(ids)}.every(id => ${rows}.includes(id))`, "reloaded Open rows");
    await evaluate(page, "new Promise(resolve => setTimeout(resolve, 1200))");
    const after = await evaluate(page, `(async () => {
      const store = await import(chrome.runtime.getURL('js/lib/store.js'));
      return { inbox: await store.listItems('inbox'), tabs: (await chrome.tabs.query({})).filter(t => ${JSON.stringify(ids)}.includes(t.id)).map(t => ({id:t.id,url:t.url})) };
    })()`);
    assert.deepEqual(after, before, "Dashboard reload with automation disabled must preserve exact tabs and Inbox");
    receipt.dashboardReload = { tabsPreserved: after.tabs.length, inboxUnchanged: true, observationMs: 1200 };
    fixtureStage = "seed-saved";
    const savedBefore = await evaluate(page, `(async () => {
      const store = await import(chrome.runtime.getURL('js/lib/store.js'));
      const { createSessionFromWindowsJournaled } = await import(chrome.runtime.getURL('js/lib/sessions.js'));
      const duplicate = { url: 'https://saved-fixture.invalid/same', title: 'Repeated saved page' };
      const unique = { url: 'https://saved-fixture.invalid/unique', title: 'Distinct saved page' };
      await createSessionFromWindowsJournaled([[duplicate, unique], [{...duplicate}]], 'Fixture repeated');
      await createSessionFromWindowsJournaled([[{...duplicate}]], 'Fixture separate');
      const items = {};
      for (let i = 0; i < 2; i++) {
        const meta = await store.newMeta();
        items[meta.id] = {...meta, kind:'tab', tabs:[{...duplicate}], source:'manual', labels:[]};
      }
      await store.mutateStores(['inbox'], () => ({inbox:items}));
      return { inbox: await store.listItems('inbox'), sessions: await store.listNamedSessions() };
    })()`);
    receipt.duplicates = {};
    for (const [section, expectedRows, expectedBadges] of [["inbox", 2, 2], ["sessions", 4, 2]]) {
      fixtureStage = `${section}-duplicates`;
      await changeDocument(page, { url: `chrome-extension://${id}/dashboard.html#${section}` });
      await waitFor(page, `document.querySelectorAll('[data-tablist="${section}"] [data-tablist-row]').length === ${expectedRows}`, `${section} synthetic saved rows`);
      const observed = await evaluate(page, `(() => {
        const root = document.querySelector('[data-tablist="${section}"]');
        return { rows: root.querySelectorAll('[data-tablist-row]').length,
          badges: root.querySelectorAll('.saved-duplicate-badge').length,
          visibleLabels: [...root.querySelectorAll('.saved-duplicate-badge')].every(badge => badge.textContent.includes('Duplicate')),
          scopeCorrect: [...root.querySelectorAll('[data-tablist-row]')].every(row => {
            const context = row._tlRow.ctx;
            const expected = context.ref.url === 'https://saved-fixture.invalid/same' &&
              (${JSON.stringify(section)} === 'inbox' || context.group.data.name === 'Fixture repeated');
            return Boolean(row.querySelector('.saved-duplicate-badge')) === expected;
          }) };
      })()`);
      assert.equal(observed.badges, expectedBadges, "saved duplicate scope must match fixture");
      assert.equal(observed.visibleLabels, true, "duplicate marker must include readable copy");
      assert.equal(observed.scopeCorrect, true, "duplicate markers must belong to the exact scoped rows");
      receipt.duplicates[section] = observed;
    }
    fixtureStage = "saved-integrity";
    const savedAfter = await evaluate(page, `(async () => {
      const store = await import(chrome.runtime.getURL('js/lib/store.js'));
      return { inbox: await store.listItems('inbox'), sessions: await store.listNamedSessions() };
    })()`);
    assert.deepEqual(savedAfter, savedBefore, "viewing duplicate markers must not change saved records");
    receipt.duplicates.recordsUnchanged = true;
    assert.deepEqual(await runtimeHashes(), sources, "runtime must remain unchanged during qualification");
    receipt.sources = sources;

  } catch (error) {
    // Emit fixed diagnostics before teardown so a cleanup failure cannot hide
    // the actual qualification stage. Never serialize the thrown payload.
    console.error(`FAIL: installed live-feedback fixture (${fixtureStage})`);
    throw error;
  } finally {
    try {
      await cleanupInboxMeasurement({ sessions, client, browser, profile }, {
        terminateOwnedChrome, removeProfile: profile => rm(profile, { recursive: true, force: true }) });
    } finally {
      if (server.listening) await new Promise(resolve => {
        server.close(resolve);
        // All requests belong to this synthetic fixture. Do not leave teardown
        // waiting on an abandoned browser connection after a failed assertion.
        server.closeAllConnections();
      });
    }
  }
  receipt.cleanup = { browser: true, profile: true, server: true };
  console.log(JSON.stringify(receipt, null, 2));
}

main().catch(() => {
  console.error("FAIL: installed live-feedback run terminated");
  process.exitCode = 1;
});
