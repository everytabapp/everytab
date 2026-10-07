// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Two disposable installed profiles, native IndexedDB and a shared OS-folder bridge.
 * This intentionally does not claim native directory-picker or cloud acceptance.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile, stat, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnOwnedChrome, terminateOwnedChrome } from "../extension/test/chrome-test-process.mjs";
import { chromeBin, extensionRoot, debuggingUrl, detectExtension, createTarget,
  evaluate, prepareSession } from "./capture-store-screenshots.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(await readFile(path.join(extensionRoot, "manifest.json"), "utf8")).version;
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const output = path.resolve(process.env.EVERYTAB_VAULT_ACCEPTANCE_OUTPUT ??
  path.join(projectRoot, `review-evidence/installed-acceptance-${version}/vault-${runStamp}`));
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(path.join(tmpdir(), "everytab-vault-acceptance-"));
const sharedFolder = path.join(scratch, "synthetic-vault");
await mkdir(sharedFolder);
const token = randomUUID();
const browsers = [];
const stages = [];
const ioCounts = {};
let failure;
const record = (stage, details) => {
  stages.push({ stage, details });
  console.log(`PASS: ${stage}`);
};

// Each request is confined to the newly created synthetic folder. Handles are
// adapters, not browser FileSystemDirectoryHandles; the physical files are real.
const server = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
  if (request.method === "OPTIONS") { response.end(); return; }
  try {
    assert.equal(request.url, `/${token}`);
    assert.equal(request.method, "POST");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { operation, parts, create, text, recursive } = JSON.parse(Buffer.concat(chunks));
    assert.ok(Array.isArray(parts) && parts.every((part) =>
      typeof part === "string" && part && !/[\\/]/.test(part) && ![".", ".."].includes(part)));
    const filename = path.join(sharedFolder, ...parts);
    ioCounts[operation] = (ioCounts[operation] ?? 0) + 1;
    let value = null;
    if (operation === "directory") {
      if (create) await mkdir(filename, { recursive: false }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
      assert.ok((await stat(filename)).isDirectory());
    } else if (operation === "file") {
      if (create) await writeFile(filename, "", { flag: "wx" }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
      assert.ok((await stat(filename)).isFile());
    } else if (operation === "entries") {
      value = (await readdir(filename, { withFileTypes: true }))
        .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? "directory" : "file" }));
    } else if (operation === "read") value = await readFile(filename, "utf8");
    else if (operation === "write") {
      assert.equal(typeof text, "string");
      const pending = `${filename}.pending-${randomUUID()}`;
      await writeFile(pending, text);
      await rename(pending, filename);
    } else if (operation === "remove") await rm(filename, { recursive: recursive === true });
    else throw new Error("Unsupported fixture operation");
    response.end(JSON.stringify({ value }));
  } catch (error) {
    response.end(JSON.stringify({ error: error.code === "ENOENT" ? "NotFoundError" : "OperationError" }));
  }
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
}).catch(async (error) => { await rm(scratch, { recursive: true, force: true }); throw error; });
const endpoint = `http://127.0.0.1:${server.address().port}/${token}`;

function bridgeExpression() {
  return `(async () => {
    const invoke = async (operation, parts, extra = {}) => {
      const response = await fetch(${JSON.stringify(endpoint)}, {
        method: 'POST', headers: {'content-type':'application/json'},
        body: JSON.stringify({operation,parts,...extra})
      });
      const result = await response.json();
      if(result.error) throw new DOMException('Synthetic file operation failed', result.error);
      return result.value;
    };
    const handle = (parts, kind = 'directory') => ({
      kind, name: parts.at(-1) ?? 'synthetic-vault',
      async getDirectoryHandle(name, options = {}) {
        const next = [...parts,name]; await invoke('directory', next, options); return handle(next);
      },
      async getFileHandle(name, options = {}) {
        const next = [...parts,name]; await invoke('file', next, options); return handle(next,'file');
      },
      async *entries() {
        for(const entry of await invoke('entries',parts)) yield [entry.name,handle([...parts,entry.name],entry.kind)];
      },
      async getFile() { const text = await invoke('read',parts); return new File([text],parts.at(-1)); },
      async createWritable() {
        let contents = '';
        return { async write(value) { contents = value; }, async close() { await invoke('write',parts,{text:contents}); } };
      },
      async removeEntry(name, options = {}) { await invoke('remove',[...parts,name],options); }
    });
    window.vaultFixture = {root:handle([])};
    const f = window.vaultFixture;
    f.store = await import(chrome.runtime.getURL('js/lib/store.js'));
    await f.store.getSettings();
    f.runtime = await import(chrome.runtime.getURL('js/lib/storage/authority-runtime.js'));
    f.replication = await f.runtime.activeVaultStores();
    f.authority = await f.runtime.activeStorageAuthority();
    f.protocol = await import(chrome.runtime.getURL('js/vault/protocol-sync.js'));
    f.restore = await import(chrome.runtime.getURL('js/vault/restore.js'));
    f.rules = await import(chrome.runtime.getURL('js/lib/duplicate-domain-rules.js'));
    f.readPersistedLibrary = async () => {
      const {LIBRARY_DATABASE_NAME} = await import(chrome.runtime.getURL('js/lib/storage/schema.js'));
      const database = await new Promise((resolve,reject) => {
        const request=indexedDB.open(LIBRARY_DATABASE_NAME);
        request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
      });
      try { return await new Promise((resolve,reject) => {
        const stores=[...database.objectStoreNames]; const rows={};
        const transaction=database.transaction(stores,'readonly');
        for(const store of stores) { const request=transaction.objectStore(store).getAll();
          request.onsuccess=()=>{rows[store]=request.result;}; }
        transaction.oncomplete=()=>resolve(rows); transaction.onabort=()=>reject(transaction.error);
      }); } finally {database.close();}
    };
    f.sync = () => f.protocol.syncVault(f.root, {
      ...f.replication, commitRemoteApply: apply => f.store.commitLibraryChange(apply,{authority:f.authority})
    });
    return {version:chrome.runtime.getManifest().version,
      deviceId:await f.store.getDeviceId(), databases:await indexedDB.databases()};
  })()`;
}

