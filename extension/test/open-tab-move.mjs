import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { readFileSync } from "node:fs";

const checks = [];
const check = (condition, name, detail = "") => {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  checks.push(name);
};

const storage = createInterleavableStorage({ journal: [] });
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { locks: createMockLockManager() }
});

const tabs = new Map([
  [11, { id: 11, windowId: 1, index: 4, title: "One", url: "https://one.test/" }],
  [22, { id: 22, windowId: 2, index: 7, title: "Two", url: "https://two.test/" }],
  [33, { id: 33, windowId: 1, index: 8, title: "Three", url: "https://three.test/" }]
]);
const moveCalls = [];
const createCalls = [];
globalThis.chrome = {
  storage: { local: storage.local, onChanged: storage.onChanged },
  tabs: {
    get: async (id) => {
      if (!tabs.has(id)) throw new Error("gone");
      return structuredClone(tabs.get(id));
    },
    move: async (ids, destination) => {
      moveCalls.push({ ids: Array.isArray(ids) ? [...ids] : ids, ...destination });
      return [];
    }
  },
  windows: {
    get: async (id) => ({ id, type: "normal", incognito: false }),
    create: async (options) => {
      createCalls.push({ ...options });
      return { id: 91, type: "normal" };
    }
  }
};

const { moveSelectedOpenTabs } = await import("../js/lib/open-tab-move.js");

const existing = await moveSelectedOpenTabs([11, 22, 11], { kind: "window", windowId: 3 });
check(existing.ok && existing.moved === 2 && existing.windowId === 3,
  "an existing-window move reports the complete unique set", JSON.stringify(existing));
check(moveCalls.length === 1 && JSON.stringify(moveCalls[0]) ===
  JSON.stringify({ ids: [11, 22], windowId: 3, index: -1 }),
"the worker moves every selected tab in one ordered Chrome call", JSON.stringify(moveCalls));
let journal = storage.snapshot().journal;
check(journal.length === 1 && journal[0].moves.length === 2 &&
    JSON.stringify(journal[0].moves) === JSON.stringify([
      { tabId: 11, windowId: 1, index: 4 },
      { tabId: 22, windowId: 2, index: 7 }
    ]),
"one Undo entry preserves every selected tab's original position", JSON.stringify(journal));

moveCalls.length = 0;
const inserted = await moveSelectedOpenTabs([11, 22], { kind: "window", windowId: 3, index: 4 });
check(inserted.ok && moveCalls.length === 1 &&
    JSON.stringify(moveCalls[0]) === JSON.stringify({ ids: [11, 22], windowId: 3, index: 4 }),
"a row drop preserves its requested insertion index for the complete set",
JSON.stringify(moveCalls));

moveCalls.length = 0;
const fresh = await moveSelectedOpenTabs([11, 22, 33], { kind: "new-window" });
check(fresh.ok && fresh.moved === 3 && fresh.windowId === 91,
  "a new-window move reports the complete set and created destination", JSON.stringify(fresh));
check(createCalls.length === 1 && createCalls[0].tabId === 11 && createCalls[0].focused === false &&
    moveCalls.length === 1 && JSON.stringify(moveCalls[0]) ===
      JSON.stringify({ ids: [22, 33], windowId: 91, index: -1 }),
"new-window movement creates from the first selected tab and moves every remainder",
JSON.stringify({ createCalls, moveCalls }));
journal = storage.snapshot().journal;
check(journal.length === 3 && journal[0].moves.length === 3,
  "the new-window path also records one complete Undo entry", JSON.stringify(journal));

const beforeInvalid = JSON.stringify({ journal: storage.snapshot().journal, moveCalls, createCalls });
const invalid = await moveSelectedOpenTabs([], { kind: "new-window" });
check(!invalid.ok && invalid.reason === "empty" &&
    JSON.stringify({ journal: storage.snapshot().journal, moveCalls, createCalls }) === beforeInvalid,
"an empty move is rejected without browser or journal side effects", JSON.stringify(invalid));

const background = readFileSync(new URL("../js/background.js", import.meta.url), "utf8");
check(background.includes('handler("move-tabs", "async"') &&
    background.includes("moveSelectedOpenTabs(msg.tabIds, msg.destination)"),
"the background worker owns the selected-set move boundary");

console.log(`PASS: ${checks.length} Open tab move checks`);
