/**
 * D3 regression: one settings/rotation write with many live EveryTab contexts
 * must not queue one store-lock reservation and two full paints per context.
 */
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const memory = {
  settings: {
    uiScheme: "frozenllama",
    uiMode: "scheme",
    uiGradient: false,
    schemeFavorites: [],
    schemeRotate: "open"
  },
  customSchemes: {}
};
const listeners = new Set();
let lockTail = Promise.resolve();
let storeLockRequests = 0;
const heldLocks = new Set();
let storageReads = 0;
let storageWrites = 0;
let computedStyleReads = 0;
let suppressStorageEvents = false;

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    locks: {
      request: (name, options, callback) => {
        if (options?.ifAvailable) {
          if (heldLocks.has(name)) return Promise.resolve(callback(null));
          heldLocks.add(name);
          return Promise.resolve(callback({ name })).finally(() => heldLocks.delete(name));
        }
        if (name === "everytab-store") storeLockRequests += 1;
        const result = lockTail.then(callback);
        lockTail = result.catch(() => {});
        return result;
      }
    }
  }
});

const selected = (keys) => {
  storageReads += 1;
  if (keys == null) return clone(memory);
  if (typeof keys === "string") {
    return memory[keys] === undefined ? {} : { [keys]: clone(memory[keys]) };
  }
  if (Array.isArray(keys)) {
    return Object.fromEntries(keys.filter((key) => memory[key] !== undefined)
      .map((key) => [key, clone(memory[key])]));
  }
  return Object.fromEntries(Object.entries(keys)
    .map(([key, fallback]) => [key, clone(memory[key] ?? fallback)]));
};

const storageSet = async (values) => {
  storageWrites += 1;
  const changes = {};
  for (const [key, value] of Object.entries(values)) {
    const oldValue = clone(memory[key]);
    memory[key] = clone(value);
    changes[key] = { oldValue, newValue: clone(value) };
  }
  if (!suppressStorageEvents) {
    for (const listener of [...listeners]) listener(changes, "local");
  }
};

const style = { cssText: "", setProperty() {}, removeProperty() {} };
const classList = { add() {}, remove() {}, toggle() {} };
const root = { dataset: {}, style, classList, append() {} };
const body = { dataset: {}, style, classList };
const createElement = () => ({ dataset: {}, style: { ...style }, remove() {} });
const local = new Map();
globalThis.localStorage = {
  getItem: (key) => local.get(key) ?? null,
  setItem: (key, value) => local.set(key, String(value)),
  removeItem: (key) => local.delete(key)
};
globalThis.location = { pathname: "/options.html" };
globalThis.window = {
  location,
  matchMedia: () => ({ matches: false, addEventListener() {} })
};
globalThis.document = {
  documentElement: root,
  body,
  createElement,
  querySelectorAll: () => []
};
globalThis.getComputedStyle = () => {
  computedStyleReads += 1;
  return { getPropertyValue: () => "#fff" };
};
globalThis.chrome = {
  runtime: { getURL: (path) => path },
  storage: {
    local: { get: async (keys) => selected(keys), set: storageSet },
    onChanged: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener)
    }
  }
};

const { installBrowserMapStorageAuthority } = await import(
  "./storage-authority-fixture.mjs"
);
installBrowserMapStorageAuthority();

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, label, timeout = 250) => {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await wait(1);
  }
  fail(`timed out waiting for ${label}`);
};
const settle = async () => {
  for (let pass = 0; pass < 8; pass += 1) {
    await wait(5);
    await lockTail;
  }
};
const fail = (message, detail) => {
  console.error(`FAIL: ${message}${detail ? ` (${detail})` : ""}`);
  process.exit(1);
};

const contextCount = Math.max(2, Number.parseInt(process.argv[2] ?? "2", 10) || 2);
const { patchSettings } = await import("../js/lib/store.js");
const themeContexts = await Promise.all(Array.from(
  { length: contextCount },
  (_, context) => import(`../js/ui/theme.js?pressure=${context}`)
));
for (const context of themeContexts) context.initTheme();
await settle();
if (listeners.size < contextCount) {
  fail(`fixture did not mount ${contextCount} live theme contexts`, listeners.size);
}

