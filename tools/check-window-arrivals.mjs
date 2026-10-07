// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Real Open-card geometry and material fixture. Uses disposable data only.
 * Run: node tools/check-window-arrivals.mjs
 * Output is frame-sampled Chrome evidence, not a hardware performance guarantee.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const testedExtensionRoot = extensionRoot;
const testedVersion = JSON.parse(await readFile(path.join(testedExtensionRoot, 'manifest.json'), 'utf8')).version;
const output = process.env.WINDOW_ARRIVALS_OUTPUT ||
  path.join(projectRoot, `review-evidence/window-arrivals-v${testedVersion}`);
const profile = await mkdtemp(path.join(tmpdir(), 'everytab-window-arrivals-'));
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

const inspect = `
window.__windowViewportCalls=[];window.__windowViewportRetargets=[];window.__windowFrames=[];window.__windowOpenAnimations=[];
const nativeAnimate=Element.prototype.animate;
Element.prototype.animate=function(frames,options){
  const effect=nativeAnimate.call(this,frames,options);
  const list=this.closest('.sec-inner');
  if(list?.closest('[data-sec="open"]'))__windowOpenAnimations.push({
    isViewport:this.classList.contains('sec-inner'),
    isCurtain:this.classList.contains('window-list-curtain'),
    descendantRows:this.querySelectorAll('.trow').length,
    className:this.className
  });
  if(this.classList.contains('window-list-curtain')&&this.closest('[data-sec="open"]'))__windowViewportCalls.push({ms:performance.now(),duration:options.duration,delay:options.delay||0,easing:options.easing,frames,property:frames[0].transform!==undefined?'transform':'other'});
  return effect;
};
const nativeSetKeyframes=KeyframeEffect.prototype.setKeyframes;
KeyframeEffect.prototype.setKeyframes=function(frames){
  if(this.target?.classList.contains('window-list-curtain')&&this.target.closest('[data-sec="open"]')){
    __windowViewportRetargets.push({ms:performance.now(),frames});
  }
  return nativeSetKeyframes.call(this,frames);
};
function curtainOffset(node){
  const transform=getComputedStyle(node).transform;
  if(!transform||transform==='none')return 0;
  const matrix=transform.match(/^matrix\\(([^)]+)\\)$/)?.[1].split(',').map(value=>parseFloat(value));
  if(matrix?.length===6)return Number.isFinite(matrix[5])?matrix[5]:0;
  const matrix3d=transform.match(/^matrix3d\\(([^)]+)\\)$/)?.[1].split(',').map(value=>parseFloat(value));
  return matrix3d?.length===16&&Number.isFinite(matrix3d[13])?matrix3d[13]:0;
}
window.__startWindowSampling=()=>{
  window.__windowFrames=[];
  const began=performance.now();
  function sample(){
    const section=document.querySelector('[data-sec=open]');
    const viewport=section?.querySelector('.sec-inner');
    const cards=[...document.querySelectorAll('[data-sec=open] [data-tablist-card]')];
    if(section&&viewport&&cards.length){
      const viewportRect=viewport.getBoundingClientRect();
      const curtain=viewport.querySelector(':scope > .window-list-curtain');
      const offset=curtain?curtainOffset(curtain):viewportRect.height;
      const visibleBottom=viewportRect.top+offset;
      __windowFrames.push({ms:performance.now(),listGrowing:viewport.classList.contains('is-window-list-arriving'),sectionBottom:section.getBoundingClientRect().bottom,sectionBottomColor:getComputedStyle(section).borderBottomColor,visibleBottom,curtainOffset:offset,openCountReady:!!document.querySelector('.open-heading-count')&&!document.querySelector('.open-heading-count [data-startup-pending]'),cards:cards.map(card=>{
        const headNode=card.querySelector(':scope > .item-head-shell');
        if(!headNode)return null;
        const rect=card.getBoundingClientRect(),head=headNode.getBoundingClientRect(),body=card.querySelector(':scope > .item-body-frame')?.getBoundingClientRect(),rowNode=card.querySelector('.trow'),row=rowNode?.getBoundingClientRect();
        const visibleHeaderHeight=Math.max(0,Math.min(head.height,visibleBottom-head.top));
        const visibleBodyHeight=body?Math.max(0,Math.min(body.height,visibleBottom-body.top)):0;
        const visualBottom=body?body.top+visibleBodyHeight:head.bottom;
        return {id:card.dataset.tablistCard,height:rect.height,top:rect.top,headerHeight:head.height,visibleHeaderHeight,visibleBodyHeight,visibleFirstRow:row?Math.max(0,Math.min(row.height,visualBottom-row.top)):0,rowTransform:rowNode?getComputedStyle(rowNode).transform:null};
      }).filter(Boolean)});
    }
    if(performance.now()-began<1800)requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
};
window.__startWindowSampling();
const windows=chrome.windows.getAll.bind(chrome.windows);
chrome.windows.getAll=(...args)=>windows(...args).then(result=>new Promise(resolve=>setTimeout(()=>resolve(result),location.search.includes('cold')?450:0)));
`;

