// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Capture the Chrome Web Store beta screenshot set from the real extension.
 *
 * The browser profile, saved records, live windows, and site responses are all
 * disposable. Public-looking page URLs resolve to a local fixture server so a
 * capture never depends on the network or exposes a real browsing profile.
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  spawnOwnedChrome, terminateOwnedChrome
} from "../extension/test/chrome-test-process.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(here);
// EVERYTAB_EXTENSION_ROOT loads another runtime tree, for example an extracted
// release ZIP, so the captures provably show the shipped package. The source
// fingerprint below is always computed over the directory actually loaded.
const extensionRoot = process.env.EVERYTAB_EXTENSION_ROOT
  ? path.resolve(process.env.EVERYTAB_EXTENSION_ROOT)
  : path.join(projectRoot, "extension");
const outputRoot = path.join(
  projectRoot, "docs", "launch", "assets", "store-beta"
);
const build = JSON.parse(await readFile(path.join(extensionRoot, "manifest.json"), "utf8")).version;
const screenshotRoot = process.env.STORE_CAPTURE_OUTPUT || path.join(outputRoot, `screenshots-v${build}`);
const shots = [];

async function sourceFingerprint() {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "test" || entry.name.startsWith(".") || entry.name === "README.md") continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filename);
      else files.push(filename);
    }
  };
  walk(extensionRoot);
  const records = await Promise.all(files.sort().map(async (filename) => ({
    path: path.relative(extensionRoot, filename),
    sha256: createHash("sha256").update(await readFile(filename)).digest("hex")
  })));
  return { fileCount: records.length, sha256: createHash("sha256").update(JSON.stringify(records)).digest("hex"), files: records };
}
const chromeForTestingRoot = path.join(homedir(), ".cache", "puppeteer", "chrome");
const chromeForTestingCandidates = existsSync(chromeForTestingRoot)
  ? readdirSync(chromeForTestingRoot)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((version) => path.join(
      chromeForTestingRoot, version, "chrome-mac-arm64",
      "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"
    ))
  : [];
const chromeCandidates = [
  process.env.CHROME_BIN,
  ...chromeForTestingCandidates,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].filter(Boolean);
const chromeBin = chromeCandidates.find(existsSync);
if (!chromeBin) throw new Error("Chrome is required to capture Store screenshots");

const SITES = Object.freeze({
  mdnStorage: {
    host: "developer.mozilla.org", path: "/en-US/docs/Web/API/Storage_API",
    title: "Storage API guide | MDN", icon: "M", color: "#1f6f68"
  },
  mdnAccessibility: {
    host: "developer.mozilla.org", path: "/en-US/docs/Web/Accessibility",
    title: "Accessibility on the web | MDN", icon: "M", color: "#1f6f68"
  },
  chromeExtensions: {
    host: "developer.chrome.com", path: "/docs/extensions/",
    title: "Chrome extensions documentation", icon: "C", color: "#2870c7"
  },
  chromeUx: {
    host: "developer.chrome.com", path: "/docs/extensions/develop/ui",
    title: "Design the user interface", icon: "C", color: "#2870c7"
  },
  webPerformance: {
    host: "web.dev", path: "/learn/performance/",
    title: "Learn web performance", icon: "W", color: "#7b3fc6"
  },
  webDesign: {
    host: "web.dev", path: "/learn/design/",
    title: "Responsive web design", icon: "W", color: "#7b3fc6"
  },
  wikipediaWeb: {
    host: "en.wikipedia.org", path: "/wiki/History_of_the_World_Wide_Web",
    title: "History of the World Wide Web", icon: "W", color: "#4f5358"
  },
  wikipediaTypography: {
    host: "en.wikipedia.org", path: "/wiki/Typography",
    title: "Typography", icon: "W", color: "#4f5358"
  },
  archiveCollections: {
    host: "archive.org", path: "/details/texts",
    title: "Texts to borrow and explore", icon: "A", color: "#8d5531"
  },
  archiveWayback: {
    host: "archive.org", path: "/web/",
    title: "Explore the history of the web", icon: "A", color: "#8d5531"
  },
  gutenbergBooks: {
    host: "www.gutenberg.org", path: "/ebooks/",
    title: "Books to read | Project Gutenberg", icon: "G", color: "#9b6b20"
  },
  gutenbergShelf: {
    host: "www.gutenberg.org", path: "/ebooks/bookshelf/",
    title: "Bookshelves | Project Gutenberg", icon: "G", color: "#9b6b20"
  }
});

function faviconSvg(letter, color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <rect width="32" height="32" rx="8" fill="${color}"/>
    <text x="16" y="21" text-anchor="middle" font-family="Arial,sans-serif"
      font-size="16" font-weight="700" fill="#fff">${letter}</text>
  </svg>`;
}

function fixtureHtml(site) {
  const favicon = `data:image/svg+xml,${encodeURIComponent(faviconSvg(site.icon, site.color))}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${site.title}</title>
    <link rel="icon" href="${favicon}"></head><body><main><h1>${site.title}</h1></main></body></html>`;
}

async function startFixtureServer() {
  const byRoute = new Map(Object.values(SITES).map((site) => [
    `${site.host}${site.path}`, site
  ]));
  const server = createServer((request, response) => {
    const host = String(request.headers.host ?? "").split(":")[0];
    const pathname = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    const site = byRoute.get(`${host}${pathname}`) ?? Object.values(SITES).find(
      (candidate) => candidate.host === host
    );
    if (!site) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8"
    });
    response.end(fixtureHtml(site));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server has no TCP port");
  return {
    port: address.port,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

function siteUrl(site, port) {
  return `http://${site.host}:${port}${site.path}`;
}

