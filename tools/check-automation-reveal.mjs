// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Native CSS/controller regression for a refresh interrupting an automation fade. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanupInboxMeasurement } from './testing/inbox-measurement-cleanup.mjs';
import { CHROME_FIXTURE_ARGS, spawnOwnedChrome, terminateOwnedChrome } from '../extension/test/chrome-test-process.mjs';
import { chromeBin, extensionRoot, debuggingUrl, detectExtension, createTarget,
  CdpClient, evaluate, prepareSession } from './capture-store-screenshots.mjs';

/**
 * Operation label, error class and the first line of the message with URLs,
 * quoted values and paths removed, capped at 160 characters. The fixture
 * renders only synthetic rows, but a summary must never echo page text.
 */
function fixtureFailureDetail(operationLabel, error) {
  const errorClass = error?.constructor?.name ?? typeof error;
  const message = String(error?.message ?? '').split('\n')[0]
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/(["'`])[^"'`]*\1/g, '<value>')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s]*[\\/][^\s]*/g, '<path>')
    .replace(/[^\w .:,()<>=-]/g, '')
    .slice(0, 160);
  return `operation=${operationLabel} class=${errorClass} message=${message || 'none'}`;
}

const profile = await mkdtemp(path.join(tmpdir(), 'everytab-automation-reveal-'));
let browser, client, page, manager;
let stage = 'setup';
// Last fixture operation started; reported on failure with an allowlisted
// summary so hosted-runner failures are diagnosable without page content.
let operation = 'launch';
const receipt = { cases: [] };
const pause = ms => evaluate(page, `new Promise(resolve => setTimeout(resolve, ${ms}))`);
const pointer = (x, y) => page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
try {
  browser = spawnOwnedChrome(chromeBin, [...CHROME_FIXTURE_ARGS, '--headless=new', '--disable-gpu',
    // Hosted Ubuntu restricts the unprivileged user namespaces Chrome's
    // sandbox needs; CI opts out explicitly, as every other browser suite does.
    ...(process.env.EVERYTAB_CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    '--remote-debugging-port=0', '--enable-unsafe-extension-debugging',
    '--disable-background-networking', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  operation = 'debugging-endpoint';
  const debug = await debuggingUrl(browser);
  client = new CdpClient(debug);
  operation = 'browser-version';
  receipt.browser = (await client.send('Browser.getVersion')).product;
  operation = 'extensions-page';
  manager = await createTarget(debug, 'chrome://extensions');
  await prepareSession(manager);
  operation = 'developer-mode';
  await evaluate(manager, 'chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })');
  operation = 'load-unpacked';
  await client.send('Extensions.loadUnpacked', { path: extensionRoot });
  operation = 'detect-extension';
  const id = await detectExtension(debug);
  operation = 'dashboard-page';
  page = await createTarget(debug, `chrome-extension://${id}/dashboard.html`);
  await prepareSession(page);
  receipt.version = await evaluate(page, 'chrome.runtime.getManifest().version');
  operation = 'mount-fixture';
  await evaluate(page, `(async () => {
    const { createAutomationAwareness } = await import('./js/ui/automation-awareness.js');
    globalThis.revealOwner = createAutomationAwareness({ openSettings() {} });
    globalThis.revealHost = document.createElement('div');
    revealHost.className = 'tablist';
    revealHost.style = 'position:fixed;inset:100px 100px auto;z-index:100000;background:white';
    document.body.append(revealHost);
    globalThis.revealView = { display:'timed', action:'autosave', state:'running',
      afterMs:86400000, awayMs:3600000, progress:0.04 };
    // Mount the real cached control into a replacement shell, as Open rendering does.
    globalThis.mountReveal = (kind, keyboard = false) => revealOwner.withRowRender(() => {
      const row = document.createElement('div');
      row.className = kind === 'row' ? 'trow' + (keyboard ? ' kbd-reveal' : '') : 'item';
      row.style = 'height:60px';
      const sub = document.createElement('div');
      sub.className = 'row-subline';
      if (kind === 'row') { row.append(sub); sub.append(revealOwner.row(revealView, 42)); }
      else row.append(revealOwner.inbox({ display:'rule', afterMs:86400000 }, 'fixture'));
      revealHost.replaceChildren(row);
    });
    globalThis.sampleReveal = () => {
      const node = revealHost.querySelector('.automation-awareness');
      return { opacity:+getComputedStyle(node).opacity,
        bridge:node.matches('.is-rejoining, .is-remounting') };
    };
  })()`);
  operation = 'interaction';
  for (const reduced of [false, true]) {
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name:'prefers-reduced-motion', value:reduced ? 'reduce' : 'no-preference' }]
    });
    for (const kind of ['row', 'inbox']) {
      stage = `${kind}-${reduced ? 'reduced' : 'normal'}`;
      await pointer(20, 20);
      await evaluate(page, `mountReveal('${kind}')`);
      await pause(250);
      assert.equal((await evaluate(page, 'sampleReveal()')).opacity, 0, 'idle control is hidden');
      await pointer(200, 120);
      await pause(250);
      assert.equal((await evaluate(page, 'sampleReveal()')).opacity, 1, 'pointer reveals control');
      await evaluate(page, `mountReveal('${kind}')`);
      await pause(80);
      assert.deepEqual(await evaluate(page, 'sampleReveal()'), { opacity:1, bridge:false },
        'stationary pointer survives the mount and releases temporary classes');
      await pointer(20, 20);
      const observation = await evaluate(page, `new Promise(resolve => {
        const samples = [], start = performance.now();
        const node = revealHost.querySelector('.automation-awareness');
        // Pin a real CSS transition inside its fade. This avoids requiring a
        // particular machine to catch the short >.5 opacity interval on a frame.
        getComputedStyle(node).opacity;
        const fade = node.getAnimations().find(a => a.transitionProperty === 'opacity');
        if (fade) { fade.pause(); fade.currentTime = 10; }
        const before = +getComputedStyle(node).opacity;
        mountReveal('${kind}');
        function sample() {
          samples.push(sampleReveal());
          if (performance.now() - start < 250) requestAnimationFrame(sample);
          else resolve({ before, hadFade:!!fade, samples });
        }
        sample();
      })`);
      if (reduced) assert.equal(observation.hadFade, false, 'reduced motion has no transition');
      else {
        assert.equal(observation.hadFade, true, 'test exercises the native opacity transition');
        assert.ok(observation.before > .5 && observation.before < .99, 'refresh interrupts a partial fade');
      }
      assert.ok(observation.samples.every(s => s.opacity <= observation.before + .03),
        'refresh must not brighten a departing indicator again');
      assert.deepEqual(observation.samples.at(-1), { opacity:0, bridge:false },
        'departed control stays hidden and releases mount classes');
      receipt.cases.push({ stage, ...observation });
    }
    stage = `keyboard-${reduced ? 'reduced' : 'normal'}`;
    await evaluate(page, "mountReveal('row', true)");
    await pause(250);
    assert.equal((await evaluate(page, 'sampleReveal()')).opacity, 1, 'keyboard reveal remains visible');
    await evaluate(page, "mountReveal('row', true)");
    await pause(80);
    assert.deepEqual(await evaluate(page, 'sampleReveal()'), { opacity:1, bridge:false });
    await evaluate(page, "revealHost.querySelector('.trow').classList.remove('kbd-reveal')");
    await pause(250);
    assert.equal((await evaluate(page, 'sampleReveal()')).opacity, 0);
    await evaluate(page, "revealHost.querySelector('.automation-awareness').focus()");
    await pause(250);
    assert.equal((await evaluate(page, 'sampleReveal()')).opacity, 1, 'focus reveals the real control');
    await evaluate(page, 'document.activeElement.blur()');
    receipt.cases.push({ stage, keyboardReveal:true, focusReveal:true });
  }
  // Exercise the production list builder as well as the cached-control shell.
  await evaluate(page, `(async () => {
    const { createTabList, clearSelection } = await import('./js/ui/tablist.js');
    globalThis.clearRevealSelection = () => clearSelection('open');
    globalThis.mountOpenReveal = (awareness = true) => revealOwner.withRowRender(() => {
      const root = createTabList({ section:'open', selectable:'tab',
        groups:[{ id:'reveal-fixture', loose:true, refs:[
          { title:'Synthetic first tab', url:'https://fixture.example/first', labels:[] },
          { title:'Synthetic second tab', url:'https://fixture.example/second', labels:[] }
        ] }], rowActions:[{ id:'fixture', label:'Fixture action', run() {} }],
        rowSupplement:awareness ? ctx => revealOwner.row(revealView, 100 + ctx.index) : null
      });
      revealHost.replaceChildren(root);
    });
    globalThis.sampleOpenReveal = () => {
      const row = revealHost.querySelector('.trow');
      const awareness = row.querySelector('.automation-awareness');
      return { color:getComputedStyle(row).backgroundColor, hover:row.matches(':hover'),
        selected:row.classList.contains('sel'), actions:+getComputedStyle(row.querySelector('.tacts')).opacity,
        awareness:awareness ? +getComputedStyle(awareness).opacity : null };
    };
  })()`);
  for (const reduced of [false, true]) {
    await page.send('Emulation.setEmulatedMedia', {
      features:[{ name:'prefers-reduced-motion', value:reduced ? 'reduce' : 'no-preference' }]
    });
    for (const style of ['soft', 'crisp', 'terminal']) {
      for (const selected of [false, true]) {
        stage = `open-${style}-${reduced ? 'reduced' : 'normal'}-${selected ? 'selected' : 'idle'}`;
        await pointer(20, 20);
        await evaluate(page, `clearRevealSelection(); document.documentElement.dataset.interfaceStyle='${style}'; mountOpenReveal();`);
        if (selected) await evaluate(page, "revealHost.querySelector('.trow input').click(); document.activeElement.blur()");
        const point = await evaluate(page, `(() => {const r=revealHost.querySelector('.trow').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        await pointer(point.x, point.y); await pause(250);
        const result = await evaluate(page, `new Promise(resolve => {
          const before=sampleOpenReveal(); mountOpenReveal(); const samples=[], start=performance.now();
          function sample(){ samples.push(sampleOpenReveal());
            if(performance.now()-start<180)requestAnimationFrame(sample);else resolve({before,samples}); }
          requestAnimationFrame(sample);
        })`);
        assert.equal(result.before.hover, true, 'fixture begins with native hover');
        assert.equal(result.before.awareness, 1, 'fixture uses a revealed timed indicator');
        // A first RAF can run before Chrome assigns hover to the new shell.
        // Once assigned, even its first style sample must already be settled.
        const firstHovered = result.samples.findIndex(s => s.hover);
        assert.ok(firstHovered >= 0 && firstHovered <= 1, 'native hover settles by the second frame');
        assert.ok(result.samples.slice(firstHovered).every(s => s.hover && s.color === result.before.color &&
          s.selected === selected && s.actions === 1 && s.awareness === 1),
          'replacement must retain hovered highlight, selection, actions and timed indicator');
        assert.equal(await evaluate(page, "revealHost.querySelector('[data-tablist]').classList.contains('is-mounting')"), false,
          'mount suppression is released');
        const transitions = await evaluate(page, `['.trow','.tacts','.automation-awareness-row'].map(selector => {const s=getComputedStyle(revealHost.querySelector(selector));return {property:s.transitionProperty,duration:s.transitionDuration};})`);
        if (reduced) assert.ok(transitions.every(s => s.property === 'none' || s.duration.split(',').every(value => parseFloat(value) <= (value.trim().endsWith('ms') ? .001 : .000001))),
          'reduced motion remains suppressed after mount');
        else assert.ok(transitions.every(s => s.property !== 'none'), 'ordinary transition rules resume after mount');
        await pointer(20, 20); await pause(250);
        assert.equal((await evaluate(page, 'sampleOpenReveal()')).awareness, 0, 'pointer leave still hides automation');
        await evaluate(page, "revealHost.querySelector('.trow a').focus()"); await pause(250);
        assert.equal((await evaluate(page, 'sampleOpenReveal()')).awareness, 1, 'keyboard focus still reveals the row');
        await evaluate(page, 'document.activeElement.blur()');
        receipt.cases.push({ stage, frames:result.samples.length, preHoverFrames:firstHovered, continuity:true });
      }
    }
  }
  stage = 'open-without-automation';
  await pointer(20, 20);
  await page.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await evaluate(page, "clearRevealSelection(); document.documentElement.dataset.interfaceStyle='soft'; mountOpenReveal(false)");
  const plainPoint = await evaluate(page, `(() => {const r=revealHost.querySelector('.trow').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await pointer(plainPoint.x, plainPoint.y); await pause(250);
  const plain = await evaluate(page, `new Promise(resolve => {
    const before=sampleOpenReveal();mountOpenReveal(false);const samples=[];
    function sample(){samples.push(sampleOpenReveal());if(samples.length<12)requestAnimationFrame(sample);else resolve({before,samples});}
    requestAnimationFrame(sample);
  })`);
  assert.equal(plain.before.awareness, null, 'fixture has no automation indicator');
  const firstPlainHover = plain.samples.findIndex(s => s.hover);
  assert.ok(firstPlainHover >= 0 && firstPlainHover <= 1);
  assert.ok(plain.samples.slice(firstPlainHover).every(s => s.hover && s.color === plain.before.color && s.actions === 1),
    'row highlight continuity is independent of automation');
  receipt.cases.push({ stage, frames:plain.samples.length, preHoverFrames:firstPlainHover, continuity:true });
} catch (error) {
  console.error(`FAIL automation reveal at ${stage}: ${error instanceof assert.AssertionError
    ? error.message : `fixture operation failed (${fixtureFailureDetail(operation, error)})`}`);
  process.exitCode = 1;
} finally {
  try {
    await cleanupInboxMeasurement({ sessions:[page, manager].filter(Boolean), client, browser, profile }, {
      terminateOwnedChrome, removeProfile: profile => rm(profile, { recursive:true, force:true })
    });
    receipt.cleanup = { browser:true, profile:true };
  } catch {
    console.error('FAIL automation reveal cleanup');
    process.exitCode = 1;
  }
}

if (!process.exitCode) console.log(JSON.stringify(receipt, null, 2));
