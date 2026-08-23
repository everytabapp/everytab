/** Real-Chrome computed-style matrix for Crisp/Soft across EveryTab surfaces. */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const chromeBin = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"
].filter(Boolean).find((candidate) => existsSync(candidate));
if (!chromeBin) throw new Error("Chrome is required for the Corner style DOM test");

const extensionRoot = path.dirname(fileURLToPath(new URL("../manifest.json", import.meta.url)));
const mime = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript" };
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
const profile = await mkdtemp(`${tmpdir()}/everytab-corner-style-`);
const chrome = spawn(chromeBin, [
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
const passed = [];
try {
  const endpoint = new URL(await debuggingUrl());
  const targetResponse = await fetch(`http://${endpoint.host}/json/new?about:blank`, { method: "PUT" });
  const target = await targetResponse.json();
  client = new CdpClient(target.webSocketDebuggerUrl);
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  for (const corner of ["crisp", "soft"]) {
    for (const width of [320, 800, 1280]) {
      await client.send("Emulation.setDeviceMetricsOverride", {
        width, height: 900, deviceScaleFactor: 1, mobile: false
      });
      await client.send("Page.navigate", {
        url: `http://127.0.0.1:${port}/test/corner-style-dom.html?corner=${corner}`
      });
      const observed = await client.send("Runtime.evaluate", {
        awaitPromise: true,
        returnByValue: true,
        expression: `new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const inspect = () => {
            const node = document.querySelector('#result');
            if (node?.dataset.status) resolve({ status: node.dataset.status, text: node.textContent });
            else if (Date.now() >= deadline) reject(new Error('Corner style page timed out'));
            else setTimeout(inspect, 20);
          };
          inspect();
        })`
      });
      if (observed.exceptionDetails) {
        throw new Error(observed.exceptionDetails.exception?.description ??
          observed.exceptionDetails.text ?? observed.result?.description ??
          "Corner style evaluation failed");
      }
      const result = observed.result.value;
      if (result.status !== "pass") throw new Error(result.text || "No result");
      passed.push(`${corner}@${width}`);
    }
  }
  console.log(`PASS: Corner style DOM matrix ${passed.join(", ")}`);
} finally {
  client?.close();
  if (chrome.exitCode == null) {
    chrome.kill("SIGTERM");
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 1500);
      chrome.once("exit", () => { clearTimeout(timeout); resolve(); });
    });
  }
  server.close();
  await rm(profile, { recursive: true, force: true });
}

