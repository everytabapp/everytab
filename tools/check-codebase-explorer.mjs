// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Real-Chrome interaction contract for the generated root file explorer. */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnOwnedChrome, terminateOwnedChrome } from "../extension/test/chrome-test-process.mjs";

const chromeBin = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"
].filter(Boolean).find((candidate) => existsSync(candidate));
if (!chromeBin) throw new Error("Chrome is required for the codebase explorer test");

const extensionRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const atlas = JSON.parse(await readFile(path.join(extensionRoot, "CODEBASE-ATLAS.json"), "utf8"));
const expected = { version: atlas.version, total: atlas.entries.length,
  runtime: atlas.entries.filter(entry => entry.path.startsWith("extension/js/")).length };
const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript" };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const file = path.resolve(extensionRoot, decodeURIComponent(url.pathname).replace(/^\/+/, ""));
    if (file !== extensionRoot && !file.startsWith(`${extensionRoot}${path.sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": mime[path.extname(file)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const port = server.address().port;
const profile = await mkdtemp(`${tmpdir()}/everytab-codebase-`);
const chrome = spawnOwnedChrome(chromeBin, [
  "--headless=new", "--disable-gpu", "--disable-background-networking",
  "--disable-component-update", "--disable-default-apps", "--no-first-run",
  ...(process.env.EVERYTAB_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });

function debuggingUrl() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Chrome debugging endpoint timed out")), 10_000);
    chrome.stderr.setEncoding("utf8");
    chrome.stderr.on("data", (chunk) => {
      const match = chunk.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    });
    chrome.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited before the test with code ${code}`));
    });
  });
}

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
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }
  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }
  close() { this.socket.close(); }
}

let client;
try {
  const endpoint = new URL(await debuggingUrl());
  const targetResponse = await fetch(`http://${endpoint.host}/json/new?about:blank`, { method: "PUT" });
  const target = await targetResponse.json();
  client = new CdpClient(target.webSocketDebuggerUrl);
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Page.navigate", {
    url: `http://127.0.0.1:${port}/CODEBASE-EXPLORER.html?run=${Date.now()}`
  });
  const observed = await client.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const deadline = Date.now() + 5000;
      while (!document.querySelector('#list button')) {
        if (Date.now() > deadline) throw new Error('Atlas did not mount');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const assert = (value, label) => { if (!value) throw new Error(label); };
      assert(document.querySelector('#purpose').textContent.includes('manager'), 'Initial file purpose');
      const expected = ${JSON.stringify(expected)};
      assert(document.querySelector('.eyebrow').textContent.includes(expected.version), 'Current source version');
      assert(document.querySelectorAll('#list button').length === expected.runtime, 'All runtime modules');
      const search = document.querySelector('#search');
      search.value = 'snooze'; search.dispatchEvent(new Event('input'));
      const matches = [...document.querySelectorAll('#list button')];
      assert(matches.length > 2 && matches.length < expected.runtime, 'Search filters');
      matches[0].click();
      assert(document.querySelector('#path').textContent === matches[0].dataset.path, 'File selection');
      const related = document.querySelector('#relations button');
      assert(related, 'Relationships displayed');
      const target = related.textContent; related.click();
      assert(document.querySelector('#path').textContent === target, 'Relationship navigation');
      search.value = 'impossible-file-marker'; search.dispatchEvent(new Event('input'));
      assert(document.querySelector('#list').textContent.includes('No matching files'), 'Empty search state');
      const area = document.querySelector('#area'); area.value='all'; search.value=''; area.dispatchEvent(new Event('change'));
      assert(document.querySelectorAll('#list button').length === expected.total, 'Full file inventory');
      const data = JSON.parse(document.querySelector('#atlas-data').textContent);
      assert(!data.some(item => item.path === 'extension/js/background/failure-diagnostic.js'), 'Retired source absent');
      assert(data.some(item => item.path === 'extension/js/lib/failure-diagnostic.js'), 'Current diagnostics indexed');
      assert(data.find(item => item.path === 'extension/js/lib/portable-state.js').exports.length > 0, 'Facade exports represented');
      const source = document.querySelector('#relations a');
      assert(source && source.getAttribute('href') === document.querySelector('#path').textContent.split('/').map(encodeURIComponent).join('/'), 'Relative source link');
      area.value='runtime'; area.dispatchEvent(new Event('change'));
      const first = document.querySelector('#list button'); first.focus();
      return {status:'pass', keyboardTarget:first.dataset.path,
        text:'PASS: root explorer current inventory, search, dependency navigation, source links and empty state'};
    })()`
  });
  if (observed.exceptionDetails) {
    throw new Error(observed.exceptionDetails.exception?.description ??
      observed.exceptionDetails.text ?? observed.result?.description ??
      "Codebase explorer browser evaluation failed");
  }
  const result = observed.result.value;
  if (result.status !== "pass") throw new Error(result.text || "No result");
  await client.send("Page.bringToFront");
  await client.send("Runtime.evaluate", { expression: "document.querySelector('#list button').focus()" });
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter",
    windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  const keyboard = await client.send("Runtime.evaluate", { returnByValue: true, awaitPromise: true,
    expression: `(async () => {
      const deadline = Date.now() + 3000;
      while (document.querySelector('#path').textContent !== ${JSON.stringify(result.keyboardTarget)} && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 20));
      return { path: document.querySelector('#path').textContent,
        focused: document.activeElement?.dataset?.path, documentFocused: document.hasFocus() };
    })()` });
  if (keyboard.result.value.path !== result.keyboardTarget)
    throw new Error(`Keyboard file selection failed: ${JSON.stringify({ expected: result.keyboardTarget, ...keyboard.result.value })}`);
  await client.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
  const narrow = await client.send("Runtime.evaluate", { returnByValue: true,
    expression: "document.documentElement.scrollWidth <= document.documentElement.clientWidth" });
  if (narrow.result.value !== true) throw new Error("Explorer overflows at narrow width");
  console.log(result.text + `; keyboard activation and 360px layout; ${expected.runtime} runtime / ${expected.total} indexed files`);
} finally {
  client?.close();
  await terminateOwnedChrome(chrome);
  server.close();
  await rm(profile, { recursive: true, force: true });
}
