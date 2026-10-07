// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { createInboxDepartureTrace, validateInboxDepartureCompletion } from "./inbox-departure-trace.mjs";

const marker = (name, ts, extra = {}) => ({ name, ts, pid: 1, tid: 2, ph: "R", ...extra });
const cost = (name, ts, dur, extra = {}) => ({ name, ts, dur, pid: 1, tid: 2, ph: "X", ...extra });
function anchored(events = []) {
  const trace = createInboxDepartureTrace();
  trace.accept([marker("inbox:departure", 1_000), ...events, marker("inbox:injected", 5_000)]);
  return trace;
}

test("trace completion rejects reported loss and preserves an omitted flag as unknown", () => {
  assert.deepEqual(validateInboxDepartureCompletion({ dataLossOccurred: false }), { dataLossOccurred: false });
  assert.deepEqual(validateInboxDepartureCompletion({}), { dataLossOccurred: null });
  assert.deepEqual(validateInboxDepartureCompletion({ stream: "private-stream", traceFormat: "private" }),
    { dataLossOccurred: null });
  assert.throws(() => validateInboxDepartureCompletion({ dataLossOccurred: true }),
    { message: "Departure trace reported data loss" });
  for (const dataLossOccurred of [undefined, null, 0, 1, "false", "private", {}, []]) {
    assert.throws(() => validateInboxDepartureCompletion({ dataLossOccurred }),
      { message: "Departure trace completion metadata is invalid" });
  }
  for (const params of [undefined, null, false, 1, "private", []]) {
    assert.throws(() => validateInboxDepartureCompletion(params),
      { message: "Departure trace completion metadata is invalid" });
  }
});

test("streamed complete costs clip to the marker interval and keep independent overlapping totals", () => {
  const trace = createInboxDepartureTrace();
  trace.accept([cost("RunTask", 0, 8_000), marker("inbox:departure", 1_000)]);
  trace.accept([cost("Layout", 3_000, 4_000), cost("FunctionCall", 1_500, 2_000),
    cost("Layout", 500, 1_000), marker("inbox:injected", 5_000)]);
  const result = trace.read();
  assert.equal(result.intervalMs, 4);
  assert.deepEqual(result.events, [
    { name: "Layout", atMs: 0, durationMs: 0.5 },
    { name: "RunTask", atMs: 0, durationMs: 4 },
    { name: "FunctionCall", atMs: 0.5, durationMs: 2 },
    { name: "Layout", atMs: 2, durationMs: 2 }
  ]);
  assert.deepEqual(result.summary, [
    { name: "FunctionCall", count: 1, durationMs: 2 },
    { name: "Layout", count: 2, durationMs: 2.5 },
    { name: "RunTask", count: 1, durationMs: 4 }
  ]);
  assert.match(result.overlapWarning, /overlap.*do not sum/);
  assert.ok(result.summary.reduce((sum, item) => sum + item.durationMs, 0) > result.intervalMs);
});

test("only fixed cost names from the marker renderer thread survive", () => {
  const names = ["RunTask", "FunctionCall", "UpdateLayoutTree", "Layout", "PrePaint", "Paint",
    "EventDispatch", "ParseHTML", "EvaluateScript", "MinorGC", "MajorGC"];
  const trace = anchored([
    ...names.map(name => cost(name, 2_000, 100)),
    cost("Layout", 2_000, 100, { pid: 9 }), cost("Layout", 2_000, 100, { tid: 9 }),
    cost("private-user-event", 2_000, 100), cost("Layout", 2_000, 100, { ph: "B" }),
    cost("Layout", 2_000, 100, { ph: "E" })
  ]);
  assert.deepEqual(trace.read().events.map(event => event.name), names.sort());
});

