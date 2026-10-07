/** Real-Chrome regressions for Search layering and selection scroll stability. */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnOwnedChrome, terminateOwnedChrome } from "./chrome-test-process.mjs";

const chromeBin = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"
].filter(Boolean).find((candidate) => existsSync(candidate));
if (!chromeBin) throw new Error("Chrome is required for the Dashboard polish DOM test");

const extensionRoot = path.dirname(fileURLToPath(new URL("../manifest.json", import.meta.url)));
const projectRoot = path.dirname(extensionRoot);
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

const listening = new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
await listening;
const port = server.address().port;
const profile = await mkdtemp(`${tmpdir()}/everytab-dashboard-polish-`);
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
  await client.send("Page.bringToFront");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 720, deviceScaleFactor: 1, mobile: false
  });
  await client.send("Page.navigate", {
    url: `http://127.0.0.1:${port}/extension/test/dashboard-polish-dom.html`
  });
  const observed = await client.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 20000;
      const inspect = () => {
        const node = document.querySelector('#result');
        if (node?.dataset.status) resolve({
          status: node.dataset.status,
          text: node.textContent,
          inboxPerfMs: node.dataset.inboxPerfMs || null
        });
        else if (Date.now() >= deadline) reject(new Error('Dashboard polish page timed out'));
        else setTimeout(inspect, 20);
      };
      inspect();
    })`
  });
  if (observed.exceptionDetails) {
    throw new Error(observed.exceptionDetails.exception?.description ??
      observed.exceptionDetails.text ?? observed.result?.description ??
      "Dashboard polish evaluation failed");
  }
  const result = observed.result.value;
  if (result.status !== "pass") throw new Error(result.text || "No result");
  console.log(`${result.text}${result.inboxPerfMs ? ` | 250-card Inbox: ${result.inboxPerfMs} ms` : ""}`);
  await client.send("Page.navigate", {
    url: `http://127.0.0.1:${port}/extension/test/automation-awareness-dom.html`
  });
  const hoverTarget = await client.send("Runtime.evaluate", {
    awaitPromise: true, returnByValue: true,
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const inspect = () => {
        const result = document.querySelector('#result');
        if (result?.dataset.status === 'fail') return reject(new Error(result.textContent));
        if (result?.dataset.status !== 'pass') {
          if (Date.now() > deadline) return reject(new Error('Awareness page timed out'));
          return setTimeout(inspect, 20);
        }
        document.documentElement.dataset.rowInfo = 'detailed';
        const node = document.querySelector('.automation-awareness-copy');
        const r = node.getBoundingClientRect();
        resolve({x:r.x, y:r.y, width:r.width, height:r.height, scale:1});
      }; inspect();
    })`
  });
  if (hoverTarget.exceptionDetails) throw new Error(hoverTarget.exceptionDetails.text);
  const clip = hoverTarget.result.value;
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved", x: clip.x + clip.width / 2, y: clip.y + clip.height / 2
  });
  await client.send("Runtime.evaluate", {
    awaitPromise: true, expression: "new Promise(resolve => setTimeout(resolve, 300))"
  });
  const hovered = await client.send("Page.captureScreenshot", { format: "png", clip });
  const hoverStyle = await client.send("Runtime.evaluate", { returnByValue: true, expression: `(() => {
    const node = document.querySelector('.automation-awareness-copy');
    const style = getComputedStyle(node);
    return {hovered: node.parentElement.matches(':hover'), line: style.textDecorationLine,
      offset: style.textUnderlineOffset, height: node.clientHeight, overflow: style.overflow};
  })()` });
  await client.send("Runtime.evaluate", {
    expression: "document.querySelector('.automation-awareness-copy').style.textDecoration = 'none'"
  });
  const withoutUnderline = await client.send("Page.captureScreenshot", { format: "png", clip });
  if (hovered.data === withoutUnderline.data) {
    throw new Error("Hovering automation status paints no visible underline inside its text bounds: " +
      JSON.stringify(hoverStyle.result.value));
  }
  console.log("PASS: real pointer hover paints a visible automation-status underline");
} finally {
  client?.close();
  await terminateOwnedChrome(chrome);
  server.close();
  await rm(profile, { recursive: true, force: true });
}
