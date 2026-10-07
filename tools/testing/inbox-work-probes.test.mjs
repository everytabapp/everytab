// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { installInboxWorkProbes, assertInboxWorkReceipt } from "./inbox-work-probes.mjs";

const names = ["NumberFormat", "DateTimeFormat", "RelativeTimeFormat", "ListFormat", "PluralRules"];
function fixture(run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  let ticks = 0;
  const seen = [], styles = [];
  const host = {
    Intl: Object.fromEntries([...names, "getCanonicalLocales"].map(key => [key, Intl[key]])),
    performance: { now() { assert.equal(this, host.performance); return ticks++; } },
    chrome: { i18n: { getMessage(...args) {
      seen.push({ receiver: this, args });
      if (args[0] === "throw") throw args[1];
      return args[1];
    } } },
    getComputedStyle(...args) {
      styles.push({ receiver: this, args });
      if (args[0].failure) throw args[0].failure;
      return args[0].style;
    }
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: host });
  let probe;
  try {
    // The native runner injects this exact serialized function in a new realm.
    const install = new Function(`return (${installInboxWorkProbes.toString()})()`) ;
    probe = install();
    run({ host, probe, seen, styles });
  } finally {
    probe?.restore();
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else delete globalThis.window;
  }
}

test("serialized installation preserves Intl prototypes, static methods and formatted results", () => fixture(({ host, probe }) => {
  for (const name of names) {
    assert.strictEqual(host.Intl[name].prototype, Intl[name].prototype);
    assert.strictEqual(host.Intl[name].supportedLocalesOf, Intl[name].supportedLocalesOf);
    assert.deepEqual(host.Intl[name].supportedLocalesOf(["en"]), ["en"]);
    const value = new host.Intl[name]("en");
    assert.ok(value instanceof host.Intl[name] && value instanceof Intl[name]);
    assert.equal(value.resolvedOptions().locale, "en");
  }
  assert.equal(new host.Intl.NumberFormat("en", { useGrouping: false }).format(1234), "1234");
  assert.equal(new host.Intl.PluralRules("en").select(2), "other");
  assert.equal(new host.Intl.RelativeTimeFormat("en").format(-1, "day"), "1 day ago");
  assert.equal(new host.Intl.ListFormat("en").format(["a", "b"]), "a and b");
  for (const value of Object.values(probe.read().intl)) {
    assert.ok(value.calls > 0); assert.equal(value.ms, value.calls);
  }
}));

test("constructor proxies preserve subclass newTarget, callable Intl behavior and native throws", () => fixture(({ host, probe }) => {
  class Derived extends host.Intl.NumberFormat {}
  const derived = new Derived("en");
  assert.strictEqual(Object.getPrototypeOf(derived), Derived.prototype);
  assert.equal(derived.format(42), "42");
  const callable = host.Intl.NumberFormat("en");
  assert.equal(callable.format(42), "42");
  const legacy = Object.create(Intl.NumberFormat.prototype);
  assert.strictEqual(host.Intl.NumberFormat.call(legacy, "en"), legacy);
  assert.equal(legacy.format(42), "42");
  assert.throws(() => host.Intl.RelativeTimeFormat("en"), TypeError);
  assert.throws(() => new host.Intl.NumberFormat("invalid_locale"), RangeError);
  assert.deepEqual(probe.read().intl.NumberFormat, { calls: 4, ms: 4 });
  assert.deepEqual(probe.read().intl.RelativeTimeFormat, { calls: 1, ms: 1 });
}));

test("locale and message proxies preserve arguments, receiver, return and thrown identity", () => fixture(({ host, probe, seen }) => {
  assert.deepEqual(host.Intl.getCanonicalLocales(["EN-us", "fr"]), ["en-US", "fr"]);
  assert.throws(() => host.Intl.getCanonicalLocales("invalid_locale"), RangeError);
  const payload = { privateText: "do not report" };
  assert.strictEqual(host.chrome.i18n.getMessage("private-key", payload, { escapeLt: true }), payload);
  assert.strictEqual(seen[0].receiver, host.chrome.i18n);
  assert.deepEqual(seen[0].args, ["private-key", payload, { escapeLt: true }]);
  const other = {}, failure = new Error("private error");
  assert.throws(() => host.chrome.i18n.getMessage.call(other, "throw", failure), error => error === failure);
  assert.strictEqual(seen[1].receiver, other);
  assert.deepEqual(probe.read().locale, { calls: 2, ms: 2 });
  assert.deepEqual(probe.read().messages, { calls: 2, ms: 2 });
}));

test("startup timing is restricted to the pending before pseudo-element and includes transform", () => fixture(({ host, probe, styles }) => {
  let reads = 0;
  const style = { get transform() { reads++; return "private transform"; } };
  const node = { matches(selector) { assert.equal(selector, ".startup-count[data-startup-pending]"); return true; }, style };
  assert.strictEqual(host.getComputedStyle(node, "::before"), style);
  assert.equal(reads, 1);
  assert.equal(style.transform, "private transform");
  assert.equal(reads, 2, "caller receives the original style and still performs its own read");
  assert.strictEqual(styles[0].receiver, host);
  assert.deepEqual(styles[0].args, [node, "::before"]);
  host.getComputedStyle(node);
  host.getComputedStyle(node, "::after");
  host.getComputedStyle({ matches: () => false, style }, "::before");
  assert.equal(reads, 2);
  assert.deepEqual(probe.read().startupStyle, { calls: 1, ms: 1 });
  const failure = new Error("private style error");
  assert.throws(() => host.getComputedStyle({ ...node, failure }, "::before"), error => error === failure);
  const throwingStyle = { get transform() { throw failure; } };
  assert.throws(() => host.getComputedStyle({ ...node, style: throwingStyle }, "::before"), error => error === failure);
  assert.deepEqual(probe.read().startupStyle, { calls: 3, ms: 3 });
}));

