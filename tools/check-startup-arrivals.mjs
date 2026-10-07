// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Mounted startup cues: truthful pending counts, one arrival, no replay. */
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

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.resolve(root, process.env.EVERYTAB_STARTUP_OUTPUT || 'review-evidence/startup-cohesion-v0.8.600');
const baseline = process.env.EVERYTAB_STARTUP_BASELINE === '1';
const profile = await mkdtemp(path.join(tmpdir(), 'everytab-startup-arrivals-'));
const server = await startFixtureServer();
const mapped = [...new Set(Object.values(SITES).map(({ host }) => host))]
  .map(host => `MAP ${host} 127.0.0.1`).join(',');
const chrome = spawnOwnedChrome(chromeBin, [
  ...(process.env.EVERYTAB_STARTUP_HEADED ? [] : ['--headless=new']), '--disable-gpu', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, `--disable-extensions-except=${extensionRoot}`,
  `--load-extension=${extensionRoot}`, `--host-resolver-rules=${mapped}`,
  '--no-first-run', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-networking', '--disable-component-update', 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });

const inspectStartup = `
window.__arrivalCalls = []; window.__arrivalAnimations = [];
window.__arrivalErrors = { errors: 0, rejections: 0 };
addEventListener('error', () => { __arrivalErrors.errors++; });
addEventListener('unhandledrejection', () => { __arrivalErrors.rejections++; });
window.__initialCounts = null; window.__pendingFrames=[];
function samplePending() {
  const slots=[...document.querySelectorAll('.startup-count[data-startup-pending]')].map(node=>{
    const style=getComputedStyle(node,'::before'), line=Number.parseFloat(style.lineHeight);
    const offset=new DOMMatrixReadOnly(style.transform==='none'?undefined:style.transform).m42;
    return {target:node.className,text:node.textContent,hidden:node.getAttribute('aria-hidden'),content:style.content,
      transform:style.transform,line,offset,digit:Math.round(-offset/line)%10,playState:style.animationPlayState,
      duration:style.animationDuration,animation:style.animationName,color:getComputedStyle(node).color,reelColor:style.color,buttonColor:node.closest('.navitem.active')?getComputedStyle(node.closest('.navitem.active')).color:null,
      boxHeight:node.getBoundingClientRect().height,overflow:getComputedStyle(node).overflow,summary:!!node.closest('.open-heading-count')};
  });
  if(slots.length)__pendingFrames.push({ms:performance.now(),slots});
  if(performance.now()<1800)requestAnimationFrame(samplePending);
}
requestAnimationFrame(samplePending);
const nativeAnimate = Element.prototype.animate;
Element.prototype.animate = function(frames, options) {
  const animation = nativeAnimate.call(this, frames, options);
  if (this.matches('.startup-count, .startup-count-value, .page-attention, [data-sec=open] .sec-inner')) {
    const node=this, entry={ms:performance.now(),target:this.className,text:this.textContent.slice(0,80),duration:options.duration,frames,samples:[]};
    __arrivalCalls.push(entry);
    if(location.search.includes('hold')) { animation.pause(); __arrivalAnimations.push(animation); }
    function sample() {
      const style=getComputedStyle(node), slot=node.closest('.startup-count');
      entry.samples.push({ms:performance.now(),connected:node.isConnected,playState:animation.playState,time:animation.currentTime,
        display:style.display,opacity:style.opacity,transform:style.transform,clip:style.clipPath,height:node.getBoundingClientRect().height,
        slotOverflow:slot?getComputedStyle(slot).overflow:null,
        pendingTransform:slot?getComputedStyle(slot,'::before').transform:null,
        pendingOpacity:slot?getComputedStyle(slot,'::before').opacity:null});
      if(performance.now()-entry.ms<entry.duration+34)requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  }
  return animation;
};
new MutationObserver(() => {
  if (__initialCounts || !document.querySelector('.sidebar')) return;
  __initialCounts = {
    nav: [...document.querySelectorAll('.sidebar [data-startup-pending]')].map(n => ({text:n.textContent,hidden:n.getAttribute('aria-hidden')})),
    star: document.querySelector('.starred-edge-count')?.textContent,
    starName: document.querySelector('.starred-edge-toggle')?.getAttribute('aria-label'),
    heading: document.querySelector('[data-sec=open] h2')?.textContent,
    headingHeight:document.querySelector('[data-sec=open] h2')?.getBoundingClientRect().height,
    summarySlots:document.querySelectorAll('.open-heading-count .startup-count').length,summaryText:document.querySelector('.open-heading-count')?.textContent
  };
}).observe(document, { childList:true, subtree:true });
// Hold only Chrome's live-window response. The shell, Search and saved reads
// retain their normal asynchronous behavior; no product test hook is added.
const nativeWindows = chrome.windows.getAll.bind(chrome.windows);
chrome.windows.getAll = (...args) => nativeWindows(...args).then(result =>
  new Promise(resolve => setTimeout(() => resolve(result), location.search.includes('reel')?1600:450)));
`;
let session;
const results = [];
const runtimeChecks = [];
async function checkRuntimeErrors(phase) {
  const counts = await evaluate(session, 'window.__arrivalErrors');
  assert.deepEqual(counts, { errors: 0, rejections: 0 }, `${phase}: runtime error/rejection counts must be zero`);
  runtimeChecks.push({ phase, ...counts });
}
try {
  await mkdir(output, { recursive: true });
  const debug = await debuggingUrl(chrome), id = await detectExtension(debug);
  session = await createTarget(debug, `chrome-extension://${id}/dashboard.html#open`);
  await prepareSession(session);
  const fixture = captureFixture(server.port);
  fixture.windows[0].push('mdnStorage'); // One duplicate supplies a real attention entry.
  await evaluate(session, seedExpression(fixture));
  await session.send('Emulation.setDeviceMetricsOverride', { width:1920, height:900, deviceScaleFactor:1, mobile:false });
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: inspectStartup });
  for (const reduced of [false, true]) {
    await session.send('Emulation.setEmulatedMedia', { features:[{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}] });
    await session.send('Page.bringToFront');
    await session.send('Page.navigate', { url:`chrome-extension://${id}/dashboard.html?arrival-fixture=${reduced}#open` });
    try { await waitFor(session, 'window.__initialCounts', 'pending Dashboard shell'); }
    catch {
      console.error(await evaluate(session, '({errors:window.__arrivalErrors,ready:document.readyState,initialObserved:!!window.__initialCounts})'));
      throw new Error('Pending Dashboard shell did not appear');
    }
    const pending = await evaluate(session, '__initialCounts');
    assert.equal(pending.nav.length, 8, 'all counted navigation routes have a pending slot');
    assert.ok(pending.nav.every(n => n.text === '' && n.hidden === 'true'), 'pending counts never invent a number');
    assert.equal(pending.star, '', 'Starred does not first show a false zero');
    assert.ok(!pending.starName.includes('0'), 'pending Starred accessible name does not claim zero');
    assert.ok(!pending.heading.includes('…'), 'Open heading never displays an ellipsis');
    assert.equal(pending.summarySlots,2,'summary presents separate tab/window reels');
    assert.equal(pending.summaryText,'Open tabs ( in  windows)','summary wording is already in its final position while numbers are pending');
    const keyboard = await evaluate(session, `(() => {
      const input=document.querySelector('.search-field input');input.focus();input.value='ready';
      return document.activeElement===input && input.value==='ready';
    })()`);
    assert.ok(keyboard, 'Search accepts keyboard input while window data is pending');
    await waitFor(session, "document.querySelectorAll('[data-sec=open] .trow').length >= 10 && document.querySelector('.page-attention:not([hidden])') && !document.querySelector('.sidebar [data-startup-pending]')", 'true counts and attention');
    await evaluate(session, 'new Promise(resolve => setTimeout(resolve, 220))');
    const settled = await evaluate(session, `({ errors:__arrivalErrors,calls:__arrivalCalls, pendingFrames:__pendingFrames, heading:document.querySelector('[data-sec=open] h2').textContent,
      headingHeight:document.querySelector('[data-sec=open] h2').getBoundingClientRect().height,
      count:document.querySelector('.sidebar [data-page=open] .n').textContent,
      star:document.querySelector('.starred-edge-count').textContent,
      selected:document.activeElement===document.querySelector('.search-field input') })`);
    await checkRuntimeErrors(reduced ? 'reduced-settlement' : 'normal-settlement');
    assert.equal(settled.headingHeight,pending.headingHeight,'pending reel reserves the same heading line height as the real count');
    assert.equal(settled.star, '5', 'Starred resolves to its actual count');
    assert.ok(settled.heading.includes(settled.count) && settled.heading.includes('windows'), 'Open heading contains its true tab/window summary');
    assert.ok(settled.selected, 'async data and cue preserve keyboard focus');
    if (!baseline && reduced) assert.equal(settled.calls.length,0,'reduced motion presents final values immediately');
    else if (!baseline) {
      assert.equal(settled.calls.filter(c=>c.target==='page-attention').length,1,'late activity receives one arrival');
      assert.ok(settled.calls.filter(c=>c.target.includes('startup-count')).length>=9,'true counts roll in');
      const pendingReel=settled.pendingFrames.flatMap(f=>f.slots.filter(n=>n.summary));
      await writeFile(path.join(output,'startup-diagnostic.json'),JSON.stringify(settled,null,2));
      assert.ok(new Set(pendingReel.map(n=>n.digit)).size>=3,'pending heading visibly rolls through at least three digits before truth arrives');
      assert.ok(pendingReel.every(n=>n.boxHeight<22 && n.overflow==='clip'),'summary reels stay clipped to a compact text line');
      const selectedReels=settled.pendingFrames.flatMap(f=>f.slots.filter(n=>n.buttonColor));
      assert.ok(selectedReels.length>0 && selectedReels.every(n=>n.reelColor===n.buttonColor && n.color===n.buttonColor),'selected Open reel inherits selected text color throughout pending frames');
      assert.ok(settled.calls.filter(c=>c.target==='startup-count-value').every(c=>/^\d+$/.test(c.text)),'only numeric slots move, never the summary phrase');
      assert.ok(pendingReel.every(n=>n.text==='' && n.hidden==='true' && !n.content.includes('…')),'visual digits never become semantic counts');
      const counts=settled.calls.filter(c=>c.target==='startup-count-value');
      assert.ok(counts.length>=9 && counts.every(c=>c.duration===180), 'count lines use the existing180ms continuity token');
      for(const count of counts) {
        const intermediate=count.samples.filter(s=>s.connected && +s.opacity>0 && +s.opacity<1);
        assert.ok(intermediate.length>=3, 'each count has several attached intermediate rendered frames');
        assert.ok(intermediate.every(s=>s.display==='block' && s.slotOverflow==='clip'), 'the moving count is a block inside a clipped line');
        assert.ok(intermediate.some(s=>Number(s.transform.match(/matrix\(.*?, ([\d.-]+)\)$/)?.[1])>1), 'actual count moves by more than one pixel in intermediate frames');
        assert.ok(intermediate.some(s=>s.pendingTransform!=='none' && +s.pendingOpacity>0 && +s.pendingOpacity<1), 'outgoing reel visibly rolls away');
      }
      assert.equal(settled.calls.find(c=>c.target==='page-attention').duration,140,'activity keeps its quiet140ms lift');
    }
    const before = settled.calls.length;
    await evaluate(session, "chrome.tabs.create({url:'about:blank',active:false})");
    await waitFor(session, `Number(document.querySelector('.sidebar [data-page=open] .n').textContent) > ${Number(settled.count)}`, 'fresh live count after ordinary tab event');
    const hiddenAfterSettings = await evaluate(session, `(async () => {
      const wasHidden = document.body.classList.contains('hide-taglines');
      const store = await import(chrome.runtime.getURL('js/lib/store.js'));
      await store.patchSettings({ uiSectionIntros: wasHidden });
      return !wasHidden;
    })()`);
    await waitFor(session, `document.body.classList.contains('hide-taglines') === ${hiddenAfterSettings}`, 'ordinary settings storage event');
    await evaluate(session, 'new Promise(resolve => setTimeout(resolve, 750))');
    const replayCount = await evaluate(session,'__arrivalCalls.length');
    assert.equal(replayCount,before,'ordinary storage/tab churn does not replay startup cues');
    await checkRuntimeErrors(reduced ? 'reduced-refresh' : 'normal-refresh');
    results.push({reduced,pending,settled,replayCount});
  }
  // A preference change during a cue must also expose the settled content.
  await session.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await evaluate(session, `(async()=>{
    const {createStartupArrival}=await import(chrome.runtime.getURL('js/ui/startup-arrival.js'));
    window.__testArrival=createStartupArrival();const n=__testArrival.pendingCount();n.id='arrival-preference-probe';
    n.style.setProperty('--motion-continuity','10000ms');document.body.append(n);
    __testArrival.settleCount(n,42,'preference-change');
  })()`);
  await session.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await waitFor(session,"document.querySelector('#arrival-preference-probe').getAnimations({subtree:true}).length===0",'live reduced-motion preference');
  assert.equal(await evaluate(session,"document.querySelector('#arrival-preference-probe').textContent"),'42','preference change preserves final truth');
  await evaluate(session,'__testArrival.destroy();document.querySelector("#arrival-preference-probe").remove()');
  await checkRuntimeErrors('preference-change');
  if(!baseline) {
    await session.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    const continuation=await evaluate(session, `(async()=>{
      const {createStartupArrival}=await import(chrome.runtime.getURL('js/ui/startup-arrival.js'));
      const arrival=createStartupArrival(), first=arrival.pendingCount();document.body.append(first);
      arrival.settleCount(first,7,'replaced');
      await new Promise(r=>setTimeout(r,70));
      const replacement=arrival.pendingCount();first.replaceWith(replacement);arrival.settleCount(replacement,7,'replaced');
      const animation=replacement.querySelector('.startup-count-value').getAnimations()[0];
      const continuedAt=animation.currentTime;
      await new Promise(r=>setTimeout(r,140));
      const final={text:replacement.textContent,animations:replacement.getAnimations({subtree:true}).length,rolling:replacement.hasAttribute('data-startup-rolling')};
      arrival.settleCount(replacement,8,'replaced');
      const replay=replacement.getAnimations({subtree:true}).length;
      arrival.destroy();replacement.remove();
      const warmArrival=createStartupArrival(),warmNode=warmArrival.pendingCount();document.body.append(warmNode);
      warmArrival.settleCount(warmNode,42,'warm');
      const warm={text:warmNode.textContent,pending:warmNode.hasAttribute('data-startup-pending'),hidden:warmNode.getAttribute('aria-hidden')};
      const summary=warmArrival.pendingSummary(['Open tabs (',' in ',' windows)'],'open-heading-count');document.body.append(summary);
      warmArrival.settleSummary(summary,'Open tabs (1,234 in 1 window)','summary');
      const summaryResult={text:summary.textContent,numbers:[...summary.querySelectorAll('.startup-count-value')].map(n=>n.textContent),hidden:summary.getAttribute('aria-hidden')};
      warmArrival.settleSummary(summary,'Open tabs (١٬٢٣٤ in ٢ windows)','summary');
      const localizedResult={text:summary.textContent,numbers:[...summary.querySelectorAll('.startup-count-value')].map(n=>n.textContent)};
      warmArrival.settleSummary(summary,'Open tabs ready','summary');
      const fallback=summary.textContent;
      warmArrival.destroy();warmNode.remove();summary.remove();
      return {continuedAt,final,replay,warm,summaryResult,localizedResult,fallback};
    })()`);
    assert.ok(continuation.continuedAt>=60 && continuation.continuedAt<150,'replacement resumes elapsed time instead of starting a new roll');
    assert.deepEqual(continuation.final,{text:'7',animations:0,rolling:false},'continued count settles within original deadline and cleans up');
    assert.equal(continuation.replay,0,'later value changes never restart the roll');
    assert.deepEqual(continuation.warm,{text:'42',pending:false,hidden:null},'warm data is synchronously available without waiting for the reel');
    assert.deepEqual(continuation.summaryResult,{text:'Open tabs (1,234 in 1 window)',numbers:['1,234','1'],hidden:null},'known summary publishes grouped numbers and singular wording synchronously');
    assert.deepEqual(continuation.localizedResult,{text:'Open tabs (١٬٢٣٤ in ٢ windows)',numbers:['١٬٢٣٤','٢']},'localized grouped digits preserve exact source text');
    assert.equal(continuation.fallback,'Open tabs ready','unexpected nonnumeric wording remains readable as a static heading');
    await checkRuntimeErrors('continuation-and-localized-summary');
    results.push({continuation});
    await session.send('Page.navigate',{url:`chrome-extension://${id}/dashboard.html?reel=1#open`});
    await waitFor(session,"document.querySelector('.open-heading-count [data-startup-pending]') && performance.now()>180",'native pending digit reel');
    const ax=await session.send('Accessibility.getFullAXTree');
    const pendingHeading=ax.nodes.find(n=>n.role?.value==='heading' && n.name?.value?.startsWith('Open tabs'))?.name.value;
    assert.equal(pendingHeading?.trim(),'Open tabs','decorative digits do not enter the actual accessibility heading');
    const nativeFrames=[];
    for(let index=1;index<=3;index++) {
      const state=await evaluate(session,"__pendingFrames.at(-1)");
      const shot=await session.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      await writeFile(path.join(output,`pending-native-${index}.png`),Buffer.from(shot.data,'base64'));
      nativeFrames.push(state);
      await evaluate(session,'new Promise(resolve=>setTimeout(resolve,120))');
    }
    assert.ok(new Set(nativeFrames.map(f=>f.slots.find(n=>n.summary)?.digit)).size>=2,'native screenshots capture distinct digits while data is still pending');
    results.push({pendingHeading,nativeFrames,headed:!!process.env.EVERYTAB_STARTUP_HEADED});
    await waitFor(session,"!document.querySelector('.open-heading-count [data-startup-pending]')",'real count after native reel samples');
    await checkRuntimeErrors('native-reel-and-accessibility');
    await evaluate(session,`(async()=>{
      const {createStartupArrival}=await import(chrome.runtime.getURL('js/ui/startup-arrival.js'));
      window.__reelLife=createStartupArrival();window.__reelNode=__reelLife.pendingCount();document.body.append(__reelNode);
    })()`);
    await waitFor(session,"new DOMMatrixReadOnly(getComputedStyle(__reelNode,'::before').transform).m42 < -5",'pending reel has visibly advanced before hiding');
    const background=await createTarget(debug,'about:blank');
    await background.send('Page.enable');await background.send('Page.bringToFront');
    await waitFor(session,"document.visibilityState==='hidden' && getComputedStyle(__reelNode,'::before').animationPlayState==='paused'",'hidden reel pauses');
    const pauseBefore=await evaluate(session,"getComputedStyle(__reelNode,'::before').transform");
    await new Promise(resolve=>setTimeout(resolve,180));
    const pauseAfter=await evaluate(session,"getComputedStyle(__reelNode,'::before').transform");
    assert.equal(pauseAfter,pauseBefore,'hidden reel holds its exact rendered position');
    assert.ok(!pauseBefore.endsWith(', 0, 0)'),'pause check holds an already advanced reel');
    await session.send('Page.bringToFront');
    await waitFor(session,"document.visibilityState==='visible' && getComputedStyle(__reelNode,'::before').animationPlayState==='running'",'visible reel resumes');
    await waitFor(session,`getComputedStyle(__reelNode,'::before').transform !== ${JSON.stringify(pauseAfter)}`,'visible reel actually advances again');
    await session.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    const neutral=await evaluate(session,"({content:getComputedStyle(__reelNode,'::before').content,animation:getComputedStyle(__reelNode,'::before').animationName,height:getComputedStyle(__reelNode,'::before').height,hidden:__reelNode.getAttribute('aria-hidden')})");
    assert.deepEqual(neutral,{content:'\"\"',animation:'none',height:'2px',hidden:'true'},'reduced motion uses a neutral bar without digits or ellipsis');
    await session.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    const cleanup=await evaluate(session,`(()=>{
      __reelLife.destroy();const stopped=getComputedStyle(__reelNode,'::before').animationName;
      __reelNode.remove();return stopped;
    })()`);
    assert.equal(cleanup,'none','destroy removes pending loop');
    await checkRuntimeErrors('visibility-preference-and-cleanup');
    background.close();results.push({pauseBefore,pauseAfter,neutral,cleanup});
    const selectedColors=await evaluate(session,`(async()=>{
      const {createStartupArrival}=await import(chrome.runtime.getURL('js/ui/startup-arrival.js'));
      const arrival=createStartupArrival(),root=document.documentElement,priorScheme=root.dataset.scheme,priorMode=root.dataset.mode,results=[];
      const button=document.querySelector('.sidebar .navitem.active'),priorCount=button.querySelector('.startup-count'),count=arrival.pendingCount();
      priorCount.replaceWith(count);
      for(const scheme of ['cream','matcha','sunset'])for(const mode of ['light','dark']) {
        root.dataset.scheme=scheme;root.dataset.mode=mode;
        await new Promise(resolve=>setTimeout(resolve,120));
        results.push({scheme,mode,button:getComputedStyle(button).color,reel:getComputedStyle(count,'::before').color});
      }
      count.replaceWith(priorCount);arrival.destroy();root.dataset.scheme=priorScheme;root.dataset.mode=priorMode;return results;
    })()`);
    assert.ok(selectedColors.every(c=>c.button===c.reel),'selected reel uses settled selected text color in three light/dark schemes');
    assert.ok(new Set(selectedColors.map(c=>c.button)).size>1,'color matrix exercises different computed inks');
    await checkRuntimeErrors('selected-color-matrix');
    results.push({selectedColors});

    await session.send('Page.navigate',{url:`chrome-extension://${id}/dashboard.html?hold=1#open`});
    await waitFor(session,"document.querySelectorAll('[data-sec=open] .trow').length>=10 && !document.querySelector('.sidebar [data-startup-pending]')",'held arrival for rendered screenshots');
    for(const ms of [0,60,110,180]) {
      await evaluate(session,`(() => {
        for(const animation of document.getAnimations()) {
          if(animation.effect?.target?.matches('.startup-count, .startup-count-value, .page-attention, [data-sec=open] .sec-inner')) {
            animation.pause();animation.currentTime=${ms};
          }
        }
      })()`);
      const shot=await session.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      await writeFile(path.join(output,`startup-frame-${String(ms).padStart(3,'0')}.png`),Buffer.from(shot.data,'base64'));
    }
    await checkRuntimeErrors('held-rendered-frames');
  }
  await checkRuntimeErrors('final');
  await writeFile(path.join(output,baseline?'startup-before.json':'startup-mounted.json'),JSON.stringify({browser:chromeBin,recordedAt:new Date().toISOString(),results,runtimeChecks},null,2));
  console.log('PASS: truthful pending counts, continuous pending digit reels and180ms true-value settlement,140ms activity, reduced motion and preference change, immediate keyboard input, no refresh replay');
} finally {
  session?.close();await terminateOwnedChrome(chrome);await server.close();await rm(profile,{recursive:true,force:true});
}
