// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Ordering is a behavior contract, not a machine-dependent latency threshold. */
import test from "node:test";
import assert from "node:assert/strict";
import { captureInboxDocumentRoot, navigateInboxTrial } from "./inbox-navigation.mjs";

const url = "chrome-extension://fixture/dashboard.html?inboxTrial=250%2F1#inbox";
const focusSteps = ["Page.bringToFront", "tabs.getCurrent", "tabs.update", "windows.update", "Emulation.setFocusEmulationEnabled"];
function harness({ navigation = { loaderId: "new-loader", frameId: "main-frame" }, failAt, waitAt } = {}) {
  const events = [];
  async function step(name, params) {
    events.push({ name, params });
    if (failAt === name) throw new Error("synthetic operation failure");
    if (waitAt?.name === name) await waitAt.promise;
  }
  const page = { async send(method, params) {
    await step(method, params);
    return method === "Page.navigate" ? navigation : {};
  } };
  const chrome = {
    tabs: {
      async getCurrent() { await step("tabs.getCurrent"); return { id: 19, windowId: 7 }; },
      async update(id, options) { await step("tabs.update", { id, options }); }
    },
    windows: { async update(id, options) { await step("windows.update", { id, options }); } }
  };
  const evaluate = async (owner, expression) => {
    assert.equal(owner, page);
    // Execute the actual helper's outgoing-document callback with synthetic
    // Chrome boundaries; do not substitute a copied focus implementation.
    return Function("chrome", `return ${expression}`)(chrome);
  };
  return { page, evaluate, events, navigation };
}

test("reload uses the same awaited setup and hook, without requiring a navigate response", async () => {
  const h = harness();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const pending = navigateInboxTrial({ ...h, url, reload: true, profile: true, beforeNavigate: async () => {
    h.events.push({ name: "beforeNavigate" }); entered(); await gate;
  } });
  await ready;
  assert.deepEqual(h.events.map(event => event.name), [...focusSteps, "beforeNavigate"]);
  release();
  assert.equal(await pending, null, "reload acceptance does not imply document completion");
  assert.deepEqual(h.events.map(event => event.name), [...focusSteps, "beforeNavigate", "Profiler.start", "Page.reload"]);
  assert.deepEqual(h.events.at(-1).params, { ignoreCache: false });
});

test("reload failures reject without fallback and invalid modes fail before effects", async () => {
  for (const failAt of [...focusSteps, "Profiler.start", "Page.reload"]) {
    const h = harness({ failAt });
    await assert.rejects(navigateInboxTrial({ ...h, url, reload: true, profile: true }), /synthetic operation failure/);
    assert.equal(h.events.at(-1).name, failAt);
    assert.equal(h.events.some(event => event.name === "Page.navigate"), false);
  }
  for (const reload of [null, 0, "true", {}]) {
    const h = harness();
    await assert.rejects(navigateInboxTrial({ ...h, url, reload }), /Reload mode must be boolean/);
    assert.deepEqual(h.events, []);
  }
});

for (const profile of [false, true]) test(`focus completes before measured navigation (profiling ${profile})`, async () => {
  const h = harness();
  const result = await navigateInboxTrial({ ...h, url, profile });
  assert.equal(result, h.navigation);
  assert.deepEqual(h.events.map(event => event.name), [...focusSteps, ...(profile ? ["Profiler.start"] : []), "Page.navigate"]);
  assert.deepEqual(h.events.find(event => event.name === "tabs.update").params, { id: 19, options: { active: true } });
  assert.deepEqual(h.events.find(event => event.name === "windows.update").params, { id: 7, options: { focused: true } });
  assert.deepEqual(h.events.find(event => event.name === "Emulation.setFocusEmulationEnabled").params, { enabled: true });
  assert.deepEqual(h.events.at(-1).params, { url });
});

test("a pending focus operation cannot overlap profiler start or measured navigation", async () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  const h = harness({ waitAt: { name: "windows.update", promise } });
  const pending = navigateInboxTrial({ ...h, url, profile: true });
  try {
    for (let turn = 0; turn < 30 && !h.events.some(event => event.name === "windows.update"); turn++) await Promise.resolve();
    assert.equal(h.events.at(-1)?.name, "windows.update", "test must reach the unresolved focus operation");
    assert.deepEqual(h.events.map(event => event.name), focusSteps.slice(0, 4));
  } finally {
    release();
    await pending;
  }
  assert.deepEqual(h.events.map(event => event.name), [...focusSteps, "Profiler.start", "Page.navigate"]);
});

test("every focus failure prevents profiler start and navigation", async () => {
  for (const failAt of focusSteps) {
    const h = harness({ failAt });
    await assert.rejects(navigateInboxTrial({ ...h, url, profile: true }), /synthetic operation failure/);
    assert.deepEqual(h.events.map(event => event.name), focusSteps.slice(0, focusSteps.indexOf(failAt) + 1));
  }
});

test("profiler failure prevents navigation and navigation failures reject without retry", async () => {
  for (const failAt of ["Profiler.start", "Page.navigate"]) {
    const h = harness({ failAt });
    await assert.rejects(navigateInboxTrial({ ...h, url, profile: true }), /synthetic operation failure/);
    assert.deepEqual(h.events.map(event => event.name), [...focusSteps, "Profiler.start", ...(failAt === "Page.navigate" ? ["Page.navigate"] : [])]);
  }
});

