// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Real-extension tooltip, toast and disclosure fixture. Uses disposable data only.
 * Run: node tools/check-delight-interactions.mjs
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
const output = path.join(projectRoot, 'review-evidence/delight-v0.8.597');
const profile = await mkdtemp(path.join(tmpdir(), 'everytab-delight-interactions-'));
const server = await startFixtureServer();
const mappedHosts = [...new Set(Object.values(SITES).map(({ host }) => host))]
  .map((host) => `MAP ${host} 127.0.0.1`).join(',');
const chrome = spawnOwnedChrome(chromeBin, [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, `--disable-extensions-except=${extensionRoot}`,
  `--load-extension=${extensionRoot}`, `--host-resolver-rules=${mappedHosts}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });

let session;
try {
  await mkdir(output, {recursive:true});
  const debugUrl = await debuggingUrl(chrome);
  const id = await detectExtension(debugUrl);
  session = await createTarget(debugUrl, `chrome-extension://${id}/dashboard.html#open`);
  await prepareSession(session);
  await evaluate(session, seedExpression(captureFixture(server.port)));
  await session.send('Page.navigate', {url:`chrome-extension://${id}/dashboard.html#open`});
  await waitFor(session, 'document.querySelectorAll(".navgroup").length >= 2', 'saved navigation branches');
  const results=[];
  for(const reduced of [false,true]) {
    await session.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}]});
    const result=await evaluate(session, `import(chrome.runtime.getURL('test/delight-interactions-browser.js')).then(m=>m.runInteractionChecks(${reduced}))`);
    results.push(result);
  }
  await session.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await evaluate(session, `(async()=>{
    const {createUndoToast}=await import(chrome.runtime.getURL('js/ui/toast.js'));
    const toast=createUndoToast();document.body.append(toast.element);toast.showNotice('Preference-change fixture');
    const branch=document.querySelector('.navgroup:has([data-page="labels"])');
    if(!branch.classList.contains('open'))branch.querySelector('.twist').click();
    await new Promise(r=>setTimeout(r,220));
    branch.querySelector('.twist').click();toast.hideToast();
    globalThis.__interactionPreferenceProbe={toast,subnav:branch.querySelector('.subnav')};
  })()`);
  await session.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await new Promise(r=>setTimeout(r,60));
  const preference=await evaluate(session, `(()=>{
    const {toast,subnav}=__interactionPreferenceProbe;
    const result={toastHidden:toast.element.classList.contains('hidden'),toastAnimations:toast.element.getAnimations().length,
      foldAnimations:subnav.getAnimations().length,foldStyle:subnav.style.blockSize,foldInert:subnav.inert};
    toast.element.remove();delete globalThis.__interactionPreferenceProbe;return result;
  })()`);
  assert.ok(preference.toastHidden && preference.toastAnimations===0 && preference.foldAnimations===0 && !preference.foldStyle && preference.foldInert,'changing reduced motion settles active exits immediately');
  results.push({preferenceChange:preference});
  await writeFile(path.join(output,'interactions-browser.json'),JSON.stringify({capturedAt:new Date().toISOString(),browser:chromeBin,results},null,2)+'\n');
  console.log(JSON.stringify(results,null,2));
} finally {
  session?.close();
  await terminateOwnedChrome(chrome);
  await server.close();
  await rm(profile,{recursive:true,force:true});
}
