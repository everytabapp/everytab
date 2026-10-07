/** Chrome event → actual Dashboard scheduling/interaction registration, with synthetic render output. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { coalesce } from "../js/ui/dom.js";
import * as scheduling from "../js/ui/refresh-scheduler.js";

const source = await readFile(new URL("../js/ui/dashboard.js", import.meta.url), "utf8");
function block(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, "Dashboard caller seam must remain identifiable");
  return source.slice(start, end);
}
const gate = block("const openRefreshGate =", "// Open gates inside");
const live = block("const DASHBOARD_REFRESH_RUNNERS =", "// storage events (M0");

function event() {
  const listeners = new Set();
  return { addListener: listener => listeners.add(listener),
    emit: (...args) => { for (const listener of listeners) listener(...args); } };
}
const settle = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };

async function harness({ foreground = true, hidden = false } = {}) {
  let now = 0, nextTimer = 0, held = false, blockedRender = null;
  let browserRows = ["one", "two", "three"], renderedRows = [...browserRows];
  const frames = [], timers = new Map(), commits = [], holdChanges = new Set(), auxiliary = [];
  const documentEvents = new Map(), windowEvents = new Map();
  const document = { visibilityState: hidden ? "hidden" : "visible",
    addEventListener: (name, callback) => documentEvents.set(name, callback) };
  const chrome = {
    tabs: Object.fromEntries(["onCreated", "onRemoved", "onUpdated", "onMoved", "onAttached", "onDetached"].map(name => [name, event()])),
    tabGroups: { onUpdated: event() },
    windows: { onFocusChanged: event(), getCurrent: async () => ({ id: 1 }),
      getLastFocused: async () => ({ id: foreground ? 1 : 2 }) }
  };
  const renderOpenInner = async () => {
    const rows = [...browserRows];
    if (blockedRender) await blockedRender;
    renderedRows = rows;
    commits.push({ at: now, rows });
  };
  const auxiliaryHolds = new Map();
  const record = name => () => { auxiliary.push(name); return auxiliaryHolds.get(name); };
  const bindings = {
    ...scheduling, coalesce, document, chrome,
    window: { addEventListener: (name, callback) => windowEvents.set(name, callback) },
    openSec: { body: {} }, renderOpenInner,
    anchoredPanelOpenWithin: () => held,
    subscribeAnchoredPanelChange: listener => { holdChanges.add(listener); return () => holdChanges.delete(listener); },
    currentPage: "open", sectionVisible: name => name === "open",
    primaryOpenReady: Promise.resolve(), createDisplayTabReads: () => ({}),
    perfActive: () => false,
    reconcileOpenTabUpdate: () => false,
    getCloseDaySurface: () => ({ checkFreshnessSoon: record("close-day-freshness") }),
    warmHiddenOpen: record("warm"), vaultPrimaryReady: false, vaultSchedulePending: false,
    createFrameRefreshScheduler: (run, options) => scheduling.createFrameRefreshScheduler(run,
      { ...options, requestFrame: callback => { frames.push(callback); } }),
    createForegroundTrailingRefresh: (run, options) => scheduling.createForegroundTrailingRefresh(run,
      { ...options, setTimer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
        clearTimer: id => timers.delete(id) })
  };
  for (const name of ["renderStarred", "renderCloseDay", "renderInbox", "renderLabels", "renderArchive", "renderSessions",
    "renderSnapshots", "renderSnoozes", "renderDuplicates", "renderVault", "refreshVaultPill", "renderActivity", "renderStats",
    "renderNav", "renderNavOpen", "renderNavLibrary", "renderNavSessions", "renderAttention", "renderAttentionLive",
    "refreshFocusChrome", "refreshMountedSettings"]) {
    bindings[name] = record(name);
  }
  // Execute the maintained caller rather than reproducing its event mapping or
  // refresh policy. Only browser, clock/frame, visibility and render boundaries
  // are synthetic; all scheduling and the Open interaction gate are production.
  Function(...Object.keys(bindings), `${gate}\n${live}`)(...Object.values(bindings));
  await settle();
  return {
    chrome, document, commits, auxiliary, frames,
    rows: () => renderedRows,
    browser: rows => { browserRows = [...rows]; },
    async frame() {
      for (const callback of frames.splice(0)) callback();
      await settle();
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await settle();
      }
      now = end;
    },
    async visibility(value) { document.visibilityState = value; documentEvents.get("visibilitychange")(); await settle(); },
    async focus(value) { chrome.windows.onFocusChanged.emit(value ? 1 : 2); await settle(); },
    async hold(value) { held = value; for (const listener of holdChanges) listener(); await settle(); },
    blockRender(promise) { blockedRender = promise; },
    blockAuxiliary(name, promise) { auxiliaryHolds.set(name, promise); }
  };
}

test("moving a Chrome tab updates Open on the next frame, without a 180ms quiet window", async t => {
  const h = await harness();
  h.browser(["three", "one", "two"]);
  h.chrome.tabs.onMoved.emit(3, { windowId: 1, fromIndex: 2, toIndex: 0 });
  await h.advance(16); await h.frame();
  const firstFrame = [...h.rows()];
  await h.advance(164); await h.frame();
  t.diagnostic(JSON.stringify({ firstFrame, at180ms: h.rows(), commits: h.commits.map(commit => commit.at) }));
  assert.deepEqual(firstFrame, ["three", "one", "two"]);
});

test("detaching and attaching tabs each refresh the owning window membership promptly", async () => {
  const detached = await harness();
  detached.browser(["one", "three"]);
  detached.chrome.tabs.onDetached.emit(2, { oldWindowId: 1, oldPosition: 1 });
  await detached.advance(16); await detached.frame();
  assert.deepEqual(detached.rows(), ["one", "three"], "the source must update even before an attach event arrives");

  const attached = await harness();
  attached.browser(["one", "new-window:two", "three"]);
  attached.chrome.tabs.onAttached.emit(2, { newWindowId: 2, newPosition: 0 });
  await attached.advance(16); await attached.frame();
  assert.deepEqual(attached.rows(), ["one", "new-window:two", "three"]);
});

test("placement bursts coalesce to the latest order and noisy updates cannot delay the next frame", async () => {
  const h = await harness();
  h.browser(["two", "one", "three"]);
  h.chrome.tabs.onMoved.emit(2, { windowId: 1, fromIndex: 1, toIndex: 0 });
  h.browser(["three", "two", "one"]);
  h.chrome.tabs.onDetached.emit(3, { oldWindowId: 1, oldPosition: 2 });
  h.chrome.tabs.onAttached.emit(3, { newWindowId: 1, newPosition: 0 });
  h.chrome.tabs.onUpdated.emit(1, { title: "Synthetic changed title" });
  await h.advance(16); await h.frame();
  assert.deepEqual(h.rows(), ["three", "two", "one"]);
  assert.equal(h.commits.length, 1);
  assert.deepEqual(h.auxiliary, [], "global counts must retain their ordinary trailing schedule");
  await h.advance(164); await h.frame();
  // Tab signals refresh the live-only navigation counts and Needs you inputs;
  // the complete saved-library variants belong to storage changes.
  assert.ok(h.auxiliary.includes("warm") && h.auxiliary.includes("renderNavOpen") &&
    h.auxiliary.includes("renderAttentionLive") && h.auxiliary.includes("renderDuplicates"));
  assert.ok(!h.auxiliary.includes("renderNav") && !h.auxiliary.includes("renderAttention"),
    "a tab burst must not clone or scan the saved library");
});

test("continued tab movement reconciles each available frame without waiting for quiet", async () => {
  const h = await harness();
  for (const order of [["two", "one", "three"], ["three", "two", "one"], ["one", "three", "two"]]) {
    h.browser(order);
    h.chrome.tabs.onMoved.emit(1, { windowId: 1 });
    await h.advance(16); await h.frame();
    assert.deepEqual(h.rows(), order);
    await h.advance(44);
  }
  assert.deepEqual(h.commits.map(commit => commit.at), [16, 76, 136]);
  assert.deepEqual(h.auxiliary, []);
});

test("hidden and unfocused Dashboards retain placement changes without rendering until foreground", async () => {
  for (const options of [{ hidden: true }, { foreground: false }]) {
    const h = await harness(options);
    h.browser(["three", "two", "one"]);
    h.chrome.tabs.onMoved.emit(3, { windowId: 1 });
    h.chrome.tabs.onDetached.emit(1, { oldWindowId: 1 });
    await h.advance(500); await h.frame();
    assert.deepEqual(h.commits, []);
    assert.deepEqual(h.auxiliary, []);
    assert.equal(h.frames.length, 0);
    if (options.hidden) await h.visibility("visible");
    else await h.focus(true);
    // The pending global refresh and prompt Open share the next frame.
    await h.advance(0); await h.frame();
    assert.deepEqual(h.rows(), ["three", "two", "one"]);
    assert.equal(h.commits.length, 1);
  }
});

test("losing visibility after a move was queued prevents that frame from replacing Open", async () => {
  const h = await harness();
  h.browser(["two", "three", "one"]);
  h.chrome.tabs.onMoved.emit(1, { windowId: 1 });
  await h.visibility("hidden");
  await h.advance(16); await h.frame();
  assert.deepEqual(h.commits, []);
  await h.visibility("visible");
  await h.advance(0); await h.frame();
  assert.deepEqual(h.rows(), ["two", "three", "one"]);
  assert.equal(h.commits.length, 1);
});

test("an anchored interaction retains its nodes and reconciles the latest placement when released", async () => {
  const h = await harness();
  await h.hold(true);
  h.browser(["three", "one", "two"]);
  h.chrome.tabs.onMoved.emit(3, { windowId: 1 });
  await h.advance(16); await h.frame();
  h.browser(["two", "three", "one"]);
  h.chrome.tabs.onAttached.emit(2, { newWindowId: 1 });
  await h.advance(16); await h.frame();
  assert.deepEqual(h.rows(), ["one", "two", "three"]);
  assert.deepEqual(h.commits, []);
  await h.hold(false);
  assert.deepEqual(h.rows(), ["two", "three", "one"]);
  assert.equal(h.commits.length, 1);
});

test("moves during an in-flight Open refresh earn one follow-up frame with the latest placement", async () => {
  const h = await harness();
  let release;
  h.blockRender(new Promise(resolve => { release = resolve; }));
  h.browser(["two", "one", "three"]);
  h.chrome.tabs.onMoved.emit(2, { windowId: 1 });
  await h.advance(16); await h.frame();
  assert.deepEqual(h.commits, []);
  h.browser(["three", "two", "one"]);
  h.chrome.tabs.onMoved.emit(3, { windowId: 1 });
  h.chrome.tabs.onAttached.emit(3, { newWindowId: 1 });
  release(); await settle();
  assert.equal(h.commits.length, 1);
  await h.advance(16); await h.frame();
  assert.deepEqual(h.rows(), ["three", "two", "one"]);
  assert.equal(h.commits.length, 2);
  assert.equal(h.frames.length, 0);
});

test("ordinary tab and group signals still wait for their existing quiet window", async () => {
  for (const fire of [h => h.chrome.tabs.onCreated.emit({ id: 4 }), h => h.chrome.tabs.onRemoved.emit(1),
    h => h.chrome.tabs.onUpdated.emit(1, { status: "complete" }), h => h.chrome.tabGroups.onUpdated.emit({ id: 5 })]) {
    const h = await harness();
    h.browser(["three", "two", "one"]);
    fire(h);
    await h.advance(120); await h.frame();
    assert.deepEqual(h.commits, []);
    fire(h);
    await h.advance(179); await h.frame();
    assert.deepEqual(h.commits, []);
    await h.advance(1); await h.frame();
    assert.deepEqual(h.rows(), ["three", "two", "one"]);
    assert.deepEqual(h.commits.map(commit => commit.at), [300]);
  }
});


test("a move must not wait for an earlier auxiliary navigation read", async () => {
  const fixture = await harness();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  fixture.blockAuxiliary("renderNavOpen", pending);
  fixture.chrome.tabs.onUpdated.emit(1, { url: "https://fixture.invalid/changed" });
  await fixture.advance(180);
  await fixture.frame();
  assert.ok(fixture.auxiliary.includes("renderNavOpen"), "the previous global read is in flight");
  fixture.browser(["three", "one", "two"]);
  fixture.chrome.tabs.onMoved.emit(3, { windowId: 1, fromIndex: 2, toIndex: 0 });
  await fixture.advance(16);
  await fixture.frame();
  try {
    assert.deepEqual(fixture.rows(), ["three", "one", "two"],
      "Chrome placement must update while unrelated navigation data is still pending");
  } finally { release(); await settle(); }
});
