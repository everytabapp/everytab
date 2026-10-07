// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** First-frame controls and a clock-clear atmosphere in disposable Chrome. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnOwnedChrome,terminateOwnedChrome} from '../extension/test/chrome-test-process.mjs';
import {chromeBin,extensionRoot,debuggingUrl,detectExtension,createTarget,evaluate,prepareSession,waitFor} from './capture-store-screenshots.mjs';
const output=path.resolve(process.env.EVERYTAB_CONTROLS_OUTPUT || 'review-evidence/startup-cohesion-v0.8.600/controls');
const profile=await mkdtemp(path.join(tmpdir(),'everytab-controls-'));
const chrome=spawnOwnedChrome(chromeBin,['--headless=new','--disable-gpu','--remote-debugging-port=0',`--user-data-dir=${profile}`,`--load-extension=${extensionRoot}`,`--disable-extensions-except=${extensionRoot}`,'--no-first-run','--disable-background-networking','about:blank'],{stdio:['ignore','ignore','pipe']});
let page;
const evidence={};
try {
 await mkdir(output,{recursive:true});
 const debug=await debuggingUrl(chrome),id=await detectExtension(debug);
 page=await createTarget(debug,`chrome-extension://${id}/dashboard.html`);await prepareSession(page);
 await evaluate(page,`(async()=>{await chrome.storage.local.set({onboardingDone:true});await import(chrome.runtime.getURL('js/lib/store.js')).then(s=>s.patchSettings({newTabMode:'minimal',newTabFocus:'omnibox',uiGradient:true,uiScheme:'matcha',uiMode:'scheme',uiSidebarCollapsed:false}));})()`);
 const {identifier:probe}=await page.send('Page.addScriptToEvaluateOnNewDocument',{source:`
 window.__firstControls={};window.__focusReads=0;
 const nativeWindows=chrome.windows.getAll.bind(chrome.windows);
 chrome.windows.getAll=(...args)=>nativeWindows(...args).then(value=>new Promise(resolve=>setTimeout(()=>resolve(value),900)));
 const nativeMessage=chrome.runtime.sendMessage.bind(chrome.runtime);
 chrome.runtime.sendMessage=(message,...args)=>{const result=nativeMessage(message,...args);if(message.type==='focus-guard-status'){__focusReads++;return result.then(value=>new Promise(resolve=>setTimeout(()=>resolve(value),900)));}return result;};
 new MutationObserver(()=>{
  if(!__firstControls.dashboard&&document.querySelector('.sidebar'))__firstControls.dashboard={at:performance.now(),buttons:document.querySelectorAll('.quick-theme button').length,rows:document.querySelectorAll('[data-sec=open] .trow').length};
  if(!__firstControls.minimal&&document.querySelector('.minimal-clock')){const b=document.querySelector('.minimal-focus-action');__firstControls.minimal={at:performance.now(),present:!!b,visibility:b?getComputedStyle(b).visibility:null,text:b?.textContent};}
 }).observe(document,{childList:true,subtree:true});
 `});
 await page.send('Page.navigate',{url:`chrome-extension://${id}/dashboard.html`});
 await waitFor(page,'__firstControls.dashboard','first Dashboard controls');
 evidence.dashboard=await evaluate(page,'__firstControls.dashboard');
 assert.equal(evidence.dashboard.buttons,4,'all appearance buttons exist with sidebar');
 assert.equal(evidence.dashboard.rows,0,'appearance controls precede delayed live rows');
 await evaluate(page,"window.__earlyMode=document.querySelector('.mode-choice');__earlyMode.focus()");
 await waitFor(page,"document.querySelector('[data-sec=open] .trow') && !document.querySelector('.sidebar [data-startup-pending]')",'Dashboard hydration');
 evidence.appearanceHydration=await evaluate(page,"({same:__earlyMode===document.querySelector('.mode-choice'),focused:document.activeElement===__earlyMode,active:document.activeElement?.outerHTML.slice(0,500),mode:document.documentElement.dataset.nav})");

 assert.equal(evidence.appearanceHydration.same,true,'appearance hydration preserves control identity');
 // Initial routing deliberately focuses Search. Test a later settings refresh
 // separately so that route focus is not misattributed to control replacement.
 await evaluate(page,"__earlyMode.focus();import(chrome.runtime.getURL('js/lib/store.js')).then(s=>s.patchSettings({uiMode:'dark'}))");
 await waitFor(page,"document.querySelectorAll('.mode-choice')[1].getAttribute('aria-pressed')==='true'",'appearance settings refresh');
 assert.equal(await evaluate(page,'document.activeElement===__earlyMode'),true,'settings hydration retains keyboard focus');
 evidence.navSpacing=await evaluate(page,`(()=>{const labels=[...document.querySelectorAll('.side-scroll>.navlabel')];return labels.slice(1).map(label=>({text:label.textContent,gap:label.getBoundingClientRect().top-label.previousElementSibling.getBoundingClientRect().bottom,padding:getComputedStyle(label).paddingTop}));})()`);
 assert.equal(evidence.navSpacing[0].gap,evidence.navSpacing[1].gap,'Saved and More have equal section gaps');
 assert.equal(evidence.navSpacing[0].padding,evidence.navSpacing[1].padding);
 await evaluate(page,"document.querySelector('.quick-theme>.gear').click()");
 await waitFor(page,"!document.querySelector('.theme-pop').classList.contains('hidden')",'live palette opens');
 assert.equal(await evaluate(page,"document.querySelector('.theme-opt-row[data-scheme-id=matcha] .theme-opt').getAttribute('aria-pressed')"),'true','palette uses current settings');
 await page.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 let paused=null;
 const listener=({data})=>{const message=JSON.parse(data);if(message.method==='Fetch.requestPaused'&&message.sessionId===page.sessionId)paused=message.params;};
 page.client.socket.addEventListener('message',listener);
 await page.send('Fetch.enable',{patterns:[{urlPattern:'*minimal-focus-action.js',requestStage:'Request'}]});
 await page.send('Page.navigate',{url:`chrome-extension://${id}/newtab.html`});
 await waitFor(page,'__firstControls.minimal','first Minimal controls');
 evidence.minimal=await evaluate(page,'__firstControls.minimal');
 assert.equal(evidence.minimal.present,true);assert.equal(evidence.minimal.visibility,'visible');assert.equal(evidence.minimal.text,'Focus');
 const deadline=Date.now()+3000;while(!paused&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.ok(paused,'optional Focus module is genuinely held');
 await evaluate(page,"window.__earlyFocus=document.querySelector('.minimal-focus-action');__earlyFocus.focus()");
 evidence.statusReadsBeforeModule=await evaluate(page,'__focusReads');
 await page.send('Fetch.continueRequest',{requestId:paused.requestId});await page.send('Fetch.disable');page.client.socket.removeEventListener('message',listener);
 await waitFor(page,`__focusReads>${evidence.statusReadsBeforeModule}`,'Focus owner status request');
 assert.equal(await evaluate(page,"document.activeElement===__earlyFocus&&getComputedStyle(__earlyFocus).visibility==='visible'"),true,'adoption preserves keyboard focus and visibility');
 await waitFor(page,"!__earlyFocus.classList.contains('is-hydrating')",'Focus status settles');
 assert.equal(await evaluate(page,"document.activeElement===__earlyFocus&&__earlyFocus===document.querySelector('.minimal-focus-action')"),true);
 evidence.focusHydrated=await evaluate(page,"({text:__earlyFocus.textContent,aria:__earlyFocus.getAttribute('aria-label'),reads:__focusReads})");
 await page.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:probe});
 evidence.atmosphere=[];
 for(const [width,height] of [[1280,800],[1280,600],[640,800],[320,800]]){
  await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  const record=await evaluate(page,`(()=>{const clock=document.querySelector('.clock').getBoundingClientRect(),layer=document.querySelector('.minimal-atmosphere'),s=getComputedStyle(layer);const stops=[...s.maskImage.matchAll(/([\\d.]+)px/g)].map(m=>Number(m[1]));return {width:innerWidth,height:innerHeight,clockBottom:clock.bottom,mask:s.maskImage,clearEdge:stops[0],maskFixed:s.position,orbs:[...document.querySelectorAll('.orb')].map(o=>({top:getComputedStyle(o).top,bottom:getComputedStyle(o).bottom}))};})()`);
  assert.ok(record.clearEdge>=record.clockBottom+20,'clock fully within transparent atmosphere mask');assert.equal(record.maskFixed,'fixed');evidence.atmosphere.push(record);
 }
 await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
 for(const scheme of ['matcha','nautilus']){
  await evaluate(page,`import(chrome.runtime.getURL('js/lib/store.js')).then(s=>s.patchSettings({uiScheme:'${scheme}'}))`);
  await page.send('Page.navigate',{url:`chrome-extension://${id}/newtab.html`});await waitFor(page,"document.querySelector('.clock')",'scheme Minimal');
  await evaluate(page,'new Promise(r=>setTimeout(r,500))');
  let shot=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(output,`${scheme}-moving.png`),Buffer.from(shot.data,'base64'));
  await waitFor(page,"!document.getAnimations().some(a=>a.effect?.target?.classList.contains('orb'))",'glows settle',6000);
  shot=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(output,`${scheme}-settled.png`),Buffer.from(shot.data,'base64'));
 }
 // A click before the optional module arrives must reach the adopted owner
 // once, rather than disappearing during the handoff.
 paused=null;page.client.socket.addEventListener('message',listener);
 await page.send('Fetch.enable',{patterns:[{urlPattern:'*minimal-focus-action.js',requestStage:'Request'}]});
 await page.send('Page.navigate',{url:`chrome-extension://${id}/newtab.html`});
 await waitFor(page,"document.querySelector('.minimal-focus-action')",'early Focus click');
 const clickDeadline=Date.now()+3000;while(!paused&&Date.now()<clickDeadline)await new Promise(r=>setTimeout(r,20));assert.ok(paused);
 await evaluate(page,"document.querySelector('.minimal-focus-action').click()");
 await page.send('Fetch.continueRequest',{requestId:paused.requestId});await page.send('Fetch.disable');page.client.socket.removeEventListener('message',listener);
 const navigationDeadline=Date.now()+10000;let destination='';
 do { const frame=(await page.send('Page.getFrameTree')).frameTree.frame;
  destination=frame.url+(frame.urlFragment || '');
  if(destination.includes('#settings'))break;
  await new Promise(r=>setTimeout(r,40));
 }while(Date.now()<navigationDeadline);
 assert.ok(destination.includes('#settings'),'queued Focus click reaches setup: '+destination);
 await waitFor(page,"document.body.dataset.page==='settings'&&document.getElementById('setg-focus')",'Focus settings mounts');
 evidence.queuedFocusClick=true;
 await writeFile(path.join(output,'checks.json'),JSON.stringify(evidence,null,2)+'\n');console.log('PASS first controls, adoption, palette, navigation spacing and clock-clear atmosphere');
}finally{page?.close();await terminateOwnedChrome(chrome);await rm(profile,{recursive:true,force:true});}