let session;
try {
  await mkdir(output, { recursive: true });
  const debug = await debuggingUrl(chrome);
  const id = await detectExtension(debug);
  session = await createTarget(debug, `chrome-extension://${id}/dashboard.html#open`);
  await prepareSession(session);
  await evaluate(session, seedExpression(captureFixture(server.port)));
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: inspect });

  const runs = [];
  for (const mode of ['cold', 'warm', 'reduced', 'reload']) {
    await session.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: mode === 'reduced' ? 'reduce' : 'no-preference' }]
    });
    if (mode === 'reload') await session.send('Page.reload');
    else await session.send('Page.navigate', {
      url: `chrome-extension://${id}/dashboard.html?window-arrival=${mode}#open`
    });
    await waitFor(session, 'document.querySelectorAll("[data-sec=open] .trow").length>10', 'real window rows');
    await evaluate(session, 'document.querySelector(".ob-head button")?.click()');
    await new Promise(resolve => setTimeout(resolve, 400));
    const run = await evaluate(session, '({viewportCalls:__windowViewportCalls,viewportRetargets:__windowViewportRetargets,openAnimations:__windowOpenAnimations,frames:__windowFrames})');
    assert.ok(run.frames.length > 0, `${mode}: frame sampler captured the Open list`);
    assert.ok(run.frames[0].openCountReady, 'known Open heading count is published before the list sequence');
    if (mode === 'reduced' || mode === 'reload') {
      assert.equal(run.viewportCalls.length, 0,
        mode === 'reload'
          ? 'a page reload keeps the already-visible Open list steady'
          : 'reduced motion is instant');
      if (mode === 'reload') assert.equal(await evaluate(session,
        'performance.getEntriesByType("navigation")[0]?.type'), 'reload');
    } else {
      assert.equal(run.viewportCalls.length, 1,
        `${mode}: one continuous Open-list reveal controls the visible edge without easing restarts`);
      assert.ok(run.viewportRetargets.every(candidate => candidate.frames.length === 2),
        `${mode}: geometry updates retarget the same two-point effect`);
      const [call] = run.viewportCalls;
      const continuity = await evaluate(session, `Number.parseFloat(getComputedStyle(
        document.querySelector('[data-sec=open] .sec-inner')
      ).getPropertyValue('--motion-continuity')) || 180`);
      const travel = await evaluate(session, `(()=>{const node=document.querySelector(
        '[data-sec=open] .sec-inner');const rect=node.getBoundingClientRect();return {
          height:rect.height,visible:Math.max(0,Math.min(rect.height,innerHeight-rect.top))};})()`);
      const expectedDuration = continuity * Math.max(1.125, Math.min(1.395,
        travel.visible / 500));
      assert.ok(Math.abs(call.duration - expectedDuration) < 2,
        `${mode}: the spatial reveal stays quick while adapting to visible travel`);
      assert.ok(run.viewportCalls.every(candidate => candidate.property === 'transform' &&
        candidate.delay === 0 && candidate.frames.length === 2 &&
        candidate.easing === 'cubic-bezier(.34, 1.2, .64, 1)'),
      `${mode}: every list update remains one two-point transform animation`);
      assert.ok(run.openAnimations.every(animation => animation.isCurtain &&
        animation.descendantRows === 0),
      `${mode}: the moving layer is a simple curtain, not the painted row tree`);
      assert.equal(run.openAnimations.length, run.viewportCalls.length,
        `${mode}: every Open-list animation target is the curtain`);
      assert.equal(call.property, 'transform', `${mode}: the list reveal uses a compositor transform`);
      assert.equal(call.delay, 0, `${mode}: the single reveal starts immediately`);
      assert.equal(call.frames.length, 2, `${mode}: the reveal has one continuous interpolation`);
      const finalFrames = run.viewportRetargets.at(-1)?.frames ?? call.frames;
      const finalOffset = Number.parseFloat(finalFrames.at(-1).transform
        .match(/^translateY\(([^)]+)\)$/)?.[1]);
      assert.ok(Math.abs(finalOffset - travel.visible) < 1,
        `${mode}: the final keyframe reaches the visible viewport bottom`);

      const activeFrames = run.frames.filter(frame => frame.listGrowing);
      assert.ok(activeFrames.length >= 6, `${mode}: real intermediate list reveal is perceptible`);
      assert.ok(new Set(activeFrames.map(frame => Math.round(frame.curtainOffset))).size >= 3,
        `${mode}: the reveal edge changes across frames`);
      const midpoint = activeFrames.find(frame =>
        frame.ms - activeFrames[0].ms >= call.duration / 2);
      assert.ok(midpoint, `${mode}: the reveal remains observable through its midpoint`);
      const startOffset = activeFrames[0].curtainOffset;
      const midpointProgress = (midpoint.curtainOffset - startOffset) /
        (travel.visible - startOffset);
      assert.ok(midpointProgress > .7,
        `${mode}: the reveal moves decisively in its first half`);
      assert.ok(Math.max(...activeFrames.map(frame => frame.visibleBottom)) -
        Math.min(...activeFrames.map(frame => frame.visibleBottom)) > 40,
      `${mode}: the list reveals more than a tiny cue`);
      assert.ok(activeFrames.every(frame => frame.sectionBottomColor === 'rgba(0, 0, 0, 0)'),
        `${mode}: the section separator stays hidden during growth`);
      assert.ok(activeFrames.every(frame =>
        Math.abs(frame.sectionBottom - activeFrames[0].sectionBottom) < .5),
      `${mode}: section separator geometry stays fixed during growth`);
      assert.ok(activeFrames.every(frame => frame.cards.every(card => card.rowTransform === 'none')),
        `${mode}: rows retain native text geometry`);

      const firstBodyFrames = activeFrames.map(frame => frame.cards[0].visibleBodyHeight);
      assert.ok(new Set(firstBodyFrames.map(Math.round)).size >= 3,
        `${mode}: the first window body reveals across frames`);
      assert.ok(Math.max(...firstBodyFrames) - Math.min(...firstBodyFrames) > 40,
        `${mode}: the first window body has a material reveal`);
      assert.ok(activeFrames.some(frame => frame.cards[0].visibleBodyHeight > 0 &&
        frame.cards[1].visibleHeaderHeight === 0),
      `${mode}: the next header stays hidden until the first window passes`);
      assert.ok(activeFrames.some(frame => frame.cards[1].visibleHeaderHeight > 0 &&
        frame.cards[2].visibleHeaderHeight === 0),
      `${mode}: the third header waits for the second window`);
    }
    if (mode !== 'reduced') {
      await waitFor(session, '!document.querySelector(".is-window-list-arriving")', 'continuous window sequence settles');
    }
    const callCount = await evaluate(session, '__windowViewportCalls.length');
    await evaluate(session, 'chrome.tabs.create({url:"about:blank",active:false})');
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(await evaluate(session, '__windowViewportCalls.length'), callCount,
      'ordinary tab updates do not replay the list reveal');
    runs.push({ mode, ...run });
  }

  await session.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
  });
  const settledImage = await session.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(output, 'window-settled.png'), Buffer.from(settledImage.data, 'base64'));
  await evaluate(session, `(async()=>{
    const {createWindowGroupArrival}=await import(chrome.runtime.getURL('js/ui/window-group-arrival.js'));
    window.__visualArrival=createWindowGroupArrival({navigationType:'navigate'});
    const body=document.querySelector('[data-sec=open] .sec-inner');
    __visualArrival.reveal(body,'visual');
    const effect=body.querySelector(':scope > .window-list-curtain').getAnimations()[0];
    effect.pause();effect.currentTime=effect.effect.getTiming().duration/2;
    await new Promise(requestAnimationFrame);
  })()`);
  const intermediate = await session.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(output, 'window-intermediate-midpoint.png'), Buffer.from(intermediate.data, 'base64'));
  await evaluate(session, '__visualArrival.destroy()');

  const lifecycle = await evaluate(session, `(async()=>{
    const {createWindowGroupArrival}=await import(chrome.runtime.getURL('js/ui/window-group-arrival.js'));
    const createArrival=()=>createWindowGroupArrival({navigationType:'navigate'});
    const body=document.querySelector('[data-sec=open] .sec-inner');
    const continuity=Number.parseFloat(getComputedStyle(body).getPropertyValue('--motion-continuity'))||180;
    const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const check=(ok,label)=>{if(!ok)throw new Error(label);};
    const curtainOffset=node=>{
      const transform=getComputedStyle(node).transform;
      if(!transform||transform==='none')return 0;
      const matrix=transform.match(/^matrix\\(([^)]+)\\)$/)?.[1].split(',').map(value=>parseFloat(value));
      if(matrix?.length===6)return Number.isFinite(matrix[5])?matrix[5]:0;
      const matrix3d=transform.match(/^matrix3d\\(([^)]+)\\)$/)?.[1].split(',').map(value=>parseFloat(value));
      return matrix3d?.length===16&&Number.isFinite(matrix3d[13])?matrix3d[13]:0;
    };
    const visibleHeight=()=>{
      const curtain=body.querySelector(':scope > .window-list-curtain');
      return curtain?curtainOffset(curtain):body.getBoundingClientRect().height;
    };
    const activeEffect=()=>body.querySelector(':scope > .window-list-curtain')?.getAnimations()[0];
    const fixture=createArrival();
    const callsBefore=__windowViewportCalls.length;
    const retargetsBefore=__windowViewportRetargets.length;
    fixture.reveal(body,'enrichment');
    const scheduledEffect=activeEffect();
    const scheduled=__windowViewportCalls.slice(callsBefore).map(call=>({start:call.ms+call.delay,end:call.ms+call.delay+call.duration,duration:call.duration}));
    const initialCard=body.querySelector('[data-tablist-card]');
    const initial=initialCard.getBoundingClientRect().height;
    const initialHeader=initialCard.querySelector('.item-head-shell').getBoundingClientRect().height;
    const initialBody=initialCard.querySelector('.item-body-frame'),initialBodyStyle=getComputedStyle(initialBody);
    const initialNatural=initialHeader+initialBody.scrollHeight+parseFloat(initialBodyStyle.borderTopWidth)+parseFloat(initialBodyStyle.borderBottomWidth);
    check(Math.abs(initial-initialNatural)<.6,'first actual card retains complete natural geometry');
    await pause(55);
    const before=visibleHeight();
    fixture.reveal(body,'enrichment',()=>{
      const replacement=body.firstElementChild.cloneNode(true);
      const rows=replacement.querySelector('.tl-rows');
      rows.append(rows.querySelector('.trow').cloneNode(true));
      body.replaceChildren(replacement);
    });
    const after=visibleHeight();
    check(Math.abs(after-before)<1,'replacement begins at the currently visible list height');
    const continuedEffect=activeEffect();
    const retargets=__windowViewportRetargets.slice(retargetsBefore);
    check(__windowViewportCalls.length===callsBefore+1&&continuedEffect===scheduledEffect,
      'enrichment retargets the original viewport animation without restarting its easing');
    check(retargets.length===1,'enrichment applies one in-place keyframe update');
    const continued=[{start:scheduled[0].start,end:scheduled[0].end,
      duration:Math.max(0,scheduled[0].end-performance.now())}];
    const settledBy=performance.now()+3000;
    while(body.classList.contains('is-window-list-arriving')&&performance.now()<settledBy)await pause(20);
    check(!body.classList.contains('is-window-list-arriving'),'enriched animation releases ownership');
    const final=body.getBoundingClientRect().height;
    const bodyStyle=getComputedStyle(body);
    const natural=[...body.children].reduce((sum,child)=>sum+child.getBoundingClientRect().height,0)+
      parseFloat(bodyStyle.paddingTop)+parseFloat(bodyStyle.paddingBottom);
    check(Math.abs(final-natural)<1,'final list geometry equals enriched content');
    const finalBodyStyle=body.querySelector('.item-body-frame')&&getComputedStyle(body.querySelector('.item-body-frame'));
    check(parseFloat(finalBodyStyle.borderBottomWidth)>0&&finalBodyStyle.borderBottomStyle!=='none'&&
      finalBodyStyle.borderBottomColor!=='rgba(0, 0, 0, 0)','settled card paints its final lower boundary');
    const finalSectionStyle=getComputedStyle(body.closest('[data-sec=open]'));
    check(finalSectionStyle.borderBottomColor!=='rgba(0, 0, 0, 0)','settled section paints its final separator');
    const callCount=__windowViewportCalls.length;
    fixture.reveal(body,'enrichment');
    check(__windowViewportCalls.length===callCount,'same logical arrival never replays');
    fixture.destroy();

    const shrinkingArrival=createArrival();
    shrinkingArrival.reveal(body,'tab-removed-during-arrival');
    await pause(35);
    check(body.classList.contains('is-window-list-arriving'),
      'a live tab removal can overlap the brief startup curtain');
    const beforeRemoval=body.getBoundingClientRect().height;
    shrinkingArrival.reveal(body,'tab-removed-during-arrival',()=>{
      const replacement=body.firstElementChild.cloneNode(true);
      replacement.querySelector('.tl-rows .trow:last-child')?.remove();
      body.replaceChildren(replacement);
    });
    const afterRemoval=body.getBoundingClientRect().height;
    check(afterRemoval<beforeRemoval-1,
      'the fixture really shortens one visible window during arrival');
    check(!body.classList.contains('is-window-list-arriving')&&
      !body.querySelector(':scope > .window-list-curtain'),
      'a changed live-tab structure settles the curtain before the list shrinks');
    shrinkingArrival.destroy();

    const longList=body.querySelector('.tablist:not([data-compact])');
    const listCards=[...longList.querySelectorAll(':scope > [data-tablist-card]')];
    const bodyCards=listCards.filter(card=>card.querySelector(':scope > .item-body-frame')?.scrollHeight>1);
    check(bodyCards.length>=3,'fixture contains at least three body-bearing windows');
    const shortExtras=listCards.filter(card=>card!==bodyCards[0]);
    shortExtras.forEach(card=>card.remove());
    const shortArrival=createArrival(),shortStart=__windowViewportCalls.length;
    shortArrival.reveal(body,'short-list');
    const shortCall=__windowViewportCalls[shortStart];
    check(shortCall?.duration>=continuity*1.125-2&&shortCall.duration<260,
      'a one-window spatial reveal stays readable and below 300ms');
    while(body.classList.contains('is-window-list-arriving'))await pause(20);
    shortArrival.destroy();

    const tallRows=bodyCards[0].querySelector('.tl-rows');
    const addedTallRows=[];
    while(body.getBoundingClientRect().height<innerHeight*3){
      const row=tallRows.querySelector('.trow').cloneNode(true);
      tallRows.append(row);addedTallRows.push(row);
    }
    const tallArrival=createArrival(),tallStart=__windowViewportCalls.length;
    tallArrival.reveal(body,'tall-window');
    const tallCall=__windowViewportCalls[tallStart];
    const tallEffect=activeEffect();
    const tallViewportHeight=Math.max(0,innerHeight-body.getBoundingClientRect().top);
    const tallFrames=[],tallSampleDeadline=performance.now()+tallCall.duration;
    while((tallEffect.currentTime??0)<tallCall.duration*.6&&performance.now()<tallSampleDeadline){
      await new Promise(requestAnimationFrame);
      tallFrames.push({time:tallEffect.currentTime??0,height:visibleHeight()});
    }
    const tallMidpoint=tallFrames.find(frame=>frame.time>=tallCall.duration/2);
    const tallMidpointHeight=tallMidpoint?.height??Infinity;
    check(tallFrames.length>=6&&tallMidpointHeight>tallViewportHeight*.7,
      'a tall first window advances decisively by midpoint');
    check(tallFrames.every((frame,index)=>index===0||frame.height+1>=tallFrames[index-1].height),
      'a naturally timed tall-window reveal advances monotonically');
    tallArrival.destroy();addedTallRows.forEach(row=>row.remove());
    shortExtras.forEach(card=>longList.append(card));

    const threeCards=new Set(bodyCards.slice(0,3));
    const threeExtras=listCards.filter(card=>!threeCards.has(card));
    threeExtras.forEach(card=>card.remove());
    const longArrival=createArrival(),longStart=__windowViewportCalls.length;
    longArrival.reveal(body,'long-list');
    const longCall=__windowViewportCalls[longStart];
    check(longCall?.duration>=continuity*1.125-2&&longCall.duration<260,
      'a three-window spatial reveal stays readable and below 300ms');
    while(body.classList.contains('is-window-list-arriving'))await pause(20);
    longArrival.destroy();threeExtras.forEach(card=>longList.append(card));

    const resizeArrival=createArrival(),resizeStart=__windowViewportCalls.length;
    resizeArrival.reveal(body,'resize');
    const resizeEffect=activeEffect();
    const frameOffset=frame=>parseFloat(frame.transform.match(/^translateY\\(([^)]+)\\)$/)?.[1]);
    const resizeBefore=frameOffset(resizeEffect.effect.getKeyframes().at(-1));
    const priorMargin=body.style.marginTop;body.style.marginTop='40px';
    window.dispatchEvent(new Event('resize'));
    const resizeAfter=frameOffset(resizeEffect.effect.getKeyframes().at(-1));
    check(activeEffect()===resizeEffect&&__windowViewportCalls.length===resizeStart+1&&
      Math.abs(resizeAfter-resizeBefore+40)<1,
      'viewport changes retarget the original effect to the current visible bottom');
    body.style.marginTop=priorMargin;resizeArrival.destroy();

    const headerOnly=body.querySelector('[data-tablist-card]').cloneNode(true);
    headerOnly.dataset.tablistCard='fixture-header-only';
    headerOnly.querySelector('.item-body-frame').remove();
    body.append(headerOnly);
    const headerArrival=createArrival();
    headerArrival.reveal(body,'header-only');
    check(!headerOnly.getAnimations().length,'header-only card owns no independent animation');
    headerArrival.destroy();headerOnly.remove();

    const added=[];
    for(let i=0;i<6;i++){
      const card=body.querySelector('[data-tablist-card]').cloneNode(true);
      card.dataset.tablistCard='fixture-cap-'+i;longList.append(card);added.push(card);
    }
    const capArrival=createArrival(),capStart=__windowViewportCalls.length;
    capArrival.reveal(body,'cap');
    const capCalls=__windowViewportCalls.slice(capStart);
    check(capCalls.length===1&&capCalls[0].frames.length===2,'large window set uses one continuous reveal '+JSON.stringify(capCalls));
    check(capCalls[0].duration<=continuity*1.395+2,'large window set keeps the bounded visible duration');
    capArrival.destroy();added.forEach(card=>card.remove());

    for(const action of ['pointer','keyboard','wheel']){
      document.activeElement?.blur?.();
      const arrival=createArrival();arrival.reveal(body,action);await pause(30);
      check(body.classList.contains('is-window-list-arriving'),action+' begins with a running effect');
      const naturalHeight=body.getBoundingClientRect().height;
      if(action==='pointer')body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
      if(action==='keyboard')document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
      if(action==='wheel')window.dispatchEvent(new WheelEvent('wheel',{deltaY:20}));
      await pause(0);
      check(!body.classList.contains('is-window-list-arriving'),action+' settles before interaction');
      check(Math.abs(body.getBoundingClientRect().height-naturalHeight)<1&&
        !body.getAnimations({subtree:true}).length,action+' restores natural list geometry after interruption');
      arrival.destroy();
    }
    document.activeElement?.blur?.();
    window.scrollTo(0,100);const scrolled=window.scrollY;
    const scrollArrival=createArrival();scrollArrival.reveal(body,'scrolled');
    check(scrolled>0&&!body.classList.contains('is-window-list-arriving')&&window.scrollY===scrolled,'scrolled page skips arrival without changing position');
    scrollArrival.destroy();window.scrollTo(0,0);
    const activeScrollArrival=createArrival();activeScrollArrival.reveal(body,'scroll-event');
    check(body.classList.contains('is-window-list-arriving'),'programmatic scroll test begins with active effects');
    window.scrollTo(0,100);await pause(40);
    check(!body.classList.contains('is-window-list-arriving'),'programmatic scroll settles the active sequence');
    activeScrollArrival.destroy();window.scrollTo(0,0);
    window.__preferenceArrival=createArrival();__preferenceArrival.reveal(body,'preference');
    check(body.classList.contains('is-window-list-arriving'),'preference test begins with active effects');
    for(const effect of body.getAnimations({subtree:true}))effect.pause();
      return {initial,initialNatural,initialHeader,headerOnlySkipped:true,before,after,remaining:continued[0].duration,final,natural,scheduled,continued,shortDuration:shortCall.duration,tallDuration:tallCall.duration,tallViewportHeight,tallMidpointHeight,longDuration:longCall.duration,resizeBefore,resizeAfter,continuity,capCalls,enrichmentContinuous:true,noReplay:true,finalBoundaryPainted:true,singleViewportAnimation:true,resizeRetargeted:true,pointerKeyboardWheelImmediate:true,scrollEventSettles:true,scrolledPositionPreserved:true};
  })()`);

  await session.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  });
  await waitFor(session, '!document.querySelector(".is-window-list-arriving")', 'live reduced motion settles list');
  await evaluate(session, '__preferenceArrival.destroy()');
  await session.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
  });
  await evaluate(session, `(async()=>{
    const {createWindowGroupArrival}=await import(chrome.runtime.getURL('js/ui/window-group-arrival.js'));
    document.activeElement?.blur?.();window.__hiddenArrival=createWindowGroupArrival({navigationType:'navigate'});
    __hiddenArrival.reveal(document.querySelector('[data-sec=open] .sec-inner'),'hidden');
    if(!document.querySelector('.is-window-list-arriving'))throw new Error('hidden test needs active effects');
    for(const effect of document.querySelector('[data-sec=open] .sec-inner').getAnimations({subtree:true}))effect.pause();
    const current=await chrome.tabs.getCurrent();window.__hiddenOriginal=current.id;
    window.__hiddenOther=(await chrome.tabs.create({windowId:current.windowId,url:'about:blank',active:true})).id;
  })()`);
  await waitFor(session, 'document.hidden&&!document.querySelector(".is-window-list-arriving")', 'real background tab settles list');
  await evaluate(session, `(async()=>{__hiddenArrival.destroy();await chrome.tabs.update(__hiddenOriginal,{active:true});await chrome.tabs.remove(__hiddenOther);})()`);
  lifecycle.hiddenSettled = true;
  const screenshot = await session.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(output, 'window-enrichment-settled.png'), Buffer.from(screenshot.data, 'base64'));
  await writeFile(path.join(output, 'window-arrivals.json'), JSON.stringify({ browser: chromeBin, runs, lifecycle }, null, 2) + '\n');
  console.log(JSON.stringify({
    runs: runs.map(run => ({ mode: run.mode, calls: run.viewportCalls.length, frames: run.frames.length })),
    lifecycle
  }, null, 2));
} finally {
  session?.close();
  await terminateOwnedChrome(chrome);
  await server.close();
  await rm(profile, { recursive: true, force: true });
}
