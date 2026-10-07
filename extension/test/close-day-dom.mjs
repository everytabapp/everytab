import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnOwnedChrome, terminateOwnedChrome } from "./chrome-test-process.mjs";

const chromeBin = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"
].filter(Boolean).find((path) => existsSync(path));
if (!chromeBin) throw new Error("Chrome is required for the Close-the-day DOM test");

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = pathToFileURL(resolve(extensionRoot, "test/close-day-dom.html")).href +
  (process.env.CLOSE_DAY_TEST_REVIEW === "1" ? "?review=1" : "");
const widths = (process.env.CLOSE_DAY_TEST_WIDTHS ?? "320,800,1280")
  .split(",").map(Number).filter(Number.isFinite);
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function chromeDebuggingUrl(child) {
  return new Promise((resolveUrl, rejectUrl) => {
    const timeout = setTimeout(() => rejectUrl(new Error("Chrome debugging endpoint timed out")), 10_000);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolveUrl(match[1]);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectUrl(new Error(`Chrome exited before the mounted test with code ${code}.\n${stderr}`));
    });
  });
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.socket.addEventListener("open", resolveReady, { once: true });
      this.socket.addEventListener("error", rejectReady, { once: true });
    });
    this.socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const result = new Promise((resolveResult, rejectResult) =>
      this.pending.set(id, { resolve: resolveResult, reject: rejectResult }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  close() {
    this.socket.close();
  }
}

async function newPage(debuggingUrl) {
  const endpoint = new URL(debuggingUrl);
  const response = await fetch(`http://${endpoint.host}/json/new?about:blank`, { method: "PUT" });
  if (!response.ok) throw new Error(`Could not create Chrome target (${response.status})`);
  const target = await response.json();
  return new CdpClient(target.webSocketDebuggerUrl);
}

async function waitForResult(client, width) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await client.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const result = document.querySelector('#result');
          const host = document.querySelector('#host');
          return {
            status: result?.dataset.status ?? 'pending',
            text: result?.textContent ?? '',
            mounted: Boolean(host?.firstElementChild),
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth
          };
        })()`
      });
      const state = response.result?.value;
      if (state?.status === "fail") throw new Error(`${width}px: ${state.text}`);
      if (state?.status === "pass") {
        if (!state.mounted) {
          throw new Error(`${width}px: fixture passed without mounting its workflow`);
        }
        if (state.scrollWidth > state.clientWidth + 1) {
          throw new Error(`${width}px: document overflow ${state.scrollWidth}/${state.clientWidth}`);
        }
        return state.text;
      }
    } catch (error) {
      if (String(error?.message ?? error).includes(`${width}px:`)) throw error;
    }
    await delay(50);
  }
  throw new Error(`${width}px: mounted workflow timed out`);
}

const profile = await mkdtemp(`${tmpdir()}/everytab-close-day-ui-`);
const chrome = spawnOwnedChrome(chromeBin, [
  "--headless=new", "--disable-gpu", "--disable-background-networking",
  "--disable-component-update", "--disable-default-apps", "--no-first-run",
  "--allow-file-access-from-files", "--remote-debugging-port=0",
  `--user-data-dir=${profile}`, "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });

let client;
try {
  client = await newPage(await chromeDebuggingUrl(chrome));
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  for (const width of widths) {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width, height: 900, deviceScaleFactor: 1, mobile: false
    });
    await client.send("Page.navigate", { url: fixture });
    console.log(`${width}px ${await waitForResult(client, width)}`);
  }
} finally {
  client?.close();
  await terminateOwnedChrome(chrome);
  await rm(profile, { recursive: true, force: true });
}
