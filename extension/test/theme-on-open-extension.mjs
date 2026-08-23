/**
 * Installed-shape D3 regression.
 *
 * Loads this exact unpacked extension into a fresh Chrome profile, writes the
 * real extension storage, then opens repeated real chrome://newtab/ targets.
 * This deliberately does not mock theme.js, storage events, module timing, or
 * the New Tab override.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.dirname(here);
let extensionId = createHash("sha256").update(extensionRoot).digest("hex").slice(0, 32)
  .replace(/[0-9a-f]/g, (nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16)));
const chromeCandidates = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].filter(Boolean);
const chromeBin = chromeCandidates.find((candidate) => existsSync(candidate));
if (!chromeBin) throw new Error("Chrome is required for the installed-shape theme regression");
const directOpenCount = Math.max(1, Number.parseInt(process.env.EVERYTAB_OPEN_COUNT ?? "8", 10) || 8);
const newTabMode = process.env.EVERYTAB_NEW_TAB_MODE === "minimal" ? "minimal" : "dashboard";
const newTabFocus = process.env.EVERYTAB_NEW_TAB_FOCUS === "omnibox" ? "omnibox" : "search";
const maxContentReadyMs = Number(process.env.EVERYTAB_MAX_CONTENT_READY_MS ?? 0);
const maxSingletonMs = Number(process.env.EVERYTAB_MAX_SINGLETON_MS ?? 0);
const liveTabCount = Math.max(0, Number.parseInt(process.env.EVERYTAB_LIVE_TAB_COUNT ?? "0", 10) || 0);
const liveWindowCount = Math.max(1, Number.parseInt(process.env.EVERYTAB_LIVE_WINDOW_COUNT ?? "1", 10) || 1);
const useStableExtensionTarget = process.env.EVERYTAB_STABLE_EXTENSION_TARGET === "1";
const useHeadlessChrome = process.env.EVERYTAB_CHROME_HEADLESS === "1";

function debuggingUrl(process) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Chrome debugging endpoint timed out")), 10_000);
    let stderr = "";
    process.stderr.setEncoding("utf8");
    process.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    });
    process.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited before the test with code ${code}.\n${stderr}`));
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
        request.reject(new Error(`Chrome DevTools target closed during command ${id}`));
      }
      this.pending.clear();
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`Chrome DevTools command ${method} timed out`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  close() {
    this.socket.close();
  }
}

async function detectInstalledExtensionId(debugUrl, fallback) {
  const client = new CdpClient(debugUrl);
  try {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const { targetInfos = [] } = await client.send("Target.getTargets");
      const everyTabTarget = targetInfos.find(({ url = "" }) => {
        if (!url.startsWith("chrome-extension://")) return false;
        try {
          const pathname = new URL(url).pathname;
          return pathname.endsWith("/js/background.js") ||
            pathname.endsWith("/dashboard.html") ||
            pathname.endsWith("/newtab.html");
        } catch {
          return false;
        }
      });
      if (everyTabTarget) return new URL(everyTabTarget.url).host;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return fallback;
  } finally {
    client.close();
  }
}

async function newTarget(debugUrl, url) {
  const endpoint = new URL(debugUrl);
  const response = await fetch(`http://${endpoint.host}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT"
  });
  if (!response.ok) throw new Error(`Could not create target (${response.status})`);
  const target = await response.json();
  return new CdpClient(target.webSocketDebuggerUrl);
}

const schemeTraceScript = `(() => {
  const trace = [];
  globalThis.__everyTabSchemeTrace = trace;
  globalThis.__everyTabPageErrors = [];
  addEventListener("error", (event) => globalThis.__everyTabPageErrors.push(
    event.error?.stack || event.message || "page-error"
  ));
  addEventListener("unhandledrejection", (event) => globalThis.__everyTabPageErrors.push(
    event.reason?.stack || String(event.reason || "unhandled-rejection")
  ));
  const read = () => document.documentElement?.dataset.customScheme ||
    document.documentElement?.dataset.scheme || "";
  const record = (source) => {
    const scheme = read();
    if (!scheme || trace.at(-1)?.scheme === scheme) return;
    trace.push({
      scheme,
      source,
      at: performance.now(),
      readyState: document.readyState,
      bootSelection: globalThis.__everyTabBootThemeSelection ?? null
    });
  };
  const observer = new MutationObserver(() => record("mutation"));
  observer.observe(document, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-scheme", "data-custom-scheme"]
  });
  document.addEventListener("readystatechange", () => record("ready-state"));
  setInterval(() => record("sample"), 2);
})()`;

async function newTracedTarget(debugUrl, url) {
  const client = await newTarget(debugUrl, "about:blank");
  await client.send("Page.addScriptToEvaluateOnNewDocument", { source: schemeTraceScript });
  await client.send("Page.navigate", { url });
  return client;
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ??
      response.exceptionDetails.text ?? "Chrome evaluation failed");
  }
  return response.result?.value;
}

async function waitFor(client, expression, label, timeout = 3000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = await evaluate(client, expression);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const profile = await mkdtemp(`${tmpdir()}/everytab-theme-on-open-`);
const chrome = spawn(chromeBin, [
  ...(process.env.EVERYTAB_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
  ...(useHeadlessChrome ? ["--headless=new"] : []),
  "--disable-gpu",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--no-first-run",
  `--disable-extensions-except=${extensionRoot}`,
  `--load-extension=${extensionRoot}`,
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "--window-size=480,640",
  "--window-position=-10000,-10000",
  "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });

const clients = [];
try {
  const debugUrl = await debuggingUrl(chrome);
  console.log("EveryTab installed gate: Chrome debugging ready");
  extensionId = await detectInstalledExtensionId(debugUrl, extensionId);
  console.log(`EveryTab installed gate: extension ${extensionId.slice(-6)} detected`);
  const seed = await newTarget(debugUrl,
    `chrome-extension://${extensionId}/suspend.html?originalUrl=https%3A%2F%2Fexample.com`);
  clients.push(seed);
  await waitFor(seed, "typeof chrome?.storage?.local?.get === 'function'", "extension storage");
  // Let the fresh-install dashboard finish before establishing the rotation
  // baseline; that one-time welcome surface is not part of a mature-profile
  // New Tab sequence.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await evaluate(seed, `(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ settings: {
      uiScheme: "devtty",
      uiMode: "scheme",
      uiGradient: false,
      schemeFavorites: [],
      schemeRotate: "open",
      newTabMode: "${newTabMode}",
      newTabFocus: "${newTabFocus}",
      oneNewTabPerWindow: false
    }});
    globalThis.themeRotationWrites = [];
    chrome.storage.onChanged.addListener((changes, area) => {
      const before = changes.settings?.oldValue?.uiScheme;
      const after = changes.settings?.newValue?.uiScheme;
      if (area === "local" && before && after && before !== after) {
        globalThis.themeRotationWrites.push({ before, after });
      }
    });
    localStorage.clear();
    return true;
  })()`);
  await waitFor(seed, `(async () => {
    const cache = JSON.parse(localStorage.getItem("tvTheme") || "null");
    const prepared = (await chrome.storage.local.get("schemeRotationPrepared"))
      .schemeRotationPrepared;
    return cache?.preparedTheme && prepared?.next ? true : null;
  })()`, "warm prepared rotation cache", 10_000);
  console.log("EveryTab installed gate: rotation baseline ready");

  if (liveTabCount > 0) {
    await evaluate(seed, `(async () => {
      const total = ${liveTabCount};
      const windowCount = ${liveWindowCount};
      const widths = Array.from({ length: windowCount }, (_, index) =>
        Math.floor(total / windowCount) + (index < total % windowCount ? 1 : 0));
      for (let windowIndex = 0; windowIndex < widths.length; windowIndex += 1) {
        const count = widths[windowIndex];
        if (!count) continue;
        const createdWindow = await chrome.windows.create({
          url: "https://example.invalid/everytab-fixture/" + windowIndex + "/0",
          focused: false
        });
        await Promise.all(Array.from({ length: Math.max(0, count - 1) }, (_, tabIndex) =>
          chrome.tabs.create({
            windowId: createdWindow.id,
            active: false,
            url: "https://example.invalid/everytab-fixture/" + windowIndex + "/" + (tabIndex + 1)
          })));
      }
      return true;
    })()`, 30_000);
    // This models a mature profile, not a burst benchmark. Creating 120 fresh
    // network pages immediately before timing leaves Chrome's renderer/network
    // work racing the extension and makes the result describe fixture setup.
    // Wait until those exact fixture tabs have settled, then give their final
    // tab events one task boundary before opening the measured New Tab.
    await waitFor(seed, `(async () => {
      const tabs = await chrome.tabs.query({});
      const fixture = tabs.filter((tab) =>
        (tab.pendingUrl || tab.url || "").startsWith("https://example.invalid/everytab-fixture/"));
      return fixture.length === ${liveTabCount} && fixture.every((tab) => tab.status !== "loading")
        ? true
        : null;
    })()`, "settled mature-profile fixture", 30_000);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const observed = [];
  const inspectedNewTabUrl = useStableExtensionTarget
    ? `chrome-extension://${extensionId}/newtab.html?focus=search`
    : "chrome://newtab/";
  const baselineOperational = await evaluate(seed, `(async () => ({
    cache: JSON.parse(localStorage.getItem("tvTheme") || "null"),
    prepared: (await chrome.storage.local.get("schemeRotationPrepared")).schemeRotationPrepared,
    state: (await chrome.storage.local.get("schemeRotationState")).schemeRotationState
  }))()`);
  for (let index = 0; index < directOpenCount; index += 1) {
    const tab = await newTracedTarget(debugUrl, inspectedNewTabUrl);
    clients.push(tab);
    let result;
    try {
      result = await waitFor(tab, `(async () => {
        if (!location.href.startsWith("chrome-extension://${extensionId}/newtab.html")) return null;
        const stored = (await chrome.storage.local.get("settings")).settings?.uiScheme;
        const painted = document.documentElement.dataset.customScheme ||
          document.documentElement.dataset.scheme;
        if (!stored || painted !== stored) return null;
        const openBody = document.querySelector('[data-sec="open"] .sec-inner');
        const contentReady = "${newTabMode}" === "minimal"
          ? Boolean(document.querySelector(".minimal-clock") && document.querySelector(".minimal-deck"))
          : Boolean(openBody?.childElementCount && !openBody.querySelector(".loading-feedback"));
        if (!contentReady) return null;
        return {
          href: location.href,
          stored,
          painted,
          bootPainted: globalThis.__everyTabBootThemeSelection ?? null,
          contentReady,
          contentReadyAt: performance.now()
        };
      })()`, `New Tab ${index + 1} rotation`, 10_000);
    } catch (error) {
      const state = await evaluate(tab, `(async () => ({
        href: location.href,
        readyState: document.readyState,
        painted: document.documentElement.dataset.customScheme ||
          document.documentElement.dataset.scheme,
        stored: (await chrome.storage.local.get("settings")).settings?.uiScheme,
        appChildren: document.querySelector("#app")?.childElementCount ?? -1,
        errors: globalThis.__everyTabPageErrors ?? []
      }))()`);
      throw new Error(`${error.message}: ${JSON.stringify(state)}`);
    }
    const writeCount = await evaluate(seed, "globalThis.themeRotationWrites.length");
    if (writeCount !== index + 1) {
      const writes = await evaluate(seed, "globalThis.themeRotationWrites");
      throw new Error(`New Tab ${index + 1} caused ${writeCount} total scheme writes; ` +
        `expected exactly ${index + 1}: ${JSON.stringify(writes)}`);
    }
    observed.push(result);
  }
  console.log(`EveryTab installed gate: ${directOpenCount} New Tab paints verified`);

  const wrongBootPaint = observed.find(({ bootPainted, stored }) =>
    bootPainted && bootPainted !== stored
  );
  if (observed.some(({ bootPainted }) => !bootPainted)) {
    throw new Error(`New Tab did not expose its synchronous boot selection: ` +
      JSON.stringify(observed));
  }
  if (wrongBootPaint) {
    throw new Error(`New Tab synchronously painted ${wrongBootPaint.bootPainted} ` +
      `before settling on ${wrongBootPaint.stored}; baseline=` +
      `${JSON.stringify(baselineOperational)}; observed=${JSON.stringify(observed)}`);
  }

  const schemes = observed.map(({ painted }) => painted);
  if (schemes[0] === "devtty") {
    throw new Error(`First New Tab did not rotate: ${schemes.join(" -> ")}`);
  }
  if (new Set(schemes).size !== schemes.length) {
    throw new Error(`Repeated New Tabs stalled or repeated: ${schemes.join(" -> ")}`);
  }
  const slowContent = maxContentReadyMs > 0
    ? observed.find(({ contentReadyAt }) => contentReadyAt > maxContentReadyMs)
    : null;
  if (slowContent) {
    throw new Error(`${newTabMode} content needed ${slowContent.contentReadyAt.toFixed(1)}ms; ` +
      `budget ${maxContentReadyMs.toFixed(1)}ms`);
  }

  // Keep the eight Dashboard contexts above alive, then inspect the actual
  // pre-paint-to-settled timeline of one more New Tab. Multiple extension pages
  // share one localStorage cache, so final-state-only assertions cannot catch a
  // visible next-scheme -> following-scheme -> authoritative-scheme flash.
  const traced = await newTracedTarget(debugUrl, inspectedNewTabUrl);
  clients.push(traced);
  const tracedResult = await waitFor(traced, `(async () => {
    if (!location.href.startsWith("chrome-extension://${extensionId}/newtab.html")) return null;
    const stored = (await chrome.storage.local.get("settings")).settings?.uiScheme;
    const painted = document.documentElement.dataset.customScheme ||
      document.documentElement.dataset.scheme;
    if (!stored || painted !== stored) return null;
    const openBody = document.querySelector('[data-sec="open"] .sec-inner');
    const contentReady = "${newTabMode}" === "minimal"
      ? Boolean(document.querySelector(".minimal-clock") && document.querySelector(".minimal-deck"))
      : Boolean(openBody?.childElementCount && !openBody.querySelector(".loading-feedback"));
    if (!contentReady) return null;
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { stored, painted, trace: globalThis.__everyTabSchemeTrace ?? [] };
  })()`, "traced New Tab rotation", 10_000);
  // Ignore the static HTML fallback observed while Chrome is still parsing the
  // first head script. The product default can change; the first meaningful
  // paint begins once boot.js records the synchronous cache selection.
  const distinctPaints = tracedResult.trace
    .filter(({ bootSelection }) => bootSelection)
    .map(({ scheme }) => scheme)
    .filter(Boolean);
  const intermediatePaints = distinctPaints.filter((scheme) => scheme !== tracedResult.stored);
  if (intermediatePaints.length) {
    throw new Error(`New Tab visibly painted a non-final scheme before settling: ` +
      `${JSON.stringify(tracedResult.trace)}; final=${tracedResult.stored}`);
  }
  const expectedWrites = directOpenCount + 1;
  const finalWrites = await evaluate(seed, "globalThis.themeRotationWrites.length");
  if (finalWrites !== expectedWrites) {
    throw new Error(`Traced New Tab caused ${finalWrites} total scheme writes; ` +
      `expected ${expectedWrites}`);
  }
  console.log("EveryTab installed gate: traced paint verified");
  await evaluate(seed, `(async () => {
    const stored = (await chrome.storage.local.get("settings")).settings;
    await chrome.storage.local.set({ settings: {
      ...stored,
      newTabFocus: "omnibox",
      oneNewTabPerWindow: true
    } });
    return true;
  })()`);
  // Create the browser's default New Tab through chrome.tabs rather than a
  // DevTools `Target.createTarget(chrome://newtab/)` shortcut. This exercises
  // the same native override lifecycle as Cmd+T, including tabs.onCreated,
  // the override mount message, and worker-owned retirement.
  const singletonState = await evaluate(seed, `(async () => {
    const startedAt = performance.now();
    const createdTabs = [];
    for (let index = 0; index < 3; index += 1) {
      createdTabs.push(await chrome.tabs.create({ active: true }));
    }
    const createdIds = new Set(createdTabs.map((tab) => tab.id));
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const [live] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (live) {
        const tabs = await chrome.tabs.query({ windowId: live.windowId });
        const newTabs = tabs.filter((tab) => {
          try {
            const raw = tab.pendingUrl || tab.url || "";
            const url = new URL(raw);
            return raw === "chrome://newtab/" ||
              (url.origin === "chrome-extension://${extensionId}" &&
                url.pathname.endsWith("/newtab.html"));
          } catch { return false; }
        });
        if (newTabs.length === 1 && newTabs[0].id === live.id && createdIds.has(live.id)) {
          return {
            windowId: live.windowId,
            keeperTabId: live.id,
            rapidCreated: createdIds.size,
            elapsedMs: performance.now() - startedAt
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const [live] = await chrome.tabs.query({ active: true, currentWindow: true });
    const finalTabs = live ? await chrome.tabs.query({ windowId: live.windowId }) : [];
    throw new Error("Rapid native default New Tabs did not converge to one EveryTab New Tab: " +
      JSON.stringify(finalTabs.map((tab) => ({
        id: tab.id,
        active: tab.active,
        pinned: tab.pinned,
        url: tab.url,
        pendingUrl: tab.pendingUrl
      }))));
  })()`);
  if (maxSingletonMs > 0 && singletonState.elapsedMs > maxSingletonMs) {
    throw new Error(`New Tab singleton needed ${singletonState.elapsedMs.toFixed(1)}ms; ` +
      `budget ${maxSingletonMs.toFixed(1)}ms`);
  }
  console.log("EveryTab installed gate: native singleton verified");
  console.log(`PASS: installed New Tab rotation ${schemes.join(" -> ")}; ` +
    `clean trace ${tracedResult.trace.map(({ scheme }) => scheme).join(" -> ")}; ` +
    `singleton keeper ${singletonState.keeperTabId} after ${singletonState.rapidCreated} rapid tabs ` +
    `in window ${singletonState.windowId} in ${singletonState.elapsedMs.toFixed(1)}ms; ` +
    `${newTabMode} content ${observed.map(({ contentReadyAt }) => contentReadyAt.toFixed(1)).join("/")}ms`);
} finally {
  for (const client of clients) client.close();
  // Chrome for Testing can leave its stderr pipe open after a polite signal,
  // which strands this otherwise-completed gate. This process owns the fresh
  // temporary profile and browser instance exclusively, so terminate that
  // exact child and release its handles before removing the fixture.
  const exited = chrome.exitCode == null
    ? new Promise((resolve) => chrome.once("exit", resolve))
    : Promise.resolve();
  if (chrome.exitCode == null) chrome.kill("SIGKILL");
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ]);
  chrome.stderr.destroy();
  chrome.unref();
  try {
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 8 : 0,
      retryDelay: 100
    });
  } catch (error) {
    // Chrome on Windows can leave a short-lived child holding LocalStorage
    // after the owned browser process exits. The hosted runner removes its
    // isolated temp directory; do not turn a completed product gate red for
    // that runner-only cleanup race.
    if (process.platform !== "win32" || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) {
      throw error;
    }
    console.warn(`EveryTab: temporary Chrome profile cleanup deferred (${error.code})`);
  }
}
