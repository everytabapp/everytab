// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Record original Chrome screencast frames and replay their native timestamps. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnOwnedChrome, terminateOwnedChrome } from '../extension/test/chrome-test-process.mjs';
import { chromeBin, extensionRoot, debuggingUrl, detectExtension, createTarget,
  evaluate, prepareSession, waitFor } from './capture-store-screenshots.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const build = JSON.parse(await readFile(path.join(extensionRoot, 'manifest.json'), 'utf8')).version;
const scheme = process.argv.find(arg => arg.startsWith('--scheme='))?.split('=')[1] || 'matcha';
assert.ok(['matcha', 'nautilus', 'ink'].includes(scheme), 'Choose Matcha, Nautilus or Ink');
const output = process.env.MINIMAL_REPLAY_OUTPUT || path.join(root, 'review-evidence', `motion-clarity-v${build}`, 'replay');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function jpegDimensions(bytes) {
  assert.equal(bytes.readUInt16BE(0), 0xffd8, 'Native capture is JPEG');
  let offset = 2;
  while (offset < bytes.length) {
    assert.equal(bytes[offset], 0xff, 'Valid JPEG marker');
    const marker = bytes[offset + 1];
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  throw new Error('Native JPEG dimensions missing');
}
async function sourceFingerprint() {
  const files = [];
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.name === 'test' || item.name.startsWith('.') || item.name === 'README.md') continue;
      const filename = path.join(directory, item.name);
      if (item.isDirectory()) await walk(filename); else files.push(filename);
    }
  }
  await walk(extensionRoot);
  const records = await Promise.all(files.sort().map(async filename => ({
    path: path.relative(extensionRoot, filename), sha256: hash(await readFile(filename))
  })));
  return { fileCount: records.length, sha256: hash(JSON.stringify(records)), files: records };
}

