// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Installed Inbox bundle disclosure/selection; owned profile, synthetic data and CDP pointer input. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnOwnedChrome, terminateOwnedChrome } from "../extension/test/chrome-test-process.mjs";
import { chromeBin, extensionRoot, debuggingUrl, detectExtension, createTarget,
  CdpClient, evaluate, prepareSession, waitFor } from "./capture-store-screenshots.mjs";
import { BUNDLE_COUNT, TABS_PER_BUNDLE, INITIAL_ROWS, bundleId, makeInboxBundleItems,
  validateInboxBundleObservation } from "./testing/installed-inbox-bundles.mjs";

const sessions = [], trials = [];
const rootSelector = '[data-tablist="inbox"]';
const cardSelector = index => `${rootSelector} [data-tablist-card="${bundleId(index)}"]`;
let browser, browserClient, profile, activePage, controller;
let stage = "setup", failed = false;
function progress(value) { stage = value; console.error(`CHECK: installed Inbox bundles ${value}`); }

async function open(debug, url = "about:blank") {
  const page = await createTarget(debug, url);
  sessions.push(page);
  await prepareSession(page);
  return page;
}

async function click(page, selector) {
  const point = await evaluate(page, `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target || target.disabled) throw new Error('fixture-control-unavailable');
    target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const rect = target.getBoundingClientRect();
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (rect.width <= 0 || rect.height <= 0 || !(hit === target || target.contains(hit))) {
      throw new Error('fixture-control-obscured');
    }
    return { x, y };
  })()`);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
}

async function observe(page) {
  return evaluate(page, `(() => {
    const roots = [...document.querySelectorAll(${JSON.stringify(rootSelector)})];
    const root = roots[0];
    const rendered = node => Boolean(node?.isConnected && node.getClientRects().length &&
      node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 &&
      getComputedStyle(node).visibility !== 'hidden');
    const expanded = node => node?.getAttribute('aria-expanded') === 'true' ? true
      : node?.getAttribute('aria-expanded') === 'false' ? false : null;
    const horizontalBounds = node => {
      const { left, right } = node.getBoundingClientRect(); return { left, right };
    };
    return { host: location.pathname.slice(1), width: innerWidth, height: innerHeight,
      documentScrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth,
      rootCount: roots.length, rowCount: root?.querySelectorAll('[data-tablist-row]').length ?? 0,
      sectionDisclosures: root?.querySelectorAll('.disclosure-section').length ?? 0,
      routeActive: location.pathname === '/sidepanel.html'
        ? document.querySelector('#switch-inbox')?.getAttribute('aria-selected') === 'true'
        : location.hash === '#inbox',
      visible: document.visibilityState === 'visible', focused: document.hasFocus(),
      cards: [...(root?.querySelectorAll('[data-tablist-card]') ?? [])].map(card => ({
        id: card.dataset.tablistCard, rendered: rendered(card), ...horizontalBounds(card),
        foldExpanded: expanded(card.querySelector('.item-head-toggle')),
        rows: [...card.querySelectorAll('[data-tablist-row]')].map(row => ({
          key: row.dataset.tablistRow, title: row.querySelector('.t a')?.textContent,
          url: row.querySelector('.t a')?.href,
          selected: row.classList.contains('sel'), checked: row.querySelector('input[type=checkbox]')?.checked,
          checkboxEnabled: Boolean(row.querySelector('input[type=checkbox]') && !row.querySelector('input[type=checkbox]').disabled),
          rendered: rendered(row), ...horizontalBounds(row)
        })),
        disclosures: [...card.querySelectorAll('[data-disclosure-key]')].map(button => {
          const id = button.getAttribute('aria-controls'), body = id ? document.getElementById(id) : null;
          return { key: button.dataset.disclosureKey, expanded: expanded(button),
            label: button.querySelector('.disclosure-label')?.textContent,
            controlsOwnRows: Boolean(body && card.contains(body) &&
              document.querySelectorAll('[id="' + CSS.escape(id) + '"]').length === 1 &&
              [...card.querySelectorAll('[data-tablist-row]')].every(row => body.contains(row))),
            enabled: !button.disabled && rendered(button) };
        })
      })) };
  })()`);
}