test("raw args, URL, stacks, user names and event mutations never enter output", () => {
  const event = cost("FunctionCall", 2_000, 100, {
    args: { url: "https://private.invalid", stack: "private stack", data: { name: "private" } },
    cat: "private category", url: "private URL"
  });
  const trace = anchored([event, { name: "private-user-mark", ph: "R", ts: 3_000, pid: 1, tid: 2 }]);
  event.name = "private-mutated"; event.ts = 999_000;
  const result = trace.read();
  assert.deepEqual(result.events, [{ name: "FunctionCall", atMs: 1, durationMs: 0.1 }]);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.deepEqual(Object.keys(result.events[0]), ["name", "atMs", "durationMs"]);
  result.events[0].name = "changed"; result.summary[0].count = 900;
  assert.equal(trace.read().events[0].name, "FunctionCall");
  assert.equal(trace.read().summary[0].count, 1);
});

test("missing, duplicate, cross-thread and reversed marker pairs fail with safe diagnostics", () => {
  const departure = marker("inbox:departure", 1_000), injected = marker("inbox:injected", 5_000);
  for (const markers of [[], [departure], [injected], [departure, departure, injected],
    [departure, injected, injected], [departure, { ...injected, pid: 3 }],
    [departure, { ...injected, tid: 3 }], [departure, { ...injected, ts: 500 }],
    [departure, { ...injected, ph: "X" }]]) {
    const trace = createInboxDepartureTrace(); trace.accept(markers);
    assert.throws(() => trace.read(), /one ordered marker pair on the same renderer thread/);
  }
});

test("R and instant marker phases work regardless of batch delivery order", () => {
  for (const ph of ["R", "I", "i"]) {
    const trace = createInboxDepartureTrace();
    trace.accept([marker("inbox:injected", 5_000, { ph })]);
    trace.accept([cost("Paint", 2_000, 1_000), marker("inbox:departure", 1_000, { ph })]);
    assert.equal(trace.read().intervalMs, 4);
    assert.equal(trace.read().events[0].durationMs, 1);
  }
});

test("malformed markers reject the interval and malformed costs are excluded", () => {
  for (const value of [undefined, null, NaN, Infinity, -1, "2000"]) {
    const trace = createInboxDepartureTrace();
    trace.accept([marker("inbox:departure", value), marker("inbox:injected", 5_000)]);
    assert.throws(() => trace.read(), /ordered marker pair/);
    for (const field of ["ts", "dur", "pid", "tid"]) {
      assert.deepEqual(anchored([cost("Layout", 2_000, 100, { [field]: value })]).read().events, []);
    }
  }
  assert.deepEqual(anchored([null, 12, cost("Layout", Number.MAX_VALUE, Number.MAX_VALUE),
    cost("Layout", 2_000, 100, { tid: 1.5 })]).read().events, []);
  assert.throws(() => createInboxDepartureTrace().accept(null), /event array/);
});

test("half-open clipping excludes outside costs and preserves observed zero duration", () => {
  const trace = anchored([cost("Paint", 500, 500), cost("Paint", 5_000, 100),
    cost("Paint", 500, 0), cost("Paint", 5_000, 0), cost("Layout", 1_000, 0)]);
  assert.deepEqual(trace.read().events, [{ name: "Layout", atMs: 0, durationMs: 0 }]);
  const empty = createInboxDepartureTrace();
  empty.accept([marker("inbox:departure", 1_000), cost("Layout", 0, 2_000), marker("inbox:injected", 1_000)]);
  assert.equal(empty.read().intervalMs, 0);
  assert.deepEqual(empty.read().events, []);
});


test("fixed root-change observations retain only instant points inside the interval", () => {
  const trace = anchored([
    marker("inbox:root-style-change", 2_000, { args: { private: "private" } }),
    marker("inbox:root-attribute-change", 2_500),
    marker("inbox:body-class-change", 3_000),
    marker("inbox:root-style-change", 5_000),
    marker("inbox:body-class-change", 3_000, { tid: 20 }),
    marker("inbox:private-attribute", 3_000),
    cost("inbox:root-style-change", 3_000, 200)
  ]);
  assert.deepEqual(trace.read().events, [
    { name: "inbox:root-style-change", atMs: 1, durationMs: 0 },
    { name: "inbox:root-attribute-change", atMs: 1.5, durationMs: 0 },
    { name: "inbox:body-class-change", atMs: 2, durationMs: 0 }
  ]);
});