test("missing loader identity and explicit navigation error cannot produce a successful receipt", async () => {
  for (const navigation of [undefined, {}, { loaderId: "" }, { loaderId: 4 }, { loaderId: "new-loader", errorText: "synthetic failure" }]) {
    const h = harness();
    h.page.send = async (method, params) => { h.events.push({ name: method, params }); return method === "Page.navigate" ? navigation : {}; };
    await assert.rejects(navigateInboxTrial({ ...h, url }), /Fresh Dashboard navigation must succeed/);
    assert.equal(h.events.filter(event => event.name === "Page.navigate").length, 1);
  }
});

test("the pre-navigation hook waits after focus and before profiling or navigation", async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const hookEntered = new Promise(resolve => { entered = resolve; });
  const h = harness();
  const pending = navigateInboxTrial({ ...h, url, profile: true, beforeNavigate: async () => {
    h.events.push({ name: "beforeNavigate" });
    entered();
    await gate;
    h.events.push({ name: "beforeNavigate.complete" });
  } });
  try {
    await hookEntered;
    assert.deepEqual(h.events.map(event => event.name), [...focusSteps, "beforeNavigate"]);
  } finally {
    release();
    await pending;
  }
  assert.deepEqual(h.events.map(event => event.name),
    [...focusSteps, "beforeNavigate", "beforeNavigate.complete", "Profiler.start", "Page.navigate"]);
});

test("a rejected pre-navigation hook prevents profiler start and navigation", async () => {
  const h = harness(), failure = new Error("synthetic hook failure");
  await assert.rejects(navigateInboxTrial({ ...h, url, profile: true, beforeNavigate: async () => {
    h.events.push({ name: "beforeNavigate" });
    throw failure;
  } }), error => error === failure);
  assert.deepEqual(h.events.map(event => event.name), [...focusSteps, "beforeNavigate"]);
});


function rootHarness({ result = { result: { objectId: "private-object" } },
  node = { nodeType: 1, localName: "html", backendNodeId: 71 }, failAt } = {}) {
  const calls = [];
  return { calls, page: { async send(method, params) {
    calls.push({ method, params });
    if (method === failAt) throw new Error("private protocol payload");
    if (method === "Runtime.evaluate") return result;
    if (method === "DOM.describeNode") return { node };
    return {};
  } } };
}

test("document-root capture reads the actual root and releases its remote object", async () => {
  const h = rootHarness();
  assert.equal(await captureInboxDocumentRoot(h.page), 71);
  assert.deepEqual(h.calls.map(c => c.method), ["Runtime.evaluate", "DOM.describeNode", "Runtime.releaseObject"]);
  assert.deepEqual(h.calls[0].params, { expression: "document.documentElement", returnByValue: false });
  assert.deepEqual(h.calls[1].params, { objectId: "private-object", depth: 0 });
  assert.deepEqual(h.calls[2].params, { objectId: "private-object" });
});

test("document-root capture rejects invalid identities and always releases an acquired object", async () => {
  for (const backendNodeId of [undefined, null, 0, -1, 1.5, "71", Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const h = rootHarness({ node: { nodeType: 1, localName: "html", backendNodeId } });
    await assert.rejects(captureInboxDocumentRoot(h.page), { message: "Inbox document root capture failed" });
    assert.equal(h.calls.at(-1).method, "Runtime.releaseObject");
  }
  for (const node of [{ nodeType: 9, localName: "html", backendNodeId: 71 },
    { nodeType: 1, localName: "body", backendNodeId: 71 }, null]) {
    const h = rootHarness({ node });
    await assert.rejects(captureInboxDocumentRoot(h.page), { message: "Inbox document root capture failed" });
    assert.equal(h.calls.at(-1).method, "Runtime.releaseObject");
  }
});

test("document-root capture suppresses protocol payloads and fails on release failure", async () => {
  for (const failAt of ["Runtime.evaluate", "DOM.describeNode", "Runtime.releaseObject"]) {
    const h = rootHarness({ failAt });
    await assert.rejects(captureInboxDocumentRoot(h.page), { message: "Inbox document root capture failed" });
    assert.deepEqual(h.calls.map(c => c.method), failAt === "Runtime.evaluate"
      ? ["Runtime.evaluate"] : ["Runtime.evaluate", "DOM.describeNode", "Runtime.releaseObject"]);
  }
  for (const result of [{}, { exceptionDetails: { text: "private" }, result: { objectId: "private-object" } },
    { result: { objectId: "" } }, { result: { objectId: 7 } }]) {
    const h = rootHarness({ result });
    await assert.rejects(captureInboxDocumentRoot(h.page), { message: "Inbox document root capture failed" });
    assert.deepEqual(h.calls.map(c => c.method), result.result?.objectId === "private-object"
      ? ["Runtime.evaluate", "Runtime.releaseObject"] : ["Runtime.evaluate"]);
  }
});

test("document-root capture awaits release before returning the private identity", async () => {
  const h = rootHarness();
  const send = h.page.send;
  let release, reached;
  const releasing = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  h.page.send = async (method, params) => {
    const result = await send(method, params);
    if (method === "Runtime.releaseObject") { reached(); await gate; }
    return result;
  };
  let done = false;
  const pending = captureInboxDocumentRoot(h.page).then(id => { done = true; return id; });
  await releasing;
  assert.equal(done, false);
  release();
  assert.equal(await pending, 71);
});
