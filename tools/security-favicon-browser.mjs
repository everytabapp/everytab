// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

// Synthetic installed-Chrome privacy regression. Run: node tools/security-favicon-browser.mjs
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {existsSync,readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnOwnedChrome, terminateOwnedChrome} from '../extension/test/chrome-test-process.mjs';
class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      for (const [id, request] of this.pending) {
        clearTimeout(request.timer);
        request.reject(new Error(`Chrome target closed during command ${id}`));
      }
      this.pending.clear();
    });
  }

  async send(method, params = {}, sessionId = undefined) {
    await this.ready;
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`Chrome DevTools command ${method} timed out`));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return result;
  }

  close() {
    this.socket.close();
  }
}

class CdpSession {
  constructor(client, sessionId) {
    this.client = client;
    this.sessionId = sessionId;
  }

  send(method, params = {}) {
    return this.client.send(method, params, this.sessionId);
  }

  close() {
    this.client.close();
  }
}

async function targetInfos(debugUrl) {
  const client = new CdpClient(debugUrl);
  try {
    return (await client.send("Target.getTargets")).targetInfos ?? [];
  } finally {
    client.close();
  }
}

async function attachTarget(debugUrl, targetId) {
  const client = new CdpClient(debugUrl);
  try {
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    return new CdpSession(client, sessionId);
  } catch (error) {
    client.close();
    throw error;
  }
}

async function createTarget(debugUrl, url, options = {}) {
  const client = new CdpClient(debugUrl);
  try {
    const { targetId } = await client.send("Target.createTarget", { url, ...options });
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    return new CdpSession(client, sessionId);
  } catch (error) {
    client.close();
    throw error;
  }
}


const hits=[];
const server=createServer((req,res)=>{hits.push({url:req.url,referer:req.headers.referer??null,origin:req.headers.origin??null,cookie:req.headers.cookie??null});res.writeHead(200,{'Content-Type':'image/svg+xml'});res.end('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const profile=await mkdtemp(path.join(tmpdir(),'everytab-security-'));
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension');
const chromeRoot=path.join(homedir(),'.cache/puppeteer/chrome');
const candidates=existsSync(chromeRoot)?readdirSync(chromeRoot).sort().reverse().map(v=>path.join(chromeRoot,v,'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')):[];
const chromeBin=[process.env.CHROME_BIN,...candidates,'/usr/bin/google-chrome','/usr/bin/chromium'].find(p=>p&&existsSync(p));
if(!chromeBin)throw new Error('Chrome for Testing required; set CHROME_BIN');
const browser=spawnOwnedChrome(chromeBin,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,`--disable-extensions-except=${root}`,`--load-extension=${root}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','about:blank'],{stdio:['ignore','ignore','pipe']});
let session;
try {
 const ws=await new Promise((resolve,reject)=>{let log='';let timer=setTimeout(()=>reject(new Error('Chrome launch timed out')),15000);browser.stderr.on('data',b=>{log+=b;const match=log.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});});
 let id;
 for(let i=0;i<150;i++){const targets=await targetInfos(ws);id=targets.find(t=>t.url.startsWith('chrome-extension://') && t.url.endsWith('/js/background.js'))?.url.split('/')[2];if(id)break;await new Promise(r=>setTimeout(r,50));}
 if(!id)throw new Error('No extension found');
 session=await createTarget(ws,`chrome-extension://${id}/dashboard.html`);
 await new Promise(r=>setTimeout(r,800));
 const result=await session.send('Runtime.evaluate',{expression:`(async()=>{
 const {parseImport}=await import('./js/lib/import-formats.js');
 const {createTabList}=await import('./js/ui/tablist.js');
 const parsed=parseImport(JSON.stringify({sessions:[{name:'Synthetic import',tabs:[{url:'https://example.com/harmless',title:'Synthetic title <img src=x onerror=alert(1)>',favIconUrl:'http://127.0.0.1:${port}/icon.svg?recipient=synthetic-unique-marker'}]}]}),'session-buddy');
 const ref=parsed.groups[0].tabs[0];
 const embedded='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2216%22 height=%2216%22%3E%3Crect width=%2216%22 height=%2216%22 fill=%22red%22/%3E%3C/svg%3E';
 const hostileSvg='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><script>globalThis.__faviconScriptRan=true</script><image href="http://127.0.0.1:${port}/svg-external-marker" width="16" height="16"/><rect width="16" height="16" fill="red"/></svg>');
 const list=createTabList({section:'security-fixture',groups:[{id:'fixture',title:'Fixture',refs:[ref,{url:'https://example.com/embedded',title:'Embedded',favIconUrl:embedded},{url:'https://example.com/svg',title:'SVG external reference',favIconUrl:hostileSvg}],chips:[]}]});
 document.body.append(list);
 const embeddedImage=[...list.querySelectorAll('img')].find(i=>i.src===embedded);
 await new Promise(resolve=>{if(embeddedImage.complete)resolve();else{embeddedImage.onload=resolve;embeddedImage.onerror=resolve;}});
 return {parsedRef:ref,imgSource:list.querySelector('img')?.src,titleRenderedAsText:list.textContent.includes(ref.title),embeddedLoaded:embeddedImage.naturalWidth===16,scriptRan:globalThis.__faviconScriptRan===true};
 })()`,awaitPromise:true,returnByValue:true});
 assert.equal(result.exceptionDetails,undefined,JSON.stringify(result.exceptionDetails));
 const value=result.result.value;
 assert.equal(new URL(value.imgSource).protocol,'chrome-extension:');
 assert.equal(new URL(value.imgSource).pathname,'/_favicon/');
 assert.equal(value.titleRenderedAsText,true);
 assert.equal(value.embeddedLoaded,true);
 assert.equal(value.scriptRan,false);
 console.log(JSON.stringify({result:value},null,2));
 await new Promise(r=>setTimeout(r,500));
 assert.equal(hits.length,0,'displaying imported favicon must not contact its server');
 console.log('PASS: imported tracking icon made zero requests; cached source and embedded icon retained; HTML title is text');
} finally {session?.close();await terminateOwnedChrome(browser);server.close();await rm(profile,{recursive:true,force:true});}
