// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Explicit measurement, not a timing gate. Uses only an owned profile and synthetic databases.
 * Run: CHROME_BIN=/path/to/chrome node tools/measure-native-storage.mjs [--search|--search-mixed] > receipt.json
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir, cpus, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnOwnedChrome, terminateOwnedChrome } from "../extension/test/chrome-test-process.mjs";
import { SCENARIOS, ROUNDS } from "../extension/test/native-storage-benchmark-page.mjs";
import { MIXED_SCENARIOS, WORKLOADS } from "../extension/test/native-mixed-search-fixture.mjs";
import { inspectMeasurementReceipt } from "./testing/native-measurement-receipt.mjs";

const args = process.argv.slice(2);
if (args.length && !(args.length === 1 && ["--search", "--search-mixed"].includes(args[0]))) {
  throw new Error("Use no arguments for Library storage, --search for mounted Search, or --search-mixed for mixed Search workloads");
}
const mixedMode = args[0] === "--search-mixed";
const searchMode = args[0] === "--search" || mixedMode;
const { chromeBin, createTarget, debuggingUrl, evaluate } = await import("./capture-store-screenshots.mjs");

const root = await realpath(fileURLToPath(new URL("../extension/", import.meta.url)));
const loadedSources = new Map();
let sourceFailure;
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    const allowed = pathname === "/test/native-storage-benchmark.html" ||
      pathname === "/test/native-storage-benchmark-page.mjs" ||
      pathname === "/test/native-search-benchmark.html" ||
      pathname === "/test/native-search-benchmark-page.mjs" ||
      pathname === "/test/native-mixed-search-benchmark.html" ||
      pathname === "/test/native-mixed-search-benchmark-page.mjs" ||
      pathname === "/test/native-mixed-search-fixture.mjs" ||
      pathname === "/test/native-search-oracles.mjs" ||
      pathname === "/test/browser-message-fixture.js" ||
      pathname === "/_locales/en/messages.json" ||
      (pathname.startsWith("/js/") && pathname.endsWith(".js")) ||
      (pathname.startsWith("/css/") && pathname.endsWith(".css"));
    if (!allowed) { response.writeHead(404).end(); return; }
    const file = await realpath(path.resolve(root, `.${pathname}`));
    if (!file.startsWith(`${root}${path.sep}`)) { response.writeHead(403).end(); return; }
    const body = await readFile(file);
    const sourcePath = path.posix.normalize(pathname).slice(1);
    const hash = createHash("sha256").update(body).digest("hex");
    if (loadedSources.has(sourcePath) && loadedSources.get(sourcePath) !== hash) {
      sourceFailure ??= new Error(`Measurement source changed during run: ${sourcePath}`);
      response.writeHead(409).end();
      return;
    }
    loadedSources.set(sourcePath, hash);
    const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
      ".css": "text/css", ".json": "application/json" };
    response.writeHead(200, { "Content-Type": mime[path.extname(pathname)],
      "Cache-Control": "no-store" });
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
let profile;
let chrome;
let session;
let report;
let failure;

