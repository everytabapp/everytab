// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Installed host documents + native tab events; synthetic input, not OS IME or attached browser panels. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnOwnedChrome, terminateOwnedChrome } from "../extension/test/chrome-test-process.mjs";
import { chromeBin, extensionRoot, debuggingUrl, detectExtension, createTarget, attachTarget,
  CdpClient, evaluate, prepareSession, waitFor } from "./capture-store-screenshots.mjs";

const hosts = ["dashboard.html", "popup.html", "sidepanel.html", "newtab.html"];
const title = "refreshfixture subject";
const revisedTitle = "refreshfixture revised subject";
const companionTitle = "refreshfixture companion";
const sessions = [];
const results = [];
let browser, browserClient, profile, activeHost;
let stage = "setup", phase = "setup", failed = false, diagnostic = null;
function step(name) { stage = `${phase}:${name}`; diagnostic = null; }
function beginPhase(name) {
  stage = phase = name;
  diagnostic = null;
  console.error(`CHECK: installed Search refresh ${name}`);
}
const server = createServer((request, response) => {
  if (request.url.startsWith("/icon-")) {
    response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
    response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="${request.url.includes("second") ? "blue" : "red"}"/></svg>`);
    return;
  }
  const pageTitle = request.url.includes("companion") ? companionTitle : title;
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(`<!doctype html><title>${pageTitle}</title><link rel="icon" type="image/svg+xml" href="/icon-first.svg"><p>Synthetic disposable Search fixture</p>`);
});
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function open(debug, url) {
  const session = await createTarget(debug, url);
  sessions.push(session);
  await prepareSession(session);
  return session;
}

async function typeQuery(host, query, titles) {
  step("query-dispatch");
  await evaluate(host, `(() => {
    window.fixtureExpectedTitles = ${JSON.stringify(titles)};
    fixtureInput.focus();
    fixtureInput.value = ${JSON.stringify(query)};
    fixtureInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  })()`);
  step("query-exact-results");
  await waitFor(host, `JSON.stringify(fixtureRows().map(row => row.querySelector('.rtitle')?.textContent).sort()) ===
    ${JSON.stringify(JSON.stringify([...titles].sort()))}`, "exact query result titles");
  // Let any progressive completion finish before capturing row identities.
  step("query-settle");
  await waitFor(host, "performance.now() - fixtureLastRowsChanged > 350", "settled Search rows");
  step("query-settled-results");
  assert.equal(await evaluate(host, `JSON.stringify(fixtureRows().map(row => row.querySelector('.rtitle')?.textContent).sort()) ===
    ${JSON.stringify(JSON.stringify([...titles].sort()))}`), true, "settled rows match the exact expected set");
}

async function captureSelection(host) {
  step("selection-dispatch");
  await evaluate(host, `(() => {
    window.fixturePreArrowIndex = fixtureRows().findIndex(row => row.id === fixtureInput.getAttribute('aria-activedescendant'));
    fixtureInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    fixtureInput.setSelectionRange(2, 8, 'backward');
    window.fixtureBefore = {
      input: fixtureInput, rows: fixtureRows(), presentation: fixturePresentation(), value: fixtureInput.value,
      start: fixtureInput.selectionStart, end: fixtureInput.selectionEnd,
      direction: fixtureInput.selectionDirection, active: fixtureInput.getAttribute('aria-activedescendant')
    };
    window.fixtureRemoved = false;
    fixtureEvents.length = 0;
  })()`);
  step("selection-assert");
  diagnostic = await evaluate(host, `({
    focused: document.activeElement === fixtureInput,
    twoRows: fixtureBefore.rows.length === 2,
    secondActive: fixtureBefore.rows[1]?.id === fixtureBefore.active,
    secondSelected: fixtureBefore.rows[1]?.getAttribute('aria-selected') === 'true',
    textSelection: fixtureBefore.start === 2 && fixtureBefore.end === 8 && fixtureBefore.direction === 'backward'
  })`);
  assert.equal(Object.values(diagnostic).every(Boolean), true,
  "fixture starts with focused input, second result and nonempty backward selection");
}

async function assertPresentationContinuity(host, key, expected) {
  step("native-event-only-delivery");
  await waitFor(host, `fixtureEvents.some(event => event.change[${JSON.stringify(key)}] === ${JSON.stringify(expected)} &&
    event.keys.length === 1 && event.keys[0] === ${JSON.stringify(key)})`, `native ${key}-only delivery`);
  // This is a bounded observation after confirmed native delivery, not a timing benchmark.
  step("continuity-observation");
  await pause(500);
  step("continuity-assert");
  const state = await evaluate(host, "fixtureContinuity()");
  diagnostic = state;
  assert.deepEqual(state, { sameInput: true, focused: true, sameQuery: true, sameSelection: true,
    sameActive: true, sameRows: true, samePresentation: true, neverRemoved: true, noUrlEvent: true });
}

async function checkContentOracle(host) {
  step("content-oracle-negative-check");
  const result = await evaluate(host, `(() => {
    const row = fixtureBefore.rows[0], title = row.querySelector('.rtitle');
    const textNode = title.firstChild, originalText = textNode.data, originalTitle = title.getAttribute('title');
    const originalPresentation = fixtureBefore.presentation;
    const probe = document.createElement('img');
    probe.hidden = true;
    const rejectsSameNodeChange = () => {
      const state = fixtureContinuity();
      return state.sameRows && !state.samePresentation;
    };
    try {
      textNode.data = 'synthetic in-place text change';
      const rejectsText = rejectsSameNodeChange();
      textNode.data = originalText;
      title.setAttribute('title', 'synthetic tooltip change');
      const rejectsTitleAttribute = rejectsSameNodeChange();
      if (originalTitle === null) title.removeAttribute('title'); else title.setAttribute('title', originalTitle);
      // Search currently renders text-only result rows. A temporary hidden image
      // qualifies the same oracle's attribute guard without claiming real icons.
      probe.setAttribute('src', 'data:image/svg+xml,%3Csvg/%3E');
      row.append(probe);
      fixtureBefore.presentation = fixturePresentation();
      probe.setAttribute('src', 'data:image/svg+xml,%3Csvg%20width=%222%22/%3E');
      const rejectsIconSource = rejectsSameNodeChange();
      probe.remove();
      fixtureBefore.presentation = originalPresentation;
      return { rejectsText, rejectsTitleAttribute, rejectsIconSource,
        restored: Object.values(fixtureContinuity()).every(Boolean) };
    } finally {
      textNode.data = originalText;
      if (originalTitle === null) title.removeAttribute('title'); else title.setAttribute('title', originalTitle);
      probe.remove(); fixtureBefore.presentation = originalPresentation;
    }
  })()`);
  diagnostic = result;
  assert.deepEqual(result, { rejectsText: true, rejectsTitleAttribute: true, rejectsIconSource: true, restored: true });
}

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  profile = await mkdtemp(path.join(tmpdir(), "everytab-search-refresh-"));
  browser = spawnOwnedChrome(chromeBin, ["--headless=new", "--disable-gpu", "--remote-debugging-port=0",
    "--enable-unsafe-extension-debugging", "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    ...(process.env.EVERYTAB_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
    `--user-data-dir=${profile}`, "--no-first-run", "--disable-background-networking", "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const debug = await debuggingUrl(browser);
  browserClient = new CdpClient(debug);
  const manager = await open(debug, "chrome://extensions");
  await evaluate(manager, "chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })");
  await browserClient.send("Extensions.loadUnpacked", { path: extensionRoot });
  const id = await detectExtension(debug);
  const controller = await open(debug, `chrome-extension://${id}/dashboard.html`);
  await evaluate(controller, `(async () => {
    const store = await import(chrome.runtime.getURL('js/lib/store.js'));
    await chrome.storage.local.set({ onboardingDone: true });
    await store.patchSettings({ newTabMode: 'minimal', newTabFocus: 'omnibox',
      oneNewTabPerWindow: false, suspendEnabled: false, suspendMaxTabs: 0 });
  })()`);

  for (const hostPath of hosts) {
    beginPhase(`${hostPath}:setup`);
    const urls = [`${origin}/urlneedle-subject`, `${origin}/urlneedle-companion`];
    const tabIds = await evaluate(controller, `(async () => {
      const tabs = [];
      for (const url of ${JSON.stringify(urls)}) tabs.push(await chrome.tabs.create({ url, active: false }));
      return tabs.map(tab => tab.id);
    })()`);
    // Native tab readiness includes the initial favicon, so its delayed delivery
    // cannot masquerade as the explicitly changed favicon below.
    await evaluate(controller, `(async () => {
      const deadline = performance.now() + 15000;
      while (performance.now() < deadline) {
        const tabs = await Promise.all(${JSON.stringify(tabIds)}.map(id => chrome.tabs.get(id)));
        if (tabs.every(tab => tab.status === 'complete' && tab.favIconUrl?.includes('/icon-first.svg'))) return;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      throw new Error('native-fixture-tabs-not-ready');
    })()`);
    const { targetInfos } = await browserClient.send("Target.getTargets");
    const subjectTarget = targetInfos.find(target => target.type === "page" && target.url === urls[0]);
    assert.ok(subjectTarget, "owned synthetic subject target exists");
    const subject = await attachTarget(debug, subjectTarget.targetId);
    sessions.push(subject);
    await prepareSession(subject);
    const host = await open(debug, `chrome-extension://${id}/${hostPath}`);
    activeHost = host;
    await host.send("Page.bringToFront");
    await host.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await waitFor(host, "document.querySelector('.search-input')", "installed Search mounted");
    assert.equal(await evaluate(host, `chrome.tabs.get(${tabIds[0]}).then(tab => tab.active)`), false,
      "synthetic subject is a background tab while Search owns focus");
    assert.equal(await evaluate(host, `location.pathname === ${JSON.stringify(`/${hostPath}`)} &&
      ${hostPath === "newtab.html" ? "document.documentElement.dataset.newTabSurface === 'minimal'" : "true"}`), true,
    "requested production host mounted");
    await evaluate(host, `(() => {
      window.fixtureInput = document.querySelector('.search-input');
      window.fixtureBox = fixtureInput.closest('.search-box');
      // Dashboard portals this container outside .search-box. The combobox's
      // live aria-controls names the result list in every production host.
      const containers = document.querySelectorAll(${JSON.stringify(hostPath === "dashboard.html"
        ? ".hero-search-overlay .search-results" : ".search-box .search-results")});
      if (containers.length !== 1) throw new Error('fixture-results-container-ambiguous');
      window.fixtureResults = containers[0];
      window.fixtureRows = () => {
        const list = document.getElementById(fixtureInput.getAttribute('aria-controls'));
        return list?.getAttribute('role') === 'listbox' && fixtureResults.contains(list)
          ? [...list.querySelectorAll('.search-row')] : [];
      };
      window.fixturePresentation = () => fixtureRows().map(row => ({
        text: row.textContent, title: row.querySelector('.rtitle')?.textContent,
        titleAttribute: row.querySelector('.rtitle')?.getAttribute('title'),
        icons: [...row.querySelectorAll('img')].map(image => ({
          src: image.getAttribute('src'), srcset: image.getAttribute('srcset'),
          currentSrc: image.currentSrc
        }))
      }));
      window.fixtureEvents = [];
      window.fixtureLastRowsChanged = performance.now();
      window.fixtureBefore = null;
      window.fixtureRemoved = false;
      window.fixtureContinuity = () => {
        const before = fixtureBefore, rows = fixtureRows();
        return {
          sameInput: document.querySelector('.search-input') === before.input,
          focused: document.activeElement === before.input,
          sameQuery: fixtureInput.value === before.value,
          sameSelection: fixtureInput.selectionStart === before.start && fixtureInput.selectionEnd === before.end &&
            fixtureInput.selectionDirection === before.direction,
          sameActive: fixtureInput.getAttribute('aria-activedescendant') === before.active &&
            document.getElementById(before.active)?.getAttribute('aria-selected') === 'true',
          sameRows: rows.length === before.rows.length && rows.every((row, index) => row === before.rows[index]),
          samePresentation: JSON.stringify(fixturePresentation()) === JSON.stringify(before.presentation),
          neverRemoved: !fixtureRemoved,
          noUrlEvent: !fixtureEvents.some(event => Object.hasOwn(event.change, 'url'))
        };
      };
      window.fixtureObserver = new MutationObserver(records => {
        if (records.some(record => record.type === 'childList')) fixtureLastRowsChanged = performance.now();
        for (const record of records) for (const removed of record.removedNodes) {
          if (fixtureBefore?.rows.some(row => removed === row || removed.contains?.(row))) fixtureRemoved = true;
        }
      });
      fixtureObserver.observe(fixtureBox, { subtree: true, childList: true });
      if (!fixtureBox.contains(fixtureResults)) {
        fixtureObserver.observe(fixtureResults.parentElement, { subtree: true, childList: true });
      }
      window.fixtureOnUpdated = (tabId, change) => {
        if (tabId === ${tabIds[0]}) fixtureEvents.push({ change, keys: Object.keys(change) });
      };
      chrome.tabs.onUpdated.addListener(fixtureOnUpdated);
    })()`);

    beginPhase(`${hostPath}:title`);
    await typeQuery(host, "refreshfixture", [title, companionTitle]);
    await captureSelection(host);
    await checkContentOracle(host);
    step("native-title-change");
    await evaluate(subject, `document.title = ${JSON.stringify(revisedTitle)}`);
    await assertPresentationContinuity(host, "title", revisedTitle);
    beginPhase(`${hostPath}:fresh-input`);
    await typeQuery(host, "refreshfixture revised", [revisedTitle]);
    await typeQuery(host, "refreshfixture", [revisedTitle, companionTitle]);

    beginPhase(`${hostPath}:favicon`);
    await captureSelection(host);
    const secondIcon = `${origin}/icon-second.svg`;
    step("native-favicon-change");
    await evaluate(subject, `document.querySelector('link[rel=icon]').href = ${JSON.stringify(secondIcon)}`);
    await assertPresentationContinuity(host, "favIconUrl", secondIcon);

    beginPhase(`${hostPath}:url`);
    await typeQuery(host, "urlneedle", [revisedTitle, companionTitle]);
    // buildResultRows renders title/meta/action text, without favicon elements.
    // Therefore the next input can prove fresh title/URL data, not a new icon paint.
    step("no-rendered-favicon-assert");
    assert.equal(await evaluate(host, "fixtureRows().every(row => row.querySelectorAll('img').length === 0)"), true,
      "current production Search result rows do not render favicons");
    await captureSelection(host);
    const destination = `${origin}/destination`;
    step("native-url-change");
    await evaluate(controller, `chrome.tabs.update(${tabIds[0]}, { url: ${JSON.stringify(destination)} })`);
    step("native-url-delivery");
    await waitFor(host, `fixtureEvents.some(event => event.change.url === ${JSON.stringify(destination)})`, "native URL delivery");
    step("automatic-url-refresh");
    await waitFor(host, `fixtureRows().filter(row => row.querySelector('.rtype-open')).length === 1 &&
      fixtureRows().find(row => row.querySelector('.rtype-open'))?.querySelector('.rtitle')?.textContent ===
      ${JSON.stringify(companionTitle)}`, "URL change removes the live subject without another input");
    await waitFor(host, "performance.now() - fixtureLastRowsChanged > 350", "URL result completion settled");
    step("url-snapshot-provenance");
    // A retained automatic Snapshot can expose the former URL once the live
    // occurrence stops hiding it. Qualify that row from actual Recovery-backed
    // data, including its localized Snapshot metadata; arbitrary extras fail.
    diagnostic = await evaluate(host, `(async () => {
      const { listItems } = await import(chrome.runtime.getURL('js/lib/store.js'));
      const { searchResultMeta } = await import(chrome.runtime.getURL('js/lib/search-copy.js'));
      const saved = await listItems('sessions');
      const expected = saved.filter(session => session.auto === true).flatMap(session =>
        (session.windows ?? []).flat().filter(tab => tab.url === ${JSON.stringify(urls[0])} &&
          ${JSON.stringify([title, revisedTitle])}.includes(tab.title)).map(tab => ({
            title: tab.title,
            meta: searchResultMeta({ type: 'session', snapshot: true, sourceCreatedAt: session.createdAt })
          })));
      const rows = fixtureRows();
      const live = rows.filter(row => row.querySelector('.rtype-open'));
      const snapshots = rows.filter(row => row.querySelector('.rtype-session'));
      return {
        oneLiveCompanion: live.length === 1 && live[0].querySelector('.rtitle')?.textContent === ${JSON.stringify(companionTitle)},
        noUnknownTypes: rows.length === live.length + snapshots.length,
        atMostOneSnapshot: snapshots.length <= 1,
        snapshotProvenance: snapshots.every(row => expected.some(item =>
          item.title === row.querySelector('.rtitle')?.textContent && item.meta === row.querySelector('.rmeta')?.textContent)),
        snapshotRows: snapshots.length, matchingRecoveryOccurrences: expected.length
      };
    })()`);
    assert.equal(diagnostic.oneLiveCompanion && diagnostic.noUnknownTypes && diagnostic.atMostOneSnapshot &&
      diagnostic.snapshotProvenance, true, "URL results contain only the live companion and a proven synthetic Snapshot");
    const snapshotRowsAfterUrl = diagnostic.snapshotRows;
    step("url-continuity-assert");
    const afterUrl = await evaluate(host, `({
      sameInput: document.querySelector('.search-input') === fixtureBefore.input,
      focused: document.activeElement === fixtureInput,
      sameQuery: fixtureInput.value === fixtureBefore.value,
      sameSelection: fixtureInput.selectionStart === fixtureBefore.start && fixtureInput.selectionEnd === fixtureBefore.end &&
        fixtureInput.selectionDirection === fixtureBefore.direction,
      replacedRows: fixtureRemoved && fixtureRows().every(row => !fixtureBefore.rows.includes(row))
    })`);
    diagnostic = afterUrl;
    assert.deepEqual(afterUrl, { sameInput: true, focused: true, sameQuery: true, sameSelection: true, replacedRows: true });
    results.push({ host: hostPath, titleOnly: true, faviconOnly: true, nextInputFresh: true,
      urlRefresh: true, queryAndTextSelection: true, contentOracleNegatives: true, renderedFavicons: false,
      snapshotRowsAfterUrl });
    console.log(`PASS: ${hostPath} native presentation continuity and URL refresh`);
    await evaluate(host, `(() => {
      fixtureObserver.disconnect(); chrome.tabs.onUpdated.removeListener(fixtureOnUpdated);
    })()`);
    const hostId = await evaluate(host, "chrome.tabs.getCurrent().then(tab => tab.id)");
    await evaluate(controller, `chrome.tabs.remove(${JSON.stringify([...tabIds, hostId])})`);
    host.client.close(); subject.client.close();
    activeHost = null;
  }
} catch (error) {
  failed = true;
  // CDP exceptions can include document contents. Keep failure reporting scoped
  // to fixed stage names; assertions are rerunnable against disposable fixtures.
  console.error(`FAIL: installed Search refresh at ${stage}`);
  let observed = null;
  if (activeHost) {
    try {
      observed = await evaluate(activeHost, `(() => {
        const input = document.querySelector('.search-input');
        const rows = typeof fixtureRows === 'function' ? fixtureRows() : [];
        const events = window.fixtureEvents ?? [];
        const allowedTypes = ['open', 'session', 'session-entity', 'inbox', 'starred', 'snoozed',
          'archive', 'collection', 'history', 'label-group-entity', 'session-group-entity'];
        return { rowCount: rows.length, focused: Boolean(input && document.activeElement === input),
          rowTypes: rows.map(row => allowedTypes.find(type => row.querySelector('.rtype-' + type)) ?? 'other'),
          expectedResultCount: window.fixtureExpectedTitles?.length ?? null,
          expectedTitleMatchCount: rows.filter(row =>
            window.fixtureExpectedTitles?.includes(row.querySelector('.rtitle')?.textContent)).length,
          queryLength: input?.value.length ?? null, selectionStart: input?.selectionStart ?? null,
          selectionEnd: input?.selectionEnd ?? null, backwardSelection: input?.selectionDirection === 'backward',
          preArrowIndex: window.fixturePreArrowIndex ?? null,
          selectedIndex: rows.findIndex(row => row.id === input?.getAttribute('aria-activedescendant')),
          nativeEventCount: events.length,
          titleOnlyEvents: events.filter(event => event.keys.length === 1 && event.keys[0] === 'title').length,
          faviconOnlyEvents: events.filter(event => event.keys.length === 1 && event.keys[0] === 'favIconUrl').length,
          urlEvents: events.filter(event => event.keys.includes('url')).length };
      })()`);
    } catch {}
  }
  console.error(JSON.stringify({ stage,
    errorClass: ["AssertionError", "Error", "TypeError"].includes(error?.name) ? error.name : "OtherError",
    checks: diagnostic, observed }));
} finally {
  const cleanup = { clients: true, browser: false, profile: false, server: false };
  for (const session of sessions) {
    try { session.client.close(); } catch { cleanup.clients = false; }
  }
  try { browserClient?.close(); } catch { cleanup.clients = false; }
  try { await terminateOwnedChrome(browser); cleanup.browser = true; } catch {}
  // Keep a profile if process ownership cleanup failed; never remove files from a live browser.
  if (cleanup.browser) {
    try { if (profile) await rm(profile, { recursive: true, force: true }); cleanup.profile = true; } catch {}
  }
  try {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    cleanup.server = true;
  } catch {}
  const clean = Object.values(cleanup).every(Boolean);
  console.log(JSON.stringify({ fixture: "installed-search-refresh", passed: !failed && clean && results.length === hosts.length,
    results, cleanup, limits: ["production host documents, not attached popup or side panel", "synthetic input, not OS IME",
      "Search rows have no rendered favicon; native favicon delivery and continuity only",
      "presentation stability observed for 500ms after native event delivery"] }));
  if (failed || !clean) process.exitCode = 1;
}
