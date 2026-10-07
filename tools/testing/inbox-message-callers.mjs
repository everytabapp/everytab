// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";

/**
 * Diagnostic only: capturing a full stack on every message call adds overhead.
 * Serialize this function before runtime modules; it has no module dependencies.
 * No raw stack, function name, message key, substitution or return value is kept.
 */
export function installInboxMessageCallers(allowedPaths) {
  const host = window;
  const safePath = path => typeof path === "string" && path.startsWith("js/") &&
    path.split("/").every(part => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== "..");
  if (!Array.isArray(allowedPaths) || !allowedPaths.every(safePath)) {
    throw new Error("Message caller paths must be safe relative sources");
  }
  const allowed = new Set(allowedPaths);
  const origin = host.location.origin;
  if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
    throw new Error("Message caller probe requires an extension origin");
  }
  const owner = host.chrome?.i18n;
  const original = owner?.getMessage;
  if (typeof original !== "function") throw new Error("Native message lookup is unavailable");
  const descriptor = Object.getOwnPropertyDescriptor(owner, "getMessage");
  const previousProbe = Object.getOwnPropertyDescriptor(host, "__inboxMessageCallers");
  let calls = 0, unattributed = 0, restored = false;
  const sites = new Map();

  function callerSite(stack) {
    if (typeof stack !== "string") return null;
    for (const rawLine of stack.split("\n")) {
      if (!/^\s+at /.test(rawLine)) continue;
      let location = rawLine.trim().slice(3);
      // A named V8 frame ends in " (URL:line:column)". Only parse that final
      // location, so a URL embedded in a function name cannot impersonate it.
      if (location.endsWith(")")) {
        const boundary = location.lastIndexOf(" (");
        if (boundary < 0) continue;
        location = location.slice(boundary + 2, -1);
      }
      const position = /^(.*):(\d+):(\d+)$/.exec(location);
      if (!position) continue;
      const [, source, lineText, columnText] = position;
      const line = Number(lineText), column = Number(columnText);
      if (!Number.isSafeInteger(line) || line <= 0 || !Number.isSafeInteger(column) || column <= 0 ||
          !source.startsWith(`${origin}/`)) continue;
      const file = source.slice(origin.length + 1);
      if (!safePath(file) || !allowed.has(file) || file === "js/lib/i18n.js") continue;
      return { file, line };
    }
    return null;
  }
  const replacement = new Proxy(original, {
    apply(target, receiver, args) {
      calls++;
      let site = null;
      try { site = callerSite(new host.Error().stack); } catch {}
      if (site) {
        const key = `${site.file}:${site.line}`;
        const entry = sites.get(key) ?? { ...site, calls: 0 };
        entry.calls++;
        sites.set(key, entry);
      } else unattributed++;
      return Reflect.apply(target, receiver, args);
    }
  });
  const probe = {
    read() {
      return { calls, unattributed, sites: [...sites.values()]
        .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
        .map(site => ({ ...site })) };
    },
    restore() {
      if (restored) return;
      restored = true;
      if (owner.getMessage === replacement) {
        if (descriptor) Object.defineProperty(owner, "getMessage", descriptor);
        else delete owner.getMessage;
      }
      if (host.__inboxMessageCallers === probe) {
        if (previousProbe) Object.defineProperty(host, "__inboxMessageCallers", previousProbe);
        else delete host.__inboxMessageCallers;
      }
    }
  };
  try {
    Object.defineProperty(owner, "getMessage", { configurable: true, writable: true,
      enumerable: descriptor?.enumerable ?? true, value: replacement });
    Object.defineProperty(host, "__inboxMessageCallers", { configurable: true, writable: true, value: probe });
    return probe;
  } catch (error) {
    probe.restore();
    throw error;
  }
}

/** Strict boundary for this explicit fixture; unexpected fields may contain private data. */
export function assertInboxMessageCallersReceipt(receipt, allowedPaths) {
  const safePath = path => typeof path === "string" && path.startsWith("js/") &&
    path.split("/").every(part => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== "..");
  assert.ok(Array.isArray(allowedPaths) && allowedPaths.every(safePath), "Invalid caller source allowlist");
  const allowed = new Set(allowedPaths);
  function shape(value, keys) {
    assert.ok(value !== null && typeof value === "object" && !Array.isArray(value) &&
      Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)),
    "Message caller receipt has missing or unexpected fields");
  }
  shape(receipt, ["calls", "unattributed", "sites"]);
  assert.ok(Number.isSafeInteger(receipt.calls) && receipt.calls > 0 &&
    Number.isSafeInteger(receipt.unattributed) && receipt.unattributed >= 0 && Array.isArray(receipt.sites),
  "Message caller totals are invalid");
  assert.ok(receipt.sites.length > 0, "Message caller fixture requires at least one attributed site");
  let total = receipt.unattributed, previous = null;
  for (const site of receipt.sites) {
    shape(site, ["file", "line", "calls"]);
    assert.ok(allowed.has(site.file) && site.file !== "js/lib/i18n.js" &&
      Number.isSafeInteger(site.line) && site.line > 0 && Number.isSafeInteger(site.calls) && site.calls > 0,
    "Message caller site is invalid");
    assert.ok(!previous || previous.file < site.file ||
      (previous.file === site.file && previous.line < site.line), "Message caller sites must be sorted and unique");
    previous = site;
    total += site.calls;
  }
  assert.ok(Number.isSafeInteger(total) && total === receipt.calls, "Message caller counts do not balance");
  return receipt;
}
