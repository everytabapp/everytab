// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { createInboxStartupNetwork } from "./inbox-startup-network.mjs";

const origin = `chrome-extension://${"a".repeat(32)}`;
const paths = ["dashboard.html", "js/a.js", "js/b.js", "css/base.css"];
const create = () => createInboxStartupNetwork({ extensionOrigin: origin, allowedPaths: paths });
const request = (requestId, file, timestamp, extra = {}) => ({ requestId, loaderId: "private-loader", frameId: "private-frame",
  timestamp, type: file.startsWith("dashboard") ? "Document" : "Script",
  request: { url: `${origin}/${file}`, headers: { private: "do not retain" } }, ...extra });
function start(collector, token = "250/1") {
  collector.reset(token);
  collector.accept("Network.requestWillBeSent", request("private-main", `dashboard.html?inboxTrial=${token}`, 10));
}
function respond(collector, requestId, file, timestamp, type = "Script", extra = {}) {
  collector.accept("Network.responseReceived", { requestId, loaderId: "private-loader", timestamp,
    type, response: { url: `${origin}/${file}`, statusText: "private text" }, ...extra });
}

test("expected document anchors an independent CDP clock with complete and incomplete files", () => {
  const collector = create();
  assert.deepEqual(collector.read(), { available: false, clock: "cdp-main-document-request", files: [] });
  start(collector);
  collector.assertNavigation("private-loader", "private-frame");
  respond(collector, "private-main", "dashboard.html?inboxTrial=250/1", 10.125, "Document");
  collector.accept("Network.loadingFinished", { requestId: "private-main", timestamp: 10.25 });
  collector.accept("Network.requestWillBeSent", request("private-script", "js/a.js?private-cache-key#private", 10.25));
  respond(collector, "private-script", "js/a.js?private-cache-key", 10.5);
  collector.accept("Network.loadingFinished", { requestId: "private-script", timestamp: 10.75 });
  collector.accept("Network.requestWillBeSent", request("pending", "js/b.js", 10.5));
  assert.deepEqual(collector.read(), { available: true, clock: "cdp-main-document-request", files: [
    { file: "dashboard.html", type: "Document", requestMs: 0, responseMs: 125, endMs: 250, failed: false },
    { file: "js/a.js", type: "Script", requestMs: 250, responseMs: 500, endMs: 750, failed: false },
    { file: "js/b.js", type: "Script", requestMs: 500, responseMs: null, endMs: null, failed: false }
  ] });
  const snapshot = collector.read(); snapshot.files[0].file = "changed";
  assert.equal(collector.read().files[0].file, "dashboard.html");
  assert.ok(!JSON.stringify(collector.read()).includes("private"));
});

test("reset rejects earlier trial, loader and unknown request events", () => {
  const collector = create(); start(collector); collector.reset("250/2");
  collector.accept("Network.requestWillBeSent", request("old-main", "dashboard.html?inboxTrial=250/1", 20));
  collector.accept("Network.requestWillBeSent", request("old-script", "js/a.js", 20));
  assert.equal(collector.read().available, false);
  collector.accept("Network.requestWillBeSent", request("new-main", "dashboard.html?inboxTrial=250/2", 21, { loaderId: "new-loader" }));
  collector.accept("Network.requestWillBeSent", request("old-script", "js/a.js", 22));
  collector.accept("Network.loadingFinished", { requestId: "old-main", timestamp: 22 });
  collector.accept("Network.loadingFinished", { requestId: "unknown", timestamp: 22 });
  assert.equal(collector.read().files.length, 1);
  assert.equal(collector.read().files[0].endMs, null);
  collector.accept("Network.requestWillBeSent", request("child", "js/a.js", 22,
    { loaderId: "new-loader", frameId: "other-frame" }));
  assert.equal(collector.read().files.length, 1);
  assert.throws(() => collector.assertNavigation("private-loader", "private-frame"), /measured navigation/);
  assert.throws(() => collector.assertNavigation("new-loader", "other-frame"), /measured navigation/);
  collector.assertNavigation("new-loader", "private-frame");
});