storeLockRequests = 0;
storageReads = 0;
storageWrites = 0;
computedStyleReads = 0;
const selectionStarted = performance.now();
await patchSettings({ uiScheme: "ink" });
await waitFor(() => root.dataset.scheme === "ink", "manual selection paint");
const selectionPaintMs = performance.now() - selectionStarted;
await settle();
const selectionMs = performance.now() - selectionStarted;
if (root.dataset.scheme !== "ink") fail("manual selection did not paint", root.dataset.scheme);
if (storeLockRequests > 2) {
  fail("one manual selection queued cross-context reservation work",
    `storeLocks=${storeLockRequests}, reads=${storageReads}, writes=${storageWrites}, ms=${selectionMs.toFixed(1)}`);
}
if (computedStyleReads > contextCount + 2) {
  fail("one manual selection repainted contexts after the visible paint was complete",
    `styleReads=${computedStyleReads}, reads=${storageReads}, writes=${storageWrites}`);
}

location.pathname = "/newtab.html";
const openSchemes = [];
let slowestOpenPaintMs = 0;
for (let open = 1; open <= 3; open += 1) {
  storeLockRequests = 0;
  storageReads = 0;
  storageWrites = 0;
  computedStyleReads = 0;
  const beforeOpen = memory.settings.uiScheme;
  const openStarted = performance.now();
  const { initTheme: initOpenTheme } = await import(`../js/ui/theme.js?pressure-open=${open}`);
  initOpenTheme();
  await waitFor(() => root.dataset.scheme === memory.settings.uiScheme &&
    memory.settings.uiScheme !== beforeOpen, `New Tab ${open} paint`);
  const openPaintMs = performance.now() - openStarted;
  slowestOpenPaintMs = Math.max(slowestOpenPaintMs, openPaintMs);
  await settle();
  const openMs = performance.now() - openStarted;
  openSchemes.push(memory.settings.uiScheme);
  if (storeLockRequests !== 1) {
    fail(`New Tab ${open} did not own exactly one rotation transaction`,
      `storeLocks=${storeLockRequests}, reads=${storageReads}, writes=${storageWrites}, ms=${openMs.toFixed(1)}`);
  }
  const liveThemeContexts = contextCount + open;
  if (computedStyleReads > liveThemeContexts * 2) {
    fail(`New Tab ${open} repainted its opening context twice`,
      `styleReads=${computedStyleReads}, contexts=${liveThemeContexts}`);
  }
}
if (new Set(openSchemes).size !== openSchemes.length) {
  fail("consecutive New Tabs repeated or stalled", openSchemes.join(" -> "));
}

// The newly opening document must paint the draw it owns. A storage broadcast
// keeps other live contexts in sync, but it is not a completion signal for the
// writer and may arrive after the visible entry boundary. Delaying that event
// reproduces the installed failure: Settings advances while New Tab stays put.
suppressStorageEvents = true;
const beforeOwnedOpen = memory.settings.uiScheme;
root.dataset.scheme = beforeOwnedOpen;
local.delete("tvTheme");
const { initTheme: initOwnedOpen } = await import("../js/ui/theme.js?pressure-owned-open=1");
initOwnedOpen();
await waitFor(() => memory.settings.uiScheme !== beforeOwnedOpen,
  "opening context to commit its own rotation");
await settle();
if (root.dataset.scheme !== memory.settings.uiScheme) {
  fail("opening context relied on its storage broadcast to paint its own draw",
    `stored=${memory.settings.uiScheme}, painted=${root.dataset.scheme}`);
}
suppressStorageEvents = false;

console.log(`PASS: ${contextCount} existing contexts, selection paint ${selectionPaintMs.toFixed(1)}ms ` +
  `(settled ${selectionMs.toFixed(1)}ms), 3 New Tabs changed without repeats, owned draw painted, ` +
  `slowest paint ${slowestOpenPaintMs.toFixed(1)}ms`);