function debuggingUrl(chromeProcess) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Chrome debugging endpoint timed out")), 15_000);
    let stderr = "";
    chromeProcess.stderr.setEncoding("utf8");
    chromeProcess.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (process.env.EVERYTAB_CAPTURE_CHROME_STDERR === "1") process.stderr.write(chunk);
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    });
    chromeProcess.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited before capture with code ${code}.\n${stderr}`));
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
        request.reject(new Error(`Chrome target closed during command ${id}`));
      }
      this.pending.clear();
    });
  }

  async send(method, params = {}, sessionId = undefined) {
    await this.ready;
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      // Full-page Store stills can make headless Chrome spend more than the
      // ordinary interaction budget in raster/compositor work. Keep all UI
      // commands tight while giving the one evidence-producing call room.
      const commandTimeout = method === "Page.captureScreenshot" ? 60_000 : 20_000;
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`Chrome DevTools command ${method} timed out`));
      }, commandTimeout);
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

// Store captures opt in to settling a fresh install (wait for storage setup,
// close the welcome Dashboard). Other tools that share this helper keep the
// plain detection unless they pass the option or set the environment flag.
async function detectExtension(debugUrl, {
  settleFreshInstall = process.env.EVERYTAB_CAPTURE_SETTLE_INSTALL === "1"
} = {}) {
  const deadline = performance.now() + 15_000;
  let lastCandidates = [];
  while (performance.now() < deadline) {
    const candidates = await targetInfos(debugUrl);
    lastCandidates = candidates;
    const target = candidates.find(({ url = "" }) =>
      url.startsWith("chrome-extension://") &&
      ["/js/background.js", "/dashboard.html", "/newtab.html"].some((suffix) => {
        try { return new URL(url).pathname.endsWith(suffix); } catch { return false; }
      })
    );
    if (target) {
      const extensionId = new URL(target.url).host;
      if (settleFreshInstall) await waitForStorageAuthority(debugUrl, extensionId);
      return extensionId;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const inventory = lastCandidates.map(({ type, url }) => ({ type, url }));
  throw new Error(`The unpacked EveryTab extension did not expose a target: ${JSON.stringify(inventory)}`);
}

/**
 * A page opened in the first moments after install can start before the
 * worker has published the storage authority and then stays blank. Wait for
 * the worker's first-install setup so every capture page boots normally.
 */
async function waitForStorageAuthority(debugUrl, extensionId, timeout = 15_000) {
  const deadline = performance.now() + timeout;
  const workerUrl = `chrome-extension://${extensionId}/js/background.js`;
  while (performance.now() < deadline) {
    const worker = (await targetInfos(debugUrl)).find(({ type, url }) => type === "service_worker" && url === workerUrl);
    if (worker) {
      const session = await attachTarget(debugUrl, worker.targetId);
      try {
        const result = await session.send("Runtime.evaluate", {
          expression: "chrome.storage.local.get('storageAuthority').then((value) => Boolean(value.storageAuthority))",
          awaitPromise: true, returnByValue: true
        });
        if (result.result?.value === true) {
          await closeFirstInstallDashboard(debugUrl, extensionId);
          return;
        }
      } catch {
        // The worker can restart while installing; poll again.
      } finally {
        session.close();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("EveryTab did not finish its first-install storage setup");
}

/**
 * A fresh install opens a welcome Dashboard after storage setup. Close it so
 * every capture starts from the same synthetic windows; the capture pages
 * open their own Dashboard afterwards. Builds without it wait 5 s and go on.
 */
async function closeFirstInstallDashboard(debugUrl, extensionId, timeout = 5_000) {
  const deadline = performance.now() + timeout;
  const prefix = `chrome-extension://${extensionId}/dashboard.html`;
  while (performance.now() < deadline) {
    const welcome = (await targetInfos(debugUrl)).filter(({ type, url = "" }) => type === "page" && url.startsWith(prefix));
    if (welcome.length) {
      const client = new CdpClient(debugUrl);
      try {
        for (const { targetId } of welcome) await client.send("Target.closeTarget", { targetId });
      } finally {
        client.close();
      }
      return welcome.length;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return 0;
}

async function evaluate(session, expression) {
  const result = await session.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ?? "Runtime evaluation failed";
    throw new Error(description);
  }
  return result.result?.value;
}

async function waitFor(session, expression, label, timeout = 15_000) {
  const value = await evaluate(session, `new Promise((resolve, reject) => {
    const started = performance.now();
    const inspect = () => {
      let ready = false;
      try { ready = Boolean(${expression}); } catch {}
      if (ready) resolve(true);
      else if (performance.now() - started >= ${timeout}) reject(new Error(${JSON.stringify(label)}));
      else setTimeout(inspect, 40);
    };
    inspect();
  })`);
  if (!value) throw new Error(`Timed out waiting for ${label}`);
}

async function prepareSession(session) {
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await setViewport(session, 1280, 800);
  await session.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }]
  });
  await waitFor(session, "document.readyState === 'complete'", "document load");
}

async function setViewport(session, width, height, deviceScaleFactor = 1) {
  await session.send("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor, mobile: false,
    screenWidth: width, screenHeight: height
  });
}

async function capture(session, filename, details) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const { data } = await session.send("Page.captureScreenshot", {
    format: "png", fromSurface: true, captureBeyondViewport: false
  });
  const bytes = Buffer.from(data, "base64");
  await writeFile(path.join(screenshotRoot, filename), bytes);
  const geometry = await evaluate(session, `(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return {left:box.left, top:box.top, right:box.right, bottom:box.bottom, width:box.width, height:box.height};
    };
    return { scrollY, viewport: {width:innerWidth,height:innerHeight},
      ledger: rect('[data-sec="open"] .trow'), starred: rect('.starred-edge-toggle'),
      clock: rect('.minimal-clock .clock'), date: rect('.minimal-clock .date'),
      deck: rect('.minimal-deck'),
      pageOffset: {x:visualViewport.pageLeft,y:visualViewport.pageTop} };
  })()`);
  if (details.verifyOpenLedger && (!geometry.ledger || !geometry.starred || geometry.ledger.right > geometry.starred.left)) {
    throw new Error('The Starred control overlaps the Open ledger');
  }
  if (details.verifyMinimalSearchClock && (!geometry.clock || !geometry.date || !geometry.deck ||
      geometry.clock.top < -1 || geometry.date.bottom > geometry.deck.top - 8)) {
    throw new Error(`Minimal Search crops or overlaps its clock composition: ${JSON.stringify(geometry)}`);
  }
  const width = details.width ?? 1280;
  const height = details.height ?? 800;
  if (bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) {
    throw new Error(`Unexpected screenshot dimensions for ${filename}: expected ${width}x${height}`);
  }
  shots.push({ filename, ...details, sha256: createHash("sha256").update(bytes).digest("hex"),
    width, height,
    geometry,
    appearance: await evaluate(session, `({scheme: document.documentElement.dataset.scheme, mode: document.documentElement.dataset.mode, style: document.documentElement.dataset.interfaceStyle, lang: document.documentElement.lang || null, browserUiLanguage: globalThis.chrome?.i18n?.getUILanguage?.() ?? null})`) });
}