test("outside or spoofed URLs and unknown types never appear in the report", () => {
  const collector = create(); start(collector);
  const urls = ["https://private.invalid/js/a.js", `chrome-extension://${"b".repeat(32)}/js/a.js`,
    `${origin}.invalid/js/a.js`, `chrome-extension://private@${"a".repeat(32)}/js/a.js`,
    `${origin}/js/unknown.js`, `${origin}/js/%61.js`, `${origin}/js/a%2F.js`, "private malformed URL"];
  for (const [index, url] of urls.entries()) {
    collector.accept("Network.requestWillBeSent", request(`outside-${index}`, "js/a.js", 11, { request: { url } }));
  }
  collector.accept("Network.requestWillBeSent", request("unknown-type", "js/a.js", 11, { type: "private-type" }));
  collector.accept("Network.webSocketCreated", { requestId: "private-websocket", url: "wss://private.invalid" });
  assert.equal(collector.read().files.length, 1);
  assert.ok(!JSON.stringify(collector.read()).includes("private"));
});

test("redirect chains and response identity changes are excluded", () => {
  const collector = create(); start(collector);
  collector.accept("Network.requestWillBeSent", request("redirect", "js/a.js", 11));
  collector.accept("Network.requestWillBeSent", request("redirect", "js/b.js", 12, { redirectResponse: { url: "private" } }));
  collector.accept("Network.loadingFinished", { requestId: "redirect", timestamp: 13 });
  collector.accept("Network.requestWillBeSent", request("wrong-response", "js/a.js", 11));
  respond(collector, "wrong-response", "js/b.js", 12);
  collector.accept("Network.requestWillBeSent", request("wrong-loader", "js/a.js", 11));
  respond(collector, "wrong-loader", "js/a.js", 12, "Script", { loaderId: "another-loader" });
  assert.equal(collector.read().files.length, 1);
  collector.accept("Network.requestWillBeSent", request("private-main", "dashboard.html?inboxTrial=250/1", 13,
    { redirectResponse: {} }));
  assert.deepEqual(collector.read(), { available: false, clock: "cdp-main-document-request", files: [] });
});

test("failed requests retain only failure state and valid timestamps, never error payloads", () => {
  const collector = create(); start(collector);
  collector.accept("Network.requestWillBeSent", request("failed", "js/a.js", 10.25));
  collector.accept("Network.loadingFailed", { requestId: "failed", timestamp: 10.5,
    errorText: "private network message", blockedReason: "private" });
  collector.accept("Network.loadingFinished", { requestId: "failed", timestamp: 11 });
  assert.deepEqual(collector.read().files[1], { file: "js/a.js", type: "Script", requestMs: 250,
    responseMs: null, endMs: 500, failed: true });
  assert.ok(!JSON.stringify(collector.read()).includes("private"));
});

test("missing navigation identity stays unavailable while a canceled main request is explicitly failed", () => {
  const collector = create(); collector.reset("250/1");
  for (const extra of [{ loaderId: undefined }, { frameId: undefined }, { request: {} }]) {
    collector.accept("Network.requestWillBeSent", request("missing", "dashboard.html?inboxTrial=250/1", 10, extra));
    assert.equal(collector.read().available, false);
  }
  start(collector);
  collector.accept("Network.loadingFailed", { requestId: "private-main", timestamp: 10.25,
    canceled: true, errorText: "private cancellation text" });
  assert.deepEqual(collector.read(), { available: true, clock: "cdp-main-document-request", files: [
    { file: "dashboard.html", type: "Document", requestMs: 0, responseMs: null, endMs: 250, failed: true }
  ] });
  collector.assertNavigation("private-loader", "private-frame");
  collector.accept("Network.requestWillBeSent", request("wrong-frame-response", "js/a.js", 11));
  respond(collector, "wrong-frame-response", "js/a.js", 12, "Script", { frameId: "another-frame" });
  assert.equal(collector.read().files.length, 1);
});

