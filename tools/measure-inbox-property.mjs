// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Static outgoing Inbox comparison. Never edits runtime CSS or a user profile. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
import path from "node:path";
import { spawnOwnedChrome, terminateOwnedChrome } from "../extension/test/chrome-test-process.mjs";
import { chromeBin, extensionRoot, debuggingUrl, detectExtension, createTarget,
  CdpClient, evaluate, prepareSession, waitFor } from "./capture-store-screenshots.mjs";
import { captureInboxDocumentRoot, navigateInboxTrial } from "./testing/inbox-navigation.mjs";
import { createInboxDepartureTrace, validateInboxDepartureCompletion } from "./testing/inbox-departure-trace.mjs";
import { cleanupInboxMeasurement } from "./testing/inbox-measurement-cleanup.mjs";
import { validateInboxPropertyState, validateInboxPropertyPair,
  validateInboxFocusState, validateInboxFocusPair, validateInboxCommandPair, validateInboxMediaPair, validateInboxCommandDestination, summarizeInboxFocusPhases } from "./testing/inbox-property-fixture.mjs";

async function sourceHashes() {
  const entries = await readdir(extensionRoot, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile() &&
    !path.relative(extensionRoot, entry.parentPath).split(path.sep).includes("test"));
  const hashes = {};
  for (const entry of files.sort((a, b) => path.join(a.parentPath, a.name).localeCompare(path.join(b.parentPath, b.name)))) {
    const file = path.join(entry.parentPath, entry.name);
    hashes[path.relative(extensionRoot, file)] = createHash("sha256").update(await readFile(file)).digest("hex");
  }
  return hashes;
}

async function fixtureHashes() {
  const files = ["extension/test/inbox-property-static.html", "tools/measure-inbox-property.mjs",
    "tools/testing/inbox-property-fixture.mjs", "tools/testing/inbox-departure-trace.mjs",
    "tools/testing/inbox-navigation.mjs", "tools/testing/inbox-measurement-cleanup.mjs",
    "tools/capture-store-screenshots.mjs", "extension/test/chrome-test-process.mjs"];
  return Object.fromEntries(await Promise.all(files.map(async file =>
    [file, createHash("sha256").update(await readFile(path.join(extensionRoot, "..", file))).digest("hex")])));
}

// Run only in the owned synthetic Dashboard. Markup stays in memory, never in receipts.
async function captureMarkup() {
  const body = document.body.cloneNode(true);
  body.querySelectorAll("script").forEach(script => script.remove());
  if (body.querySelector("iframe, [srcset]")) throw new Error("Unsupported static fixture content");
  const sourceImages = [...document.body.querySelectorAll("img")];
  for (const [index, image] of [...body.querySelectorAll("img")].entries()) {
    const src = sourceImages[index].currentSrc || sourceImages[index].src;
    if (src.startsWith("blob:")) {
      const blob = await (await fetch(src)).blob();
      image.src = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } else if (src) image.src = src;
  }
  // Relative links/images refer to Dashboard, not the test host directory.
  for (const link of body.querySelectorAll("[href]")) {
    link.setAttribute("href", new URL(link.getAttribute("href"), location.href).href);
  }
  const attributes = element => [...element.attributes].map(({ name, value }) => [name, value]);
  return { html: body.innerHTML, root: attributes(document.documentElement), body: attributes(document.body),
    inputs: [...document.body.querySelectorAll("input")].map(input => ({
      checked: input.checked, indeterminate: input.indeterminate, value: input.value })) };
}

