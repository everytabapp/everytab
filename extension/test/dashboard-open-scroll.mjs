/** Actual Open render caller: scroll capture ordering and unchanged replacement safeguards. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../js/ui/dashboard.js", import.meta.url), "utf8");
const start = source.indexOf("async function renderOpenInner() {");
const end = source.indexOf("/* ================= Close the day", start);
assert.ok(start >= 0 && end > start, "Open render caller seam must remain identifiable");
const renderSource = source.slice(start, end);

function harness({ visible = true, held = false, empty = false, node = {}, y = 320,
  replacementY = y, maxScroll = 2000, renderResult, failure, placementUpdated = false } = {}) {
  const calls = [], scrollTo = [], stale = new Set(["open"]);
  let scroll = y, currentHeld = held;
  const body = { childNodes: empty ? [] : [{}], replaceChildren(next) {
    assert.equal(next, node);
    calls.push("replace"); scroll = Math.min(replacementY, maxScroll);
  } };
  const bindings = {
    openSectionVisible: () => visible, staleSections: stale,
    openSec: { body, h2: { removeAttribute(name) { assert.equal(name, "aria-label"); calls.push("heading-aria"); } } },
    openHeadingCount: {},
    localeMessage: (key) => key,
    showLoadingFeedback() { calls.push("loading-start"); return { stop() { calls.push("loading-stop"); } }; },
    getOpenSurface: () => ({ async render() {
      calls.push("render");
      if (failure) throw failure;
      if (renderResult) await renderResult;
      return { heading: "3 tabs", node, placementUpdated };
    } }),
    startupArrival: {
      settleSummary() { calls.push("heading-summary"); },
      revealGroups(owner, key, replace) {
        assert.equal(owner, body); assert.equal(key, "open-windows");
        calls.push("reveal"); replace();
      }
    },
    openRefreshGate: { isHeld: () => currentHeld, defer() { calls.push("defer"); } },
    automationAwareness: { sync() { calls.push("automation-sync"); } },
    window: {
      get scrollY() { calls.push("scroll-read"); return scroll; },
      scrollTo(x, next) { calls.push("scroll-to"); scrollTo.push([x, next]); scroll = Math.min(next, maxScroll); }
    }
  };
  const render = Function(...Object.keys(bindings), `${renderSource}\nreturn renderOpenInner;`)(...Object.values(bindings));
  return { render, calls, scrollTo, stale, scroll: () => scroll, setScroll: value => { scroll = value; }, hold: value => { currentHeld = value; } };
}

test("Open captures scroll before heading writes and still checks scroll after replacement", async () => {
  const h = harness();
  await h.render();
  assert.deepEqual(h.calls, ["render", "scroll-read", "heading-summary", "heading-aria", "reveal",
    "replace", "automation-sync", "scroll-read"]);
  assert.deepEqual(h.scrollTo, []);
  assert.equal(h.scroll(), 320);
});

test("replacement restores a nonzero scroll position, including browser-clamped destinations", async () => {
  const h = harness({ y: 875, replacementY: 0 });
  await h.render();
  assert.deepEqual(h.scrollTo, [[0, 875]]);
  assert.equal(h.scroll(), 875);
  assert.equal(h.calls.filter(call => call === "scroll-read").length, 2);
  assert.ok(h.calls.indexOf("scroll-to") > h.calls.indexOf("replace"));

  const clamped = harness({ y: 875, replacementY: 300, maxScroll: 300 });
  await clamped.render();
  assert.deepEqual(clamped.scrollTo, [[0, 875]], "the browser owns clamping; the saved target must remain unchanged");
  assert.equal(clamped.scroll(), 300);
  assert.equal(clamped.calls.filter(call => call === "scroll-read").length, 2,
    "do not force repeated layouts trying to defeat browser clamping");

  const top = harness({ y: 0, replacementY: 0 });
  await top.render();
  assert.deepEqual(top.scrollTo, []);
  assert.equal(top.scroll(), 0);
});

test("held Open retains its subtree and heading updates without an unused scroll read", async () => {
  const h = harness({ held: true });
  await h.render();
  assert.deepEqual(h.calls, ["render", "heading-summary", "heading-aria", "defer"]);
  assert.deepEqual(h.scrollTo, []);
  assert.equal(h.scroll(), 320);
});

test("an interaction opened while the surface awaited rendering still prevents replacement", async () => {
  let release;
  const h = harness({ renderResult: new Promise(resolve => { release = resolve; }) });
  const running = h.render();
  assert.deepEqual(h.calls, ["render"]);
  h.hold(true); release();
  await running;
  assert.deepEqual(h.calls, ["render", "heading-summary", "heading-aria", "defer"]);
});

test("hidden and null-node results preserve existing subtrees without scroll or reveal work", async () => {
  const hidden = harness({ visible: false });
  await hidden.render();
  assert.deepEqual(hidden.calls, []);
  assert.ok(hidden.stale.has("open"));

  const nullNode = harness({ node: null });
  await nullNode.render();
  assert.deepEqual(nullNode.calls, ["render", "heading-summary", "heading-aria"]);
  assert.equal(nullNode.stale.has("open"), false);
});

test("initial loading feedback stops after successful, held, empty and failed surface results", async () => {
  for (const options of [{}, { held: true }, { node: null }]) {
    const h = harness({ ...options, empty: true });
    await h.render();
    assert.equal(h.calls[0], "loading-start");
    assert.equal(h.calls.at(-1), "loading-stop");
    if (options.held || options.node === null) assert.equal(h.calls.includes("scroll-read"), false);
  }
  const failure = new Error("Synthetic render failure");
  const h = harness({ empty: true, failure });
  await assert.rejects(h.render(), error => error === failure);
  assert.deepEqual(h.calls, ["loading-start", "render", "loading-stop"]);
});


test("scrolling during an awaited surface read preserves the latest user position", async () => {
  let release;
  const h = harness({ y: 100, replacementY: 0,
    renderResult: new Promise(resolve => { release = resolve; }) });
  const running = h.render();
  h.setScroll(650);
  release();
  await running;
  assert.deepEqual(h.scrollTo, [[0, 650]]);
  assert.equal(h.scroll(), 650);
});


test("a placement-only surface commit retains its mounted subtree without a second host commit", async () => {
  const h = harness({ placementUpdated: true });
  await h.render();
  assert.deepEqual(h.calls, ["render"], "surface owns the placement and scroll correction; host must not detach retained rows");
  assert.deepEqual(h.scrollTo, []);
});
