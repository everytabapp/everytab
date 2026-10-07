// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Real-extension clock typography and bounded atmosphere checks. Disposable profile only. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnOwnedChrome,terminateOwnedChrome} from '../extension/test/chrome-test-process.mjs';
import {chromeBin,extensionRoot,debuggingUrl,detectExtension,createTarget,evaluate,prepareSession,waitFor} from './capture-store-screenshots.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output=path.join(root,'review-evidence/minimal-day-period-v0.8.620/browser');
const profile=await mkdtemp(path.join(tmpdir(),'everytab-minimal-delight-'));
const chrome=spawnOwnedChrome(chromeBin,['--headless=new','--disable-gpu','--remote-debugging-port=0',`--user-data-dir=${profile}`,`--load-extension=${extensionRoot}`,`--disable-extensions-except=${extensionRoot}`,'--no-first-run','--disable-background-networking','about:blank'],{stdio:['ignore','ignore','pipe']});
const evidence={clock:[],dayPeriod:[],motion:[],locale:[]};
const measureClock=`(() => {
 const clock=document.querySelector('.clock');const time=clock.firstChild;const text=time.data;const colon=text.indexOf(':');
 const range=document.createRange();range.selectNodeContents(clock);const box=range.getBoundingClientRect();
 let colonInkCenter=null;
 if(colon>=0){range.setStart(time,colon);range.setEnd(time,colon+1);const rect=range.getBoundingClientRect();const style=getComputedStyle(clock);const context=document.createElement('canvas').getContext('2d');context.font=style.fontWeight+' '+style.fontSize+' '+style.fontFamily;context.letterSpacing=style.letterSpacing;const ink=context.measureText(':');colonInkCenter=rect.x+(ink.actualBoundingBoxRight-ink.actualBoundingBoxLeft)/2;}
 return {text,direction:document.documentElement.dir,viewport:innerWidth,range:{x:box.x,width:box.width},colonInkCenter,offset:colonInkCenter-innerWidth/2,tabular:getComputedStyle(clock).fontVariantNumeric,singleTextNode:time.nodeType===Node.TEXT_NODE};
})()`;
const animations=`document.getAnimations().filter(animation=>animation.effect?.target?.classList.contains('orb')).map(animation=>({duration:animation.effect.getTiming().duration,iterations:animation.effect.getTiming().iterations,state:animation.playState,target:animation.effect.target.className,properties:Object.keys(animation.effect.getKeyframes()[0])}))`;
let page;
try {
 await mkdir(output,{recursive:true});const ws=await debuggingUrl(chrome);const id=await detectExtension(ws);const url=`chrome-extension://${id}/newtab.html`;
 page=await createTarget(ws,`chrome-extension://${id}/dashboard.html`);await prepareSession(page);
 await evaluate(page,`(async()=>{await chrome.storage.local.set({onboardingDone:true});await import(chrome.runtime.getURL('js/lib/store.js')).then(store=>store.patchSettings({newTabMode:'minimal',newTabFocus:'omnibox',newTabWelcomeEnabled:true,newTabWelcomePhrases:['One thing at a time.'],uiGradient:true,uiScheme:'matcha'}));})()`);
 const navigate=async()=>{await page.send('Page.navigate',{url});await waitFor(page,"document.querySelector('.clock')?.textContent",'Minimal clock');};
 await navigate();
 assert.equal(await evaluate(page,`import(chrome.runtime.getURL('js/lib/i18n.js')).then(i18n=>document.querySelector('.clock').getAttribute('aria-label')===i18n.formatTime(new Date(),{hour:'2-digit',minute:'2-digit'}))`),true,'runtime preserves locale formatter');
 for(const width of [1280,640,360,320]){
  await page.send('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false});
  for(const text of ['00:00','01:11','09:41','11:11','12:00','23:59']){
   await evaluate(page,`(()=>{const clock=document.querySelector('.clock');clock.firstChild.data=${JSON.stringify(text)};clock.querySelector('.clock-period').textContent='';clock.removeAttribute('data-has-period');clock.setAttribute('aria-label',${JSON.stringify(text)});})()`);const record=await evaluate(page,measureClock);evidence.clock.push({kind:'width',width,...record});
   assert.ok(Math.abs(record.offset)<1,`visible colon centered at ${width}: ${record.offset}`);assert.ok(record.range.width<=width,`clock fits ${width}: ${record.range.width}`);assert.equal(record.singleTextNode,true);assert.equal(record.tabular,'tabular-nums');
  }
  const {data}=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(output,`minimal-${width}.png`),Buffer.from(data,'base64'));
 }
 await evaluate(page,`(()=>{const input=document.querySelector('.search-field input');input.focus();input.value='zz-clock-fixture-miss';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await waitFor(page,"document.querySelector('.minimal-deck.is-search-expanded') && document.querySelector('.search-results')?.textContent.includes('zz-clock-fixture-miss')",'narrow Search');
 const narrowSearch=await evaluate(page,`(()=>{const input=document.querySelector('.search-field input'),box=input.getBoundingClientRect();return {focused:document.activeElement===input,left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:innerWidth,height:innerHeight};})()`);
 assert.equal(narrowSearch.focused,true);assert.ok(narrowSearch.left>=0&&narrowSearch.right<=narrowSearch.width&&narrowSearch.top>=0&&narrowSearch.bottom<=narrowSearch.height);evidence.narrowSearch=narrowSearch;
 const expandedShot=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(output,'minimal-320-search.png'),Buffer.from(expandedShot.data,'base64'));
 await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
 // Exercise the unchanged runtime formatting path with fixture UI locales.
 // Other messages still come from the real packaged Chrome catalogue.
 for(const locale of ['en-GB','en-US','ar-EG']){
  for(const hour of ['00','09','12']){
   const stamp=`2026-09-12T${hour}:41:00Z`;
   const {identifier}=await page.send('Page.addScriptToEvaluateOnNewDocument',{source:`
    const originalLookup=chrome.i18n.getMessage.bind(chrome.i18n);
    chrome.i18n.getMessage=(key,...rest)=>key==='@@ui_locale'?${JSON.stringify(locale)}:key==='@@bidi_dir'?${JSON.stringify(locale==='ar-EG'?'rtl':'ltr')}:originalLookup(key,...rest);
    const NativeDate=Date;globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[${JSON.stringify(stamp)}]));}static now(){return new NativeDate(${JSON.stringify(stamp)}).getTime();}};
   `});
   await page.send('Emulation.setTimezoneOverride',{timezoneId:'UTC'});await navigate();
   const record=await evaluate(page,`(()=>{const text=new Intl.DateTimeFormat(${JSON.stringify(locale)},{hour:'2-digit',minute:'2-digit',timeZone:'UTC'}).format(new Date());const clock=document.querySelector('.clock');const range=document.createRange();range.selectNodeContents(clock);const box=range.getBoundingClientRect();return {locale:${JSON.stringify(locale)},text,actual:clock.getAttribute('aria-label')||clock.textContent,direction:document.documentElement.dir,viewport:innerWidth,range:{left:box.left,right:box.right,width:box.width},periodSize:Number.parseFloat(getComputedStyle(clock.querySelector('.clock-period')||clock).fontSize),timeSize:Number.parseFloat(getComputedStyle(clock).fontSize)};})()`);
   assert.equal(record.text,record.actual);if(locale==='en-US'){assert.match(record.actual,/AM|PM/);assert.ok(record.range.left>=0&&record.range.right<=record.viewport,`12-hour clock fits the viewport: ${JSON.stringify(record)}`);assert.ok(record.periodSize<record.timeSize*.16,`day period stays subordinate: ${JSON.stringify(record)}`);}if(locale==='ar-EG')assert.equal(record.direction,'rtl');
   const ax=await page.send('Accessibility.getFullAXTree');assert.ok(ax.nodes.some(node=>node.name?.value===record.text),'formatted clock is readable in the accessibility tree');evidence.locale.push(record);
   if(locale==='en-US'&&hour==='09'){
    for(const [width,height] of [[1655,904],[1280,800],[1024,700],[720,800],[420,800],[360,800],[320,700]]){
     await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
     const responsive=await evaluate(page,`(()=>{const clock=document.querySelector('.clock'),time=clock.firstChild,period=clock.querySelector('.clock-period'),timeRange=document.createRange();timeRange.selectNodeContents(time);const timeBox=timeRange.getBoundingClientRect(),periodBox=period.getBoundingClientRect(),style=getComputedStyle(clock);return {width:innerWidth,height:innerHeight,label:clock.getAttribute('aria-label'),left:Math.min(timeBox.left,periodBox.left),right:Math.max(timeBox.right,periodBox.right),timeSize:Number.parseFloat(style.fontSize),periodSize:Number.parseFloat(getComputedStyle(period).fontSize)};})()`);
     assert.ok(responsive.left>=0&&responsive.right<=responsive.width,`12-hour clock fits ${width}x${height}: ${JSON.stringify(responsive)}`);assert.ok(responsive.periodSize<responsive.timeSize*.16);evidence.dayPeriod.push(responsive);
     if(width===1655){const {data}=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(output,'minimal-en-US-1655x904.png'),Buffer.from(data,'base64'));}
    }
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
   }
   await page.send('Page.removeScriptToEvaluateOnNewDocument',{identifier});
  }
 }
 await navigate();
 await evaluate(page,"(()=>{document.documentElement.dir='rtl';const clock=document.querySelector('.clock');clock.firstChild.data='09:41';clock.querySelector('.clock-period').textContent='';clock.removeAttribute('data-has-period');clock.setAttribute('aria-label','09:41');})()");
 const rtl=await evaluate(page,measureClock);evidence.clock.push({kind:'rtl',...rtl});assert.ok(Math.abs(rtl.offset)<.5,`RTL colon centered: ${rtl.offset}`);
 await evaluate(page,"document.documentElement.dir='ltr'");
 await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
 await evaluate(page,`chrome.tabs.getCurrent().then(tab=>chrome.tabs.setZoom(tab.id,2))`);
 const zoom=await evaluate(page,measureClock);evidence.clock.push({kind:'native-200-percent-zoom',...zoom});assert.ok(Math.abs(zoom.offset)<.5);assert.ok(zoom.range.width<=zoom.viewport);
 await evaluate(page,`chrome.tabs.getCurrent().then(tab=>chrome.tabs.setZoom(tab.id,1))`);
 await page.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 await navigate();let active=await evaluate(page,animations);assert.equal(active.length,2,'two existing orbs animate');assert.ok(active.every(a=>a.duration===4600&&a.iterations===1));assert.ok(active.every(a=>a.properties.every(key=>['offset','easing','composite','computedOffset','transform','opacity'].includes(key))));
 const startingClock=await evaluate(page,measureClock);evidence.motion.push({kind:'visible-start',active});
 await waitFor(page,`${animations}.length===0`,'atmosphere settles',6000);const settledClock=await evaluate(page,measureClock);assert.deepEqual(startingClock.range,settledClock.range,'background animation never moves clock');evidence.motion.push({kind:'settled',active:await evaluate(page,animations)});
 await page.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await navigate();assert.equal((await evaluate(page,animations)).length,0,'reduced motion is static');evidence.motion.push({kind:'reduced',active:[]});
 await page.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});await navigate();assert.equal((await evaluate(page,animations)).length,2);
 await page.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await waitFor(page,`${animations}.length===0`,'motion preference cancels');evidence.motion.push({kind:'preference-change-cancelled',active:[]});
 await page.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});await navigate();assert.equal((await evaluate(page,animations)).length,2);
 const covering=await evaluate(page,`chrome.tabs.create({url:'about:blank',active:true}).then(tab=>tab.id)`);await waitFor(page,"document.visibilityState==='hidden'",'native tab backgrounding');assert.equal((await evaluate(page,animations)).length,0,'backgrounding cancels motion');await evaluate(page,`chrome.tabs.remove(${covering})`);await page.send('Page.bringToFront');await waitFor(page,"document.visibilityState==='visible'",'tab restored');assert.equal((await evaluate(page,animations)).length,0,'return never replays atmosphere');evidence.motion.push({kind:'background-cancelled-no-replay',active:[]});
 const hidden=await createTarget(ws,url,{background:true});await prepareSession(hidden);await hidden.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});await hidden.send('Page.reload');await waitFor(hidden,"document.querySelector('.clock')?.textContent",'background initial mount');assert.equal(await evaluate(hidden,'document.visibilityState'),'hidden');assert.equal((await evaluate(hidden,animations)).length,0,'initially hidden tab is static');hidden.close();evidence.motion.push({kind:'initially-hidden',active:[]});
 await evaluate(page,`import(chrome.runtime.getURL('js/lib/store.js')).then(store=>store.patchSettings({uiGradient:false}))`);await navigate();assert.equal((await evaluate(page,animations)).length,0,'flat appearance stays static');evidence.motion.push({kind:'gradient-off',active:[]});
 await writeFile(path.join(output,'checks.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({clockChecks:evidence.clock.length,dayPeriodChecks:evidence.dayPeriod.length,localeChecks:evidence.locale.length,motionChecks:evidence.motion.length,output},null,2));
}finally{page?.close();await terminateOwnedChrome(chrome);await rm(profile,{recursive:true,force:true});}