async function mountMarkup(snapshot, removed) {
  const attributes = (element, values) => {
    for (const { name } of [...element.attributes]) element.removeAttribute(name);
    for (const [name, value] of values) element.setAttribute(name, value);
  };
  attributes(document.documentElement, snapshot.root);
  attributes(document.body, snapshot.body);
  document.body.innerHTML = snapshot.html;
  const inputs = [...document.body.querySelectorAll("input")];
  if (inputs.length !== snapshot.inputs.length) throw new Error("Static fixture input mismatch");
  inputs.forEach((input, index) => Object.assign(input, snapshot.inputs[index]));
  const sheet = [...document.styleSheets].find(sheet => sheet.href === chrome.runtime.getURL("css/primitives.css"));
  const rules = [...sheet.cssRules];
  const registrations = rules.flatMap((rule, index) =>
    rule instanceof CSSPropertyRule ? [{ index, name: rule.name }] : []);
  if (registrations.length !== 1 || registrations[0].name !== "--focus-layout-h") {
    throw new Error("Static fixture requires one known property declaration");
  }
  // Common fixture state in BOTH variants. Without an explicit value, deleting
  // the registration changes a collapsed strip from 0px to auto height.
  if (getComputedStyle(document.documentElement).getPropertyValue("--focus-layout-h").trim() !== "0px" ||
      [...document.querySelectorAll(".focus-strip-layout")].some(strip => strip.getBoundingClientRect().height !== 0)) {
    throw new Error("Static fixture requires initially collapsed Focus");
  }
  document.documentElement.style.setProperty("--focus-layout-h", "0px");
  const remaining = rules.filter((_, index) => index !== registrations[0].index).map(rule => rule.cssText);
  if (removed) sheet.deleteRule(registrations[0].index);
  const after = [...sheet.cssRules];
  const afterRemaining = after.filter(rule => !(rule instanceof CSSPropertyRule)).map(rule => rule.cssText);
  if (JSON.stringify(remaining) !== JSON.stringify(afterRemaining) ||
      after.filter(rule => rule instanceof CSSPropertyRule).length !== (removed ? 0 : 1)) {
    throw new Error("Static fixture changed unrelated rules");
  }
  await document.fonts.ready;
  await Promise.all([...document.images].map(image => image.decode().catch(() => undefined)));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function fixtureState(includeFocus = false, includeMedia = false) {
  const rows = [...document.querySelectorAll('[data-tablist="inbox"] [data-tablist-row]')];
  const rect = element => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return [x, y, width, height];
  };
  const strips = [...document.querySelectorAll(".focus-strip-layout")];
  const active = document.activeElement;
  const key = row => row.dataset.tablistRow;
  const prefix = chrome.runtime.getURL("");
  return {
    ...(includeMedia ? { reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches } : {}),
    ...(includeFocus ? { focusedCheckbox: active?.matches('input[type="checkbox"]') ?? false,
      focusedRowCount: rows.filter(row => row.matches(":focus-within")).length,
      hoveredRowKeys: rows.filter(row => row.matches(":hover")).map(key),
      svgUseCount: document.querySelectorAll("svg use").length } : {}),
    rowKeys: rows.map(key), selectedKeys: rows.filter(row => row.classList.contains("sel")).map(key),
    checkedKeys: rows.filter(row => row.querySelector('input[type="checkbox"]').checked).map(key),
    focusedKey: active?.closest("[data-tablist-row]")?.dataset.tablistRow ?? null,
    focusVisible: active?.matches(":focus-visible") ?? false,
    focusLayoutValue: getComputedStyle(document.documentElement).getPropertyValue("--focus-layout-h").trim(),
    documentVisible: document.visibilityState === "visible", focused: document.hasFocus(),
    scriptCount: document.scripts.length,
    inlineHandlerCount: [...document.querySelectorAll("*")].filter(element =>
      [...element.attributes].some(attribute => attribute.name.startsWith("on"))).length,
    scriptResources: performance.getEntriesByType("resource").filter(entry => entry.initiatorType === "script").length,
    stylesheetPaths: [...document.styleSheets].map(sheet => sheet.href?.startsWith(prefix) ? sheet.href.slice(prefix.length) : "unowned"),
    propertyRules: [...document.styleSheets].reduce((sum, sheet) => sum +
      [...sheet.cssRules].filter(rule => rule instanceof CSSPropertyRule).length, 0),
    elements: document.querySelectorAll("*").length, focusStripCount: strips.length,
    geometry: [innerWidth, innerHeight, scrollX, scrollY, ...rect(document.body), ...rows.flatMap(rect), ...strips.flatMap(rect)]
  };
}

async function clickEndpoint(page, index, forceUnchecked = false) {
  const point = await evaluate(page, `(() => {
    const box = document.querySelectorAll('[data-tablist="inbox"] [data-tablist-row]')[${index}].querySelector('input[type="checkbox"]');
    if (${forceUnchecked}) box.checked = false;
    box.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = box.getBoundingClientRect();
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    if (document.elementFromPoint(x, y) !== box) throw new Error('Fixture checkbox obscured');
    return { x, y };
  })()`);
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
}

