/**
 * Regression for a long-lived profile whose retired rotation keys were kept as
 * explicit null values. The diagnostics report intentionally classifies null
 * and absence alike as "missing", so this is the exact reported state shape.
 */
import assert from "node:assert/strict";
import { createMockLockManager } from "./e2-mocks.mjs";

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const listeners = new Set();
const memory = {
  settings: {
    uiScheme: "dasher",
    uiMode: "scheme",
    schemeRotate: "open",
    schemeFavorites: []
  },
  customSchemes: {
    "11111111-1111-4111-8111-111111111111": {
      id: "11111111-1111-4111-8111-111111111111",
      modifiedAt: 1_786_999_000_000,
      deletedAt: 1_786_999_000_000
    },
    "22222222-2222-4222-8222-222222222222": {
      id: "22222222-2222-4222-8222-222222222222",
      modifiedAt: 1_786_999_000_001,
      deletedAt: 1_786_999_000_001
    }
  },
  schemeRotationState: null,
  schemeRotationPrepared: null
};

const selected = (keys) => {
  const list = typeof keys === "string" ? [keys] : keys;
  return Object.fromEntries(list.filter((key) => Object.hasOwn(memory, key))
    .map((key) => [key, clone(memory[key])]));
};

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => selected(keys),
      set: async (values) => {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: clone(memory[key]), newValue: clone(value) };
          memory[key] = clone(value);
        }
        for (const listener of listeners) listener(clone(changes), "local");
      }
    },
    onChanged: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener)
    }
  }
};
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { locks: createMockLockManager() }
});

const { maybeRotateSchemeOnOpen } = await import("../js/lib/scheme-rotation.js");
const result = await maybeRotateSchemeOnOpen(() => 0.25);

assert.equal(result?.changed, true, "an explicit null legacy state still rotates");
assert.notEqual(memory.settings.uiScheme, "dasher", "the visible scheme advances");
assert.equal(
  memory.schemeRotationPrepared?.from,
  memory.settings.uiScheme,
  "the same commit reserves a successor from the new scheme"
);

console.log("PASS: explicit null legacy rotation state is treated as an empty shuffle bag");
