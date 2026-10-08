// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Native handle/IndexedDB/syncNow integration in a disposable extension profile.
 * OPFS grants are automatic: this does not prove picker, external-folder permission,
 * revocation, mounted UI or cloud transport behavior.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { CHROME_FIXTURE_ARGS, spawnOwnedChrome, terminateOwnedChrome } from '../extension/test/chrome-test-process.mjs';
import { chromeBin, extensionRoot, debuggingUrl, detectExtension, createTarget,
  evaluate, prepareSession, CdpClient } from './capture-store-screenshots.mjs';

const version = JSON.parse(await readFile(path.join(extensionRoot, 'manifest.json'), 'utf8')).version;
const output = path.resolve(process.env.EVERYTAB_VAULT_HANDLE_OUTPUT ??
  `review-evidence/installed-acceptance-${version}/native-handle-${Date.now()}`);
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'everytab-native-handle-'));
const evidence = { version, mechanism: 'native OPFS FileSystemDirectoryHandle, native IndexedDB and production syncNow',
  nativePicker: false, externalFolderPermissions: false, cloudOrCrossDevice: false, stages: [] };
let browser, page, debug, failure;
const record = (name, details) => { evidence.stages.push({ name, details }); console.log(`PASS: ${name}`); };

async function launch(restore = false) {
  browser = spawnOwnedChrome(chromeBin, [...CHROME_FIXTURE_ARGS, '--headless=new', '--disable-gpu', '--remote-debugging-port=0',
    ...(process.env.EVERYTAB_CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    `--user-data-dir=${profile}`, '--enable-unsafe-extension-debugging',
    '--no-first-run', '--disable-background-networking', ...(restore ? ['--restore-last-session'] : ['about:blank'])
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  debug = await debuggingUrl(browser);
  {
    const manager = await createTarget(debug, 'chrome://extensions');
    const client = new CdpClient(debug);
    try {
      await prepareSession(manager);
      if(!restore){
        await evaluate(manager, 'chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true})');
        evidence.installation = await client.send('Extensions.loadUnpacked', {path:extensionRoot});
      }
      let registrations;
      const expectedId=evidence.installation.id;
      const deadline=Date.now()+15000;
      do {
        registrations=await evaluate(manager,`new Promise(resolve=>chrome.developerPrivate.getExtensionsInfo({},resolve))`);
        if(registrations.some(entry=>entry.id===expectedId&&entry.state==='ENABLED'))break;
        if(Date.now()>deadline)throw new Error('Retained extension registration did not become enabled');
        await new Promise(resolve=>setTimeout(resolve,100));
      }while(true);
      evidence.registrations ??= [];
      evidence.registrations.push(registrations.map(({id,state,disableReasons})=>({id,state,disableReasons})));
    } finally { manager.close(); client.close(); }
  }
  const id = restore ? evidence.extensionId : await detectExtension(debug);
  evidence.extensionId = id;
  // Popup has no Vault auto-sync owner; its installed context also wakes Chrome's extension loader.
  page = await createTarget(debug, `chrome-extension://${id}/popup.html`);
  await prepareSession(page);
  evidence.contexts ??= [];
  evidence.contexts.push(await evaluate(page,'({url:location.href,runtime:chrome?.runtime?.id,storage:!!chrome?.storage})'));
  await evaluate(page, `(async()=>{
    const deadline=Date.now()+15000;
    while(!(await chrome.storage.local.get('storageAuthority')).storageAuthority){
      if(Date.now()>deadline)throw new Error('Fresh-install storage did not initialize');
      await new Promise(resolve=>setTimeout(resolve,40));
    }
    const s=await import(chrome.runtime.getURL('js/lib/store.js'));
    await s.getSettings();
    if(!${restore})await s.patchSettings({suspendEnabled:false,autoArchiveEnabled:false,
      autoSaveMaxTabs:0,dedupAutoClose:false,snapshotEveryMinutes:0});
    const own=await chrome.tabs.getCurrent();
    for(const tab of await chrome.tabs.query({}))if(tab.id!==own.id)await chrome.tabs.remove(tab.id);
    return true;
  })()`);
}
async function closeBrowser({ requireGraceful = false } = {}) {
  let closeError, client;
  const owned = browser;
  try {
    try { page?.close(); } catch (error) { closeError = error; }
    page = null;
    if (owned && debug) {
      client = new CdpClient(debug);
      try { await client.send('Browser.close'); } catch { /* clean process exit below is authoritative */ }
      const deadline = Date.now() + 10_000;
      while (owned.exitCode == null && owned.signalCode == null && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 40));
      if (requireGraceful) {
        assert.equal(owned.exitCode, 0, 'Browser.close must finish with a clean exit before relaunch');
        assert.equal(owned.signalCode, null, 'restart must not depend on forced termination');
        evidence.cleanShutdown = {exitCode:owned.exitCode,signalCode:owned.signalCode};
        evidence.persistedInstallation=[];
        for(const filename of ['Preferences','Secure Preferences']){
          try {const prefs=JSON.parse(await readFile(path.join(profile,'Default',filename),'utf8'));
            evidence.persistedInstallation.push({filename,developer:prefs.extensions?.ui,
              installation:(()=>{const entry=prefs.extensions?.settings?.[evidence.extensionId];return entry?{location:entry.location,path:entry.path,disableReasons:entry.disable_reasons}:null;})()});}
          catch(error){if(error.code!=='ENOENT')throw error;}
        }
      }
    } else if (requireGraceful) throw new Error('No owned browser endpoint for graceful restart');
  } finally {
    try { client?.close(); } finally {
      await terminateOwnedChrome(owned);
      browser = null; debug = null;
    }
  }
  if (closeError && requireGraceful) throw closeError;
}
const run = expression => evaluate(page, `(async()=>{
  const vault=await import(chrome.runtime.getURL('js/vault/vault.js'));
  const sync=await import(chrome.runtime.getURL('js/vault/sync.js'));
  const idb=await import(chrome.runtime.getURL('js/lib/idb.js'));
  ${expression}
})()`);
async function identity() {
  return run(`const handle=await vault.getVaultHandle();
    const expected=await (await navigator.storage.getDirectory()).getDirectoryHandle('synthetic-vault');
    return {native:handle instanceof FileSystemDirectoryHandle,kind:handle.kind,name:handle.name,
      sameEntry:await handle.isSameEntry(expected),permission:await handle.queryPermission({mode:'readwrite'}),
      status:await vault.getVaultStatus()};`);
}
function assertIdentity(value) {
  assert.equal(value.native, true); assert.equal(value.kind, 'directory');
  assert.equal(value.sameEntry, true); assert.equal(value.permission, 'granted');
  assert.deepEqual(value.status, {state:'connected',name:'synthetic-vault'});
}
async function synchronize() {
  const result = await run('const outcome=await sync.syncNow();return {outcome,meta:await vault.getVaultSyncMeta()};');
  assert.equal(result.outcome.status.state, 'connected');
  assert.ok(result.outcome.report && !result.outcome.report.skipped);
  assert.equal(result.meta.ok, true); assert.equal(result.meta.storageVersion, 2);
  return result;
}
function assertNoChange(result) {
  for (const key of ['pushed','pulled','chunksWritten','chunksRead','recoverySnapshotsWritten'])
    assert.equal(result.outcome.report[key], 0, key);
  for (const key of ['checkpointWritten','recoveryPackWritten','viewsWritten'])
    assert.equal(result.outcome.report[key], false, key);
}
async function files() {
  return run(`const root=await vault.getVaultHandle();const result=[];
    async function walk(dir,prefix=''){
      for await(const [name,handle] of dir.entries()){
        const pathname=prefix+name;
        if(handle.kind==='directory')await walk(handle,pathname+'/');
        else {const file=await handle.getFile();const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
          result.push({path:pathname,size:file.size,modified:file.lastModified,
            sha256:[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('')});}
      }
    }
    await walk(root);return result.sort((a,b)=>a.path.localeCompare(b.path));`);
}
try {
  await launch();
  await run(`const handle=await (await navigator.storage.getDirectory()).getDirectoryHandle('synthetic-vault',{create:true});
    await idb.idbSet('vaultDirV2',handle);`);
  const initial = await identity(); assertIdentity(initial);
  record('native directory handle survives IndexedDB structured cloning', initial);
  const first = await synchronize();
  const format = await run(`return JSON.parse(await (await (await vault.getVaultHandle()).getFileHandle('format.json')).getFile().then(f=>f.text()));`);
  assert.equal(format.status, 'ready');
  const published = await files(); assert.ok(published.some(f=>f.path.startsWith('backups/')));
  record('production syncNow publishes a sealed Vault and successful receipt', { first, format, files:published });
  const noChange = await synchronize(); assertNoChange(noChange);
  assert.deepEqual(await files(), published, 'no-change sync preserves contents and file modification times');
  record('no-change sync preserves every Vault file', noChange);

  await page.send('Page.reload'); await prepareSession(page);
  const reloaded = await identity(); assertIdentity(reloaded);
  assertNoChange(await synchronize());
  assert.deepEqual(await files(), published);
  record('page reload retains exact directory identity and no-change behavior', reloaded);

  const lifecycle = new CdpClient(debug);
  let beforeWorker, afterWorker;
  try {
    const currentWorker = async () => (await lifecycle.send('Target.getTargets')).targetInfos.find(target =>
      target.type==='service_worker' && target.url===`chrome-extension://${evidence.extensionId}/js/background.js`);
    beforeWorker = await currentWorker();
    assert.ok(beforeWorker, 'an active worker identifies the pre-reload installation');
    await run('chrome.runtime.reload();').catch(()=>{});
    const deadline=Date.now()+15000;
    do {
      afterWorker=await currentWorker();
      if(afterWorker && afterWorker.targetId!==beforeWorker.targetId)break;
      if(Date.now()>deadline)throw new Error('Extension reload did not replace the worker');
      await new Promise(resolve=>setTimeout(resolve,100));
    }while(true);
  }finally{lifecycle.close();}
  page?.close(); page=null;
  // Reattach after native extension reload; retry until the replacement extension page is live.
  const reloadDeadline=Date.now()+15000;
  while(!page){
    const candidate=await createTarget(debug,`chrome-extension://${evidence.extensionId}/popup.html`);
    try {await prepareSession(candidate);if(await evaluate(candidate,'Boolean(chrome?.storage?.local)'))page=candidate;
      else {await candidate.send('Page.close').catch(()=>{});candidate.close();}}catch{await candidate.send('Page.close').catch(()=>{});candidate.close();}
    if(!page){if(Date.now()>reloadDeadline)throw new Error('Extension reload did not become ready');
      await new Promise(resolve=>setTimeout(resolve,100));}
  }
  assertIdentity(await identity());
  assertNoChange(await synchronize());
  record('extension reload retains the native directory handle',
    {beforeWorker:beforeWorker.targetId,afterWorker:afterWorker.targetId});
  await closeBrowser({requireGraceful:true}); await launch(true);
  const restarted = await identity(); assertIdentity(restarted);
  const afterRestart = await synchronize(); assertNoChange(afterRestart);
  assert.deepEqual(await files(), published);
  record('graceful browser restart retains native handle and no-change behavior', restarted);

  const abortResult = await run(`
    const previous=await vault.getVaultHandle();
    const replacement=await (await navigator.storage.getDirectory()).getDirectoryHandle('aborted-replacement',{create:true});
    const originalPut=IDBObjectStore.prototype.put;
    const originalPicker=window.showDirectoryPicker;
    let aborted=false,timer;
    window.showDirectoryPicker=async()=>replacement;
    IDBObjectStore.prototype.put=function(value,key){
      const request=originalPut.call(this,value,key);
      if(this.transaction.db.name==='tabvault'&&key==='vaultDirV2'){
        const tx=this.transaction;
        request.addEventListener('success',()=>{aborted=true;tx.abort();},{once:true});
      }
      return request;
    };
    let outcome;
    try {
      outcome=await Promise.race([
        vault.pickVaultFolder().then(value=>({resolved:true,value}),error=>({rejected:true,name:error.name})),
        new Promise(resolve=>{timer=setTimeout(()=>resolve({timedOut:true}),3000);})
      ]);
    }finally{
      clearTimeout(timer);IDBObjectStore.prototype.put=originalPut;window.showDirectoryPicker=originalPicker;
    }
    return {outcome,aborted,retainedSameEntry:await previous.isSameEntry(await vault.getVaultHandle()),
      meta:await vault.getVaultSyncMeta()};
  `);
  assert.equal(abortResult.aborted,true);
  assert.deepEqual(abortResult.outcome,{rejected:true,name:'AbortError'});
  assert.equal(abortResult.retainedSameEntry,true);
  assert.deepEqual(abortResult.meta,afterRestart.meta,'folder persistence failure must preserve the exact prior sync receipt');
  assert.deepEqual(await files(),published);
  record('native handle-save abort rejects promptly and preserves previous directory',abortResult);

  const nullObserver = await run('return {outcome:await sync.syncNow({onProgress:null})};');
  assert.equal(nullObserver.outcome.status.state,'connected');assertNoChange(nullObserver);
  const observed = await run(`const stages=[];const outcome=await sync.syncNow({onProgress:progress=>stages.push(progress.stage)});
    return {outcome,stages};`);
  assert.equal(observed.outcome.status.state,'connected');assertNoChange(observed);
  assert.ok(observed.stages.includes('connecting')&&observed.stages.length>1);
  record('optional null observer and actual progress callback both work',{nullObserver,observed});

  // A retained handle may refer to a directory removed outside EveryTab.
  const beforeMissing = await run('return await vault.getVaultSyncMeta();');
  await run(`await (await navigator.storage.getDirectory()).removeEntry('synthetic-vault',{recursive:true});`);
  const missing = await run('return {outcome:await sync.syncNow(),meta:await vault.getVaultSyncMeta(),handle:!!await vault.getVaultHandle()};');
  assert.equal(missing.outcome.status.state, 'error');
  assert.equal(missing.meta.ok, false); assert.ok(missing.meta.lastSyncAt >= beforeMissing.lastSyncAt);
  assert.equal(missing.handle, true, 'failure must not silently forget the configured directory');
  record('missing native directory yields a failed sync receipt and retains its handle', missing);
} catch (error) { failure = error; console.error(error); }
finally {
  evidence.cleanup = {browserTerminated:false,profileRemoved:false};
  try {await closeBrowser();evidence.cleanup.browserTerminated=true;}
  catch(error){failure ??= error;}
  if(evidence.cleanup.browserTerminated){
    try {await rm(profile,{recursive:true,force:true});evidence.cleanup.profileRemoved=true;}
    catch(error){failure ??= error;}
  }
  evidence.passed = !failure;
  if (failure) evidence.failure = failure.stack;
  await writeFile(path.join(output,'result.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(`Evidence: ${output}`);
}
if (failure) process.exitCode = 1;
