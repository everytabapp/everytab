// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { installInboxMessageCallers, assertInboxMessageCallersReceipt } from "./inbox-message-callers.mjs";

const origin = `chrome-extension://${"a".repeat(32)}`;
const paths = ["js/lib/i18n.js", "js/ui/a.js", "js/ui/b.js"];
function fixture(run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  let stack = "Error", stackFailure;
  const invocations = [];
  const host = { location: { origin }, Error: class {
    get stack() { if (stackFailure) throw stackFailure; return stack; }
  }, chrome: { i18n: { getMessage(...args) {
    invocations.push({ receiver: this, args });
    if (args[0] === "throw") throw args[1];
    return args[1];
  } } } };
  const original = host.chrome.i18n.getMessage;
  Object.defineProperty(globalThis, "window", { configurable: true, value: host });
  let probe;
  try {
    const install = new Function("paths", `return (${installInboxMessageCallers.toString()})(paths)`);
    probe = install(paths);
    run({ host, probe, invocations, original, setStack: value => { stack = value; },
      failStack: error => { stackFailure = error; } });
  } finally {
    probe?.restore();
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete globalThis.window;
  }
}

test("serialized probe selects the first safe caller after shared i18n and merges sorted sites", () => fixture(({ host, probe, setStack }) => {
  setStack(`Error: private text\n    at msg (${origin}/js/lib/i18n.js:20:3)\n    at privateFunction (${origin}/js/ui/b.js:40:2)\n    at deeper (${origin}/js/ui/a.js:10:3)`);
  host.chrome.i18n.getMessage("private-key", "private-return");
  host.chrome.i18n.getMessage("private-key", "private-return");
  setStack(`Error\n    at ${origin}/js/ui/a.js:12:4`);
  host.chrome.i18n.getMessage("x");
  setStack(`Error\n    at outer (${origin}/js/ui/a.js:2:4)`);
  host.chrome.i18n.getMessage("x");
  const value = probe.read();
  assert.deepEqual(value, { calls: 4, unattributed: 0, sites: [
    { file: "js/ui/a.js", line: 2, calls: 1 }, { file: "js/ui/a.js", line: 12, calls: 1 },
    { file: "js/ui/b.js", line: 40, calls: 2 }
  ] });
  assert.strictEqual(assertInboxMessageCallersReceipt(value, paths), value);
  assert.ok(!JSON.stringify(value).includes("private"));
  value.sites[0].calls = 999;
  assert.equal(probe.read().sites[0].calls, 1);
}));

test("foreign, spoofed, malformed and unallowlisted locations stay unattributed", () => fixture(({ host, probe, setStack }) => {
  const frames = [
    `fn (https://private.invalid/${origin}/js/ui/a.js:1:1)`,
    `fn (chrome-extension://${"b".repeat(32)}/js/ui/a.js:1:1)`,
    `fn (${origin}.invalid/js/ui/a.js:1:1)`,
    `fn (${origin}/js/ui/not-allowed.js:1:1)`,
    `fn (${origin}/js/ui/a.js?private-query:1:1)`,
    `fn (${origin}/js/ui/a.js#private-fragment:1:1)`,
    `fn (${origin}/js/../js/ui/a.js:1:1)`,
    `fn (${origin}/js/ui/%61.js:1:1)`,
    `fn (${origin}/js/ui/a.js:0:1)`, `fn (${origin}/js/ui/a.js:1:0)`,
    `fn (${origin}/js/ui/a.js:9007199254740992:1)`,
    `spoof (${origin}/js/ui/a.js:1:1) (https://private.invalid/file.js:1:1)`,
    `fn (${origin}/js/lib/i18n.js:1:1)`, "fn (native)", "not a frame"
  ];
  for (const frame of frames) {
    setStack(`Error: private text\n    at ${frame}`);
    host.chrome.i18n.getMessage("private-key", "private substitution");
  }
  setStack(null); host.chrome.i18n.getMessage("x");
  assert.deepEqual(probe.read(), { calls: frames.length + 1, unattributed: frames.length + 1, sites: [] });
}));

test("outside frames are skipped before an eligible owned caller", () => fixture(({ host, probe, setStack }) => {
  setStack(`Error\n    at fn (https://private.invalid/file.js:3:1)\n    at ${origin}/js/ui/a.js:9:1`);
  host.chrome.i18n.getMessage("x");
  assert.deepEqual(probe.read().sites, [{ file: "js/ui/a.js", line: 9, calls: 1 }]);
}));

