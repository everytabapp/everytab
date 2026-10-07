// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Real-extension first-frame and Starred geometry fixture. Uses disposable data only.
 * Run: node tools/check-startup-paint.mjs
 * Output is frame-sampled Chrome evidence, not a hardware performance guarantee.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnOwnedChrome, terminateOwnedChrome } from '../extension/test/chrome-test-process.mjs';
import {
  chromeBin, extensionRoot, SITES, startFixtureServer, debuggingUrl,
  detectExtension, createTarget, evaluate, prepareSession, waitFor,
  seedExpression, captureFixture
} from './capture-store-screenshots.mjs';

const runtimeRoot = process.env.EVERYTAB_STARTUP_EXTENSION_ROOT || extensionRoot;
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = process.env.EVERYTAB_STARTUP_EVIDENCE_DIR
  ? path.resolve(process.env.EVERYTAB_STARTUP_EVIDENCE_DIR)
  : path.join(projectRoot, 'review-evidence/startup-delight');
const profile = await mkdtemp(path.join(tmpdir(), 'everytab-startup-paint-'));
const server = await startFixtureServer();
const mappedHosts = [...new Set(Object.values(SITES).map(({ host }) => host))]
  .map((host) => `MAP ${host} 127.0.0.1`).join(',');
const chrome = spawnOwnedChrome(chromeBin, [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, `--disable-extensions-except=${runtimeRoot}`,
  `--load-extension=${runtimeRoot}`, `--host-resolver-rules=${mappedHosts}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });

const probe = `
window.__startupFrames = [];
let previous = '';
const sample = () => {
  const rect = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return [box.x, box.y, box.width, box.height].map(Math.round);
  };
  const body=document.querySelector('[data-sec=open] .sec-inner'), row=body?.querySelector('.trow');
  const card=row?.closest('[data-tablist-card]');
  let rowVisibleHeight=0;
  if(body && row) {
    const style=getComputedStyle(body), box=body.getBoundingClientRect(), rb=row.getBoundingClientRect();
    const clipBottom=style.clipPath.match(/^inset\\(\\S+ \\S+ ([\\d.]+)%/);
    const paintBottom=box.bottom-(clipBottom?Number(clipBottom[1])/100*box.height:0);
    const cardBox=card?.getBoundingClientRect();
    const clippedCard=card && getComputedStyle(card).overflow!=='visible';
    rowVisibleHeight=Math.max(0,
      Math.min(rb.bottom,paintBottom,clippedCard?cardBox.bottom:Infinity)-
      Math.max(rb.top,box.top,clippedCard?cardBox.top:-Infinity));
  }
  const state = {
    rowVisibleHeight,
    rowHeight:row?.getBoundingClientRect().height ?? 0,
    windowHeight:card?.getBoundingClientRect().height ?? 0,
    windowAnimating:card?.classList.contains('is-window-arriving') ?? false,
    shell: !!document.querySelector('.sidebar'),
    rows: document.querySelectorAll('[data-sec=open] .trow').length,
    rowOpacity: document.querySelector('[data-sec=open] .sec-inner')
      ? Number(getComputedStyle(document.querySelector('[data-sec=open] .sec-inner')).opacity) : null,
    nav: document.querySelectorAll('.navitem').length,
    more: rect('.side-scroll > .nav:last-child'),
    sectionGaps: [...document.querySelectorAll('.side-scroll > .navlabel')].slice(1)
      .map(label => label.getBoundingClientRect().top - label.previousElementSibling.getBoundingClientRect().bottom),
    deck: rect('.minimal-deck'), search: rect('.search-field'),
    starred: document.querySelectorAll('.minimal-launch-item').length,
    hydrating: !!document.querySelector('.is-hydrating-layout'),
    booting: document.body?.classList.contains('booting') || false
  };
  const key = JSON.stringify(state);
  if (key !== previous) { __startupFrames.push({ ms: performance.now(), ...state }); previous = key; }
  if (performance.now() < 1200) requestAnimationFrame(sample);
};
requestAnimationFrame(sample);
`;

// Delay only the optional prefetch boundary, while the real store still reads.
// This verifies that slow optional data cannot become a first-paint dependency.
const slowPrefetch = `
Object.defineProperty(window, '__everyTabNewTabStarred', {
  configurable: true,
  set(state) {
    Object.defineProperty(state, 'items', { get: () => null, set() {} });
    state.ready = state.ready.then((items) => new Promise((resolve) => setTimeout(() => resolve(items), 450)));
    Object.defineProperty(window, '__everyTabNewTabStarred', { configurable: true, writable: true, value: state });
  }
});
`;
const records = [];
let session;
try {
  await mkdir(output, { recursive: true });
  const debugUrl = await debuggingUrl(chrome);
  const id = await detectExtension(debugUrl);
  session = await createTarget(debugUrl, `chrome-extension://${id}/dashboard.html#open`);
  await prepareSession(session);
  await evaluate(session, seedExpression(captureFixture(server.port)));
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: probe });

  for (const reducedMotion of [false, true]) {
    await session.send('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }
    ] });
    for (const mode of ['dashboard', 'minimal']) {
      await evaluate(session, `import(chrome.runtime.getURL('js/lib/store.js')).then(s => s.patchSettings({
        newTabMode: '${mode}', uiScheme: 'matcha', uiInterfaceStyle: 'soft'
      }))`);
      for (let run = 0; run < (process.env.GEOMETRY_ONLY ? 0 : 5); run++) {
        await session.send('Page.navigate', { url: `chrome-extension://${id}/newtab.html` });
        await waitFor(session, 'performance.now() >= 1250', 'startup frame sample');
        const frames = await evaluate(session, '__startupFrames');
        records.push({ mode, reducedMotion, run, frames });
        if (mode === 'minimal') {
          const painted = frames.filter(frame => frame.deck);
          assert.ok(painted.length > 0, 'Minimal paints');
          assert.equal(painted.at(-1).starred, 5, 'five synthetic Starred pages arrive');
          assert.equal(painted[0].starred, 5, 'warm optional read joins the first Minimal frame');
          assert.deepEqual(painted[0].deck, painted.at(-1).deck, 'the resting deck never changes geometry');
          assert.ok(painted.every(frame => !frame.hydrating), 'no needless entrance growth');
        } else {
          assert.ok(frames.some(frame => frame.rows >= 8), 'Dashboard paints live tab rows');
          const navFrames = frames.filter(frame => frame.more);
          assert.ok(navFrames.every(frame => frame.sectionGaps.length===2 && Math.abs(frame.sectionGaps[0]-frame.sectionGaps[1])<.5), 'More follows Saved with matching section spacing during hydration');
        }
      }
    }
    const { identifier } = await session.send('Page.addScriptToEvaluateOnNewDocument', { source: slowPrefetch });
    await session.send('Page.navigate', { url: `chrome-extension://${id}/newtab.html` });
    await waitFor(session, 'performance.now() >= 1250', 'delayed optional data');
    const frames = await evaluate(session, '__startupFrames');
    records.push({ mode: 'minimal-delayed', reducedMotion, frames });
    const painted = frames.filter(frame => frame.deck);
    assert.equal(painted[0].starred, 0, 'Search paints before delayed Starred');
    assert.equal(painted.at(-1).starred, 5, 'delayed Starred still arrives');
    if (reducedMotion) assert.ok(painted.every(frame => !frame.hydrating), 'reduced motion has no hydration transition');
    await evaluate(session, `(() => { const input = document.querySelector('.search-field input'); input.focus(); input.value = 'design'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.equal(await evaluate(session, "document.activeElement === document.querySelector('.search-field input')"), true, 'Search retains keyboard focus');
    await session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }

  await session.send('Page.navigate', { url: `chrome-extension://${id}/dashboard.html#open` });
  await waitFor(session, "document.querySelector('[data-sec=open] .item')", 'Open geometry');
  const geometry = [];
  for (const width of [800, 1024, 1280, 1440, 1920]) {
    await session.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    for (const open of [false, true]) {
      await evaluate(session, `(() => { const edge = document.querySelector('.starred-edge'); if (edge.classList.contains('is-open') !== ${open}) edge.querySelector('button').click(); })()`);
      await evaluate(session, 'new Promise(resolve => setTimeout(resolve, 400))');
      const box = await evaluate(session, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
        const edge = document.querySelector('.starred-edge').getBoundingClientRect();
        const item = document.querySelector('[data-sec=open] .item').getBoundingClientRect();
        resolve({ edgeLeft: edge.left, itemRight: item.right, gap: edge.left - item.right });
      })))`);
      geometry.push({ width, open, ...box });
      assert.ok(box.gap >= 0, `Starred does not overlap the list at ${width}px (${open ? 'open' : 'closed'}): ${JSON.stringify(box)}`);
    }
  }
  // Native Chrome zoom, not a CSS transform or a screenshot scale.
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 800, deviceScaleFactor: 1, mobile: false });
  const zoom = await evaluate(session, `(async () => {
    const tab = await chrome.tabs.getCurrent();
    await chrome.tabs.setZoom(tab.id, 2);
    await new Promise(resolve => setTimeout(resolve, 150));
    const route = document.querySelector('.side-scroll > .nav:last-child button:last-child');
    route.focus(); route.scrollIntoView({ block: 'nearest' });
    await new Promise(resolve => requestAnimationFrame(resolve));
    const routeBox = route.getBoundingClientRect();
    const scrollBox = document.querySelector('.side-scroll').getBoundingClientRect();
    const footer = document.querySelector('.side-foot').getBoundingClientRect();
    return { factor: await chrome.tabs.getZoom(tab.id), width: innerWidth, height: innerHeight,
      focused: document.activeElement === route, routeBounds: [routeBox.top, routeBox.bottom], scrollBounds: [scrollBox.top, scrollBox.bottom],
      // Native scroll offsets round to device pixels at 200% zoom.
      routeVisible: routeBox.top >= scrollBox.top - .5 && routeBox.bottom <= scrollBox.bottom + .5,
      footerVisible: footer.top >= 0 && footer.bottom <= innerHeight };
  })()`);
  assert.equal(zoom.factor, 2, 'real browser zoom is 200%');
  assert.ok(zoom.focused && zoom.routeVisible && zoom.footerVisible, 'More routes and footer remain reachable at 200% zoom');
  await writeFile(path.join(output, process.env.GEOMETRY_ONLY ? 'geometry-zoom.json' : 'verification.json'), JSON.stringify({
    capturedAt: new Date().toISOString(), browser: chromeBin,
    fixture: '10 synthetic live pages in two windows, 5 Starred pages; disposable Chrome profile',
    viewport: '1280 x 800; geometry also checked at 800, 1024, 1440, 1920',
    records, geometry, zoom
  }, null, 2));
  console.log(`PASS: ${records.filter(record => Number.isInteger(record.run)).length} startup samples, delayed-data and reduced-motion checks, keyboard Search, 10 Starred geometry checks, 200% native zoom`);
} finally {
  session?.close();
  await terminateOwnedChrome(chrome);
  await server.close();
  await rm(profile, { recursive: true, force: true });
}
