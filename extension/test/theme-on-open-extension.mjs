/**
 * Installed-shape D3 regression.
 *
 * Loads this exact unpacked extension into a fresh Chrome profile, writes the
 * real extension storage, then opens repeated real chrome://newtab/ targets.
 * This deliberately does not mock theme.js, storage events, module timing, or
 * the New Tab override.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnOwnedChrome, terminateOwnedChrome } from "./chrome-test-process.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = process.env.EVERYTAB_EXTENSION_ROOT
  ? path.resolve(process.env.EVERYTAB_EXTENSION_ROOT)
  : path.dirname(here);
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
const requestedNewTabMode = process.env.EVERYTAB_NEW_TAB_MODE;
const newTabMode = ["dashboard", "minimal"].includes(requestedNewTabMode)
  ? requestedNewTabMode
  : "dashboard";
const newTabFocus = process.env.EVERYTAB_NEW_TAB_FOCUS === "omnibox" ? "omnibox" : "search";
const maxContentReadyMs = Number(process.env.EVERYTAB_MAX_CONTENT_READY_MS ?? 0);
const maxSingletonMs = Number(process.env.EVERYTAB_MAX_SINGLETON_MS ?? 0);
const liveTabCount = Math.max(0, Number.parseInt(process.env.EVERYTAB_LIVE_TAB_COUNT ?? "0", 10) || 0);
const liveWindowCount = Math.max(1, Number.parseInt(process.env.EVERYTAB_LIVE_WINDOW_COUNT ?? "1", 10) || 1);
const useStableExtensionTarget = process.env.EVERYTAB_STABLE_EXTENSION_TARGET === "1";
const useHeadlessChrome = process.env.EVERYTAB_CHROME_HEADLESS === "1";
const workerBootstrapOnly = process.env.EVERYTAB_WORKER_BOOTSTRAP_ONLY === "1";
const spreadContextCount = Math.max(0,
  Number.parseInt(process.env.EVERYTAB_SPREAD_CONTEXT_COUNT ?? "0", 10) || 0);
const spreadOnly = process.env.EVERYTAB_SPREAD_ONLY === "1";
const schemeRotate = process.env.EVERYTAB_SCHEME_ROTATE === "off" ? "off" : "open";
const maxSpreadReadyMs = Number(process.env.EVERYTAB_MAX_SPREAD_READY_MS ?? 0);
const maxPopupReadyMs = Number(process.env.EVERYTAB_MAX_POPUP_READY_MS ?? 0);
const checkSchemeSheet = process.env.EVERYTAB_CHECK_SCHEME_SHEET === "1";

function debuggingUrl(process) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Chrome debugging endpoint timed out")), 10_000);
    let stderr = "";
    process.stderr.setEncoding("utf8");
    process.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (globalThis.process.env.EVERYTAB_DEBUG_CHROME_STDERR === "1") {
        globalThis.process.stderr.write(chunk);
      }
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

  async send(method, params = {}, sessionId = undefined) {
    await this.ready;
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`Chrome DevTools command ${method} timed out`));
      }, 15_000);
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

async function detectInstalledExtensionId(debugUrl, fallback) {
  const client = new CdpClient(debugUrl);
  try {
    // Chrome can register an unpacked extension before exposing its MV3 worker
    // target. The path-derived fallback is not an identity guarantee, so wait
    // for the real extension origin instead of probing a browser-owned New Tab.
    const deadline = performance.now() + 15_000;
    while (performance.now() < deadline) {
      const { targetInfos = [] } = await client.send("Target.getTargets");
      const matchesEveryTab = ({ url = "" }) => {
        if (!url.startsWith("chrome-extension://")) return false;
        try {
          const pathname = new URL(url).pathname;
          return pathname.endsWith("/js/background.js") ||
            pathname.endsWith("/dashboard.html") ||
            pathname.endsWith("/newtab.html");
        } catch {
          return false;
        }
      };
      const workerTarget = targetInfos.find(({ url = "" }) =>
        matchesEveryTab({ url }) && new URL(url).pathname.endsWith("/js/background.js"));
      // Chrome can expose the overridden New Tab extension URL for only a few
      // milliseconds before restoring its browser-owned chrome://newtab/
      // identity. That target is not a stable fresh-install control surface.
      // Prefer only the Dashboard that onInstalled deliberately opens after storage
      // becomes authoritative; the caller waits for it when the worker wins
      // this discovery race.
      const pageTarget = targetInfos.find((target) => target.type === "page" &&
        matchesEveryTab(target) && new URL(target.url).pathname.endsWith("/dashboard.html"));
      const everyTabTarget = workerTarget ?? pageTarget;
      if (everyTabTarget) {
        return {
          extensionId: new URL(everyTabTarget.url).host,
          workerTargetId: workerTarget?.targetId ?? null,
          extensionTargetId: pageTarget?.targetId ?? null
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return { extensionId: fallback, workerTargetId: null, extensionTargetId: null };
  } finally {
    client.close();
  }
}

async function attachTarget(debugUrl, targetId) {
  const client = new CdpClient(debugUrl);
  try {
    const { sessionId } = await client.send("Target.attachToTarget", {
      targetId,
      flatten: true
    });
    return new CdpSession(client, sessionId);
  } catch (error) {
    client.close();
    throw error;
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

async function waitForExtensionPageTarget(debugUrl, extensionId, timeout = 15_000) {
  const prefix = `chrome-extension://${extensionId}/`;
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const target = (await targetInfos(debugUrl)).find((candidate) =>
      candidate.type === "page" && candidate.url.startsWith(prefix) &&
      new URL(candidate.url).pathname.endsWith("/dashboard.html"));
    if (target) return target.targetId;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

async function waitForNewPageTarget(debugUrl, beforeIds, predicate, label, timeout = 3000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const target = (await targetInfos(debugUrl)).find((candidate) =>
      candidate.type === "page" && !beforeIds.has(candidate.targetId) && predicate(candidate));
    if (target) return attachTarget(debugUrl, target.targetId);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function newTarget(debugUrl, url) {
  const client = new CdpClient(debugUrl);
  try {
    const { targetId } = await client.send("Target.createTarget", { url });
    client.close();
    return await attachTarget(debugUrl, targetId);
  } catch (error) {
    client.close();
    throw error;
  }
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
const chrome = spawnOwnedChrome(chromeBin, [
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
  checkSchemeSheet ? "--window-position=50,50" : "--window-position=-10000,-10000",
  "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });

const clients = [];
try {
  const debugUrl = await debuggingUrl(chrome);
  console.log("EveryTab installed gate: Chrome debugging ready");
  const detectedExtension = await detectInstalledExtensionId(debugUrl, extensionId);
  extensionId = detectedExtension.extensionId;
  console.log(`EveryTab installed gate: extension ${extensionId.slice(-6)} detected`);
  if (workerBootstrapOnly) {
    if (!detectedExtension.workerTargetId) {
      throw new Error("EveryTab MV3 service worker was not available");
    }
    console.log(`PASS: installed EveryTab MV3 worker ${detectedExtension.workerTargetId}`);
  } else {
  // Ask the installed worker to open the control surface. New Chrome versions
  // can block a DevTools-created navigation directly into an extension origin,
  // while chrome.tabs.create is the real installed-extension path.
  let seed;
  if (detectedExtension.extensionTargetId) {
    seed = await attachTarget(debugUrl, detectedExtension.extensionTargetId);
  } else {
    // Fresh storage initialization deliberately finishes before the first
    // Dashboard is opened. The worker can therefore become discoverable a few
    // moments before that page target exists. Wait for the real install page
    // rather than racing Chrome's New Tab override while installation is still
    // settling. Builds that omit the install page retain the ordinary fallback.
    const installedPageTargetId = await waitForExtensionPageTarget(
      debugUrl, extensionId
    );
    if (!installedPageTargetId && detectedExtension.workerTargetId) {
      const worker = await attachTarget(debugUrl, detectedExtension.workerTargetId);
      const workerState = await evaluate(worker, `(async () => ({
        storage: await chrome.storage.local.get([
          "storageAuthority", "storageAuthorityInitialization", "deviceId"
        ]),
        runtime: chrome.runtime.getManifest().version
      }))()`);
      worker.close();
      throw new Error(`Fresh install did not open its Dashboard: ${JSON.stringify(workerState)}`);
    }
    seed = installedPageTargetId
      ? await attachTarget(debugUrl, installedPageTargetId)
      : await newTarget(debugUrl, "chrome://newtab/");
  }
  clients.push(seed);
  const seedInitialHref = await evaluate(seed, "globalThis.location?.href ?? ''");
  try {
    await waitFor(seed, "typeof chrome?.storage?.local?.get === 'function'", "extension storage");
  } catch (error) {
    const evidence = await evaluate(seed, `(() => ({
      href: globalThis.location?.href ?? "",
      title: globalThis.document?.title ?? "",
      readyState: globalThis.document?.readyState ?? "worker",
      body: globalThis.document?.body?.innerText?.slice(0, 240) ?? "",
      chromePresent: typeof chrome !== "undefined",
      runtimePresent: typeof chrome?.runtime?.getURL === "function",
      storagePresent: typeof chrome?.storage?.local?.get === "function"
    }))()`);
    evidence.seedInitialHref = seedInitialHref;
    evidence.extensionTargets = (await targetInfos(debugUrl))
      .filter(({ url = "" }) => url.startsWith("chrome-extension://"))
      .map(({ type, url }) => ({ type, url }));
    throw new Error(`${error.message}: ${JSON.stringify(evidence)}`);
  }
  const seedPath = await evaluate(seed, "location.pathname");
  if (seedPath.endsWith("/newtab.html")) {
    await evaluate(seed,
      "location.replace(chrome.runtime.getURL('options.html')); true");
    await waitFor(seed, `location.pathname.endsWith("/options.html") &&
      typeof chrome?.storage?.local?.get === "function"`, "stable extension control page");
  }
  // Let the fresh-install dashboard finish before establishing the rotation
  // baseline; that one-time welcome surface is not part of a mature-profile
  // New Tab sequence.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await evaluate(seed, `(async () => {
    const authority = await chrome.storage.local.get("storageAuthority");
    if (authority.storageAuthority?.kind !== "storage-authority" ||
        authority.storageAuthority?.databases?.library !== "everytab-library-v2" ||
        authority.storageAuthority?.databases?.recovery !== "everytab-recovery-v2") {
      throw new Error("Fresh Chrome profile did not initialize its Storage authority");
    }
    const store = await import(chrome.runtime.getURL("js/lib/store.js"));
    globalThis.everyTabTestStore = store;
    // Clear stale first-paint state before the Settings write. The live theme
    // listener must be allowed to rebuild the cache from that write.
    localStorage.clear();
    await store.patchSettings({
      uiScheme: "devtty",
      uiMode: "scheme",
      uiGradient: false,
      schemeFavorites: [],
      schemeRotate: "${schemeRotate}",
      newTabMode: "${newTabMode}",
      newTabFocus: "${newTabFocus}",
      oneNewTabPerWindow: false,
      newTabWelcomeEnabled: true,
      newTabWelcomePhrases: ["Welcome home"]
    });
    await store.mutateStores(["starred"], () => ({
      starred: Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
      const id = "star-" + index;
      return [id, {
        id,
        url: "https://starred.example/" + index,
        title: "Starred " + (index + 1),
        position: index,
        createdAt: index + 1,
        modifiedAt: index + 1,
        deviceId: "fixture-device"
      }];
      }))
    }));
    if ("${schemeRotate}" === "open") {
      const rotation = await import(chrome.runtime.getURL("js/lib/scheme-rotation.js"));
      await rotation.prepareNextSchemeOnOpen();
      // Reconcile the already-mounted control page after the explicit
      // reservation. Production settings UI performs the same final paint.
      await store.patchSettings({ uiGradient: false });
    }
    globalThis.themeRotationWrites = [];
    chrome.storage.onChanged.addListener((changes, area) => {
      const settingsChange = changes.settings ??
        changes.storageV2Revision?.newValue?.logicalChanges?.settings;
      const before = settingsChange?.oldValue?.uiScheme;
      const after = settingsChange?.newValue?.uiScheme;
      if (area === "local" && before && after && before !== after) {
        globalThis.themeRotationWrites.push({ before, after });
      }
    });
    return true;
  })()`);
  try {
    await waitFor(seed, `(async () => {
      const cache = JSON.parse(localStorage.getItem("tvTheme") || "null");
      if ("${schemeRotate}" === "off") return cache?.selection ? true : null;
      const prepared = await (await import(chrome.runtime.getURL("js/lib/store.js")))
        .readStoreValue("schemeRotationPrepared");
      return cache?.preparedTheme && prepared?.next ? true : null;
    })()`, "warm prepared rotation cache", 10_000);
  } catch (error) {
    const evidence = await evaluate(seed, `(async () => ({
      href: location.href,
      cache: JSON.parse(localStorage.getItem("tvTheme") || "null"),
      prepared: await (await import(chrome.runtime.getURL("js/lib/store.js")))
        .readStoreValue("schemeRotationPrepared"),
      settings: await (await import(chrome.runtime.getURL("js/lib/store.js"))).getSettings()
    }))()`);
    throw new Error(`${error.message}: ${JSON.stringify(evidence)}`);
  }
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

  // Mature-profile context pressure: retain one real New Tab in each existing
  // Chrome window, then time the next surface while the earlier renderers stay
  // alive. This is deliberately separate from the same-window singleton burst
  // below; the user-visible regression only appeared as the second and third
  // windows accumulated their own EveryTab page.
  if (spreadContextCount > 0) {
    await evaluate(seed, `(async () => {
      await globalThis.everyTabTestStore.patchSettings({ oneNewTabPerWindow: true });
      return true;
    })()`);
    const fixtureWindowIds = await evaluate(seed, `(async () => {
      const windows = await chrome.windows.getAll({ populate: true });
      return windows.filter((win) => win.type === "normal" && win.tabs?.some((tab) =>
        (tab.pendingUrl || tab.url || "").startsWith("https://example.invalid/everytab-fixture/")))
        .map((win) => win.id)
        .slice(0, ${spreadContextCount});
    })()`);
    if (fixtureWindowIds.length !== spreadContextCount) {
      throw new Error(`Spread-context fixture needed ${spreadContextCount} windows; ` +
        `found ${fixtureWindowIds.length}`);
    }
    const spreadReady = [];
    for (const [index, windowId] of fixtureWindowIds.entries()) {
      const beforeIds = new Set((await targetInfos(debugUrl)).map(({ targetId }) => targetId));
      const startedAt = performance.now();
      await evaluate(seed, `(async () => {
        await chrome.windows.update(${windowId}, { focused: true });
        return chrome.tabs.create({ windowId: ${windowId}, active: true });
      })()`);
      const tab = await waitForNewPageTarget(debugUrl, beforeIds, ({ url }) =>
        url === "chrome://newtab/" ||
          url.startsWith("chrome-extension://${extensionId}/newtab.html"),
      `spread New Tab ${index + 1}`, 10_000);
      clients.push(tab);
      await waitFor(tab, `(() => {
        if (!location.href.startsWith("chrome-extension://${extensionId}/newtab.html")) return null;
        if ("${newTabMode}" === "minimal") return document.querySelector(".minimal-deck") ? true : null;
        const openBody = document.querySelector('[data-sec="open"] .sec-inner');
        if (!openBody?.childElementCount || openBody.querySelector(".loading-feedback")) return null;
        return true;
      })()`, `spread New Tab ${index + 1} content`, 10_000);
      if (newTabMode === "dashboard") {
        const identity = await evaluate(tab, `(async () => {
          const currentCard = [...document.querySelectorAll('[data-tablist-card]')]
            .find((card) => card.querySelector('.item-badge'));
          currentCard?.querySelector('button.disclosure-row')?.click();
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            getCurrent: await chrome.tabs.getCurrent(),
            active: await chrome.tabs.query({ active: true, currentWindow: true }),
            markers: [...document.querySelectorAll(".surface-tab-state")].map((node) =>
              node.closest("[data-tablist-row]")?.getAttribute("data-tablist-row"))
          };
        })()`);
        if (identity.markers.length !== 1) {
          throw new Error(`EveryTab host-tab identity failed: ${JSON.stringify(identity)}`);
        }
      }
      spreadReady.push(performance.now() - startedAt);
    }
    const slowSpread = maxSpreadReadyMs > 0
      ? spreadReady.find((elapsed) => elapsed > maxSpreadReadyMs)
      : null;
    if (slowSpread) {
      throw new Error(`Spread New Tab needed ${slowSpread.toFixed(1)}ms; ` +
        `budget ${maxSpreadReadyMs.toFixed(1)}ms; all=${spreadReady
          .map((elapsed) => elapsed.toFixed(1)).join("/")}ms`);
    }
    const popupStartedAt = performance.now();
    const popup = await newTarget(debugUrl, `chrome-extension://${extensionId}/popup.html`);
    clients.push(popup);
    await waitFor(popup, `document.body?.classList.contains("popup-ready") ? true : null`,
      "context-pressured Popup", 10_000);
    const popupReady = performance.now() - popupStartedAt;
    if (maxPopupReadyMs > 0 && popupReady > maxPopupReadyMs) {
      throw new Error(`Context-pressured Popup needed ${popupReady.toFixed(1)}ms; ` +
        `budget ${maxPopupReadyMs.toFixed(1)}ms`);
    }
    console.log(`EveryTab installed gate: spread contexts ` +
      `${spreadReady.map((elapsed) => elapsed.toFixed(1)).join("/")}ms; ` +
      `Popup ${popupReady.toFixed(1)}ms`);
    await evaluate(seed, "globalThis.themeRotationWrites = []");
  }

  if (!spreadOnly) {
  const observed = [];
  let manualSchemeWrites = 0;
  const inspectedNewTabUrl = useStableExtensionTarget
    ? `chrome-extension://${extensionId}/newtab.html?focus=search`
    : "chrome://newtab/";
  const baselineOperational = await evaluate(seed, `(async () => ({
    cache: JSON.parse(localStorage.getItem("tvTheme") || "null"),
    prepared: await (await import(chrome.runtime.getURL("js/lib/store.js")))
      .readStoreValue("schemeRotationPrepared"),
    state: await (await import(chrome.runtime.getURL("js/lib/store.js")))
      .readStoreValue("schemeRotationState")
  }))()`);
  for (let index = 0; index < directOpenCount; index += 1) {
    const tab = await newTracedTarget(debugUrl, inspectedNewTabUrl);
    clients.push(tab);
    let result;
    try {
      result = await waitFor(tab, `(async () => {
        if (!location.href.startsWith("chrome-extension://${extensionId}/newtab.html")) return null;
        const stored = (await (await import(chrome.runtime.getURL("js/lib/store.js")))
          .getSettings()).uiScheme;
        const painted = document.documentElement.dataset.customScheme ||
          document.documentElement.dataset.scheme;
        if (!stored || painted !== stored) return null;
        const openBody = document.querySelector('[data-sec="open"] .sec-inner');
        const contentReady = "${newTabMode}" === "minimal"
          ? Boolean(document.querySelector(".minimal-clock") &&
              document.querySelector(".minimal-welcome")?.textContent === "Welcome home" &&
              document.querySelector(".minimal-deck"))
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
        stored: (await (await import(chrome.runtime.getURL("js/lib/store.js")))
          .getSettings()).uiScheme,
        appChildren: document.querySelector("#app")?.childElementCount ?? -1,
        surface: document.documentElement.dataset.newTabSurface ?? null,
        minimalCssDisabled: document.querySelector("#newtab-minimal-css")?.disabled ?? null,
        bodyClasses: [...document.body.classList],
        clock: Boolean(document.querySelector(".minimal-clock")),
        deck: Boolean(document.querySelector(".minimal-deck")),
        focusHydrating: document.querySelector(".minimal-focus-action")?.classList
          .contains("is-hydrating") ?? null,
        appDisplay: getComputedStyle(document.querySelector("#app")).display,
        appVisibility: getComputedStyle(document.querySelector("#app")).visibility,
        appRect: (() => {
          const rect = document.querySelector("#app")?.getBoundingClientRect();
          return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
        })(),
        errors: globalThis.__everyTabPageErrors ?? []
      }))()`);
      throw new Error(`${error.message}: ${JSON.stringify(state)}`);
    }
    if (newTabMode === "minimal" && index === 0) {
      // Focus is deliberately an enhancement behind Minimal's first useful
      // paint. Its module must still resolve, but a slow worker status response
      // is not allowed to redefine when the core surface became visible.
      try {
        await waitFor(tab,
          `document.querySelector(".minimal-focus-action:not(.is-hydrating)") ? true : null`,
          "Minimal Focus enhancement", 10_000);
      } catch (error) {
        const focusState = await evaluate(tab, `(() => ({
          host: Boolean(document.querySelector(".minimal-focus-action-host")),
          action: Boolean(document.querySelector(".minimal-focus-action")),
          hydrating: document.querySelector(".minimal-focus-action")?.classList
            .contains("is-hydrating") ?? null,
          errors: globalThis.__everyTabPageErrors ?? []
        }))()`);
        throw new Error(`${error.message}: ${JSON.stringify(focusState)}`);
      }
      await evaluate(tab, `(() => {
        const input = document.querySelector(".search-field input");
        input.value = "";
        input.focus();
        return true;
      })()`);
      await waitFor(tab,
        `document.querySelector(".minimal-deck.is-search-expanded") ? true : null`,
        "Minimal Search direction A expansion");
      await new Promise((resolve) => setTimeout(resolve, 220));
      const expandedSearch = await evaluate(tab, `(() => {
        const deck = document.querySelector(".minimal-deck");
        const results = document.querySelector(".search-results");
        const launcher = document.querySelector(".minimal-launcher");
        const deckStyle = getComputedStyle(deck);
        return {
          expanded: deck.classList.contains("is-search-expanded"),
          height: deck.getBoundingClientRect().height,
          maxResultsHeight: Number.parseFloat(getComputedStyle(results).maxHeight),
          launcherVisibility: getComputedStyle(launcher).visibility,
          transitionDuration: deckStyle.transitionDuration
        };
      })()`);
      if (!expandedSearch.expanded || expandedSearch.height < 248 ||
          expandedSearch.maxResultsHeight < 150 ||
          expandedSearch.launcherVisibility !== "hidden" ||
          !expandedSearch.transitionDuration.split(",").some((value) =>
            Math.abs(Number.parseFloat(value) - 0.18) < 0.001)) {
        throw new Error(`Minimal Search direction A failed: ${JSON.stringify(expandedSearch)}`);
      }
      await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown" });
      await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown" });
      await waitFor(tab,
        `document.activeElement?.classList.contains("minimal-launch") &&
          !document.querySelector(".minimal-deck")?.classList.contains("is-search-expanded") ? true : null`,
        "Minimal empty-Search keyboard handoff");
      await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown" });
      await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown" });
      await waitFor(tab,
        `document.activeElement?.closest(".minimal-launch-item")?.dataset.starId === "star-5" ? true : null`,
        "Minimal vertical Starred navigation");
      await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight" });
      await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight" });
      await waitFor(tab,
        `document.activeElement?.closest(".minimal-launch-item")?.dataset.starId === "star-6" ? true : null`,
        "Minimal horizontal Starred navigation");
      await tab.send("Emulation.setDeviceMetricsOverride", {
        width: 320, height: 720, deviceScaleFactor: 1, mobile: false
      });
      const pressure = await evaluate(tab, `(() => {
        const visible = [...document.querySelectorAll("#app *")]
          .filter((node) => getComputedStyle(node).display !== "none")
          .map((node) => node.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.height > 0);
        const footer = document.querySelector(".links")?.getBoundingClientRect();
        const note = document.querySelector(".minimal-welcome")?.getBoundingClientRect();
        const deck = document.querySelector(".minimal-deck")?.getBoundingClientRect();
        const focusCopyNode = document.querySelector(
          ".minimal-focus-state.is-current .minimal-focus-copy");
        const focusAction = document.querySelector(".minimal-focus-action")?.getBoundingClientRect();
        const dashboardLink = document.querySelector(".links a")?.getBoundingClientRect();
        return {
          overflowLeft: Math.max(0, ...visible.map((rect) => -rect.left)),
          overflowRight: Math.max(0, ...visible.map((rect) => rect.right - innerWidth)),
          footerWidth: footer?.width ?? -1,
          deckInnerWidth: deck ? deck.width - 28 : -1,
          noteAboveDeck: Boolean(note && deck && note.bottom < deck.top),
          focusCopy: focusCopyNode?.textContent ?? "",
          focusCopyClipped: Boolean(focusCopyNode &&
            focusCopyNode.scrollWidth > focusCopyNode.clientWidth + 1),
          focusWidth: focusAction?.width ?? -1,
          focusFooterAligned: Boolean(focusAction && dashboardLink &&
            Math.abs((focusAction.top + focusAction.height / 2) -
              (dashboardLink.top + dashboardLink.height / 2)) <= 1),
          starredCount: document.querySelectorAll(".minimal-launch").length
        };
      })()`);
      if (pressure.overflowLeft > 1 || pressure.overflowRight > 1 ||
          pressure.footerWidth > pressure.deckInnerWidth + 1 || !pressure.noteAboveDeck ||
          pressure.focusCopy !== "Set Focus" || pressure.focusCopyClipped ||
          Math.abs(pressure.focusWidth - 96) > 1 || !pressure.focusFooterAligned ||
          pressure.starredCount !== 10) {
        throw new Error(`Minimal personalization pressure failed at 320px: ${JSON.stringify(pressure)}`);
      }
      const renameState = await evaluate(tab, `(async () => {
        const first = document.querySelector('.minimal-launch-item[data-star-id="star-0"]');
        const rename = first?.querySelector(".minimal-launch-rename");
        const itemRect = first?.getBoundingClientRect();
        const renameRect = rename?.getBoundingClientRect();
        const topRight = Boolean(itemRect && renameRect &&
          Math.abs(renameRect.top - itemRect.top + 7) <= 1 &&
          Math.abs(renameRect.right - itemRect.right - 5) <= 1);
        const initialOpacity = rename ? getComputedStyle(rename).opacity : null;
        rename?.focus();
        await new Promise((resolve) => setTimeout(resolve, 200));
        const focusedOpacity = rename ? getComputedStyle(rename).opacity : null;
        rename?.click();
        const input = first?.querySelector(".minimal-launch-rename-input");
        if (!input) return { initialOpacity, focusedOpacity, topRight, inputMounted: false };
        input.value = "Renamed Star";
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        const limit = performance.now() + 2500;
        while (performance.now() < limit) {
          const store = await import(chrome.runtime.getURL("js/lib/store.js"));
          const record = (await store.readStoreMap("starred"))?.["star-0"];
          if (record?.title === "Renamed Star" &&
              document.querySelector('.minimal-launch-item[data-star-id="star-0"]')
                ?.textContent.includes("Renamed Star")) {
            return {
              initialOpacity,
              focusedOpacity,
              topRight,
              inputMounted: true,
              storedTitle: record.title,
              starredCount: document.querySelectorAll(".minimal-launch").length
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return { initialOpacity, focusedOpacity, topRight, inputMounted: true, timedOut: true };
      })()`);
      if (renameState.initialOpacity !== "0" || renameState.focusedOpacity !== "1" ||
          !renameState.topRight || !renameState.inputMounted ||
          renameState.storedTitle !== "Renamed Star" ||
          renameState.starredCount !== 10) {
        throw new Error(`Minimal Starred rename failed: ${JSON.stringify(renameState)}`);
      }
    }
    if (newTabMode === "dashboard" && index === 0) {
      const searchState = await evaluate(tab, `(async () => {
        const input = document.querySelector(".search-input");
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus({ preventScroll: true });
        const limit = performance.now() + 1000;
        while (performance.now() < limit && !document.querySelector(".ghost-chips")) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const results = document.querySelector(".search-results");
        return {
          directTextNodes: [...results.childNodes]
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent),
          completeText: results.textContent
        };
      })()`);
      if (searchState.directTextNodes.some((text) => text.includes("null")) ||
          searchState.completeText.includes("null")) {
        throw new Error(`Dashboard focused Search rendered null: ${JSON.stringify(searchState)}`);
      }
      if (checkSchemeSheet && index === directOpenCount - 1) {
        await tab.send("Page.bringToFront");
        await tab.send("Emulation.setDeviceMetricsOverride", {
          width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
        });
        await evaluate(tab, `scrollTo(0, Math.min(300,
          Math.max(0, document.documentElement.scrollHeight - innerHeight)))`);
        await new Promise((resolve) => setTimeout(resolve, 80));
        await waitFor(tab, `Boolean(document.querySelector(".quick-theme > .gear"))`,
          "Dashboard scheme trigger", 5000);
        const opening = await evaluate(tab, `(() => {
          const trigger = document.querySelector(".quick-theme > .gear");
          const sheet = document.querySelector("#sidebar-scheme-picker");
          trigger.click();
          return {
            openingTransform: getComputedStyle(sheet).transform,
            beforePageScroll: scrollY
          };
        })()`);
        await waitFor(tab,
          `!document.querySelector("#sidebar-scheme-picker")?.classList.contains("hidden")`,
          "Dashboard scheme sheet");
        await new Promise((resolve) => setTimeout(resolve, 240));
        const beforeFavorite = await evaluate(tab, `(() => {
          const sheet = document.querySelector("#sidebar-scheme-picker");
          const scroller = sheet.querySelector(".theme-takeover-scroll");
          const star = sheet.querySelector(".theme-catalogue .theme-star");
          const state = {
            id: star.dataset.schemeId,
            starTop: star.getBoundingClientRect().top,
            sheetTop: sheet.getBoundingClientRect().top,
            scrollTop: scroller.scrollTop,
            pageScroll: scrollY
          };
          star.click();
          return state;
        })()`);
        await waitFor(tab,
          `(async () => Boolean((await (await import(chrome.runtime.getURL("js/lib/store.js")))
            .getSettings()).schemeFavorites?.includes(${JSON.stringify(beforeFavorite.id)})))()`,
          "favorite scheme write");
        await new Promise((resolve) => setTimeout(resolve, 40));
        const afterFavorite = await evaluate(tab, `(() => {
          const sheet = document.querySelector("#sidebar-scheme-picker");
          const scroller = sheet.querySelector(".theme-takeover-scroll");
          const star = [...sheet.querySelectorAll(".theme-catalogue .theme-star")]
            .find((button) => button.dataset.schemeId === ${JSON.stringify(beforeFavorite.id)});
          const current = document.documentElement.dataset.customScheme ||
            document.documentElement.dataset.scheme;
          const next = [...sheet.querySelectorAll(".theme-catalogue .theme-opt")]
            .find((option) => option.closest(".theme-opt-row")?.dataset.schemeId !== current);
          const state = {
            starTop: star.getBoundingClientRect().top,
            sheetTop: sheet.getBoundingClientRect().top,
            scrollTop: scroller.scrollTop,
            pageScroll: scrollY,
            nextId: next.closest(".theme-opt-row").dataset.schemeId
          };
          next.click();
          return state;
        })()`);
        await waitFor(tab,
          `(async () => {
            const stored = (await (await import(chrome.runtime.getURL("js/lib/store.js")))
              .getSettings()).uiScheme;
            const painted = document.documentElement.dataset.customScheme ||
              document.documentElement.dataset.scheme;
            return stored === ${JSON.stringify(afterFavorite.nextId)} && painted === stored;
          })()`,
          "in-place scheme selection", 5000);
        const sheetState = await evaluate(tab, `(() => {
          const sheet = document.querySelector("#sidebar-scheme-picker");
          const scroller = sheet.querySelector(".theme-takeover-scroll");
          const sidebar = document.querySelector(".sidebar");
          const trigger = document.querySelector(".quick-theme > .gear");
          const measuredStar = sheet.querySelector(".theme-catalogue .theme-star");
          const measuredStarStyle = getComputedStyle(measuredStar);
          const sidebarRect = sidebar.getBoundingClientRect();
          const sheetRect = sheet.getBoundingClientRect();
          return {
            ariaHidden: sheet.getAttribute("aria-hidden"),
            classes: sheet.className,
            visibility: getComputedStyle(sheet).visibility,
            animationName: getComputedStyle(sheet).animationName,
            triggerExpanded: trigger.getAttribute("aria-expanded"),
            triggerVisible: trigger.getBoundingClientRect().width > 0,
            sidebarVisible: sidebarRect.width > 0,
            contentOnly: Math.abs(sheetRect.left - sidebarRect.right) <= 1,
            optionCount: sheet.querySelectorAll(".theme-catalogue .theme-opt").length,
            groupColumns: getComputedStyle(sheet.querySelector(".theme-groups-grid"))
              .gridTemplateColumns.split(" ").length,
            hasOverflow: scroller.scrollHeight > scroller.clientHeight + 1,
            scrollerHeight: scroller.clientHeight,
            scrollerContentHeight: scroller.scrollHeight,
            sheetHeight: sheetRect.height,
            openingTransform: ${JSON.stringify(opening.openingTransform)},
            settledTransform: getComputedStyle(sheet).transform,
            sheetTopDelta: sheetRect.top - ${beforeFavorite.sheetTop},
            favoriteSheetTopDelta: ${afterFavorite.sheetTop - beforeFavorite.sheetTop},
            favoriteStarTopDelta: ${afterFavorite.starTop - beforeFavorite.starTop},
            favoriteScrollDelta: ${afterFavorite.scrollTop - beforeFavorite.scrollTop},
            pageScrollDelta: scrollY - ${opening.beforePageScroll},
            pageScrollAfterOpen: ${beforeFavorite.pageScroll - opening.beforePageScroll},
            pageScrollAfterFavorite: ${afterFavorite.pageScroll - opening.beforePageScroll},
            selected: ${JSON.stringify(afterFavorite.nextId)},
            stillOpen: !sheet.classList.contains("hidden"),
            starDisplay: measuredStarStyle.display,
            starPlaceItems: measuredStarStyle.placeItems,
            starPaddingInline: measuredStarStyle.paddingInline,
            sheetSettingValues: [...sheet.querySelectorAll(".theme-sheet-select")]
              .map((select) => select.value),
            sheetSettingGap: getComputedStyle(sheet.querySelector(".theme-sheet-settings")).gap,
            sheetSettingAlignment: getComputedStyle(sheet.querySelector(".theme-sheet-settings")).justifyContent
          };
        })()`);
        sheetState.quickModesStayOpen = await evaluate(tab, `(async () => {
          const sheet = document.querySelector("#sidebar-scheme-picker");
          for (const button of document.querySelectorAll(".quick-theme .mode-choice")) {
            button.click();
            await new Promise((resolve) => setTimeout(resolve, 60));
            if (sheet.classList.contains("hidden") || sheet.classList.contains("closing")) return false;
          }
          return true;
        })()`);
        await evaluate(tab, `document.querySelector("main").dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true }))`);
        await new Promise((resolve) => setTimeout(resolve, 240));
        sheetState.closed = await evaluate(tab, `(() => {
          const sheet = document.querySelector("#sidebar-scheme-picker");
          return sheet.classList.contains("hidden") &&
            sheet.getAttribute("aria-hidden") === "true" &&
            document.querySelector(".quick-theme > .gear")?.getAttribute("aria-expanded") === "false";
        })()`);
        if (sheetState.ariaHidden !== "false" || sheetState.triggerExpanded !== "true" ||
            !sheetState.triggerVisible || !sheetState.sidebarVisible || !sheetState.contentOnly ||
            sheetState.optionCount !== 36 || sheetState.groupColumns !== 4 || sheetState.hasOverflow ||
            sheetState.openingTransform === sheetState.settledTransform ||
            Math.abs(sheetState.sheetTopDelta) > 1 ||
            Math.abs(sheetState.favoriteSheetTopDelta) > 1 ||
            Math.abs(sheetState.favoriteStarTopDelta) > 1 ||
            Math.abs(sheetState.favoriteScrollDelta) > 1 ||
            Math.abs(sheetState.pageScrollDelta) > 1 || !sheetState.stillOpen || !sheetState.closed ||
            sheetState.starDisplay !== "grid" || sheetState.starPlaceItems !== "center" ||
            sheetState.starPaddingInline !== "0px" || sheetState.sheetSettingValues.length !== 2 ||
            parseFloat(sheetState.sheetSettingGap) < 16 ||
            sheetState.sheetSettingAlignment !== "flex-end" || !sheetState.quickModesStayOpen) {
          throw new Error(`Dashboard scheme sheet failed: ${JSON.stringify(sheetState)}`);
        }
        manualSchemeWrites += 1;
        console.log(`EveryTab installed gate: scheme sheet ${sheetState.selected} selected in place`);
      }
    }
    const writeCount = await evaluate(seed, "globalThis.themeRotationWrites.length");
    if (writeCount !== index + 1 + manualSchemeWrites) {
      const writes = await evaluate(seed, "globalThis.themeRotationWrites");
      throw new Error(`New Tab ${index + 1} caused ${writeCount} total scheme writes; ` +
        `expected exactly ${index + 1 + manualSchemeWrites}: ${JSON.stringify(writes)}`);
    }
    observed.push(result);
  }
  console.log(`EveryTab installed gate: ${directOpenCount} New Tab paints verified`);

  if (checkSchemeSheet) {
    console.log("PASS: installed Dashboard scheme sheet interaction and motion");
  } else {
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
    const stored = (await (await import(chrome.runtime.getURL("js/lib/store.js")))
      .getSettings()).uiScheme;
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
  const expectedWrites = directOpenCount + 1 + manualSchemeWrites;
  const finalWrites = await evaluate(seed, "globalThis.themeRotationWrites.length");
  if (finalWrites !== expectedWrites) {
    throw new Error(`Traced New Tab caused ${finalWrites} total scheme writes; ` +
      `expected ${expectedWrites}`);
  }
  console.log("EveryTab installed gate: traced paint verified");
  await evaluate(seed, `(async () => {
    await globalThis.everyTabTestStore.patchSettings({
      newTabFocus: "omnibox",
      oneNewTabPerWindow: true
    });
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
  }
  }
  }
} finally {
  for (const client of clients) client.close();
  await terminateOwnedChrome(chrome, { graceMs: 250, forceMs: 2_000 });
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