async function launch(name) {
  const profile = path.join(scratch, name);
  await mkdir(profile);
  const browser = spawnOwnedChrome(chromeBin, [
    "--headless=new", "--disable-gpu", "--remote-debugging-port=0",
    ...(process.env.EVERYTAB_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
    `--user-data-dir=${profile}`, `--load-extension=${extensionRoot}`,
    `--disable-extensions-except=${extensionRoot}`, "--no-first-run",
    "--disable-background-networking", "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const owned = { browser, profile };
  browsers.push(owned);
  const debug = await debuggingUrl(browser);
  const id = await detectExtension(debug);
  owned.page = await createTarget(debug, `chrome-extension://${id}/dashboard.html`);
  await prepareSession(owned.page);
  owned.identity = await evaluate(owned.page, bridgeExpression());
  return owned;
}

const run = (owner, expression) => evaluate(owner.page, `(async()=>{const f=window.vaultFixture;${expression}})()`);
async function sync(owner) {
  const receipt = await run(owner, "return await f.sync();");
  assert.ok(!receipt.skipped, "fixture sync acquired its per-profile Vault lock");
  return receipt;
}

try {
  const a = await launch("profile-a");
  const b = await launch("profile-b");
  assert.notEqual(a.identity.deviceId, b.identity.deviceId);
  assert.ok(a.identity.databases.length && b.identity.databases.length);
  record("independent installed profiles with native IndexedDB", [a.identity,b.identity]);
  await run(a, `await f.store.patchSettings({newTabWelcomeEnabled:true});
    await f.rules.setDuplicateDomainRule('vault-fixture.example','include-fragment');`);
  record("A publishes initial Library and backup to shared native folder", await sync(a));
  record("B imports A checkpoint and settings", await sync(b));
  assert.deepEqual(await run(b, `return {enabled:(await f.store.getFreshSettings()).newTabWelcomeEnabled,
    rules:await f.rules.readDuplicateDomainRules()};`), {
    enabled:true,rules:[{hostname:"vault-fixture.example",mode:"include-fragment"}]
  });
  await run(b, `await f.store.patchSettings({newTabWelcomeEnabled:false});
    await f.rules.setDuplicateDomainRule('vault-fixture.example','skip');`);
  await sync(b); await sync(a);
  assert.deepEqual(await run(a, `return {enabled:(await f.store.getFreshSettings()).newTabWelcomeEnabled,
    rules:await f.rules.readDuplicateDomainRules()};`), {
    enabled:false,rules:[{hostname:"vault-fixture.example",mode:"skip"}]
  });
  record("B-to-A settings and exact-host rule change converges");
  await run(b, "await f.rules.setDuplicateDomainRule('vault-fixture.example','standard');");
  await sync(b); await sync(a);
  assert.deepEqual(await run(a,"return await f.rules.readDuplicateDomainRules();"),[]);
  record("rule removal converges as an empty portable list");

  const reviewed = await run(a, `const points=await f.restore.listVaultRestorePoints(f.root);
    f.preview=await f.restore.previewVaultRestorePoint(f.root,{library:f.replication.library,name:points[0].name});
    return f.preview;`);
  await run(b, `const record={...await f.store.newMeta(),kind:'tab',tabs:[{
    url:'https://vault-fixture.example/new-after-review',title:'Synthetic remote change'}]};
    f.remoteRecordId=record.id; await f.store.upsertItem('inbox',record);`);
  const remoteId = await run(b,"return f.remoteRecordId;");
  await sync(b); await sync(a);
  const before = await run(a,"return await f.readPersistedLibrary();");
  const rejected = await run(a, `try {
    await f.restore.restoreVaultRestorePoint(f.root,{library:f.replication.library,authority:f.authority,preview:f.preview});
    return {rejected:false};
  } catch(error) { return {rejected:true,message:error.message}; }`);
  assert.equal(rejected.rejected,true);
  assert.match(rejected.message,/changed after.*review/i);
  const after = await run(a,"return await f.readPersistedLibrary();");
  assert.deepEqual(after,before,"stale rejection must preserve complete native Library state");
  assert.ok(await run(a,`const item=await f.store.getFreshItem('inbox',${JSON.stringify(remoteId)}); return Boolean(item && !item.deletedAt);`));
  record("remote sync invalidates Restore review without changing saved state",{
    previewStateHash:reviewed.summary.currentStateHash,...rejected,remoteRecordPreserved:true
  });

  const restored = await run(a, `f.preview=await f.restore.previewVaultRestorePoint(f.root,
    {library:f.replication.library,name:f.preview.point.name});
    f.restored=await f.restore.restoreVaultRestorePoint(f.root,
    {library:f.replication.library,authority:f.authority,preview:f.preview}); return f.restored;`);
  assert.ok(restored.restoreId);
  assert.equal(await run(a,`const item=await f.store.getFreshItem('inbox',${JSON.stringify(remoteId)}); return Boolean(item && !item.deletedAt);`),false);
  await run(a,`await f.restore.undoVaultRestore({library:f.replication.library,authority:f.authority,
    restoreId:f.restored.restoreId});`);
  assert.ok(await run(a,`const item=await f.store.getFreshItem('inbox',${JSON.stringify(remoteId)}); return Boolean(item && !item.deletedAt);`));
  record("fresh Restore applies and Undo preserves the later remote record", {restoreId:restored.restoreId});

  await sync(a); await sync(b); await sync(a);
  const noChangeA = await sync(a);
  const noChangeB = await sync(b);
  for(const receipt of [noChangeA,noChangeB]) {
    assert.equal(receipt.pushed,0); assert.equal(receipt.pulled,0);
    assert.equal(receipt.chunksWritten,0); assert.equal(receipt.chunksRead,0);
    assert.equal(receipt.checkpointWritten,false);
    assert.equal(receipt.recoveryPackWritten,false);
    assert.equal(receipt.recoverySnapshotsWritten,0);
    assert.equal(receipt.viewsWritten,false);
  }
  record("caught-up peers have no-change sync receipts",{a:noChangeA,b:noChangeB});

  const files=[];
  const walk=async(parts=[])=>{
    for(const entry of await readdir(path.join(sharedFolder,...parts),{withFileTypes:true})) {
      const next=[...parts,entry.name];
      if(entry.isDirectory()) await walk(next);
      else { const bytes=await readFile(path.join(sharedFolder,...next));
        files.push({path:next.join('/'),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}); }
    }
  };
  await walk();
  const format=JSON.parse(await readFile(path.join(sharedFolder,'format.json'),'utf8'));
  assert.equal(format.status,'ready');
  assert.ok(files.some(file=>file.path.startsWith('backups/')));
  assert.ok(files.filter(file=>/devices\/.*\/manifest\.json$/.test(file.path)).length >= 2);
  await writeFile(path.join(output,'native-files.json'),JSON.stringify(files,null,2)+'\n');
  record("shared OS directory contains sealed format, both device manifests and backup",{files:files.length,ioCounts});
} catch(error) {
  failure=error;
  console.error(error);
} finally {
  for(const owned of browsers) { owned.page?.client.close(); await terminateOwnedChrome(owned.browser); }
  await new Promise(resolve=>server.close(resolve));
  await rm(scratch,{recursive:true,force:true});
  await writeFile(path.join(output,'result.json'),JSON.stringify({
    passed:!failure,version,at:new Date().toISOString(),mechanism:'native IndexedDB plus shared OS-folder bridge',
    nativeDirectoryPicker:false,cloudOrCrossDevice:false,stages,ioCounts,
    ...(failure?{failure:failure.stack}:{}),cleanup:'owned profiles and synthetic folder removed'
  },null,2)+'\n');
  console.log(`Evidence: ${output}`);
}
if(failure) process.exitCode=1;