async function waitForReceipt(url, deadline, trial = null) {
  let lastProgress;
  while (performance.now() < deadline) {
    if (sourceFailure) throw sourceFailure;
    let observed;
    try {
      observed = await evaluate(session, "({ href: location.href, state: window.benchmarkState ?? null })");
    } catch (error) {
      // Navigation can replace the execution context while a poll is in flight.
      // Other CDP failures must still abort the measurement and reach cleanup.
      if (!/Execution context was destroyed|Cannot find context with specified id/.test(error.message)) throw error;
    }
    if (sourceFailure) throw sourceFailure;
    const receipt = inspectMeasurementReceipt(observed, url, trial);
    if (receipt) return receipt;
    const state = observed?.href === url ? observed.state : null;
    const progress = JSON.stringify(state?.progress);
    if (progress && progress !== lastProgress) { process.stderr.write(`${progress}\n`); lastProgress = progress; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(mixedMode ? "Native mixed Search measurement exceeded ten minutes"
    : searchMode ? "Native Search measurement exceeded six minutes"
    : "Native storage measurement exceeded four minutes");
}

try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  profile = await mkdtemp(path.join(tmpdir(), "everytab-native-measurement-"));
  chrome = spawnOwnedChrome(chromeBin, [
    "--headless=new", "--disable-gpu", "--disable-background-networking", "--disable-component-update",
    "--disable-default-apps", "--no-first-run", "--remote-debugging-port=0",
    ...(searchMode ? ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"] : []),
    ...(process.env.EVERYTAB_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
    `--user-data-dir=${profile}`, "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const debugUrl = await Promise.race([
    debuggingUrl(chrome), new Promise((resolve, reject) => chrome.once("error", reject))
  ]);
  session = await createTarget(debugUrl, "about:blank");
  const browser = await session.send("Browser.getVersion");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const deadline = performance.now() + (mixedMode ? 600_000 : searchMode ? 360_000 : 240_000);
  let measured;
  if (searchMode) {
    await session.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900,
      deviceScaleFactor: 1, mobile: false });
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }]
    });
    await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await session.send("Page.bringToFront");
    const scenarios = mixedMode ? MIXED_SCENARIOS : SCENARIOS;
    measured = { results: [], parameters: { rounds: ROUNDS, scenarios,
      ...(mixedMode ? { workloads: WORKLOADS } : {}),
      viewport: { width: 1280, height: 900 }, reducedMotion: "reduce",
      focusEmulated: true, backgroundThrottlingDisabled: true }, cleanup: { deletedDatabases: 0 } };
    for (let round = 1; round <= ROUNDS; round += 1) {
      const trialOrder = scenarios.flatMap((_, index) => mixedMode
        ? WORKLOADS.map(workload => ({ index, workload })) : [{ index }]);
      if (round % 2 === 0) trialOrder.reverse();
      for (const { index, workload } of trialOrder) {
        const page = mixedMode ? "native-mixed-search-benchmark.html" : "native-search-benchmark.html";
        const url = `${baseUrl}/test/${page}?scenario=${index}${mixedMode ? `&workload=${workload}` : ""}&round=${round}`;
        await session.send("Page.navigate", { url });
        // A new document must retain the intended foreground rendering state.
        await session.send("Page.bringToFront");
        const receipt = await waitForReceipt(url, deadline, { ...scenarios[index], round,
          ...(mixedMode ? { workload } : {}) });
        measured.results.push(receipt.result);
        measured.cleanup.deletedDatabases += receipt.cleanup.deletedDatabases;
      }
    }
  } else {
    const url = `${baseUrl}/test/native-storage-benchmark.html`;
    await session.send("Page.navigate", { url });
    measured = await waitForReceipt(url, deadline);
  }
  const version = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")).version;
  report = { schemaVersion: 1, sourceVersion: version, measuredAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, arch: process.arch,
      cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(),
      browser: browser.product, javascript: browser.jsVersion, headless: true },
    scope: mixedMode
      ? "Mixed production Search with native Library and Recovery databases on loopback; selective and broad workloads use mounted Search with synthetic input, while facets time public Search session methods and make no DOM or frame claim. Fresh document trials in one owned browser. No cold OS-cache, real browser history, contention, power-loss or cloud claim."
      : searchMode
      ? "Mounted production Search on loopback with native Library and Recovery databases and synthetic browser inputs; fresh document trials in one owned browser. No cold OS-cache, real browser history, contention, power-loss or cloud claim."
      : "Production Library module on loopback with native IndexedDB; timings include JS preparation and transaction completion. Reopened connections are not cold OS caches. No UI, authority, Search, contention, power-loss or cloud claim.",
    ...measured,
    loadedSources: Object.fromEntries([...loadedSources].sort(([a], [b]) => a.localeCompare(b))) };
} catch (error) { failure = error; }
finally {
  // Attempt each independent cleanup even if an earlier cleanup fails. Never remove
  // the profile while its owned Chrome tree might still be running.
  const cleanupErrors = [];
  try { session?.close(); } catch (error) { cleanupErrors.push(error); }
  let stopped = false;
  try { await terminateOwnedChrome(chrome); stopped = true; } catch (error) { cleanupErrors.push(error); }
  try {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } catch (error) { cleanupErrors.push(error); }
  if (stopped && profile) {
    try { await rm(profile, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) failure = new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "Measurement cleanup failed");
}
if (sourceFailure && !failure) failure = sourceFailure;
if (failure) throw failure;
report.cleanup = { ...report.cleanup, ownedBrowserStopped: true, profileRemoved: true, serverClosed: true };
console.log(JSON.stringify(report, null, 2));
