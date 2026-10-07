// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  spawnOwnedChrome, terminateOwnedChrome
} from "../extension/test/chrome-test-process.mjs";

const chromeBin = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"
].filter(Boolean).find((candidate) => existsSync(candidate));
if (!chromeBin) throw new Error("Chrome is required for the Open group rail visual check");

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(toolDir);
// A new check must not overwrite the historical captures from its original run.
const evidenceDir = process.env.EVERYTAB_OPEN_GROUP_EVIDENCE_DIR
  ? path.resolve(projectRoot, process.env.EVERYTAB_OPEN_GROUP_EVIDENCE_DIR)
  : path.join(projectRoot, "review-evidence", "selection-range-bulk-payload-0.8.632");
const mime = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript" };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const file = path.resolve(projectRoot, decodeURIComponent(url.pathname).replace(/^\/+/, ""));
    if (file !== projectRoot && !file.startsWith(`${projectRoot}${path.sep}`)) {
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
const profile = await mkdtemp(`${tmpdir()}/everytab-open-group-rail-`);
await mkdir(evidenceDir, { recursive: true });
const chrome = spawnOwnedChrome(chromeBin, [
  "--headless=new", "--disable-gpu", "--disable-background-networking",
  "--disable-component-update", "--disable-default-apps", "--no-first-run",
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
      reject(new Error(`Chrome exited before the check with code ${code}`));
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

const cases = [
  { scheme: "cream", mode: "light" },
  { scheme: "tide", mode: "light" },
  { scheme: "nautilus", mode: "dark" }
];
let client;
try {
  const endpoint = new URL(await debuggingUrl());
  const targetResponse = await fetch(`http://${endpoint.host}/json/new?about:blank`, { method: "PUT" });
  const target = await targetResponse.json();
  client = new CdpClient(target.webSocketDebuggerUrl);
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 820, deviceScaleFactor: 1, mobile: false
  });
  for (const item of cases) {
    const query = new URLSearchParams(item).toString();
    await client.send("Page.navigate", {
      url: `http://127.0.0.1:${port}/extension/test/open-group-rail-dom.html?${query}`
    });
    const observed = await client.send("Runtime.evaluate", {
      awaitPromise: true, returnByValue: true,
      expression: `new Promise((resolve, reject) => {
        const deadline = Date.now() + 15000;
        const inspect = () => {
          const node = document.querySelector('#result');
          if (node?.dataset.status) resolve({
            status: node.dataset.status,
            text: node.textContent,
            firstSelectionMs: Number(node.dataset.firstSelectionMs),
            crossWindowSelectionMs: Number(node.dataset.crossWindowSelectionMs),
            largeSelectionMs: Number(node.dataset.largeSelectionMs)
          });
          else if (Date.now() >= deadline) reject(new Error('Open group rail page timed out'));
          else setTimeout(inspect, 20);
        };
        inspect();
      })`
    });
    if (observed.exceptionDetails) throw new Error(observed.exceptionDetails.text);
    if (observed.result.value.status !== "pass") throw new Error(observed.result.value.text);
    const capture = await client.send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: false
    });
    const file = path.join(evidenceDir, `${item.scheme}-${item.mode}.png`);
    await writeFile(file, Buffer.from(capture.data, "base64"));
    console.log(`${observed.result.value.text} | ${path.relative(projectRoot, file)}`);
  }
} finally {
  client?.close();
  await terminateOwnedChrome(chrome);
  server.close();
  await rm(profile, { recursive: true, force: true });
}