function browserContextHtml({ surfaceData, kind, scheme, style }) {
  const popup = kind === "popup";
  const surfaceClass = popup ? "popup-surface" : "side-surface";
  return `<!doctype html><html lang="en" data-scheme="${scheme}" data-mode="light"
    data-interface-style="${style}"><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{width:1280px;height:800px;margin:0;overflow:hidden}
    body{font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#eef0f4;color:#252830}
    .browser{width:100%;height:100%;background:#fff;overflow:hidden}
    .tabbar{height:38px;display:flex;align-items:end;gap:7px;padding:0 14px;background:#dfe4ec;border-bottom:1px solid #cbd1da}
    .traffic{display:flex;gap:7px;align-self:center;margin-right:9px}.traffic i{width:11px;height:11px;border-radius:50%;background:#b2bac7}.traffic i:first-child{background:#ed6a5e}.traffic i:nth-child(2){background:#f4bf4f}.traffic i:last-child{background:#61c454}
    .tab{height:32px;width:292px;display:flex;align-items:center;gap:9px;padding:0 14px;border-radius:11px 11px 0 0;background:#f8f9fb;color:#343842;box-shadow:0 -1px 0 rgba(255,255,255,.8)}
    .tab-fav{display:grid;place-items:center;width:17px;height:17px;border-radius:5px;background:#9b6b20;color:white;font-size:10px;font-weight:750}.tab-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tab-close{margin-left:auto;color:#7a808b}
    .newtab{align-self:center;color:#6e7580;font-size:21px}.window-space{flex:1}
    .toolbar{height:50px;display:flex;align-items:center;gap:12px;padding:0 16px;background:#f8f9fb;border-bottom:1px solid #d6dae1;box-shadow:0 1px 4px rgba(43,48,58,.08)}
    .nav{display:flex;gap:13px;color:#626975;font-size:20px}.address{height:34px;flex:1;display:flex;align-items:center;gap:9px;padding:0 15px;border-radius:18px;background:#e9edf3;color:#5b626d}.lock{font-size:12px}.domain{color:#333843}.path{color:#858b95}
    .toolbar-icons{display:flex;align-items:center;gap:12px;color:#626975}.toolbar-icons span{display:grid;place-items:center;width:28px;height:28px}.everytab{position:relative;border-radius:50%;background:#dfe8e7;color:#1f5b58;font-weight:850}.everytab::after{content:"";position:absolute;inset:7px 6px;border-radius:2px;background:linear-gradient(#2c7d78 0 22%,transparent 22% 34%,#2c7d78 34% 56%,transparent 56% 68%,#2c7d78 68%)}
    .viewport{position:relative;height:712px;overflow:hidden;background:#fff}
    .site{position:absolute;inset:0 ${popup ? 0 : 420}px 0 0;overflow:hidden;background:#fbfaf7;color:#26282d}
    .site-head{height:68px;display:flex;align-items:center;padding:0 54px;border-bottom:1px solid #dedbd4;background:#fff}.site-brand{font:700 20px Georgia,serif}.site-nav{display:flex;gap:24px;margin-left:auto;color:#62666c;font-size:13px}
    .site-main{max-width:760px;margin:0 auto;padding:58px 48px}.site-kicker{color:#8b641b;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.site h1{font:700 43px/1.08 Georgia,serif;letter-spacing:-.025em;margin:12px 0 18px;max-width:650px}.site p{max-width:610px;color:#60636a;font-size:16px}.books{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:36px}.book{min-height:118px;padding:17px;border:1px solid #dedbd4;border-radius:8px;background:#fff}.book b{display:block;font-family:Georgia,serif;font-size:16px}.book span{display:block;margin-top:8px;color:#777b82;font-size:12px}
    .surface{position:absolute;display:block;z-index:4;background:#fff}
    .popup-surface{top:0;right:18px;width:400px;height:498px;box-shadow:0 14px 40px rgba(25,29,38,.28),0 2px 8px rgba(25,29,38,.18)}
    .side-surface{top:0;right:0;width:420px;height:712px;object-fit:cover;object-position:top;border-left:1px solid #aeb5c0;box-shadow:-10px 0 28px rgba(25,29,38,.14)}
    </style><body><div class="browser"><div class="tabbar"><div class="traffic"><i></i><i></i><i></i></div><div class="tab"><span class="tab-fav">G</span><span class="tab-title">Bookshelves | Project Gutenberg</span><span class="tab-close">×</span></div><span class="newtab">+</span><span class="window-space"></span></div><div class="toolbar"><div class="nav"><span>‹</span><span>›</span><span>↻</span></div><div class="address"><span class="lock">●</span><span class="domain">gutenberg.org</span><span class="path">/ebooks/bookshelf/</span></div><div class="toolbar-icons"><span>☆</span><span>⌁</span><span class="everytab" aria-label="EveryTab"></span><span>⋮</span></div></div><div class="viewport"><main class="site"><header class="site-head"><span class="site-brand">Project Gutenberg</span><nav class="site-nav"><span>About</span><span>Search</span><span>Bookshelves</span></nav></header><article class="site-main"><div class="site-kicker">Free literature</div><h1>Explore books by subject.</h1><p>Browse public-domain books arranged into familiar shelves. Every title is free to read and share.</p><div class="books"><div class="book"><b>Art and design</b><span>1,284 books</span></div><div class="book"><b>History</b><span>3,109 books</span></div><div class="book"><b>Science</b><span>2,416 books</span></div><div class="book"><b>Travel</b><span>896 books</span></div><div class="book"><b>Literature</b><span>8,742 books</span></div><div class="book"><b>Reference</b><span>742 books</span></div></div></article></main><img class="surface ${surfaceClass}" src="data:image/png;base64,${surfaceData}" alt=""></div></div></body></html>`;
}

