/**
 * D3 regression: a New Tab must paint the rotation it commits even when its
 * prepared first-paint cache is absent and its own storage broadcast is late.
 */
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const memory = {
  settings: {
    uiScheme: "devtty",
    uiMode: "scheme",
    uiGradient: false,
    schemeFavorites: [],
    schemeRotate: "open"
  },
  customSchemes: {}
};
const listeners = new Set();
let storeTail = Promise.resolve();

const selected = (keys) => {
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

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    locks: {
      request: (_name, _options, callback) => {
        const result = storeTail.then(() => callback({ name: "everytab-store" }));
        storeTail = result.catch(() => {});
        return result;
      }
    }
  }
});

const style = { cssText: "", setProperty() {}, removeProperty() {} };
const classList = { toggle() {} };
const root = { dataset: { scheme: "devtty" }, style, classList, append() {} };
const body = { dataset: {}, style, classList };
globalThis.location = { pathname: "/newtab.html" };
globalThis.window = {
  location,
  matchMedia: () => ({ matches: false, addEventListener() {} })
};
globalThis.document = {
  documentElement: root,
  body,
  createElement: () => ({ dataset: {}, style: { ...style }, remove() {} })
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "#fff" });
globalThis.localStorage = {
  getItem: () => null,
  setItem() {},
  removeItem() {}
};
globalThis.chrome = {
  runtime: { getURL: (path) => path },
  storage: {
    local: {
      get: async (keys) => selected(keys),
      set: async (values) => {
        for (const [key, value] of Object.entries(values)) memory[key] = clone(value);
        // Deliberately hold `onChanged`: the writing page cannot require an
        // advisory cross-context event to finish its own visible operation.
      }
    },
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
const deadline = performance.now() + 250;
const { initTheme } = await import("../js/ui/theme.js?owned-open=1");
initTheme();
while (memory.settings.uiScheme === "devtty" && performance.now() < deadline) await wait(1);
await storeTail;
await wait(5);

if (memory.settings.uiScheme === "devtty") {
  console.error("FAIL: New Tab did not commit an On-open draw");
  process.exit(1);
}
if (root.dataset.scheme !== memory.settings.uiScheme) {
  console.error("FAIL: stored scheme advanced, but opening New Tab stayed on the previous scheme " +
    `(stored=${memory.settings.uiScheme}, painted=${root.dataset.scheme})`);
  process.exit(1);
}
console.log(`PASS: opening New Tab owned and painted ${memory.settings.uiScheme}`);