const origin = `chrome-extension://${"a".repeat(32)}`;
const attribution = { extensionOrigin: origin, sourcePaths: ["js/ui/dashboard.js", "js/lib/theme.js"] };
const frame = (file = "js/lib/theme.js", extra = {}) => ({ url: `${origin}/${file}`, lineNumber: 12, columnNumber: 7,
  functionName: "private function", scriptId: "private script", ...extra });
const invalidation = (name = "StyleRecalcInvalidationTracking", ts = 2_000, extra = {}) => ({ name, ph: "I", ts,
  pid: 1, tid: 2, args: { data: { reason: "Inline CSS style declaration was mutated", stackTrace: [frame()],
    nodeName: "private node", extraData: "private data", nodeId: 999 } }, ...extra });
function attributed(events) {
  const trace = createInboxDepartureTrace(attribution);
  trace.accept([marker("inbox:departure", 1_000), ...events, marker("inbox:injected", 5_000)]);
  return trace;
}

test("optional attribution retains fixed reasons and the first owned one-based source location", () => {
  const trace = attributed([
    invalidation(), invalidation("ScheduleStyleRecalculation", 2_500, { args: { data: {
      stackTrace: [frame("js/unknown.js"), frame("js/ui/dashboard.js"), frame()] } } }),
    cost("UpdateLayoutTree", 3_000, 100, { args: { beginData: { stackTrace: [frame()] } } })
  ]);
  assert.deepEqual(trace.read().invalidations, [
    { name: "StyleRecalcInvalidationTracking", atMs: 1, reason: "Inline CSS style declaration was mutated",
      file: "js/lib/theme.js", line: 12, column: 7 },
    { name: "ScheduleStyleRecalculation", atMs: 1.5, reason: "other", file: "js/ui/dashboard.js", line: 12, column: 7 },
    { name: "UpdateLayoutTree", atMs: 2, reason: "other", file: "js/lib/theme.js", line: 12, column: 7 }
  ]);
  assert.equal(Object.hasOwn(anchored([invalidation()]).read(), "invalidations"), false, "default receipt remains unchanged");
});

test("attribution rejects spoofed and external URLs without retaining private fields", () => {
  const urls = ["https://private.invalid/js/lib/theme.js", `${origin}.invalid/js/lib/theme.js`,
    `chrome-extension://private@${"a".repeat(32)}/js/lib/theme.js`, `${origin}/js/lib/%74heme.js`,
    `${origin}/js/lib/theme.js?private`, `${origin}/js/lib/theme.js#private`,
    `${origin}/js/lib/../lib/theme.js`, `${origin}/js/private.js`, `${origin}/css/theme.css`];
  const trace = attributed(urls.map(url => invalidation(undefined, 2_000, { args: { data: {
    reason: "private reason", nodeName: "private node", stackTrace: [frame(undefined, { url })] } } })));
  for (const event of trace.read().invalidations) {
    assert.deepEqual(event, { name: "StyleRecalcInvalidationTracking", atMs: 1, reason: "other",
      file: null, line: null, column: null });
  }
  assert.equal(JSON.stringify(trace.read()).includes("private"), false);
});

test("missing or invalid frame coordinates remain unattributed and later valid frames can qualify", () => {
  for (const value of [undefined, null, 0, -1, NaN, Infinity, 1.5, "12"]) {
    for (const field of ["lineNumber", "columnNumber"]) {
      const badFrame = frame(undefined, { [field]: value });
      const event = invalidation(undefined, 2_000, { args: { data: { stackTrace: [badFrame] } } });
      assert.equal(attributed([event]).read().invalidations[0].file, null);
      event.args.data.stackTrace.push(frame("js/ui/dashboard.js", { lineNumber: 1, columnNumber: 1 }));
      assert.equal(attributed([event]).read().invalidations[0].line, 1);
    }
  }
  for (const stackTrace of [undefined, null, {}, "private"]) {
    assert.equal(attributed([invalidation(undefined, 2_000, { args: { data: { stackTrace } } })])
      .read().invalidations[0].file, null);
  }
});

