/** Real-Chrome 2×2 scheme-selector and reserved-star regression. */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnOwnedChrome, terminateOwnedChrome } from "./chrome-test-process.mjs";

const chromeBin = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"
].filter(Boolean).find((candidate) => existsSync(candidate));
if (!chromeBin) throw new Error("Chrome is required for the scheme selector regression");

const extensionRoot = path.dirname(fileURLToPath(new URL("../manifest.json", import.meta.url)));
const projectRoot = path.resolve(extensionRoot, "..");
const servedRoots = [extensionRoot, path.join(projectRoot, "tools")];
const servedRealRoots = await Promise.all(servedRoots.map((root) => realpath(root)));
const mime = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript" };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const file = path.resolve(projectRoot, decodeURIComponent(url.pathname).replace(/^\/+/, ""));
    if (!servedRoots.some((root) => file === root || file.startsWith(`${root}${path.sep}`))) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const resolved = await realpath(file);
    if (!servedRealRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const body = await readFile(resolved);
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

const profile = await mkdtemp(`${tmpdir()}/everytab-theme-picker-`);
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

  const results = [];
  for (const width of [320, 400, 800]) {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width, height: 720, deviceScaleFactor: 1, mobile: false
    });
    await client.send("Page.navigate", {
      url: `http://127.0.0.1:${server.address().port}/tools/theme-picker-harness.html?width=${width}`
    });
    const observed = await client.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const inspect = () => {
          const text = document.querySelector('#theme-picker-result')?.textContent ?? '';
          let result = null;
          try { result = text ? JSON.parse(text) : null; } catch {}
          if (result?.width === ${width}) resolve(result);
          else if (Date.now() >= deadline) reject(new Error('Scheme selector page timed out at ${width}px'));
          else setTimeout(inspect, 20);
        };
        inspect();
      })`
    });
    if (observed.exceptionDetails) {
      throw new Error(observed.exceptionDetails.exception?.description ??
        observed.exceptionDetails.text ?? observed.result?.description ??
        `Scheme selector evaluation failed at ${width}px`);
    }
    const result = observed.result.value;
    if (!result.pass) throw new Error(`Selector failed at ${width}px: ${JSON.stringify(result)}`);
    results.push(result);
  }

  if (results.some(({ quadrantColumns }) => quadrantColumns !== 2) ||
      results[0].favoriteColumns !== 1 || results[1].favoriteColumns !== 1 ||
      results[2].favoriteColumns !== 2) {
    throw new Error(`Unexpected responsive matrix: ${results.map(({ quadrantColumns, favoriteColumns }) =>
      `${quadrantColumns}/${favoriteColumns}`).join(", ")}`);
  }
  console.log(`PASS: scheme selector ${results.map((result) =>
    `${result.width}px/${result.quadrantColumns}×${result.favoriteColumns} overflow=${result.documentOverflow}`
  ).join(", ")}`);
} finally {
  client?.close();
  await terminateOwnedChrome(chrome);
  server.close();
  await rm(profile, { recursive: true, force: true });
}
