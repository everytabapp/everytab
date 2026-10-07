// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Real Focus-strip intermediate-frame fixture. Uses disposable data only.
 * Run: node tools/check-focus-motion.mjs
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

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(projectRoot, 'review-evidence/focus-motion-v0.8.598');
const testedExtensionRoot = process.env.FOCUS_EXTENSION_ROOT || extensionRoot;
const profile = await mkdtemp(path.join(tmpdir(), 'everytab-focus-motion-'));
const server = await startFixtureServer();
const mappedHosts = [...new Set(Object.values(SITES).map(({ host }) => host))]
  .map((host) => `MAP ${host} 127.0.0.1`).join(',');
const chrome = spawnOwnedChrome(chromeBin, [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, `--disable-extensions-except=${testedExtensionRoot}`,
  `--load-extension=${testedExtensionRoot}`, `--host-resolver-rules=${mappedHosts}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });

let session;
try {
  await mkdir(output,{recursive:true});
  const debugUrl=await debuggingUrl(chrome);const id=await detectExtension(debugUrl);
  session=await createTarget(debugUrl,`chrome-extension://${id}/dashboard.html#open`);
  await prepareSession(session);
  await evaluate(session,seedExpression(captureFixture(server.port)));
  await evaluate(session,`import(chrome.runtime.getURL('js/lib/store.js')).then(s=>s.patchSettings({focusMinimizeOtherWindows:false,focusSiteRules:[{domain:"distracting.example",displayDomain:"distracting.example",scope:"focus"}]}))`);
  await session.send('Page.navigate',{url:`chrome-extension://${id}/dashboard.html#open`});
  await waitFor(session,'document.querySelectorAll(".trow").length>3','real Open list');
  await evaluate(session, 'document.querySelector(".ob-head button")?.click()');
  await waitFor(session,'!document.querySelector(".ob-overlay")','tour dismissed before motion trace');
  await new Promise(r=>setTimeout(r,600));
  await session.send('Performance.enable');
  const results=[];
  for(const reduced of [false,true]) {
    await session.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}]});
    for(const action of ['start','refresh','end']) {
      const before=await session.send('Performance.getMetrics');
      const frames=await evaluate(session,`(async()=>{
        const focus=await import(chrome.runtime.getURL('js/ui/focus-strip.js'));
        const frames=[];const began=performance.now();
        const sample=()=>{
          const layout=document.querySelector('.focus-strip-layout'),strip=layout.querySelector('.focus-strip');
          const root=getComputedStyle(document.documentElement),s=getComputedStyle(layout.firstElementChild),stage=document.querySelector(".daily-stage");
          frames.push({ms:performance.now()-began,focusH:layout.getBoundingClientRect().height,
            stripTop:strip.getBoundingClientRect().top,innerH:layout.firstElementChild.getBoundingClientRect().height,
            opacity:s.opacity,clip:s.clipPath,transform:s.transform,followerTransform:getComputedStyle(stage).transform,heroH:document.querySelector('.hero').getBoundingClientRect().height,
            stageTop:document.querySelector('.daily-stage').getBoundingClientRect().top,
            cardTop:document.querySelector('[data-sec=open] .item')?.getBoundingClientRect().top,
            rootLength:root.getPropertyValue('--focus-layout-h'),baseH:root.getPropertyValue('--hero-base-h'),
            transition:document.documentElement.classList.contains('focus-layout-transition')});
          if(performance.now()-began<650)requestAnimationFrame(sample);
        };requestAnimationFrame(sample);
        if('${action}'==='start'){const result=await focus.startFocusGuard({mode:'duration',durationMinutes:30});if(!result.ok)throw new Error('Synthetic Focus start failed: '+result.reason);}
        else if('${action}'==='end')await focus.endFocusGuard();
        else { const store=await import(chrome.runtime.getURL('js/lib/store.js'));await store.patchSettings({uiSectionIntros:true}); }
        await new Promise(r=>setTimeout(r,700));return frames;
      })()`);
      const after=await session.send('Performance.getMetrics');
      const pick=name=>after.metrics.find(m=>m.name===name).value-before.metrics.find(m=>m.name===name).value;
      results.push({reduced,action,metrics:Object.fromEntries(['LayoutCount','RecalcStyleCount','LayoutDuration','RecalcStyleDuration'].map(n=>[n,pick(n)])),frames});
      if (!process.env.FOCUS_BASELINE) {
        const moving=frames.filter(f=>f.transition);
        if (reduced || action==='refresh') {
          assert.ok(frames.every(f=>f.followerTransform==='none' && f.clip==='none'),`${action}: reduced motion / unchanged data does not replay movement`);
        } else {
          assert.ok(moving.some(f=>+f.opacity>0 && +f.opacity<1),`${action}: actual intermediate opacity`);
          assert.ok(new Set(moving.map(f=>f.stageTop)).size>3,`${action}: actual intermediate follower positions`);
          const direction=action==='start'?1:-1;
          assert.ok(frames.slice(1).every((f,i)=>direction*(f.stageTop-frames[i].stageTop)>-0.6),`${action}: monotonic trajectory`);
          assert.ok(new Set(moving.map(f=>f.rootLength)).size===1,`${action}: settled root geometry throughout motion`);
          assert.ok(moving.every(f=>Math.abs((f.cardTop-f.stageTop)-44)<0.6),`${action}: first card moves with complete following surface`);
        }
        assert.equal(frames.at(-1).transition,false,'animation cleans up');
        assert.equal(frames.at(-1).followerTransform,'none','no lingering transformed sticky ancestor');
        if (!reduced && action==='start') {
          const screenshot=await session.send('Page.captureScreenshot',{format:'png'});
          await writeFile(path.join(output,'focus-settled.png'),Buffer.from(screenshot.data,'base64'));
        }
      }
    }
  }
  if (!process.env.FOCUS_BASELINE) {
    await session.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    const stress=await evaluate(session,`(async()=>{
      const focus=await import(chrome.runtime.getURL('js/ui/focus-strip.js'));
      const store=await import(chrome.runtime.getURL('js/lib/store.js'));
      const layout=document.querySelector('.focus-strip-layout'), inner=layout.firstElementChild, strip=inner.querySelector('.focus-strip'), stage=document.querySelector('.daily-stage');
      const pause=ms=>new Promise(r=>setTimeout(r,ms));
      const until=async(test,label)=>{const end=performance.now()+2000;while(!test()){if(performance.now()>end)throw new Error(label);await new Promise(requestAnimationFrame);}};
      const check=(value,label)=>{if(!value)throw new Error(label);};
      const start=async()=>{const r=await focus.startFocusGuard({mode:'duration',durationMinutes:30});check(r.ok,'worker start');};
      await start();await until(()=>inner.getAnimations().length,'start animation mounted');
      const entrance=inner.getAnimations()[0];
      await store.patchSettings({uiSectionIntros:false});await pause(35);
      check(inner.getAnimations()[0]===entrance || entrance.playState==='finished','data refresh does not restart entrance');
      const reversals=[];
      const reversalFrames=[];let sampling=true;
      const sampleReversal=()=>{reversalFrames.push({ms:performance.now(),stageTop:stage.getBoundingClientRect().top,opacity:getComputedStyle(inner).opacity,target:layout.getBoundingClientRect().height});if(sampling)requestAnimationFrame(sampleReversal);};
      requestAnimationFrame(sampleReversal);
      for(let n=0;n<3;n++){
        await focus.endFocusGuard();await until(()=>layout.getBoundingClientRect().height===0,'exit target committed');
        check(strip.inert,'outgoing strip is inert');
        await pause(30);const before=stage.getBoundingClientRect().top;
        await start();await until(()=>layout.getBoundingClientRect().height>0,'reverse target committed');
        reversals.push({before,after:stage.getBoundingClientRect().top,opacity:getComputedStyle(inner).opacity});
        await pause(30);
      }
      await pause(260);
      sampling=false;
      check(!strip.inert && !strip.classList.contains('hidden'),'latest start wins');
      check(!inner.getAnimations().length && !stage.getAnimations().length && !layout.style.overflow,'reversal effects cleaned');
      const guarded=strip.querySelector('.fs-counts-link');guarded.focus();
      await store.patchSettings({uiSectionIntros:true});await pause(70);
      check(document.activeElement===strip.querySelector('.fs-counts-link'),'equivalent control retains keyboard focus after refresh');
      await focus.endFocusGuard();await until(()=>strip.inert,'keyboard exit commits');
      check(document.activeElement.matches('input'),'focus handed to Search immediately');
      await pause(200);check(strip.classList.contains('hidden')&&!strip.children.length,'exit clears stale children');
      await start();await until(()=>inner.getAnimations().length,'wheel test running');
      window.dispatchEvent(new WheelEvent('wheel',{deltaY:20}));
      check(!inner.getAnimations().length&&!stage.getAnimations().length,'user wheel settles moving surface');
      await focus.endFocusGuard();await pause(220);
      // Search backdrop ancestors must remain untransformed throughout Focus.
      await start();await until(()=>inner.getAnimations().length,'ancestor test running');
      check(['.hero','.hero-top','.hero-panel'].every(s=>{const node=document.querySelector(s);return !node||getComputedStyle(node).transform==='none';}),'fixed Search backdrop ancestors stay untransformed');
      return {reversals,reversalFrames,refreshRetainedAnimation:true,keyboardFocusRetained:true,exitInert:true,wheelSettles:true,backdropAncestorsUntransformed:true};
    })()`);
    await session.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await waitFor(session, '!document.documentElement.classList.contains("focus-layout-transition")', 'motion preference change delivered');
    const preference=await evaluate(session,`(()=>{const layout=document.querySelector('.focus-strip-layout');return {animations:layout.firstElementChild.getAnimations().length+document.querySelector('.daily-stage').getAnimations().length,transition:document.documentElement.classList.contains('focus-layout-transition')};})()`);
    assert.equal(preference.animations,0,'reduced-motion preference change settles active effects');
    assert.equal(preference.transition,false);
    await evaluate(session,`chrome.storage.local.set({focusTemporaryAccess:{'distracting.example':{domain:'distracting.example',accessStartedAt:Date.now(),expiresAt:Date.now()+300000}}})`);
    await waitFor(session,'document.querySelector(".focus-access-row")','synthetic temporary-access row');
    await new Promise(r=>setTimeout(r,90));
    const accessHeight=await evaluate(session,`(()=>{const layout=document.querySelector('.focus-strip-layout');return {outer:layout.getBoundingClientRect().height,inner:layout.firstElementChild.getBoundingClientRect().height};})()`);
    assert.ok(Math.abs(accessHeight.outer-accessHeight.inner)<0.6,'changed access content retargets exact intrinsic height');
    await evaluate(session,`chrome.storage.local.set({focusTemporaryAccess:{}})`);
    const panel=await createTarget(debugUrl,`chrome-extension://${id}/sidepanel.html`);
    try {
      await prepareSession(panel);
      await panel.send('Emulation.setDeviceMetricsOverride',{width:390,height:800,deviceScaleFactor:1,mobile:false});
      await waitFor(panel,'document.querySelector(".focus-strip:not(.hidden) .fs-counts-link")','shared side-panel Focus');
      await new Promise(r=>setTimeout(r,260));
      await evaluate(panel,`document.querySelector('.fs-counts-link').focus()`);
      await evaluate(panel,`import(chrome.runtime.getURL('js/ui/focus-strip.js')).then(f=>f.endFocusGuard())`);
      await waitFor(panel,'document.querySelector(".focus-strip").classList.contains("hidden")','side-panel exit settled');
      const panelState=await evaluate(panel,`(()=>{const layout=document.querySelector('.focus-strip-layout');return {height:layout.getBoundingClientRect().height,animations:layout.firstElementChild.getAnimations().length,focusedInput:document.activeElement.matches('input'),inert:layout.querySelector('.focus-strip').inert};})()`);
      assert.ok(panelState.height===0&&panelState.animations===0&&panelState.focusedInput&&panelState.inert,'shared side-panel Focus exit retains accessibility and cleanup');
      await writeFile(path.join(output,'stress.json'),JSON.stringify({stress,preference,accessHeight,panelState},null,2)+'\n');
    } finally {panel.close();}
  }
  const file=path.join(output,(process.env.FOCUS_BASELINE?'baseline':'after')+'-frames.json');
  await writeFile(file,JSON.stringify({browser:chromeBin,results},null,2)+'\n');
  console.log(JSON.stringify(results.map(r=>({...r,frames:r.frames.length,heights:[...new Set(r.frames.map(f=>f.focusH))]})),null,2));
} finally {
  session?.close();await terminateOwnedChrome(chrome);await server.close();await rm(profile,{recursive:true,force:true});
}