async function waitCardRows(page, index, count) {
  await waitFor(page, `document.querySelector(${JSON.stringify(cardSelector(index))})?.querySelectorAll('[data-tablist-row]').length === ${count}`,
    "bundle rows updated");
}

try {
  profile = await mkdtemp(path.join(tmpdir(), "everytab-inbox-bundles-"));
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
  controller = await open(debug, `chrome-extension://${id}/dashboard.html#open`);
  progress("seed");
  const items = makeInboxBundleItems();
  const seeded = await evaluate(controller, `(async () => {
    const store = await import(chrome.runtime.getURL('js/lib/store.js'));
    await chrome.storage.local.set({ onboardingDone: true });
    await store.patchSettings({ suspendEnabled: false, suspendMaxTabs: 0, oneNewTabPerWindow: false });
    await store.mutateStores(['inbox'], () => ({ inbox: ${JSON.stringify(items)} }));
    return Object.fromEntries((await store.listItems('inbox')).map(item => [item.id, item]));
  })()`);
  assert.deepEqual(seeded, items, "production Store retains the exact synthetic bundle payloads");

  for (const host of ["dashboard.html", "sidepanel.html"]) for (const width of [360, 400]) {
    const tag = `${host}:${width}`;
    progress(`${tag}:mount`);
    const page = await open(debug);
    activePage = page;
    progress(`${tag}:viewport`);
    await page.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1,
      mobile: false, screenWidth: width, screenHeight: 800 });
    progress(`${tag}:navigate`);
    const navigation = await page.send("Page.navigate", {
      url: `chrome-extension://${id}/${host}${host === "dashboard.html" ? "#inbox" : ""}`
    });
    assert.ok(navigation.loaderId && !navigation.errorText, "fresh host navigation succeeds");
    progress(`${tag}:focus`);
    await page.send("Page.bringToFront");
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    progress(`${tag}:document-ready`);
    await waitFor(page, "document.readyState === 'complete'", "host document loaded");
    if (host === "sidepanel.html") {
      progress(`${tag}:switcher-ready`);
      await waitFor(page, "document.querySelector('#switch-inbox')", "Side Panel switcher mounted");
      progress(`${tag}:switch-inbox`);
      await click(page, "#switch-inbox");
    }
    progress(`${tag}:cards-ready`);
    await waitFor(page, `document.querySelectorAll('${rootSelector} [data-tablist-card]').length === ${BUNDLE_COUNT}`,
      "all Inbox cards mounted");
    progress(`${tag}:localized-disclosure-labels`);
    const labels = await evaluate(page, `({
      moreLabel: chrome.i18n.getMessage('list_more_hidden', [${JSON.stringify(String(TABS_PER_BUNDLE - INITIAL_ROWS))}]),
      fewerLabel: chrome.i18n.getMessage('list_show_fewer')
    })`);
    const phases = [];
    async function verify(phase) {
      progress(`${tag}:${phase}`);
      const value = await observe(page);
      validateInboxBundleObservation(value, { host, width, phase, ...labels });
      phases.push({ phase, cards: value.cards.length, rows: value.rowCount,
        selectedKeys: value.cards.flatMap(card => card.rows.filter(row => row.selected).map(row => row.key)) });
    }
    await verify("initial");
    for (let index = 0; index < BUNDLE_COUNT; index++) {
      progress(`${tag}:expand-${index + 1}`);
      await click(page, `${cardSelector(index)} [data-disclosure-key]`);
      await waitCardRows(page, index, TABS_PER_BUNDLE);
    }
    await verify("expanded");
    for (const [bundle, tab] of [[0, 0], [BUNDLE_COUNT - 1, TABS_PER_BUNDLE - 1]]) {
      const selector = `${cardSelector(bundle)} [data-tablist-row="${bundleId(bundle)}::${tab}"] input[type=checkbox]`;
      progress(`${tag}:select-${bundle}`);
      await click(page, selector);
      await waitFor(page, `document.querySelector(${JSON.stringify(selector)})?.checked === true`, "endpoint selected");
    }
    await verify("selected");
    const last = BUNDLE_COUNT - 1;
    progress(`${tag}:collapse-overflow`);
    await click(page, `${cardSelector(last)} [data-disclosure-key]`);
    await waitCardRows(page, last, INITIAL_ROWS);
    await verify("collapsed");
    progress(`${tag}:reexpand-overflow`);
    await click(page, `${cardSelector(last)} [data-disclosure-key]`);
    await waitCardRows(page, last, TABS_PER_BUNDLE);
    await verify("reexpanded");
    progress(`${tag}:fold-card`);
    await click(page, `${cardSelector(last)} .item-head-toggle`);
    await waitCardRows(page, last, 0);
    await verify("folded");
    progress(`${tag}:unfold-card`);
    await click(page, `${cardSelector(last)} .item-head-toggle`);
    await waitCardRows(page, last, TABS_PER_BUNDLE);
    await verify("unfolded");
    trials.push({ host, width, phases });
    console.error(`PASS: installed Inbox bundles ${tag}`);
    const tabId = await evaluate(page, "chrome.tabs.getCurrent().then(tab => tab.id)");
    await evaluate(controller, `chrome.tabs.remove(${tabId})`);
    page.client.close(); activePage = null;
  }
} catch (error) {
  failed = true;
  let observed = null;
  let fixtureStores = null;
  if (activePage) {
    try {
      observed = await evaluate(activePage, `({ width: innerWidth, height: innerHeight,
        cards: document.querySelectorAll('${rootSelector} [data-tablist-card]').length,
        rows: document.querySelectorAll('${rootSelector} [data-tablist-row]').length,
        horizontalOverflowNodes: [...document.querySelectorAll('${rootSelector} [data-tablist-card], ${rootSelector} [data-tablist-row]')]
          .filter(node => { const rect = node.getBoundingClientRect(); return rect.left < -1 || rect.right > innerWidth + 1; }).length,
        documentOverflow: document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1,
        selected: document.querySelectorAll('${rootSelector} [data-tablist-row].sel').length,
        checked: document.querySelectorAll('${rootSelector} [data-tablist-row] input[type=checkbox]:checked').length })`);
    } catch {}
  }
  if (controller) {
    try {
      fixtureStores = await evaluate(controller, `(async () => {
        const store = await import(chrome.runtime.getURL('js/lib/store.js'));
        const ids = new Set(${JSON.stringify(Array.from({ length: BUNDLE_COUNT }, (_, index) => bundleId(index)))});
        const [inbox, archive] = await Promise.all([store.listItems('inbox'), store.listItems('archive')]);
        return { inbox: inbox.filter(item => ids.has(item.id)).length,
          archive: archive.filter(item => ids.has(item.id)).length };
      })()`);
    } catch {}
  }
  console.error(JSON.stringify({ failedStage: stage,
    errorClass: ["AssertionError", "Error", "TypeError"].includes(error?.name) ? error.name : "OtherError", observed, fixtureStores }));
} finally {
  const cleanup = { clients: true, browser: false, profile: false };
  for (const session of sessions) { try { session.client.close(); } catch { cleanup.clients = false; } }
  try { browserClient?.close(); } catch { cleanup.clients = false; }
  try { await terminateOwnedChrome(browser); cleanup.browser = true; } catch {}
  if (cleanup.browser) {
    try { if (profile) await rm(profile, { recursive: true, force: true }); cleanup.profile = true; } catch {}
  }
  const clean = Object.values(cleanup).every(Boolean);
  const passed = !failed && clean && trials.length === 4;
  console.log(JSON.stringify({ fixture: "installed-inbox-bundles", passed, bundles: BUNDLE_COUNT,
    tabsPerBundle: TABS_PER_BUNDLE, trials, cleanup,
    limits: ["Side Panel document opened as a tab, not attached browser panel", "CDP pointer input, not OS input",
      "all rows are mounted after expansion; offscreen rows are not claimed simultaneously visible"] }));
  if (!passed) process.exitCode = 1;
}