async function captureBrowserContext(session, filename, surfaceFilename, details) {
  const surfaceData = (await readFile(path.join(screenshotRoot, surfaceFilename))).toString("base64");
  await setViewport(session, 1280, 800);
  const html = browserContextHtml({ surfaceData, kind: details.kind,
    scheme: details.scheme.toLowerCase().replaceAll(" ", ""), style: details.style.toLowerCase() });
  await session.send("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
  await waitFor(session, "document.querySelector('.surface')?.complete", `${details.kind} browser context`);
  await capture(session, filename, { ...details, width: 1280, height: 800, composed: true });
}

function captureFixture(port) {
  const favicon = (site) => `data:image/svg+xml,${encodeURIComponent(
    faviconSvg(site.icon, site.color)
  )}`;
  const ref = (key) => ({
    url: siteUrl(SITES[key], port), title: SITES[key].title,
    favIconUrl: favicon(SITES[key])
  });
  return {
    sites: Object.fromEntries(Object.keys(SITES).map((key) => [key, ref(key)])),
    windows: [
      ["chromeExtensions", "mdnStorage", "webPerformance", "wikipediaWeb", "archiveWayback"],
      ["mdnAccessibility", "chromeUx", "webDesign", "wikipediaTypography", "gutenbergBooks"]
    ]
  };
}

function seedExpression(fixture) {
  return `(async () => {
    const fixture = ${JSON.stringify(fixture)};
    const store = await import(chrome.runtime.getURL("js/lib/store.js"));
    const { STORE_KEYS } = await import(chrome.runtime.getURL("js/lib/types.js"));
    const now = Date.now();
    const deviceId = await store.getDeviceId();
    const meta = (id, ageMinutes = 0) => ({
      id, deviceId, createdAt: now - ageMinutes * 60_000,
      modifiedAt: now - ageMinutes * 60_000, schemaVersion: 1
    });
    const page = (key, labels = []) => ({ ...fixture.sites[key], labels });
    const inbox = {
      "11111111-1111-4111-8111-111111111111": {
        ...meta("11111111-1111-4111-8111-111111111111", 50),
        kind: "window", source: "manual", windowTitle: "Reading",
        labels: [], tabs: [
          page("gutenbergBooks", ["Reading"]),
          { ...page("archiveCollections", ["Reading", "Reference"]),
            title: "Design collections at the Internet Archive" },
          page("wikipediaWeb", ["Research"])
        ]
      },
      "22222222-2222-4222-8222-222222222222": {
        ...meta("22222222-2222-4222-8222-222222222222", 145),
        kind: "tab", source: "manual", labels: ["Design"],
        tabs: [page("webDesign", ["Design"])]
      },
      "33333333-3333-4333-8333-333333333333": {
        ...meta("33333333-3333-4333-8333-333333333333", 320),
        kind: "tab", source: "manual", labels: ["Reference"],
        tabs: [page("mdnAccessibility", ["Reference"])]
      }
    };
    const sessions = {
      "44444444-4444-4444-8444-444444444444": {
        ...meta("44444444-4444-4444-8444-444444444444", 80),
        name: "Launch notes", auto: false, labels: ["Research", "Design"],
        windows: [
          [page("chromeExtensions", ["Reference"]), page("mdnStorage", ["Research"])],
          [page("wikipediaTypography", ["Design"]), page("webDesign", ["Design"])]
        ]
      },
      "55555555-5555-4555-8555-555555555555": {
        ...meta("55555555-5555-4555-8555-555555555555", 260),
        name: "Design references", auto: false, labels: ["Design"],
        windows: [[page("chromeUx", ["Design"]), page("mdnAccessibility", ["Reference"])]]
      }
    };
    const starred = {
      "66666666-6666-4666-8666-666666666661": {
        ...meta("66666666-6666-4666-8666-666666666661", 30),
        ...fixture.sites.mdnStorage, title: "MDN", position: 0
      },
      "66666666-6666-4666-8666-666666666662": {
        ...meta("66666666-6666-4666-8666-666666666662", 29),
        ...fixture.sites.chromeExtensions, title: "Chrome Developers", position: 1
      },
      "66666666-6666-4666-8666-666666666663": {
        ...meta("66666666-6666-4666-8666-666666666663", 28),
        ...fixture.sites.wikipediaWeb, title: "Wikipedia", position: 2
      },
      "66666666-6666-4666-8666-666666666664": {
        ...meta("66666666-6666-4666-8666-666666666664", 27),
        ...fixture.sites.archiveWayback, title: "Internet Archive", position: 3
      },
      "66666666-6666-4666-8666-666666666665": {
        ...meta("66666666-6666-4666-8666-666666666665", 26),
        ...fixture.sites.gutenbergBooks, title: "Project Gutenberg", position: 4
      }
    };
    const organizationGroups = {
      "77777777-7777-4777-8777-777777777771": {
        ...meta("77777777-7777-4777-8777-777777777771", 500),
        organizationKind: "session", name: "Projects"
      },
      "77777777-7777-4777-8777-777777777772": {
        ...meta("77777777-7777-4777-8777-777777777772", 490),
        organizationKind: "label", name: "Topics"
      }
    };
    const organizationMemberships = {};
    const addMembership = (id, kind, memberKey, groupId) => {
      organizationMemberships[id] = {
        ...meta(id, 20), organizationKind: kind, memberKey, groupId
      };
    };
    addMembership("88888888-8888-4888-8888-888888888881", "session",
      "44444444-4444-4444-8444-444444444444", "77777777-7777-4777-8777-777777777771");
    addMembership("88888888-8888-4888-8888-888888888882", "session",
      "55555555-5555-4555-8555-555555555555", "77777777-7777-4777-8777-777777777771");
    for (const [index, label] of ["Research", "Design", "Reading", "Reference"].entries()) {
      addMembership(
        "88888888-8888-4888-8888-88888888889" + index,
        "label", label, "77777777-7777-4777-8777-777777777772"
      );
    }
    await store.patchSettings({
      uiScheme: "sunset", uiMode: "scheme", uiGradient: true,
      uiInterfaceStyle: "crisp", uiRowInfo: "detailed",
      uiActionLabels: "icons", uiSidebarCollapsed: false,
      uiSectionIntros: true, newTabMode: "dashboard", newTabFocus: "omnibox",
      newTabWelcomeEnabled: true, newTabWelcomePhrases: ["One thing at a time."],
      newTabWelcomeTone: "clock", schemeRotate: "off", oneNewTabPerWindow: false,
      autoArchiveEnabled: true, autoDumpAfterMinutes: 1440, autoArchiveDays: 1,
      suspendEnabled: true, suspendAfterMinutes: 720, suspendMinTabs: 0,
      autoSaveMaxTabs: 0, suspendMaxTabs: 0, inboxExpiryDays: 30,
      archiveWhitelist: ["site:archive.org"], suspendWhitelist: ["site:archive.org"]
    });
    await store.mutateStores([
      STORE_KEYS.inbox, STORE_KEYS.sessions, STORE_KEYS.starred,
      STORE_KEYS.organizationGroups, STORE_KEYS.organizationMemberships, "labelMeta"
    ], () => ({
      [STORE_KEYS.inbox]: inbox,
      [STORE_KEYS.sessions]: sessions,
      [STORE_KEYS.starred]: starred,
      [STORE_KEYS.organizationGroups]: organizationGroups,
      [STORE_KEYS.organizationMemberships]: organizationMemberships,
      labelMeta: { Research: now - 10, Design: now - 20, Reading: now - 30, Reference: now - 40 }
    }));
    await chrome.storage.local.set({ onboardingDone: true, onboardingPage: 0 });
    const created = [];
    for (const keys of fixture.windows) {
      const window = await chrome.windows.create({
        url: keys.map((key) => fixture.sites[key].url), focused: false,
        type: "normal", width: 1120, height: 720
      });
      created.push({ id: window.id, tabs: window.tabs.map((tab) => tab.id) });
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
    const activity = {};
    const ages = [8 * 60, 5 * 60, 170, 75, 35, 10 * 60, 7 * 60, 210, 95, 45];
    created.flatMap((window) => window.tabs).forEach((tabId, index) => {
      activity[tabId] = now - ages[index] * 60_000;
    });
    await chrome.storage.local.set({ tabActivity: activity });
    return { created };
  })()`;
}

async function openExtensionPage(debugUrl, extensionId, relativeUrl) {
  const session = await createTarget(debugUrl, `chrome-extension://${extensionId}/${relativeUrl}`);
  await prepareSession(session);
  return session;
}

async function createCapturePage(debugUrl, extensionId) {
  const url = `chrome-extension://${extensionId}/dashboard.html#open`;
  // Use a compositor-backed target. Current Chrome for Testing can leave a
  // hidden target without a capturable surface; EveryTab already excludes its
  // own extension pages from the user's Open-tab ledger.
  const session = await createTarget(debugUrl, url);
  await prepareSession(session);
  return session;
}

async function navigate(session, url) {
  await session.send("Page.navigate", { url });
  await waitFor(session, "document.readyState === 'complete'", `navigation to ${url}`);
}

function reviewGallery() {
  const escape = (value) => String(value).replace(/[&<>"]/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));
  const figures = shots.map((shot) => {
    const nativeSurface = shot.width !== 1280 || shot.height !== 800;
    const kind = shot.slot ? `Store image ${shot.slot}` : nativeSurface ? 'Native surface' : 'Alternate';
    const scaledReview = nativeSurface ? '' : `<details><summary>Review at 640 × 400</summary><img class="half" src="${escape(shot.filename)}" width="640" height="400" alt="Half-size review: ${escape(shot.subject)}" loading="lazy"></details>`;
    return `<section id="${escape(shot.filename.replace('.png', ''))}">
    <p class="eyebrow">${kind} · ${escape(shot.style)} · ${escape(shot.scheme)}</p>
    <h2>${escape(shot.headline)}</h2>
    <p>${escape(shot.subject)} · ${shot.width} × ${shot.height} · <a href="${escape(shot.filename)}">Open full-size PNG</a></p>
    <div class="image-frame${nativeSurface ? ' native' : ''}" style="--image-width:${shot.width}px"><img src="${escape(shot.filename)}" width="${shot.width}" height="${shot.height}" alt="${escape(shot.subject)}" loading="lazy"></div>
    ${scaledReview}
  </section>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>EveryTab ${escape(build)} · Store screenshot review</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f4f2ed;color:#26221c;font:16px/1.5 system-ui,sans-serif}
  main{max-width:1376px;margin:auto;padding:48px}h1{font-size:36px;letter-spacing:-.04em;margin:8px 0 16px}h2{font-size:26px;letter-spacing:-.025em;margin:6px 0 10px}
  p{max-width:800px}a{color:#1e4a49;text-underline-offset:3px}header{padding-bottom:36px;border-bottom:1px solid #d8d4cc}section{margin:56px 0 80px}.eyebrow{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#655f55}.image-frame{width:100%}.image-frame.native{width:min(100%,var(--image-width));padding:20px;background:#e8e4dc}.image-frame img{display:block;width:100%;height:auto}img.half{display:block;width:640px;max-width:100%;height:auto;margin-top:16px}details{margin-top:20px}summary{cursor:pointer}nav{display:flex;gap:16px;flex-wrap:wrap;margin-top:24px}
  @media(max-width:720px){main{padding:24px 16px}h1{font-size:28px}h2{font-size:23px}}
  </style><main><header><p class="eyebrow">EveryTab ${escape(build)} · Owner review</p><h1>Launch image library.</h1>
  <p>These use a disposable profile and deterministic public-page fixtures. Product-only captures are untouched. The two browser-context views place exact popup and side-panel pixels inside a deterministic browser and web-page frame so their real scale is clear.</p>
  <p>The first five images remain the proposed Store upload sequence. The other 1280 × 800 views are alternatives. Native popup and side-panel captures remain available beside their full-browser compositions.</p>
  <nav>${shots.map(shot => `<a href="#${escape(shot.filename.replace('.png', ''))}">${escape(shot.slot ? String(shot.slot) + '. ' + shot.subject : shot.subject)}</a>`).join('')}</nav></header>${figures}</main></html>\n`;
}

function reviewMarkdown() {
  const primary = shots.filter(({ slot }) => slot).sort((a, b) => a.slot - b.slot);
  const alternates = shots.filter(({ slot, width, height }) => !slot && width === 1280 && height === 800);
  const native = shots.filter(({ width, height }) => width !== 1280 || height !== 800);
  const list = (items, numbered = false) => items.map((shot, index) =>
    `${numbered ? `${index + 1}.` : '-'} \`${shot.filename}\`: ${shot.subject}, ${shot.style} / ${shot.scheme}.`
  ).join('\n');
  return `# EveryTab ${build} launch image library

Open the [visual review gallery](index.html) to compare every image at its intended
aspect ratio. All captures use the exact ${build} runtime, synthetic EveryTab
records, deterministic public-page fixtures and a disposable Chrome profile.

## Proposed Store sequence

${list(primary, true)}

## Full-size alternatives

${list(alternates)}

## Native product surfaces

${list(native)}

The Store upload remains limited to five 1280 × 800 screenshots. Native popup
and side-panel captures retain authentic compact sizes; their full-browser
alternatives use those exact pixels inside a deterministic browser/page frame.
See [capture-evidence.json](capture-evidence.json) for source, tool and image
fingerprints. No package, upload or submission is authorized by this library.
`;
}

async function main() {
  await rm(screenshotRoot, { recursive: true, force: true });
  await mkdir(screenshotRoot, { recursive: true });
  const sourceBefore = await sourceFingerprint();
  const profile = await mkdtemp(path.join(tmpdir(), "everytab-store-capture-"));
  const fixtureServer = await startFixtureServer();
  const mappedHosts = [...new Set(Object.values(SITES).map(({ host }) => host))]
    .map((host) => `MAP ${host} 127.0.0.1`).join(",");
  const chrome = spawnOwnedChrome(chromeBin, [
    "--headless=new",
    "--disable-gpu",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extensionRoot}`,
    `--load-extension=${extensionRoot}`,
    `--host-resolver-rules=${mappedHosts}`,
    "--window-size=1280,800",
    "--window-position=-10000,-10000",
    "--force-device-scale-factor=1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });

  try {
    const debugUrl = await debuggingUrl(chrome);
    const extensionId = await detectExtension(debugUrl, { settleFreshInstall: true });
    const seed = await openExtensionPage(debugUrl, extensionId, "dashboard.html#open");
    const seeded = await evaluate(seed, seedExpression(captureFixture(fixtureServer.port)));
    await evaluate(seed, `(async () => {
      const keep = new Set(${JSON.stringify(seeded.created.map(({ id }) => id))});
      const current = await chrome.windows.getCurrent();
      const windows = await chrome.windows.getAll();
      for (const window of windows) {
        if (window.type === 'normal' && window.id !== current.id && !keep.has(window.id)) {
          await chrome.windows.remove(window.id).catch(() => {});
        }
      }
      return true;
    })()`);
    seed.close();
    const capturePage = await createCapturePage(debugUrl, extensionId);

    const dashboardUrl = `chrome-extension://${extensionId}/dashboard.html`;
    const appearance = async (scheme, style) => evaluate(capturePage, `(async () => {
      const store = await import(chrome.runtime.getURL('js/lib/store.js'));
      await store.patchSettings({ uiScheme: ${JSON.stringify(scheme)}, uiMode: 'scheme', uiInterfaceStyle: ${JSON.stringify(style)} });
    })()`);
    await appearance('cream', 'crisp');
    await navigate(capturePage, `${dashboardUrl}#settings:autosave`);
    await waitFor(capturePage, "document.querySelector('#settings-autosave') || document.querySelector('.settings-filter')", "Automation settings render");
    await evaluate(capturePage, `(() => {
      const input = document.querySelector('.settings-filter');
      input.value = 'idle'; input.dispatchEvent(new InputEvent('input', {bubbles:true}));
      window.scrollTo({top:0, behavior:'instant'});
    })()`);
    await capture(capturePage, "01-automation-1280x800.png", { slot: 1, headline: "Choose what happens to idle tabs.", subject: "Auto-save and suspension settings", style: "Crisp", scheme: "Cream" });

    const minimalAppearance = async (scheme, phrase, style = 'soft') => evaluate(capturePage, `(async () => {
      const store = await import(chrome.runtime.getURL('js/lib/store.js'));
      await store.patchSettings({
        uiScheme: ${JSON.stringify(scheme)}, uiMode: 'scheme',
        uiInterfaceStyle: ${JSON.stringify(style)}, newTabMode: 'minimal',
        newTabFocus: 'omnibox', newTabWelcomeEnabled: true,
        newTabWelcomePhrases: [${JSON.stringify(phrase)}]
      });
      localStorage.removeItem('tvMinimalWelcomeState');
    })()`);
    const newtabUrl = `chrome-extension://${extensionId}/newtab.html`;

    await minimalAppearance('frozenllama', 'Make space for what matters.');
    await navigate(capturePage, newtabUrl);
    await waitFor(capturePage, "document.querySelector('.minimal-welcome')?.textContent === 'Make space for what matters.' && document.querySelectorAll('.minimal-launch-item').length >= 5", "Frozen Llama Minimal render");
    await capture(capturePage, "02-minimal-frozen-llama-1280x800.png", { slot: 2, headline: "A calmer place to begin.", subject: "Minimal New Tab with a personal welcome", style: "Soft", scheme: "Frozen Llama" });

    await minimalAppearance('aladdin', 'Start with one clear thought.');
    await navigate(capturePage, newtabUrl);
    await waitFor(capturePage, "document.querySelector('.minimal-welcome')?.textContent === 'Start with one clear thought.' && document.querySelectorAll('.minimal-launch-item').length >= 5", "Aladdin Minimal render");
    await capture(capturePage, "03-minimal-aladdin-1280x800.png", { slot: 3, headline: "Make your New Tab your own.", subject: "Minimal New Tab in the Aladdin scheme", style: "Soft", scheme: "Aladdin" });

    await appearance('ink', 'soft');
    await navigate(capturePage, `${dashboardUrl}#settings:appearance`);
    await waitFor(capturePage, "document.body?.dataset.page === 'settings' && document.querySelector('.quick-theme .gear')", "scheme picker trigger");
    await evaluate(capturePage, "document.querySelector('.quick-theme .gear').click()");
    await waitFor(capturePage, "!document.querySelector('#sidebar-scheme-picker')?.classList.contains('hidden') && document.querySelectorAll('#sidebar-scheme-picker .theme-catalogue .theme-opt-row').length >= 36", "full scheme picker");
    await capture(capturePage, "04-scheme-picker-1280x800.png", { slot: 4, headline: "Choose the browser that feels like yours.", subject: "All 36 built-in color schemes", style: "Soft", scheme: "Ink" });

    await appearance('sunset', 'soft');
    const focus = await evaluate(capturePage, `(async () => {
      const store = await import(chrome.runtime.getURL('js/lib/store.js'));
      await store.patchSettings({ newTabMode: 'minimal', newTabFocus: 'omnibox',
        newTabWelcomeEnabled: true, newTabWelcomePhrases: ['Protect the time you chose.'],
        focusSiteRules: [{domain: 'reddit.com', displayDomain: 'reddit.com', scope: 'focus'}, {domain: 'youtube.com', displayDomain: 'youtube.com', scope: 'focus'}] });
      localStorage.removeItem('tvMinimalWelcomeState');
      return chrome.runtime.sendMessage({type:'focus-guard-start', endChoice:{mode:'duration', durationMinutes:45}});
    })()`);
    if (!focus?.ok) throw new Error(`Fixture Focus did not start: ${JSON.stringify(focus)}`);
    await navigate(capturePage, newtabUrl);
    await waitFor(capturePage, "document.querySelector('.minimal-focus-control.is-active [data-focus-state=active].is-current')?.textContent.includes('45m')", "Minimal active Focus render");
    await capture(capturePage, "05-minimal-focus-1280x800.png", { slot: 5, headline: "Make room for focused work.", subject: "Minimal New Tab with a real 45-minute Focus run", focusActive: focus.status.active, style: "Soft", scheme: "Sunset Surf" });

    await appearance('cyberwave', 'crisp');
    await navigate(capturePage, `${dashboardUrl}#open`);
    await waitFor(capturePage, "document.body?.dataset.page === 'open' && document.querySelector('.hero-focus.is-active [data-focus-state=active].is-current') && document.querySelectorAll('[data-sec=\"open\"] .trow').length >= 8", "Dashboard active Focus render");
    await evaluate(capturePage, `(() => {
      const card = document.querySelector('[data-sec="open"] [data-tablist-card]');
      if (card && !card.classList.contains('is-folded')) card.querySelector('.item-head-toggle')?.click();
    })()`);
    await waitFor(capturePage, "document.querySelector('[data-sec=\"open\"] [data-tablist-card]')?.classList.contains('is-folded')", "current window collapse for Dashboard Focus");
    await capture(capturePage, "alternate-dashboard-focus-1280x800.png", { slot: null, headline: "Keep the work you chose in view.", subject: "Dashboard Open tabs with an active Focus run", focusActive: true, style: "Crisp", scheme: "Cyberwave" });
    await evaluate(capturePage, "chrome.runtime.sendMessage({type:'focus-guard-end'})");

    await appearance('godspeed', 'crisp');
    await navigate(capturePage, `${dashboardUrl}#open`);
    await waitFor(capturePage, "document.body?.dataset.page === 'open' && document.querySelectorAll('[data-sec=\"open\"] .trow').length >= 10", "Open tabs render");
    await evaluate(capturePage, `(() => {
      const card = document.querySelector('[data-sec="open"] [data-tablist-card]');
      if (card && !card.classList.contains('is-folded')) card.querySelector('.item-head-toggle')?.click();
    })()`);
    await waitFor(capturePage, "document.querySelector('[data-sec=\"open\"] [data-tablist-card]')?.classList.contains('is-folded')", "current window collapse for Open tabs");
    await capture(capturePage, "alternate-open-tabs-1280x800.png", { slot: null, headline: "See every open tab without losing your place.", subject: "Open tabs across two fixture windows", style: "Crisp", scheme: "Godspeed" });

    await appearance('nautilus', 'terminal');
    await navigate(capturePage, `${dashboardUrl}#sessions`);
    await waitFor(capturePage, "document.body?.dataset.page === 'sessions' && document.querySelectorAll('[data-sec=\"sessions\"] [data-tablist-card]').length >= 2", "Sessions render");
    await capture(capturePage, "alternate-sessions-1280x800.png", { slot: null, headline: "Bring a complete workspace back when you need it.", subject: "Named Sessions with saved windows", style: "Terminal", scheme: "Nautilus" });

    await appearance('matcha', 'soft');
    await navigate(capturePage, `${dashboardUrl}#labels`);
    await waitFor(capturePage, "document.body?.dataset.page === 'labels' && document.querySelectorAll('[data-sec=\"labels\"] [data-tablist-card]').length >= 4", "Labels render");
    await capture(capturePage, "alternate-labels-1280x800.png", { slot: null, headline: "Find related pages wherever you saved them.", subject: "Labels spanning saved pages and Sessions", style: "Soft", scheme: "Matcha" });

    await minimalAppearance('goodnight', 'What deserves your attention next?', 'crisp');
    // Render this Store-sized PNG from a genuinely large 1920 × 1200 CSS
    // viewport. A 2/3 device scale preserves the required 1280 × 800 output
    // while showing Minimal Search in the large-screen composition users see.
    await setViewport(capturePage, 1920, 1200, 2 / 3);
    await navigate(capturePage, newtabUrl);
    await waitFor(capturePage, "document.querySelector('.minimal-welcome')?.textContent === 'What deserves your attention next?'", "Good Night Minimal render");
    await evaluate(capturePage, "document.querySelector('.search-input').focus({preventScroll:true})");
    await waitFor(capturePage, "document.querySelectorAll('.ghost-domain-slot .ghost-chip').length >= 1 && document.querySelectorAll('.ghost-label-slot .ghost-chip').length >= 2 && document.querySelectorAll('.search-recent-list .search-row').length >= 8", "Minimal Search suggestions and recent tabs", 20_000);
    await capture(capturePage, "alternate-minimal-search-1280x800.png", { slot: null, headline: "Jump back to a recent page in a few keystrokes.", subject: "Large-screen Minimal Search with the complete clock, domain, Label and recent-tab suggestions", style: "Crisp", scheme: "Good Night", verifyMinimalSearchClock: true });
    await setViewport(capturePage, 1280, 800);

    await appearance('tokyonight', 'soft');
    const popupFixtureUrl = siteUrl(SITES.gutenbergShelf, fixtureServer.port);
    const popupFixture = await evaluate(capturePage, `(async () => {
      const current = await chrome.tabs.getCurrent();
      await chrome.windows.update(current.windowId, {focused:true});
      const tab = await chrome.tabs.create({windowId:current.windowId, url:${JSON.stringify(popupFixtureUrl)}, active:true});
      await new Promise((resolve) => {
        const done = (tabId, change) => {
          if (tabId !== tab.id || change.status !== 'complete') return;
          chrome.tabs.onUpdated.removeListener(done);
          resolve();
        };
        chrome.tabs.onUpdated.addListener(done);
        setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); resolve(); }, 3000);
      });
      return {tabId:tab.id, windowId:tab.windowId};
    })()`);
    if (!popupFixture?.tabId) throw new Error(`Popup fixture tab did not open for ${popupFixtureUrl}`);
    await setViewport(capturePage, 400, 498);
    await navigate(capturePage, `chrome-extension://${extensionId}/popup.html`);
    await waitFor(capturePage, "document.body.classList.contains('popup-ready') && document.querySelector('.th-title')?.textContent.includes('Bookshelves')", "popup hydration", 20_000);
    await evaluate(capturePage, `(async () => {
      const current = await chrome.tabs.getCurrent();
      await chrome.tabs.update(current.id, {active:true});
      await chrome.windows.update(current.windowId, {focused:true});
    })()`);
    await waitFor(capturePage, "document.visibilityState === 'visible' && document.querySelector('.th-title')?.textContent.includes('Bookshelves')", "visible popup capture surface");
    await capture(capturePage, "supplemental-popup-400x498.png", { slot: null, headline: "Act on the page or the whole window.", subject: "Extension popup for a public Project Gutenberg page", style: "Soft", scheme: "Tokyo Night", width: 400, height: 498 });

    await appearance('nord', 'soft');
    await setViewport(capturePage, 420, 712);
    await navigate(capturePage, `chrome-extension://${extensionId}/sidepanel.html`);
    await waitFor(capturePage, "document.querySelector('.sidepanel-shell') && document.querySelectorAll('[data-panel-section=\"open\"] .trow').length >= 10", "side panel Open render", 20_000);
    await evaluate(capturePage, `(() => {
      const card = document.querySelector('[data-panel-section="open"] [data-tablist-card]');
      if (card && !card.classList.contains('is-folded')) card.querySelector('.item-head-toggle')?.click();
    })()`);
    await waitFor(capturePage, "document.querySelector('[data-panel-section=\"open\"] [data-tablist-card]')?.classList.contains('is-folded')", "current window collapse for side panel");
    await capture(capturePage, "supplemental-side-panel-420x712.png", { slot: null, headline: "Keep EveryTab beside the page you are using.", subject: "Side panel Open view", style: "Soft", scheme: "Nord", width: 420, height: 712 });

    await setViewport(capturePage, 1280, 800);

    await appearance('tide', 'soft');
    await navigate(capturePage, `${dashboardUrl}#inbox`);
    await waitFor(capturePage, "document.body?.dataset.page === 'inbox' && document.querySelectorAll('.trow').length >= 3", "Inbox render");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await evaluate(capturePage, `(() => {
      const checkbox = document.querySelector('[data-sec="inbox"] .trow input[type=checkbox]');
      if (!checkbox) throw new Error('Missing Inbox checkbox');
      checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(capturePage, "document.querySelector('[data-sec=\"inbox\"] .trow.sel input[type=checkbox]:checked')", "Inbox row selection");
    await capture(capturePage, "alternate-inbox-1280x800.png", { slot: null, headline: "Save it now. Come back when you are ready.", subject: "Selected Inbox page", style: "Soft", scheme: "Tide" });

    await appearance('ink', 'soft');
    await navigate(capturePage, `${dashboardUrl}#open`);
    await waitFor(capturePage, "document.body?.dataset.page === 'open' && document.querySelectorAll('.trow').length >= 8", "Open tabs before Tour");
    await evaluate(capturePage, `(async () => {
      await chrome.storage.local.set({onboardingPage: 'scheme'});
      const { showOnboarding } = await import(chrome.runtime.getURL('js/ui/onboarding.js'));
      await showOnboarding();
      const allSchemes = [...document.querySelectorAll(".ob-overlay details")].find(node => node.querySelector("summary")?.textContent.includes("All schemes"));
      if (allSchemes?.open) allSchemes.querySelector("summary").click();
    })()`);
    await waitFor(capturePage, "document.querySelector('.ob-overlay')", "Tour appearance page");
    await capture(capturePage, "alternate-tour-1280x800.png", { slot: null, headline: "Make EveryTab feel like yours.", subject: "Tour appearance choices", style: "Soft", scheme: "Ink" });
    await captureBrowserContext(capturePage, "alternate-popup-browser-1280x800.png",
      "supplemental-popup-400x498.png", {
        kind: "popup", slot: null, headline: "Act without leaving the page.",
        subject: "EveryTab popup in a complete browser and public-page context",
        style: "Soft", scheme: "Tokyo Night"
      });
    await captureBrowserContext(capturePage, "alternate-side-panel-browser-1280x800.png",
      "supplemental-side-panel-420x712.png", {
        kind: "sidepanel", slot: null, headline: "Keep EveryTab beside the page.",
        subject: "EveryTab Side Panel in a complete browser and public-page context",
        style: "Soft", scheme: "Nord"
      });
    capturePage.close();
    const sourceAfter = await sourceFingerprint();
    if (sourceBefore.sha256 !== sourceAfter.sha256) throw new Error('Runtime source changed during capture; repeat after edits settle.');

    const captureSizes = Object.entries(shots.reduce((counts, shot) => {
      const key = `${shot.width}x${shot.height}`;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {})).map(([size, count]) => ({ size, count }));
    const evidence = {
      app: "everytab",
      kind: "store-beta-screenshot-capture",
      build,
      // Name only: an absolute scratch path would leak the local account name.
      extensionRoot: process.env.EVERYTAB_EXTENSION_ROOT ? `${path.basename(extensionRoot)} (EVERYTAB_EXTENSION_ROOT)` : "extension",
      source: sourceAfter,
      captureToolSha256: createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex"),
      capturedAt: new Date().toISOString(),
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
      captureSizes,
      reducedReview: "1280 x 800 PNGs can be displayed at 640 x 400 CSS pixels in the review gallery; native compact surfaces retain their own aspect ratio; no derivative images",
      motion: "prefers-reduced-motion: reduce for settled still captures",
      profile: "disposable",
      network: "local deterministic public-page fixtures",
      files: shots
    };
    await writeFile(path.join(screenshotRoot, "index.html"), reviewGallery());
    await writeFile(path.join(screenshotRoot, "REVIEW.md"), reviewMarkdown());
    await writeFile(path.join(screenshotRoot, "capture-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ...evidence, source: { fileCount: evidence.source.fileCount, sha256: evidence.source.sha256 } }, null, 2)}\n`);
  } finally {
    await terminateOwnedChrome(chrome);
    await fixtureServer.close();
    await rm(profile, { recursive: true, force: true });
  }
}

export { CdpClient, attachTarget, createTarget, detectExtension, evaluate, waitFor, prepareSession, startFixtureServer, captureFixture, seedExpression, debuggingUrl, chromeBin, extensionRoot, SITES };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