function replayHtml(receipt) {
  const frames = receipt.frames.map(({ filename, atMs }) => ({ filename, atMs }));
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EveryTab Minimal motion replay</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f3ef;color:#272923;font:16px/1.5 system-ui,sans-serif}main{max-width:1328px;margin:auto;padding:24px}h1{font-size:24px;line-height:1.2;margin:0 0 8px}p{margin:8px 0 16px;color:#575b51}.controls{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:18px 0}button{font:inherit;border:1px solid #a6aa9e;border-radius:8px;padding:8px 18px;background:white;color:inherit;cursor:pointer}button:focus-visible,input:focus-visible{outline:3px solid #45766d;outline-offset:3px}button:disabled{opacity:.5;cursor:wait}input{flex:1;min-width:140px;accent-color:#45766d}output{min-width:100px;font-variant-numeric:tabular-nums}.frame{display:block;width:auto;max-width:100%;height:auto;max-height:calc(100vh - 220px);margin-inline:auto;aspect-ratio:8/5;background:white;border:1px solid #d6d8d0}small{display:block;color:#575b51;margin-top:12px}a{color:#315f58}
</style><main><h1>Minimal: watch the background arrive.</h1><p>EveryTab ${receipt.build} · ${receipt.scheme} · original Chrome frames, played once at their recorded timing.</p>
<div class="controls"><button id="play" disabled>Loading frames…</button><button id="restart" disabled>Restart</button><label for="seek">Time</label><input id="seek" type="range" min="0" max="${receipt.durationMs}" step="1" value="0" aria-label="Replay time" disabled><output id="time">0.0 s</output></div>
<img class="frame" id="frame" src="${frames[0].filename}" width="1280" height="800" alt="Original browser frame of EveryTab Minimal">
<small>1× timing. No looping, interpolation, reconstructed UI or altered screenshots. This is a disposable-profile reload at 1280 × 800 with motion enabled. The replay samples browser frames, so it cannot prove live display frame rate or smoothness. <a href="capture-evidence.json">Capture details</a></small></main>
<script>
const frames=${JSON.stringify(frames)},duration=${receipt.durationMs};
const image=document.getElementById('frame'),play=document.getElementById('play'),restart=document.getElementById('restart'),seek=document.getElementById('seek'),time=document.getElementById('time');
let elapsed=0,anchor=0,playing=false,raf=0,index=-1;
function paint(value){elapsed=Math.min(duration,Math.max(0,value));let next=0;while(next+1<frames.length&&frames[next+1].atMs<=elapsed)next++;if(next!==index){image.src=frames[next].filename;index=next;}seek.value=elapsed;time.textContent=(elapsed/1000).toFixed(1)+' / '+(duration/1000).toFixed(1)+' s';}
function pause(){playing=false;cancelAnimationFrame(raf);play.textContent=elapsed>=duration?'Play again':'Play';}
function tick(now){paint(now-anchor);if(elapsed>=duration){pause();return;}raf=requestAnimationFrame(tick);}
function start(){if(elapsed>=duration)paint(0);playing=true;anchor=performance.now()-elapsed;play.textContent='Pause';raf=requestAnimationFrame(tick);}
play.addEventListener('click',()=>playing?pause():start());restart.addEventListener('click',()=>{pause();paint(0);start();});seek.addEventListener('input',()=>{pause();paint(Number(seek.value));});document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
Promise.all(frames.map(frame=>{const preload=new Image();preload.src=frame.filename;return preload.decode();})).then(()=>{play.disabled=restart.disabled=seek.disabled=false;paint(0);play.textContent='Play';}).catch(()=>{play.textContent='Could not load frames';});
</script></html>`;
}

await mkdir(path.dirname(output), { recursive: true });
await mkdir(output); // Existing evidence is never silently replaced.
await mkdir(path.join(output, 'frames'));
const before = await sourceFingerprint();
const profile = await mkdtemp(path.join(tmpdir(), 'everytab-minimal-motion-replay-'));
const browser = spawnOwnedChrome(chromeBin, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', '--window-size=1280,1000',
  `--user-data-dir=${profile}`, `--load-extension=${extensionRoot}`, `--disable-extensions-except=${extensionRoot}`,
  '--no-first-run', '--disable-background-networking', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let page;
try {
  const debug = await debuggingUrl(browser), id = await detectExtension(debug);
  const url = `chrome-extension://${id}/newtab.html`;
  page = await createTarget(debug, `chrome-extension://${id}/dashboard.html`);
  const { windowId } = await page.send('Browser.getWindowForTarget');
  await page.send('Browser.setWindowBounds', { windowId, bounds: { width: 1280, height: 1000 } });
  await prepareSession(page);
  // Screencasts use Chrome's visible compositor surface, unlike screenshots.
  await page.send('Emulation.setVisibleSize', { width: 1280, height: 800 });
  await evaluate(page, `Promise.all([chrome.storage.local.set({onboardingDone:true}),import(chrome.runtime.getURL('js/lib/store.js')).then(s=>s.patchSettings({newTabMode:'minimal',newTabFocus:'omnibox',newTabWelcomeEnabled:false,uiGradient:true,uiScheme:${JSON.stringify(scheme)},uiMode:'scheme',uiInterfaceStyle:'soft'}))])`);
  await page.send('Page.navigate', { url });
  await waitFor(page, "document.querySelector('.clock')?.textContent && document.querySelector('.search-field input')", 'Minimal ready');
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await page.send('Page.bringToFront');
  await waitFor(page, "document.visibilityState === 'visible'", 'visible capture surface');
  const packets = [], writes = [], errors = [];
  let collecting = false;
  const onMessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.sessionId !== page.sessionId) return;
    if (message.method === 'Page.frameNavigated' && message.params.frame.url === url && !message.params.frame.parentId) {
      collecting = true;
    }
    if (message.method !== 'Page.screencastFrame') return;
    const { data: encoded, metadata, sessionId } = message.params;
    void page.send('Page.screencastFrameAck', { sessionId }).catch(error => errors.push(error.message));
    if (!collecting) return;
    const bytes = Buffer.from(encoded, 'base64');
    const filename = `frames/${String(packets.length).padStart(4, '0')}.jpg`;
    packets.push({ filename, timestamp: metadata.timestamp, metadata,
      ...jpegDimensions(bytes), sha256: hash(bytes), bytes: bytes.length });
    writes.push(writeFile(path.join(output, filename), bytes));
  };
  page.client.socket.addEventListener('message', onMessage);
  await page.send('Page.startScreencast', { format: 'jpeg', quality: 90, everyNthFrame: 2, maxWidth: 1280, maxHeight: 800 });
  await page.send('Page.reload', { ignoreCache: false });
  await new Promise(resolve => setTimeout(resolve, 7000));
  await page.send('Page.stopScreencast');
  page.client.socket.removeEventListener('message', onMessage);
  await Promise.all(writes);
  assert.equal(errors.length, 0, 'Screencast acknowledgements succeeded');
  assert.ok(packets.length >= 5, `Expected native motion frames, got ${packets.length}`);
  assert.ok(packets.every(frame => frame.width === 1280 && frame.height === 800), 'Native frames must preserve the full viewport');
  const first = packets[0].timestamp;
  const frames = packets.map(packet => ({ ...packet, atMs: Math.round((packet.timestamp - first) * 1000) }));
  assert.ok(frames.every((frame, index) => Number.isFinite(frame.atMs) && (!index || frame.atMs >= frames[index - 1].atMs)));
  const state = await evaluate(page, `({visibility:document.visibilityState,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,scheme:document.documentElement.dataset.scheme,animations:document.getAnimations().filter(a=>a.effect?.target?.classList.contains('orb')).length,placeholder:document.querySelector('.search-input').placeholder,inputValue:document.querySelector('.search-input').value})`);
  const finalStill = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path.join(output, 'final-still.png'), Buffer.from(finalStill.data, 'base64'));
  const after = await sourceFingerprint();
  const minimalPaths = ['js/ui/newtab.js', 'css/newtab.css', 'newtab.html'];
  const minimalSource = after.files.filter(file => minimalPaths.includes(file.path));
  assert.deepEqual(minimalSource, before.files.filter(file => minimalPaths.includes(file.path)), 'Minimal source changed during recording');
  const receipt = { build, scheme, capturedAt: new Date().toISOString(), source: after,
    minimalSource, runtimeChangedDuringRecording: before.sha256 !== after.sha256,
    sourceBeforeSha256: before.sha256, sourceScope: 'Minimal candidate recording; not a final package fingerprint',
    captureToolSha256: hash(await readFile(fileURLToPath(import.meta.url))), viewport: { width: 1280, height: 800 },
    profile: 'disposable, synthetic settings, no personal data', capture: 'Chrome native Page.screencastFrame JPEG quality90, every second presented frame; original bytes without postprocessing',
    timing: 'Original Chrome metadata timestamps; no animation pausing, clock override or playback time scaling',
    durationMs: Math.max(6500, frames.at(-1).atMs), frameCount: frames.length,
    frameBytes: frames.reduce((sum, frame) => sum + frame.bytes, 0), finalState: state, frames };
  await writeFile(path.join(output, 'capture-evidence.json'), JSON.stringify(receipt, null, 2) + '\n');
  await writeFile(path.join(output, 'index.html'), replayHtml(receipt));
  console.log(JSON.stringify({ build, scheme, output, frames: frames.length, durationMs: receipt.durationMs, frameBytes: receipt.frameBytes, source: after.sha256 }, null, 2));
} finally {
  page?.close();
  await terminateOwnedChrome(browser);
  await rm(profile, { recursive: true, force: true });
}