test("attribution is limited to valid event phases and the same-thread half-open marker interval", () => {
  const trace = attributed([
    invalidation(undefined, 999), invalidation(undefined, 5_000), invalidation(undefined, 2_000, { tid: 3 }),
    invalidation(undefined, 2_000, { pid: 3 }), invalidation("private event"), invalidation(undefined, 2_000, { ph: "X" }),
    invalidation(undefined, NaN), invalidation(undefined, Infinity), invalidation(undefined, "2000"),
    invalidation("UpdateLayoutTree", 2_000), cost("UpdateLayoutTree", 2_000, NaN),
    invalidation(undefined, 1_000, { ph: "i" })
  ]);
  assert.equal(trace.read().invalidations.length, 1);
  assert.equal(trace.read().invalidations[0].atMs, 0);
});

test("attribution snapshots detach from input and output objects", () => {
  const event = invalidation(); const trace = attributed([event]);
  event.args.data.reason = "private changed"; event.args.data.stackTrace[0].lineNumber = 999;
  const result = trace.read(); result.invalidations[0].file = "private changed";
  assert.equal(trace.read().invalidations[0].file, "js/lib/theme.js");
  assert.equal(trace.read().invalidations[0].line, 12);
  assert.equal(JSON.stringify(trace.read()).includes("private"), false);
});

test("attribution requires exact extension origin and a safe bounded source catalogue", () => {
  for (const options of [null, {}, { ...attribution, extensionOrigin: `${origin}/` },
    { ...attribution, extensionOrigin: "https://private.invalid" }, { ...attribution, sourcePaths: [] },
    ...["../private.js", "js/../private.js", "js//private.js", "css/a.css", "js/a.js?private"].map(file =>
      ({ ...attribution, sourcePaths: [file] }))]) {
    assert.throws(() => createInboxDepartureTrace(options), /exact extension origin and safe source paths/);
  }
});

const roots = { outgoingRootNodeId: 812345, incomingRootNodeId: 912345 };
const registration = (nodeId, ts = 2_000, extra = {}) => invalidation(undefined, ts, {
  args: { data: { reason: "PropertyRegistration", nodeId, nodeName: "private root", stackTrace: [frame()] } }, ...extra
});

test("late root identities classify only property registrations without exposing node IDs", () => {
  const event = registration(roots.outgoingRootNodeId);
  const trace = attributed([event, registration(roots.incomingRootNodeId), registration(712345), registration(undefined)]);
  const baseline = trace.read();
  assert.ok(baseline.invalidations.every(entry => !Object.hasOwn(entry, "rootOwnership")));
  event.args.data.nodeId = roots.incomingRootNodeId;
  const result = trace.read(roots);
  assert.deepEqual(result.invalidations.map(entry => entry.rootOwnership), ["outgoing-root", "incoming-root", "other", "unknown"]);
  assert.deepEqual(trace.read(), baseline, "opt-in ownership must not change the default receipt");
  for (const value of [...Object.values(roots), 712345, "nodeId", "private root"]) assert.equal(JSON.stringify(result).includes(String(value)), false);
  assert.deepEqual(trace.read({ outgoingRootNodeId: roots.incomingRootNodeId, incomingRootNodeId: roots.outgoingRootNodeId })
    .invalidations.map(entry => entry.rootOwnership), ["incoming-root", "outgoing-root", "other", "unknown"]);
  result.invalidations[0].rootOwnership = "changed";
  assert.equal(trace.read(roots).invalidations[0].rootOwnership, "outgoing-root");
});