test("reports are detached numeric aggregates without inputs or native values", () => fixture(({ host, probe }) => {
  host.chrome.i18n.getMessage("secret key", "secret returned text");
  const first = probe.read();
  first.intl.NumberFormat.calls = 999;
  first.locale.ms = 999; first.messages.calls = 999;
  first.startupStyle.ms = 999;
  const second = probe.read();
  assert.deepEqual(second.messages, { calls: 1, ms: 1 });
  assert.deepEqual(second.intl.NumberFormat, { calls: 0, ms: 0 });
  assert.deepEqual(second.locale, { calls: 0, ms: 0 });
  assert.deepEqual(second.startupStyle, { calls: 0, ms: 0 });
  for (const counter of [...Object.values(second.intl), second.locale, second.messages, second.startupStyle]) {
    assert.deepEqual(Object.keys(counter), ["calls", "ms"]);
    assert.ok(Object.values(counter).every(Number.isFinite));
  }
  assert.ok(!JSON.stringify(second).includes("secret"));
}));

test("restore recovers original descriptors and is idempotent", () => fixture(({ host, probe }) => {
  assert.strictEqual(host.__inboxWorkProbe, probe);
  probe.restore();
  assert.equal(Object.hasOwn(host, "__inboxWorkProbe"), false);
  for (const name of names) assert.strictEqual(host.Intl[name], Intl[name]);
  assert.strictEqual(host.Intl.getCanonicalLocales, Intl.getCanonicalLocales);
  host.chrome.i18n.getMessage("unmeasured", null);
  new host.Intl.NumberFormat("en");
  assert.equal(probe.read().messages.calls, 0);
  assert.equal(probe.read().intl.NumberFormat.calls, 0);
  probe.restore();
}));

test("restore preserves a later owner's replacement", () => fixture(({ host, probe }) => {
  const replacement = () => "later owner";
  host.chrome.i18n.getMessage = replacement;
  probe.restore();
  assert.strictEqual(host.chrome.i18n.getMessage, replacement);
}));

function validWork() {
  return { intl: Object.fromEntries(names.map(name => [name, { calls: name === "NumberFormat" ? 1 : 0, ms: 0 }])),
    locale: { calls: 2, ms: 0.2 }, messages: { calls: 3, ms: 1 }, startupStyle: { calls: 0, ms: 0 } };
}

test("work receipt accepts detached real probe output and permits zero unused counters", () => fixture(({ host, probe }) => {
  new host.Intl.NumberFormat("en");
  host.Intl.getCanonicalLocales("en");
  host.chrome.i18n.getMessage("private-key", "private-text");
  const value = probe.read(), before = structuredClone(value);
  assert.strictEqual(assertInboxWorkReceipt(value), value);
  assert.deepEqual(value, before);
  assertInboxWorkReceipt(validWork());
}));

test("work receipt rejects missing or additional fields at every level without exposing them", () => {
  for (const invalid of [undefined, null, [], "private text"]) {
    assert.throws(() => assertInboxWorkReceipt(invalid), assert.AssertionError);
  }
  const locations = [value => value, value => value.intl,
    ...names.map(name => value => value.intl[name]),
    value => value.locale, value => value.messages, value => value.startupStyle];
  for (const locate of locations) {
    for (const change of [
      target => { delete target[Object.keys(target)[0]]; },
      target => { target.privatePayload = "secret text"; },
      target => { Object.defineProperty(target, "privatePayload", { value: "secret text" }); },
      target => { target[Symbol("privatePayload")] = "secret text"; }
    ]) {
      const value = validWork(); change(locate(value));
      assert.throws(() => assertInboxWorkReceipt(value), error => error instanceof assert.AssertionError &&
        !error.message.includes("secret") && !error.message.includes("privatePayload"));
    }
  }
});

test("work receipt rejects nonnumeric, fractional or unsafe counts and invalid elapsed times", () => {
  const locations = [...names.map(name => value => value.intl[name]),
    value => value.locale, value => value.messages, value => value.startupStyle];
  for (const locate of locations) {
    for (const calls of [undefined, null, "1", -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const value = validWork(); locate(value).calls = calls;
      assert.throws(() => assertInboxWorkReceipt(value), assert.AssertionError);
    }
    for (const ms of [undefined, null, "1", -1, NaN, Infinity]) {
      const value = validWork(); locate(value).ms = ms;
      assert.throws(() => assertInboxWorkReceipt(value), assert.AssertionError);
    }
  }
});

test("work receipt rejects a silently inactive required boundary", () => {
  for (const locate of [value => value.intl.NumberFormat, value => value.locale, value => value.messages]) {
    const value = validWork(); locate(value).calls = 0;
    assert.throws(() => assertInboxWorkReceipt(value), /requires observed/);
  }
});