test("invalid times and pre-request events cannot create negative or nonfinite offsets", () => {
  for (const invalid of [undefined, null, -1, NaN, Infinity, Number.MAX_VALUE, "11"]) {
    const collector = create(); start(collector);
    collector.accept("Network.requestWillBeSent", request("bad", "js/a.js", invalid));
    collector.accept("Network.loadingFinished", { requestId: "private-main", timestamp: invalid });
    assert.equal(collector.read().files.length, 1);
    assert.equal(collector.read().files[0].endMs, null);
  }
  const collector = create(); start(collector);
  collector.accept("Network.requestWillBeSent", request("early", "js/a.js", 9));
  collector.accept("Network.requestWillBeSent", request("script", "js/a.js", 11));
  respond(collector, "script", "js/a.js", 10.5);
  collector.accept("Network.loadingFinished", { requestId: "script", timestamp: 10.75 });
  assert.equal(collector.read().files[1].responseMs, null);
  assert.equal(collector.read().files[1].endMs, null);
  respond(collector, "script", "js/a.js", 12);
  collector.accept("Network.loadingFinished", { requestId: "script", timestamp: 10.5 });
  assert.equal(collector.read().files[1].endMs, null);
});

test("completion and response preserve their independent timestamps in either delivery order", () => {
  // Native extension requests can report completion before the response stamp,
  // even when CDP delivers responseReceived first. Neither stamp is a duration.
  for (const finishFirst of [false, true]) {
    for (const event of ["Network.loadingFinished", "Network.loadingFailed"]) {
      const collector = create(); start(collector);
      const finish = () => collector.accept(event, { requestId: "private-main", timestamp: 10.125 });
      const response = () => respond(collector, "private-main", "dashboard.html?inboxTrial=250/1", 10.25, "Document");
      if (finishFirst) { finish(); response(); } else { response(); finish(); }
      assert.deepEqual(collector.read().files[0], { file: "dashboard.html", type: "Document", requestMs: 0,
        responseMs: 250, endMs: 125, failed: event === "Network.loadingFailed" });
      respond(collector, "private-main", "dashboard.html?inboxTrial=250/1", 11, "Document");
      collector.accept(event === "Network.loadingFinished" ? "Network.loadingFailed" : "Network.loadingFinished",
        { requestId: "private-main", timestamp: 11 });
      assert.equal(collector.read().files[0].responseMs, 250, "duplicate response cannot rewrite the first stamp");
      assert.equal(collector.read().files[0].endMs, 125, "duplicate completion cannot rewrite the first stamp");
      assert.equal(collector.read().files[0].failed, event === "Network.loadingFailed");
    }
  }
});

test("request ordering is deterministic and repeated file requests remain distinct", () => {
  const collector = create(); start(collector);
  collector.accept("Network.requestWillBeSent", request("b", "js/b.js", 11));
  collector.accept("Network.requestWillBeSent", request("a", "js/a.js", 11));
  collector.accept("Network.requestWillBeSent", request("a-again", "js/a.js", 12));
  assert.deepEqual(collector.read().files.map(file => file.file), ["dashboard.html", "js/a.js", "js/b.js", "js/a.js"]);
  collector.accept("Network.requestWillBeSent", request("a", "js/a.js", 11));
  assert.equal(collector.read().files.length, 3, "ambiguous duplicate starts are excluded");
  collector.accept("Network.requestWillBeSent", request("b", "js/not-allowed.js", 12));
  collector.accept("Network.loadingFinished", { requestId: "b", timestamp: 13 });
  assert.equal(collector.read().files.length, 2, "even an unallowlisted duplicate invalidates the old identity");
});

test("configuration and trial token failures have fixed safe diagnostics", () => {
  for (const extensionOrigin of [null, "https://private.invalid", `${origin}/dashboard.html`, `${origin}.invalid`]) {
    assert.throws(() => createInboxStartupNetwork({ extensionOrigin, allowedPaths: paths }), assert.AssertionError);
  }
  for (const allowedPaths of [null, ["../private"], ["dashboard.html", "js//private.js"], ["js/a.js"]]) {
    assert.throws(() => createInboxStartupNetwork({ extensionOrigin: origin, allowedPaths }), assert.AssertionError);
  }
  for (const token of [null, undefined, "", 1]) assert.throws(() => create().reset(token), assert.AssertionError);
  const collector = create(); collector.reset("250/1");
  collector.accept("Network.requestWillBeSent", request("ambiguous", "dashboard.html?inboxTrial=250/1&inboxTrial=250/2", 10));
  assert.equal(collector.read().available, false);
});