test("malformed observed node IDs stay unknown and ownership never spreads to other events or reasons", () => {
  const malformed = [undefined, null, 0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, String(roots.outgoingRootNodeId), {}, []];
  const trace = attributed([...malformed.map(value => registration(value)), invalidation(),
    invalidation("ScheduleStyleRecalculation", 2_000, { args: { data: { reason: "PropertyRegistration", nodeId: roots.outgoingRootNodeId } } }),
    cost("UpdateLayoutTree", 2_000, 100, { args: { beginData: { reason: "PropertyRegistration", nodeId: roots.outgoingRootNodeId } } })]);
  const entries = trace.read(roots).invalidations;
  assert.ok(entries.filter(entry => entry.name === "StyleRecalcInvalidationTracking" && entry.reason === "PropertyRegistration")
    .every(entry => entry.rootOwnership === "unknown"));
  assert.equal(entries.filter(entry => Object.hasOwn(entry, "rootOwnership")).length, malformed.length);
  assert.ok(entries.filter(entry => entry.reason !== "PropertyRegistration" || entry.name !== "StyleRecalcInvalidationTracking")
    .every(entry => !Object.hasOwn(entry, "rootOwnership")));
});

test("ownership respects thread and half-open interval boundaries", () => {
  const trace = attributed([registration(roots.outgoingRootNodeId, 999), registration(roots.outgoingRootNodeId, 5_000),
    registration(roots.outgoingRootNodeId, 2_000, { pid: 9 }), registration(roots.outgoingRootNodeId, 2_000, { tid: 9 }),
    registration(roots.outgoingRootNodeId, 1_000), registration(roots.incomingRootNodeId, 4_999)]);
  assert.deepEqual(trace.read(roots).invalidations.map(entry => entry.rootOwnership), ["outgoing-root", "incoming-root"]);
});

test("ownership requires attribution and distinct positive safe numeric root IDs", () => {
  assert.throws(() => anchored([]).read(roots), /root ownership/);
  const trace = attributed([]);
  for (const options of [null, {}, [], 1, { ...roots, incomingRootNodeId: roots.outgoingRootNodeId },
    ...[undefined, null, 0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, "812345"].flatMap(value =>
      ["outgoingRootNodeId", "incomingRootNodeId"].map(key => ({ ...roots, [key]: value })))]) {
    assert.throws(() => trace.read(options), /root ownership/);
  }
});


test("focus preparation boundary is a fixed instant marker with no private payload", () => {
  const trace = anchored([
    marker("inbox:focus-prepared", 2_500, { args: { private: "private focus node" } }),
    marker("inbox:focus-prepared", 5_000), marker("inbox:focus-prepared", 999),
    marker("inbox:focus-prepared", 2_500, { tid: 9 }),
    cost("inbox:focus-prepared", 2_000, 100), marker("inbox:private-focus", 2_500)
  ]);
  assert.deepEqual(trace.read().events, [{ name: "inbox:focus-prepared", atMs: 1.5, durationMs: 0 }]);
});

const insertion = (nodeName, extra = {}) => invalidation(undefined, 2_000, {
  args: { data: { reason: "Node was inserted into tree", nodeName, nodeId: 765432, extraData: "private inserted data" } }, ...extra
});
test("inserted node kinds retain only fixed tags and discard debug ID/class suffixes", () => {
  const cases = [["STYLE", "style"], ["LINK", "link"], ["HTML", "html"], ["BODY", "body"], ["#text", "text"]];
  for (const tag of ["STYLE", "LINK", "HTML", "BODY"]) {
    cases.push([`${tag} id='private-id'`, tag.toLowerCase()], [`${tag} class='private-class'`, tag.toLowerCase()]);
  }
  const event = insertion("STYLE id='private-before'");
  const trace = attributed([event, ...cases.map(([nodeName]) => insertion(nodeName))]);
  event.args.data.nodeName = "LINK id='private-after'";
  const result = trace.read();
  assert.deepEqual(result.invalidations.map(entry => entry.insertedNodeKind), ["style", ...cases.map(([, kind]) => kind)]);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(JSON.stringify(result).includes("765432"), false);
  assert.equal(JSON.stringify(result).includes("nodeName"), false);
  result.invalidations[0].insertedNodeKind = "changed";
  assert.equal(trace.read().invalidations[0].insertedNodeKind, "style");
});

