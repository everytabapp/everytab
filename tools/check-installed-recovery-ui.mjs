// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Installed-extension acceptance using native storage and disposable synthetic pages. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnOwnedChrome, terminateOwnedChrome } from "../extension/test/chrome-test-process.mjs";
import {
  chromeBin, extensionRoot, debuggingUrl, detectExtension, createTarget, CdpClient, attachTarget,
  evaluate as evaluateCdp, prepareSession, waitFor
} from "./capture-store-screenshots.mjs";

const version = JSON.parse(await readFile(path.join(extensionRoot, "manifest.json"), "utf8")).version;
const output = path.resolve(process.env.EVERYTAB_RECOVERY_UI_EVIDENCE_DIR ??
  `review-evidence/installed-acceptance-${version}/recovery-ui-${Date.now()}`);
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(tmpdir(), "everytab-installed-recovery-ui-"));
const localFile = path.join(temporary, "synthetic-local-page.html");
await writeFile(localFile, "<!doctype html><title>Acceptance local file</title><h1>Synthetic local file</h1>");
const fileUrl = pathToFileURL(localFile).href;
const server = createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(`<!doctype html><title>Acceptance ${request.url}</title><h1>Synthetic acceptance page</h1>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = spawnOwnedChrome(chromeBin, [
  "--headless=new", "--disable-gpu", "--remote-debugging-port=0",
  ...(process.env.EVERYTAB_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
  `--user-data-dir=${path.join(temporary, "profile")}`,
  `--load-extension=${extensionRoot}`, `--disable-extensions-except=${extensionRoot}`,
  "--no-first-run", "--disable-background-networking", "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });
const evidence = { version, kind: "installed disposable Chrome, native IndexedDB and production handlers", checks: [] };
let page;
let worker;
let failure;
const record = (name, details) => {
  evidence.checks.push({ name, details });
  console.log(`PASS: ${name}`);
};
async function evaluate(session, expression) {
  let timer;
  try {
    return await Promise.race([
      evaluateCdp(session, expression),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Installed fixture evaluation exceeded 20 seconds')), 20_000);
      })
    ]);
  } finally { clearTimeout(timer); }
}
async function poll(expression, predicate, label, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  let observed;
  while (Date.now() < deadline) {
    observed = await evaluate(page, expression);
    if (predicate(observed)) return observed;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`${label}: ${JSON.stringify(observed)}`);
}
async function focusDashboard() {
  await evaluate(page, `(async()=>{
    const tab=await chrome.tabs.getCurrent();
    await chrome.tabs.update(tab.id,{active:true});
    await chrome.windows.update(tab.windowId,{focused:true});
  })()`);
  await page.send("Page.bringToFront");
}
async function closeOtherFixtureWindows() {
  // Headless Chrome may report more than one native window as focused. Each
  // completed recovery is recorded before its synthetic output window is closed,
  // leaving one unambiguous foreground owner for the next live-refresh check.
  await evaluate(page, `(async()=>{
    const own=await chrome.tabs.getCurrent();
    for(const win of await chrome.windows.getAll())if(win.id!==own.windowId)await chrome.windows.remove(win.id);
  })()`);
  await focusDashboard();
}
async function click(selector) {
  await focusDashboard();
  const point = await evaluate(page, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('Missing click target');
    node.scrollIntoView({block:'center'});
    const rect = node.getBoundingClientRect();
    return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
  })()`);
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}
async function clickText(text) {
  const selector = await evaluate(page, `(() => {
    const node = [...document.querySelectorAll('button')].find(n => n.textContent.trim() === ${JSON.stringify(text)});
    if (!node) throw new Error('Missing button: '+${JSON.stringify(text)});
    node.dataset.acceptanceTarget='click'; return '[data-acceptance-target="click"]';
  })()`);
  await click(selector);
  await evaluate(page, `document.querySelector(${JSON.stringify(selector)})?.removeAttribute('data-acceptance-target')`);
}
async function capture(name) {
  const shot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(path.join(output, `${name}.png`), Buffer.from(shot.data, "base64"));
}
try {
  console.log("STAGE: disposable Chrome launched");
  const endpoint = await debuggingUrl(browser);
  const id = await detectExtension(endpoint);
  console.log("STAGE: installed extension detected");
  page = await createTarget(endpoint, `chrome-extension://${id}/dashboard.html#open`);
  await prepareSession(page);
  console.log("STAGE: Dashboard loaded");
  await evaluate(page, `(async()=>{
    await chrome.storage.local.set({onboardingDone:true});
    const store=await import(chrome.runtime.getURL('js/lib/store.js'));
    await store.patchSettings({snapshotEnabled:false,suspendEnabled:false,archiveEnabled:false});
  })()`);
  await page.send("Page.reload");
  await waitFor(page, "document.querySelector('.hero-panel .search-input') && !document.querySelector('.ob-overlay')", "dashboard ready");
  evidence.storage = await evaluate(page, `(async()=>({
    databases:(await indexedDB.databases()).map(db=>db.name),
    authority:await chrome.storage.local.get('storageAuthority')
  }))()`);

  console.log("STAGE: native storage initialized");
  // Capture real open browser tabs, then restore only the candidate checked in the UI.
  const snapshot = await evaluate(page, `(async()=>{
    const tabs=await Promise.all(${JSON.stringify([`${base}/keep`, `${base}/missing`, fileUrl])}.map(url=>chrome.tabs.create({url,active:false})));
    const {takeSnapshot}=await import(chrome.runtime.getURL('js/lib/sessions.js'));
    const snapshot=await takeSnapshot();
    await chrome.tabs.remove(tabs.slice(1).map(tab=>tab.id));
    return {id:snapshot.id,urls:snapshot.windows.flat().map(ref=>ref.url)};
  })()`);
  console.log("STAGE: Snapshot captured and target pages closed");
  assert.ok(snapshot.urls.includes(fileUrl), "actual automatic capture keeps a local HTML file");
  assert.ok(snapshot.urls.every(url => !url.startsWith("chrome-extension:") && !url.startsWith("chrome:")));
  await evaluate(page, "location.hash='data'");
  await waitFor(page, "document.querySelector('#data-area-recover')", "Data recovery mounted");
  await clickText("Check automatic snapshots");
  await waitFor(page, "document.querySelector('select[aria-label=\"Automatic snapshot to compare\"]')", "Snapshot picker ready");
  await evaluate(page, `document.querySelector('select[aria-label="Automatic snapshot to compare"]').value=${JSON.stringify(snapshot.id)}`);
  await clickText("Review missing tabs");
  await waitFor(page, "document.querySelectorAll('.data-recovery-row').length===2", "two missing candidates");
  const candidateTitles = await evaluate(page, "[...document.querySelectorAll('.data-recovery-row')].map(n=>n.textContent)");
  const fileIndex = candidateTitles.findIndex(title =>
    title.includes("Acceptance local file") || title.includes("synthetic-local-page.html"));
  assert.notEqual(fileIndex, -1, "local file is a visible missing candidate");
  const otherIndex = 1 - fileIndex;
  await click(`.data-recovery-row:nth-child(${otherIndex + 1}) input`);
  await click(".data-suspend-recovery .primary");
  await poll("chrome.tabs.query({}).then(t=>t.map(x=>x.url))", urls => urls.filter(url=>url===fileUrl).length===1, "local file restored once");
  const afterFile = await evaluate(page, "chrome.tabs.query({}).then(t=>t.map(x=>x.url))");
  assert.equal(afterFile.includes(`${base}/missing`), false, "unchecked HTTP candidate is not restored");
  await waitFor(page, "document.querySelectorAll('.data-recovery-row').length===1", "candidate list refreshes after file restore");
  const fileReceipt = await evaluate(page, "[...document.querySelectorAll('.data-recovery-status')].map(n=>n.textContent)");
  await capture("snapshot-selected-file");
  await click(".data-suspend-recovery .primary");
  await poll("chrome.tabs.query({}).then(t=>t.map(x=>x.url))", urls=>urls.filter(url=>url===`${base}/missing`).length===1, "remaining page restored once");
  await waitFor(page, "document.querySelectorAll('.data-recovery-row').length===0", "no missing candidates remain");
  record("Snapshot selection restores local file and remaining HTTP page exactly once", { captured: snapshot.urls.length, candidateTitles, fileReceipt });

  await closeOtherFixtureWindows();
  await page.send("Page.reload");
  await waitFor(page, "document.querySelector('#data-area-recover')", "single-window Dashboard initialized");

  // Controlled browser-effect injection: this is native integration coverage,
  // not an assertion that an uninstrumented Chrome failure occurred naturally.
  const partialId = await evaluate(page, `(async()=>{
    const store=await import(chrome.runtime.getURL('js/lib/store.js'));
    const snapshot={...(await store.newMeta()),name:'Acceptance partial recovery',auto:true,labels:[],windows:[
      [{url:${JSON.stringify(`${base}/partial-success`)},title:'Acceptance successful target'}],
      [{url:${JSON.stringify(`${base}/partial-rejected`)},title:'Acceptance rejected target'}]
    ]};
    await store.upsertItem('sessions',snapshot);return snapshot.id;
  })()`);
  const browserClient = new CdpClient(endpoint);
  let workerTarget;
  try {
    const { targetInfos } = await browserClient.send('Target.getTargets');
    workerTarget = targetInfos.find(target => target.type === 'service_worker' &&
      target.url === `chrome-extension://${id}/js/background.js`);
  } finally { browserClient.close(); }
  assert.ok(workerTarget, 'installed production worker is available for the bounded injection');
  worker = await attachTarget(endpoint, workerTarget.targetId);
  await evaluate(worker, `(()=>{
    const original=chrome.windows.create;
    globalThis.__recoveryUiInjection={original,attempts:0};
    chrome.windows.create=async function(options,...rest){
      if([].concat(options?.url??[]).includes(${JSON.stringify(`${base}/partial-rejected`)})){
        globalThis.__recoveryUiInjection.attempts++;
        throw new Error('Synthetic recovery window creation rejected');
      }
      return original.call(chrome.windows,options,...rest);
    };
  })()`);
  await clickText('Check automatic snapshots');
  await waitFor(page, "document.querySelector('select[aria-label=\"Automatic snapshot to compare\"]')", 'partial Snapshot picker ready');
  await evaluate(page, `document.querySelector('select[aria-label="Automatic snapshot to compare"]').value=${JSON.stringify(partialId)}`);
  await clickText('Review missing tabs');
  await waitFor(page, "document.querySelectorAll('.data-recovery-row').length===2", 'both partial Snapshot targets selected');
  await click('.data-suspend-recovery .primary');
  await waitFor(page, "document.querySelectorAll('.data-recovery-row').length===1", 'rejected target remains a recoverable candidate');
  const partialResult = await evaluate(page, `(async()=>({
    status:[...document.querySelectorAll('.data-recovery-status')].map(node=>node.textContent).find(text=>text.includes('could not be confirmed')),
    remaining:document.querySelector('.data-recovery-row')?.textContent,
    urls:(await chrome.tabs.query({})).map(tab=>tab.url)
  }))()`);
  assert.match(partialResult.status ?? '', /1 recovered in 1 new window/);
  assert.match(partialResult.status, /1 tab opening could not be confirmed/);
  assert.match(partialResult.remaining, /Acceptance rejected target/);
  assert.equal(partialResult.urls.filter(url=>url===`${base}/partial-success`).length, 1);
  assert.equal(partialResult.urls.includes(`${base}/partial-rejected`), false);
  assert.equal(await evaluate(worker, 'globalThis.__recoveryUiInjection.attempts'), 1);
  await capture('snapshot-partial-unconfirmed');
  await evaluate(worker, `(()=>{
    chrome.windows.create=globalThis.__recoveryUiInjection.original;
    delete globalThis.__recoveryUiInjection;
  })()`);
  worker.close(); worker = null;
  await click('.data-suspend-recovery .primary');
  await waitFor(page, "document.querySelectorAll('.data-recovery-row').length===0", 'retry completes remaining target');
  const afterRetry = await evaluate(page, 'chrome.tabs.query({}).then(tabs=>tabs.map(tab=>tab.url))');
  assert.equal(afterRetry.filter(url=>url===`${base}/partial-success`).length, 1, 'retry does not duplicate prior success');
  assert.equal(afterRetry.filter(url=>url===`${base}/partial-rejected`).length, 1, 'retry creates the formerly rejected target once');
  record('Injected Snapshot window rejection reports partial recovery and safely retries only the missing target', {
    classification:'controlled worker Chrome API injection, native storage and successful browser effects',
    partialStatus:partialResult.status,remaining:partialResult.remaining,rejectedAttempts:1,
    finalSuccessfulCopies:1,finalRetriedCopies:1
  });
  await closeOtherFixtureWindows();
  await page.send('Page.reload');
  await waitFor(page, "document.querySelector('#data-area-recover')", 'single-window Dashboard reinitialized');

  // Seed future linked Snoozes through the production storage boundary. Their Wake
  // controls send real worker messages; only source repair is done by fixture setup.
  await evaluate(page, `(async()=>{
    const s=await import(chrome.runtime.getURL('js/lib/store.js'));
    window.__acceptanceSnoozes={};
    for(const kind of ['missing','empty']){
      const sessionId='acceptance-'+kind;
      if(kind==='empty')await s.upsertItem('sessions',{...(await s.newMeta()),id:sessionId,name:'Acceptance empty',windows:[],labels:[]});
      const item={...(await s.newMeta()),id:'acceptance-snooze-'+kind,sessionId,title:'Acceptance '+kind,dueAt:Date.now()+3600000};
      await s.upsertItem('snoozes',item);window.__acceptanceSnoozes[kind]=item;
    }
  })()`);
  await focusDashboard();
  await evaluate(page, "location.hash='snoozed'");
  await waitFor(page, "document.querySelector('[data-tablist-card=\"acceptance-snooze-missing\"] [data-action-id=\"wake\"]')", "Snoozed cards ready");
  for (const kind of ["missing", "empty"]) {
    await evaluate(page, `(()=>{
      window.__acceptanceNotices=0;
      new MutationObserver(()=>window.__acceptanceNotices++).observe(document.querySelector('.toast'),{childList:true,subtree:true,characterData:true});
    })()`);
    const prefix = `[data-tablist-card="acceptance-snooze-${kind}"]`;
    const before = await evaluate(page, `(async()=>{
      const s=await import(chrome.runtime.getURL('js/lib/store.js'));
      return {snooze:(await s.readStoreMap('snoozes'))[${JSON.stringify(`acceptance-snooze-${kind}`)}],
        counters:await s.readStoreValue('counters'),tabs:(await chrome.tabs.query({})).map(t=>t.id)};
    })()`);
    const noticesBefore = await evaluate(page, "window.__acceptanceNotices");
    await click(`${prefix} [data-action-id="wake"]`);
    await waitFor(page, `window.__acceptanceNotices > ${noticesBefore} && document.querySelector('.toast')?.textContent.includes('Session')`, "unavailable Session feedback");
    const refusal = await evaluate(page, `(async()=>{
      const s=await import(chrome.runtime.getURL('js/lib/store.js'));
      return {snooze:(await s.readStoreMap('snoozes'))[${JSON.stringify(`acceptance-snooze-${kind}`)}],counters:await s.readStoreValue('counters'),tabs:(await chrome.tabs.query({})).map(t=>t.id),notice:document.querySelector('.toast')?.textContent};
    })()`);
    assert.deepEqual(refusal.tabs, before.tabs);
    assert.deepEqual(refusal.snooze, before.snooze);
    assert.deepEqual(refusal.counters, before.counters);
    assert.equal(refusal.snooze.deletedAt, undefined);
    assert.equal(refusal.snooze.dueAt, before.snooze.dueAt);
    await capture(`snooze-${kind}-retained`);
    await evaluate(page, `(async()=>{
      const s=await import(chrome.runtime.getURL('js/lib/store.js'));
      await s.upsertItem('sessions',{...(await s.newMeta()),id:${JSON.stringify(`acceptance-${kind}`)},name:'Acceptance repaired ${kind}',windows:[[{url:${JSON.stringify(`${base}/repaired-${kind}`)},title:'Repaired ${kind}'}]],labels:[]});
    })()`);
    evidence.repairState = await evaluate(page, `(async()=>({
      visibility:document.visibilityState,focused:document.hasFocus(),window:await chrome.windows.getCurrent(),lastFocused:await chrome.windows.getLastFocused(),
      sessions:await (await import(chrome.runtime.getURL('js/lib/store.js'))).readStoreMap('sessions')
    }))()`);
    await poll(`document.querySelector(${JSON.stringify(prefix)})?.textContent`, text=>text?.includes(`repaired ${kind}`), "repaired Session refreshes card");
    // Wake re-reads the repaired source in the production worker.

    await click(`${prefix} [data-action-id="wake"]`);
    await poll("chrome.tabs.query({}).then(t=>t.map(x=>x.url))", urls=>urls.includes(`${base}/repaired-${kind}`), "repaired Session wakes");
    await poll(`import(chrome.runtime.getURL('js/lib/store.js')).then(s=>s.readStoreMap('snoozes')).then(m=>m[${JSON.stringify(`acceptance-snooze-${kind}`)}])`, value=>Boolean(value?.deletedAt), "delivered Snooze retires");
    record(`Linked Session Snooze: ${kind} source refuses without effect, repair permits Wake`, { notice: refusal.notice, recordRetained: true, countersUnchanged: true, repairedCardRefreshed: true });
    await closeOtherFixtureWindows();
    await page.send("Page.reload");
    await waitFor(page, "document.querySelector('[data-tablist=\"snoozed\"]')", "single-window Snoozed owner initialized");
  }

  // Exercise the installed Session name combobox. Synthetic composition events
  // verify ownership guards, not operation of a native input-method candidate UI.
  await focusDashboard();
  await evaluate(page, "location.hash='sessions'");
  const card = '[data-tablist-card="acceptance-empty"]';
  await waitFor(page, `document.querySelector('${card} [data-action-id="rename"]')`, "Session rename available");
  await click(`${card} [data-action-id="rename"]`);
  await waitFor(page, `${JSON.stringify(card)} && document.querySelector('${card} input[role="combobox"]')`, "name combobox open");
  const composition = await evaluate(page, `(()=>{
    const input=document.querySelector('${card} input[role="combobox"]');
    input.value='日本語 acceptance';input.dispatchEvent(new Event('input',{bubbles:true}));
    const results=[];
    for(const key of ['Enter','ArrowDown','ArrowLeft','ArrowRight','Escape']){
      const event=new KeyboardEvent('keydown',{key,isComposing:true,bubbles:true,cancelable:true});
      input.dispatchEvent(event);results.push({key,prevented:event.defaultPrevented,connected:input.isConnected,focused:document.activeElement===input,value:input.value});
    }
    return results;
  })()`);
  evidence.nameComposition = composition;
  assert.ok(composition.every(row=>!row.prevented&&row.connected&&row.focused&&row.value==='日本語 acceptance'));
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await poll("import(chrome.runtime.getURL('js/lib/store.js')).then(s=>s.readStoreMap('sessions')).then(m=>m['acceptance-empty']?.name)", name=>name==='日本語 acceptance', "ordinary Enter commits name");
  record("Installed Session rename retains composing keys and commits ordinary Enter", { composition, nativeIme: false });

  await click(".hero-panel .search-input");
  await page.send("Input.insertText", { text: "acceptance" });
  await waitFor(page, "document.querySelector('.search-row')", "Search results ready");
  const searchComposition = await evaluate(page, `(()=>{
    const input=document.querySelector('.hero-panel .search-input');
    const before={value:input.value,active:input.getAttribute('aria-activedescendant'),rows:document.querySelectorAll('.search-row').length};
    const results=['Enter','ArrowDown','Escape'].map(key=>{
      const e=new KeyboardEvent('keydown',{key,isComposing:true,bubbles:true,cancelable:true});input.dispatchEvent(e);
      return {key,prevented:e.defaultPrevented,value:input.value,active:input.getAttribute('aria-activedescendant'),focused:document.activeElement===input};
    });return {before,results};
  })()`);
  assert.ok(searchComposition.results.every(row=>!row.prevented&&row.focused&&row.value===searchComposition.before.value&&row.active===searchComposition.before.active));
  record("Installed Search keeps composing Enter/arrows/Escape inside text entry", searchComposition);
  await capture("search-composition-retained");
  evidence.status = "pass";
} catch (error) {
  failure = error;
  evidence.status = "fail";
  evidence.failure = error.stack;
  if (page) {
    evidence.dom = await evaluate(page, "({url:location.href,text:document.body.innerText})").catch(()=>null);
    await capture("failure").catch(()=>{});
  }
  throw error;
} finally {
  // Each owned resource gets its cleanup attempt even if another one fails.
  // Receipt I/O must neither bypass cleanup nor replace the original test error.
  let cleanupFailure;
  const attemptCleanup = async (operation) => {
    try { await operation(); }
    catch (error) { cleanupFailure ??= error; }
  };
  if (worker) {
    await attemptCleanup(() => evaluate(worker, `(()=>{
      if(globalThis.__recoveryUiInjection){
        chrome.windows.create=globalThis.__recoveryUiInjection.original;
        delete globalThis.__recoveryUiInjection;
      }
    })()`));
    await attemptCleanup(() => worker.close());
  }
  await attemptCleanup(() => page?.close());
  await attemptCleanup(() => terminateOwnedChrome(browser));
  await attemptCleanup(() => rm(temporary, { recursive: true, force: true }));
  await attemptCleanup(() => new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve())));
  if (cleanupFailure) {
    evidence.status = "fail";
    evidence.cleanupFailure = cleanupFailure.stack;
  }
  await attemptCleanup(() => writeFile(path.join(output, "verification.json"), JSON.stringify(evidence, null, 2)+"\n"));
  if (!failure && cleanupFailure) throw cleanupFailure;
  console.log(`Evidence: ${output}`);
}