async function main() {
  const args = process.argv.slice(2);
  const nativeReducedMotion = args.includes("--native-reduced-motion");
  if (nativeReducedMotion) {
    assert.deepEqual(args, ["--command-control", "--native-reduced-motion"], "Native motion flag requires command control");
    args.pop();
  }
  assert.ok(args.length === 0 || (args.length === 1 && ["--focus-control", "--command-control", "--media-control"].includes(args[0])),
    "Use no arguments, --focus-control, --command-control or --media-control");
  const focusMode = args[0] === "--focus-control";
  const commandMode = args[0] === "--command-control";
  const mediaMode = args[0] === "--media-control";
  const canonicalMode = commandMode || mediaMode;
  const observeFocus = focusMode || canonicalMode;
  const sources = await sourceHashes();
  const fixtureSources = await fixtureHashes();
  const sourcePaths = Object.keys(sources).filter(file => file.startsWith("js/") && file.endsWith(".js"));
  const profile = await mkdtemp(path.join(tmpdir(), "everytab-inbox-property-"));
  const sessions = [], trials = [], captures = [];
  let browser, client, browserVersion;
  let detach = () => {};
  try {
    browser = spawnOwnedChrome(chromeBin, ["--headless=new", "--disable-gpu", "--remote-debugging-port=0",
      "--enable-unsafe-extension-debugging", "--disable-background-timer-throttling",
      ...((mediaMode || nativeReducedMotion) ? ["--force-prefers-reduced-motion"] : []),
      "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-background-networking",
      ...(process.env.EVERYTAB_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
      `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    const debug = await debuggingUrl(browser);
    client = new CdpClient(debug);
    browserVersion = (await client.send("Browser.getVersion")).product;
    const manager = await createTarget(debug, "chrome://extensions");
    sessions.push(manager);
    await prepareSession(manager);
    await evaluate(manager, "chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })");
    await client.send("Extensions.loadUnpacked", { path: extensionRoot });
    const id = await detectExtension(debug), origin = `chrome-extension://${id}`;
    const page = await createTarget(debug, `${origin}/dashboard.html#open`);
    sessions.push(page);
    await prepareSession(page);
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const fixture = `${origin}/test/inbox-property-static.html`;
    const canonicalUrl = `${fixture}?commandControl=static`;
    for (const count of [250, 1000]) {
      console.error(`STAGE: capture ${count}`);
      await page.send("Page.navigate", { url: `${origin}/dashboard.html?propertySeed=${count}#open` });
      await prepareSession(page);
      await evaluate(page, `(async () => {
        const store = await import(chrome.runtime.getURL('js/lib/store.js'));
        await chrome.storage.local.set({ onboardingDone: true });
        await store.patchSettings({ suspendEnabled: false, suspendMaxTabs: 0, oneNewTabPerWindow: false });
        const now = Date.now(), deviceId = await store.getDeviceId();
        const items = Object.fromEntries(Array.from({ length: ${count} }, (_, index) => {
          const suffix = String(index).padStart(4, '0'), id = 'inbox-fixture-' + suffix;
          const icon = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="hsl(' + (index % 64) * 5 + ',50%,50%)"/></svg>');
          return [id, { id, deviceId, createdAt: now - index * 1000, modifiedAt: now - index * 1000,
            schemaVersion: 1, kind: 'tab', source: 'manual', labels: [],
            tabs: [{ title: 'Inbox fixture ' + suffix, url: 'https://inbox-fixture.invalid/item/' + suffix, favIconUrl: icon, labels: [] }] }];
        }));
        await store.mutateStores(['inbox'], () => ({ inbox: items }));
      })()`);
      await navigateInboxTrial({ page, evaluate, url: `${origin}/dashboard.html?propertyCapture=${count}#inbox` });
      await waitFor(page, `document.querySelectorAll('[data-tablist="inbox"] [data-tablist-row]').length === ${count} && !document.body.classList.contains('booting')`, "synthetic Inbox ready");
      await clickEndpoint(page, 0);
      await clickEndpoint(page, count - 1);
      await waitFor(page, "document.querySelectorAll('[data-tablist=\"inbox\"] [data-tablist-row].sel').length === 2", "endpoint selection settled");
      const snapshot = await evaluate(page, `(${captureMarkup.toString()})()`);
      captures.push({ count, markupHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") });
      for (let round = 1; round <= 3; round++) {
        const states = {};
        for (const treatment of round % 2 ? [false, true] : [true, false]) {
          const removed = !observeFocus && treatment, blurred = focusMode && treatment;
          const variant = mediaMode ? (treatment ? "native-media" : "emulated-media")
            : commandMode ? (treatment ? "reload" : "navigate")
            : focusMode ? (blurred ? "blurred" : "focused") : (removed ? "removed" : "control");
          console.error(`STAGE: ${count}/${round}/${variant}`);
          await page.send("Page.navigate", { url: canonicalMode ? canonicalUrl : `${fixture}?prepare=${count}-${round}-${variant}` });
          await prepareSession(page);
          if (canonicalMode) {
            await waitFor(page, `location.href === ${JSON.stringify(canonicalUrl)} && document.readyState === 'complete' && document.body.childElementCount === 0`, "empty canonical source");
          }
          if (mediaMode) {
            await page.send("Emulation.setEmulatedMedia", { features: treatment ? []
              : [{ name: "prefers-reduced-motion", value: "reduce" }] });
          }
          await evaluate(page, `(${mountMarkup.toString()})(${JSON.stringify(snapshot)}, ${removed})`);
          await clickEndpoint(page, count - 1, true);
          await evaluate(page, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
          let state = await evaluate(page, `(${fixtureState.toString()})(${observeFocus}, ${canonicalMode})`);
          validateInboxPropertyState(state, { count, removed });
          const outgoingRootNodeId = await captureInboxDocumentRoot(page);
          const collector = createInboxDepartureTrace({ extensionOrigin: origin, sourcePaths });
          let resolveComplete, processingFailed = false;
          const completed = new Promise(resolve => { resolveComplete = resolve; });
          const listener = ({ data }) => {
            try {
              const event = JSON.parse(data);
              if (event.method === "Tracing.dataCollected" && !processingFailed) collector.accept(event.params.value);
              if (event.method === "Tracing.tracingComplete") resolveComplete(event.params);
            } catch { processingFailed = true; }
          };
          client.socket.addEventListener("message", listener);
          detach = () => client.socket.removeEventListener("message", listener);
          const { identifier } = await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "performance.mark('inbox:injected')" });
          await navigateInboxTrial({ page, evaluate, url: canonicalMode ? canonicalUrl : `${fixture}?destination=empty`,
            reload: commandMode && treatment, beforeNavigate: async () => {
            if (observeFocus) {
              // Recheck the treatment's starting focus after the shared Chrome
              // focus setup, without a geometry read that could hide its cost.
              const startingFocus = await evaluate(page, `(() => ({
                key: document.activeElement?.closest('[data-tablist-row]')?.dataset.tablistRow,
                checkbox: document.activeElement?.matches('input[type="checkbox"]') ?? false,
                visible: document.visibilityState === 'visible', focused: document.hasFocus(),
                ...(${canonicalMode} ? { sameUrl: location.href === ${JSON.stringify(canonicalUrl)} } : {})
              }))()`);
              assert.deepEqual(startingFocus, { key: state.rowKeys.at(-1), checkbox: true, visible: true, focused: true,
                ...(canonicalMode ? { sameUrl: true } : {}) },
                "Comparison must start from the same focused endpoint");
            }
            await client.send("Tracing.start", { categories: "devtools.timeline,blink.user_timing,toplevel,disabled-by-default-devtools.timeline.invalidationTracking,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack", transferMode: "ReportEvents" });
            await evaluate(page, "performance.mark('inbox:departure')");
            if (observeFocus) {
              // Include blur/no-op, equal settling and the complete state read
              // in the trace, so earlier work cannot masquerade as removed work.
              state = await evaluate(page, `(async () => {
                if (${blurred}) document.activeElement.blur();
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                return (${fixtureState.toString()})(true, ${canonicalMode});
              })()`);
              validateInboxFocusState(state, { count, blurred });
              if (canonicalMode) assert.equal(state.reducedMotion, true, "Both media sources must retain reduced motion");
              await evaluate(page, "performance.mark('inbox:focus-prepared')");
            }
          } });
          await waitFor(page, "document.readyState === 'complete' && document.body.childElementCount === 0", "empty static destination");
          await client.send("Tracing.end");
          let timeout, completion;
          try {
            completion = validateInboxDepartureCompletion(await Promise.race([completed, new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error("Property trace did not finish")), 15_000);
            })]));
          } finally { clearTimeout(timeout); }
          detach();
          assert.equal(processingFailed, false, "Property trace processing failed");
          assert.equal(completion.dataLossOccurred, false, "Property trace requires confirmed no data loss");
          const departure = collector.read({ outgoingRootNodeId, incomingRootNodeId: await captureInboxDocumentRoot(page) });
          let destination;
          if (canonicalMode) {
            destination = await evaluate(page, `(() => {
              const entries = performance.getEntriesByType('navigation');
              return { sameUrl: location.href === ${JSON.stringify(canonicalUrl)}, entryCount: entries.length,
                type: entries[0]?.type ?? null };
            })()`);
            validateInboxCommandDestination(destination);
          }
          await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
          states[variant] = state;
          trials.push({ count, round, variant, state, departure, ...completion,
            ...(observeFocus ? { phases: summarizeInboxFocusPhases(departure) } : {}),
            ...(canonicalMode ? { destination } : {}) });
          console.error(`PASS: ${count}/${round}/${variant}`);
        }
        try {
          if (mediaMode) validateInboxMediaPair(states["emulated-media"], states["native-media"], count);
          else if (commandMode) validateInboxCommandPair(states.navigate, states.reload, count);
          else if (focusMode) validateInboxFocusPair(states.focused, states.blurred, count);
          else validateInboxPropertyPair(states.control, states.removed, count);
        } catch {
          const control = mediaMode ? states["emulated-media"] : commandMode ? states.navigate : focusMode ? states.focused : states.control;
          const changed = mediaMode ? states["native-media"] : commandMode ? states.reload : focusMode ? states.blurred : states.removed;
          const differentFields = Object.keys(control).filter(field => field !== "propertyRules" &&
            JSON.stringify(control[field]) !== JSON.stringify(changed[field]));
          const geometryDifferences = control.geometry.flatMap((value, index) =>
            value === changed.geometry[index] ? [] : [{ index, control: value, removed: changed.geometry[index] }]);
          console.error("PAIR MISMATCH: " + JSON.stringify({ count, round, differentFields,
            geometryDifferenceCount: geometryDifferences.length, firstGeometryDifferences: geometryDifferences.slice(0, 12) }));
          throw new Error("Property fixture pair mismatch");
        }
        console.error(`PASS: equal geometry and state ${count}/${round}`);
      }
    }
    assert.deepEqual(await sourceHashes(), sources, "Runtime source unchanged");
    assert.deepEqual(await fixtureHashes(), fixtureSources, "Property fixture source unchanged");
  } finally {
    detach();
    await cleanupInboxMeasurement({ sessions, client, browser, profile }, {
      terminateOwnedChrome, removeProfile: folder => rm(folder, { recursive: true, force: true })
    });
    console.error("CLEANUP: owned browser and profile removed");
  }
  console.log(JSON.stringify({ schemaVersion: 1, runtime: JSON.parse(await readFile(path.join(extensionRoot, "manifest.json"))).version,
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, browser: browserVersion },
    nativeReducedMotion: mediaMode || nativeReducedMotion,
    mode: mediaMode ? "media-control" : commandMode ? "command-control" : focusMode ? "focus-control" : "property-control",
    ...(mediaMode ? { mediaMethod: "Browser-wide force-prefers-reduced-motion is enabled in both arms. Emulated arm additionally retains the CDP reduce override; native arm clears CDP media features before mounting/settling. Both must report reduced motion and exactly equal outgoing state. Both use Page.navigate at the same canonical URL. No runtime CSS change." } : {}),
    ...(commandMode ? { commandMethod: "Same canonical URL before and after both commands. Identical mounted snapshot, property registration, focus, hover, selection and exact geometry. Trace starts before identical settling/state collection. Page.navigate targets current URL; Page.reload uses ignoreCache false. Both require distinct document roots and a completed empty destination; observed navigation type is not inferred from the command." } : {}),
    ...(focusMode ? { focusMethod: "Property rule remains present in both variants. Same endpoint pointer click and shared Chrome focus setup, then trace starts before blur/no-op and two frames plus state collection. A fixed marker separates preparation from navigation. Geometry, selection and hover must match; only focus fields may differ. Phase costs are recorded event totals, not additive CPU proof." } : {}),
    method: "Static snapshots of synthetic installed Inbox DOM; no application modules in static hosts. Both variants use an explicit collapsed Focus height of 0px. Three alternating-order pairs per size; property-control removes the single rule only from outgoing CSSOM after load, before settling/tracing. Focus-control instead varies focused-element state and retains the rule; command-control retains both focus and rule while varying the command. Same empty destination and focus-before-navigation-v2 sequence. Trace has invalidation costs but no selector statistics.",
    limits: "Static reconstruction omits application listeners and animation history. CSSOM deletion tests removal after loading, not registration never present. Explicit height excludes reliance on the registered initial value. Equal sampled geometry is not all visual or Focus behavior. Durations overlap and instrumentation changes timing. Require reproduction before interpreting causal effects; no runtime improvement follows.",
    cleanup: { browser: true, profile: true }, sources,
    fixtureSources,
    captures, trials }, null, 2));
}

main().catch(() => { console.error("FAIL: static Inbox comparison"); process.exitCode = 1; });