test("malformed and spoofed node names remain other without prefix heuristics", () => {
  const names = [undefined, null, 12, {}, [], "", "style", "STYLE-X", "STYLES", "STYLE id=private", "STYLE class=private",
    "STYLE\tid='private'", "STYLE  id='private'", "STYLE private", "STYLE#private", "STYLE.private",
    "#text id='private'", "#text class='private'", "#text private", "DIV id='private'"];
  const result = attributed(names.map(name => insertion(name))).read();
  assert.ok(result.invalidations.every(entry => entry.insertedNodeKind === "other"));
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("node-kind classification requires exact event/reason and retains existing ownership and scope", () => {
  const trace = attributed([
    insertion("STYLE"), insertion("LINK", { tid: 9 }), insertion("HTML", { pid: 9 }), insertion("BODY", { ts: 5_000 }),
    insertion("BODY", { ts: 999 }), insertion("STYLE", { ph: "X" }),
    insertion("STYLE", { name: "ScheduleStyleRecalculation" }),
    cost("UpdateLayoutTree", 2_000, 100, { args: { beginData: { reason: "Node was inserted into tree", nodeName: "STYLE" } } }),
    invalidation(undefined, 2_000, { args: { data: { reason: "Style attribute change", nodeName: "STYLE" } } }),
    registration(roots.outgoingRootNodeId)
  ]);
  const result = trace.read(roots);
  assert.equal(result.invalidations.filter(entry => Object.hasOwn(entry, "insertedNodeKind")).length, 1);
  assert.equal(result.invalidations.find(entry => entry.insertedNodeKind)?.insertedNodeKind, "style");
  assert.equal(result.invalidations.find(entry => entry.reason === "PropertyRegistration").rootOwnership, "outgoing-root");
  assert.equal(Object.hasOwn(anchored([insertion("STYLE")]).read(), "invalidations"), false);
});

function htmlInsertion(nodeId, nodeName = "HTML", extra = {}) {
  return insertion(nodeName, { args: { data: { reason: "Node was inserted into tree", nodeName, nodeId } }, ...extra });
}
test("HTML insertions receive late root ownership without changing default receipts or leaking private IDs", () => {
  const event = htmlInsertion(roots.outgoingRootNodeId, "HTML id='private-root'");
  const trace = attributed([event, htmlInsertion(roots.incomingRootNodeId), htmlInsertion(712345), htmlInsertion(undefined)]);
  const baseline = trace.read();
  assert.ok(baseline.invalidations.every(entry => !Object.hasOwn(entry, "insertedRootOwnership")));
  event.args.data.nodeId = roots.incomingRootNodeId;
  event.args.data.nodeName = "BODY";
  const result = trace.read(roots);
  assert.deepEqual(result.invalidations.map(entry => entry.insertedRootOwnership), ["outgoing-root", "incoming-root", "other", "unknown"]);
  assert.ok(result.invalidations.every(entry => entry.insertedNodeKind === "html"));
  assert.deepEqual(trace.read(), baseline);
  assert.deepEqual(trace.read({ outgoingRootNodeId: roots.incomingRootNodeId, incomingRootNodeId: roots.outgoingRootNodeId })
    .invalidations.map(entry => entry.insertedRootOwnership), ["incoming-root", "outgoing-root", "other", "unknown"]);
  for (const value of [...Object.values(roots), 712345, "nodeId", "private-root"]) assert.equal(JSON.stringify(result).includes(String(value)), false);
  result.invalidations[0].insertedRootOwnership = "changed";
  assert.equal(trace.read(roots).invalidations[0].insertedRootOwnership, "outgoing-root");
});

test("HTML insertion ownership treats malformed observed IDs as unknown", () => {
  const values = [undefined, null, 0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, String(roots.incomingRootNodeId), {}, []];
  const entries = attributed(values.map(value => htmlInsertion(value))).read(roots).invalidations;
  assert.equal(entries.length, values.length);
  assert.ok(entries.every(entry => entry.insertedRootOwnership === "unknown"));
});

test("insertion ownership applies only to exact HTML insertion scope and leaves property ownership separate", () => {
  const trace = attributed([
    htmlInsertion(roots.outgoingRootNodeId), htmlInsertion(roots.incomingRootNodeId, "HTML class='private'"),
    ...["BODY", "STYLE", "LINK", "#text", "HTML-X"].map(name => htmlInsertion(roots.outgoingRootNodeId, name)),
    htmlInsertion(roots.outgoingRootNodeId, "HTML", { name: "ScheduleStyleRecalculation" }),
    htmlInsertion(roots.outgoingRootNodeId, "HTML", { tid: 9 }), htmlInsertion(roots.outgoingRootNodeId, "HTML", { ts: 5_000 }),
    htmlInsertion(roots.outgoingRootNodeId, "HTML", { ts: 999 }),
    registration(roots.outgoingRootNodeId)
  ]);
  const entries = trace.read(roots).invalidations;
  assert.equal(entries.filter(entry => Object.hasOwn(entry, "insertedRootOwnership")).length, 2);
  assert.ok(entries.filter(entry => entry.insertedNodeKind !== "html")
    .every(entry => !Object.hasOwn(entry, "insertedRootOwnership")));
  assert.equal(entries.find(entry => entry.reason === "PropertyRegistration").rootOwnership, "outgoing-root");
  assert.ok(entries.filter(entry => entry.reason !== "PropertyRegistration").every(entry => !Object.hasOwn(entry, "rootOwnership")));
});

const dispatch = (type, ts = 2_000, dur = 100, extra = {}) => cost("EventDispatch", ts, dur,
  { args: { data: { type, private: "private event payload" } }, ...extra });
test("attributed dispatch retains only exact fixed lifecycle types, with default costs unchanged", () => {
  const types = ["beforeunload", "pagehide", "unload", "visibilitychange"];
  const trace = attributed(types.map(type => dispatch(type)));
  assert.deepEqual(trace.read().events.map(event => event.lifecycleType), types);
  const defaultResult = anchored(types.map(type => dispatch(type))).read();
  assert.ok(defaultResult.events.every(event => !Object.hasOwn(event, "lifecycleType")));
  assert.deepEqual(defaultResult.summary, trace.read().summary);
  assert.equal(JSON.stringify(trace.read()).includes("private"), false);
});

test("lifecycle metadata preserves clipping and rejects wrong event/thread/phase or outside interval", () => {
  const trace = attributed([dispatch("unload", 500, 1000), dispatch("pagehide", 4_500, 1000),
    dispatch("unload", 999, 1), dispatch("unload", 5_000), dispatch("unload", 2_000, 100, { tid: 9 }),
    dispatch("unload", 2_000, 100, { pid: 9 }), dispatch("unload", 2_000, 100, { ph: "I" }),
    cost("FunctionCall", 2_000, 100, { args: { data: { type: "unload" } } })]);
  assert.deepEqual(trace.read().events, [
    { name: "EventDispatch", atMs: 0, durationMs: 0.5, lifecycleType: "unload" },
    { name: "FunctionCall", atMs: 1, durationMs: 0.1 },
    { name: "EventDispatch", atMs: 3.5, durationMs: 0.5, lifecycleType: "pagehide" }
  ]);
});

test("unknown or malformed dispatch types are omitted and lifecycle snapshots remain detached", () => {
  const values = [undefined, null, {}, [], 1, "", "private event", "UNLOAD", "unload private", "unload\u0000"];
  const event = dispatch("pagehide");
  const trace = attributed([event, ...values.map(type => dispatch(type))]);
  event.args.data.type = "private mutated";
  const result = trace.read();
  assert.equal(result.events[0].lifecycleType, "pagehide");
  assert.ok(result.events.slice(1).every(entry => !Object.hasOwn(entry, "lifecycleType")));
  assert.equal(JSON.stringify(result).includes("private"), false);
  result.events[0].lifecycleType = "changed";
  assert.equal(trace.read().events[0].lifecycleType, "pagehide");
});
