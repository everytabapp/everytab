// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";

/**
 * Enforce this fixture's numeric-only report boundary. Exact own-key checks also
 * reject unexpected private payload fields instead of forwarding them to JSON.
 * @param {object} work Result of the installed probe's read().
 * @returns {object} The validated object, unchanged.
 */
export function assertInboxWorkReceipt(work) {
  function shape(value, keys) {
    assert.ok(value !== null && typeof value === "object" && !Array.isArray(value),
      "Inbox work receipt requires numeric counter objects");
    const actual = Reflect.ownKeys(value);
    assert.ok(actual.length === keys.length && keys.every(key => Object.hasOwn(value, key)),
      "Inbox work receipt contains missing or unexpected fields");
  }
  const names = ["NumberFormat", "DateTimeFormat", "RelativeTimeFormat", "ListFormat", "PluralRules"];
  shape(work, ["intl", "locale", "messages", "startupStyle"]);
  shape(work.intl, names);
  for (const bucket of [...names.map(name => work.intl[name]), work.locale, work.messages, work.startupStyle]) {
    shape(bucket, ["calls", "ms"]);
    assert.ok(Number.isSafeInteger(bucket.calls) && bucket.calls >= 0 &&
      Number.isFinite(bucket.ms) && bucket.ms >= 0, "Inbox work counters must be finite and nonnegative");
  }
  assert.ok(work.locale.calls > 0 && work.messages.calls > 0 && work.intl.NumberFormat.calls > 0,
    "Inbox work fixture requires observed locale, message and number-format calls");
  return work;
}

/** Install by serializing this function before the measured document's modules. */
export function installInboxWorkProbes() {
  const host = window;
  const names = ["NumberFormat", "DateTimeFormat", "RelativeTimeFormat", "ListFormat", "PluralRules"];
  const counter = () => ({ calls: 0, ms: 0 });
  const totals = { intl: Object.fromEntries(names.map(name => [name, counter()])),
    locale: counter(), messages: counter(), startupStyle: counter() };
  const restorations = [];
  const previousProbe = Object.getOwnPropertyDescriptor(host, "__inboxWorkProbe");
  const now = host.performance.now.bind(host.performance);

  function measure(bucket, invoke) {
    const start = now();
    bucket.calls++;
    try { return invoke(); }
    finally { bucket.ms += Math.max(0, now() - start); }
  }
  function replace(owner, key, replacement) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    Object.defineProperty(owner, key, { configurable: true, writable: true,
      enumerable: descriptor?.enumerable ?? true, value: replacement });
    restorations.push(() => {
      // Do not overwrite a later owner's replacement during optional teardown.
      if (owner[key] !== replacement) return;
      if (descriptor) Object.defineProperty(owner, key, descriptor);
      else delete owner[key];
    });
  }
  function wrapCall(owner, key, bucket) {
    const original = owner?.[key];
    if (typeof original !== "function") return;
    replace(owner, key, new Proxy(original, {
      apply(target, receiver, args) {
        return measure(bucket, () => Reflect.apply(target, receiver, args));
      }
    }));
  }
  let restored = false;
  const probe = {
    // Only numeric aggregates escape. Constructor options, message keys, text,
    // nodes, returned styles and exceptions are never retained in the report.
    read() {
      const copy = bucket => ({ calls: bucket.calls, ms: bucket.ms });
      return { intl: Object.fromEntries(names.map(name => [name, copy(totals.intl[name])])),
        locale: copy(totals.locale), messages: copy(totals.messages), startupStyle: copy(totals.startupStyle) };
    },
    restore() {
      if (restored) return;
      restored = true;
      for (const restore of restorations.reverse()) restore();
      if (host.__inboxWorkProbe === probe) {
        if (previousProbe) Object.defineProperty(host, "__inboxWorkProbe", previousProbe);
        else delete host.__inboxWorkProbe;
      }
    }
  };
  try {
    for (const name of names) {
      const original = host.Intl?.[name];
      if (typeof original !== "function") continue;
      replace(host.Intl, name, new Proxy(original, {
        construct(target, args, newTarget) {
          return measure(totals.intl[name], () => Reflect.construct(target, args, newTarget));
        },
        apply(target, receiver, args) {
          return measure(totals.intl[name], () => Reflect.apply(target, receiver, args));
        }
      }));
    }
    wrapCall(host.Intl, "getCanonicalLocales", totals.locale);
    wrapCall(host.chrome?.i18n, "getMessage", totals.messages);
    const originalStyle = host.getComputedStyle;
    if (typeof originalStyle === "function") {
      replace(host, "getComputedStyle", new Proxy(originalStyle, {
        apply(target, receiver, args) {
          const [node, pseudo] = args;
          if (pseudo !== "::before" || typeof node?.matches !== "function" ||
              !node.matches(".startup-count[data-startup-pending]")) {
            return Reflect.apply(target, receiver, args);
          }
          return measure(totals.startupStyle, () => {
            const style = Reflect.apply(target, receiver, args);
            // The caller immediately reads transform too. Force the same style
            // resolution here to include its cost; this diagnostic adds overhead.
            void style.transform;
            return style;
          });
        }
      }));
    }
    Object.defineProperty(host, "__inboxWorkProbe", { configurable: true, writable: true, value: probe });
    return probe;
  } catch (error) {
    probe.restore();
    throw error;
  }
}