test("native receiver, arguments, return and thrown identity survive stack errors too", () => fixture(({ host, probe, setStack, failStack, invocations }) => {
  setStack(`Error\n    at ${origin}/js/ui/a.js:1:1`);
  const result = { private: "return" }, substitutions = ["private text"];
  assert.strictEqual(host.chrome.i18n.getMessage("key", result, substitutions), result);
  assert.strictEqual(invocations[0].receiver, host.chrome.i18n);
  assert.deepEqual(invocations[0].args, ["key", result, substitutions]);
  const failure = new Error("private native error"), other = {};
  failStack(new Error("private stack error"));
  assert.throws(() => host.chrome.i18n.getMessage.call(other, "throw", failure), error => error === failure);
  assert.strictEqual(invocations[1].receiver, other);
  assert.deepEqual(probe.read(), { calls: 2, unattributed: 1, sites: [{ file: "js/ui/a.js", line: 1, calls: 1 }] });
}));

test("restore is idempotent and preserves later owner replacements", () => {
  fixture(({ host, probe, original }) => {
    probe.restore(); probe.restore();
    assert.strictEqual(host.chrome.i18n.getMessage, original);
    assert.equal(Object.hasOwn(host, "__inboxMessageCallers"), false);
    host.chrome.i18n.getMessage("x");
    assert.equal(probe.read().calls, 0);
  });
  fixture(({ host, probe }) => {
    const later = () => {};
    host.chrome.i18n.getMessage = later;
    probe.restore();
    assert.strictEqual(host.chrome.i18n.getMessage, later);
  });
});

test("invalid installation inputs fail before changing the existing native wrapper", () => fixture(({ host, probe }) => {
  const installed = host.chrome.i18n.getMessage;
  const install = new Function("paths", `return (${installInboxMessageCallers.toString()})(paths)`);
  for (const invalid of [null, ["js/../private"], ["js//private"], ["https://private.invalid"]]) {
    assert.throws(() => install(invalid), /safe relative sources/);
  }
  for (const invalid of ["null", "https://private.invalid", `${origin}/js/a.js`, `${origin}.invalid`]) {
    host.location.origin = invalid;
    assert.throws(() => install(paths), /requires an extension origin/);
  }
  host.location.origin = origin;
  assert.strictEqual(host.chrome.i18n.getMessage, installed);
  assert.strictEqual(host.__inboxMessageCallers, probe);
}));

const valid = () => ({ calls: 5, unattributed: 2, sites: [
  { file: "js/ui/a.js", line: 1, calls: 1 }, { file: "js/ui/b.js", line: 2, calls: 2 }
] });
test("strict receipt validation rejects private fields, malformed counts and unknown paths", () => {
  for (const change of [
    value => { value.privateStack = "private payload"; },
    value => { Object.defineProperty(value.sites[0], "privateText", { value: "secret" }); },
    value => { value.sites[0][Symbol("private")] = "secret"; },
    value => { delete value.unattributed; }, value => { value.calls = 0; },
    value => { value.calls = 1.5; }, value => { value.calls = NaN; },
    value => { value.unattributed = -1; }, value => { value.unattributed = "2"; },
    value => { value.sites[0].calls = 0; }, value => { value.sites[0].calls = Infinity; },
    value => { value.sites[0].line = 0; }, value => { value.sites[0].line = 1.1; },
    value => { value.sites[0].file = "js/lib/i18n.js"; },
    value => { value.sites[0].file = "https://private.invalid"; },
    value => { value.sites[0].file = "js/ui/missing.js"; },
    value => { value.sites.reverse(); }, value => { value.sites[1] = { ...value.sites[0] }; },
    value => { value.calls++; }, value => { value.sites = null; }
  ]) {
    const value = valid(); change(value);
    assert.throws(() => assertInboxMessageCallersReceipt(value, paths), error =>
      error instanceof assert.AssertionError && !error.message.includes("private payload"));
  }
  for (const value of [undefined, null, [], {}]) {
    assert.throws(() => assertInboxMessageCallersReceipt(value, paths), assert.AssertionError);
  }
  for (const allowed of [null, ["../secret"], ["js/../secret"], ["https://private.invalid"], ["js//a.js"]]) {
    assert.throws(() => assertInboxMessageCallersReceipt(valid(), allowed), assert.AssertionError);
  }
  assert.throws(() => assertInboxMessageCallersReceipt({ calls: 1, unattributed: 1, sites: [] }, paths),
    /requires at least one attributed site/);
  const value = valid(), before = structuredClone(value);
  assert.strictEqual(assertInboxMessageCallersReceipt(value, paths), value);
  assert.deepEqual(value, before);
});
