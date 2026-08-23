/* Real Settings form with a minimal local Chrome API adapter for HTTP browser QA. */
import { createBrowserI18nMock } from "../test/i18n-browser-mock.mjs";

const state = Object.create(null);
globalThis.__customSchemeHarnessErrors = [];
addEventListener("error", (event) => {
  globalThis.__customSchemeHarnessErrors.push(event.error?.stack ?? event.message);
});
addEventListener("unhandledrejection", (event) => {
  globalThis.__customSchemeHarnessErrors.push(event.reason?.stack ?? String(event.reason));
});
let fixtureId = 0;
if (typeof crypto.randomUUID !== "function") {
  Object.defineProperty(crypto, "randomUUID", {
    value: () => `00000000-0000-4000-8000-${String(++fixtureId).padStart(12, "0")}`
  });
}
Object.defineProperty(navigator, "locks", {
  configurable: true,
  value: {
    async request(_name, options, callback) {
      const run = typeof options === "function" ? options : callback;
      return run({ name: "everytab-store", mode: "exclusive" });
    }
  }
});
const listeners = new Set();
const event = {
  addListener(listener) { listeners.add(listener); },
  removeListener(listener) { listeners.delete(listener); }
};
const browserI18n = await createBrowserI18nMock();
function emit(changes) {
  for (const listener of listeners) listener(structuredClone(changes), "local");
}
globalThis.chrome = {
  i18n: browserI18n,
  storage: {
    local: {
      async get(keys) {
        if (keys == null) return structuredClone(state);
        const names = typeof keys === "string" ? [keys]
          : Array.isArray(keys) ? keys : Object.keys(keys);
        const result = {};
        for (const key of names) {
          if (Object.hasOwn(state, key)) result[key] = structuredClone(state[key]);
          else if (!Array.isArray(keys) && typeof keys === "object") result[key] = keys[key];
        }
        return result;
      },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: state[key], newValue: structuredClone(value) };
          state[key] = structuredClone(value);
        }
        emit(changes);
      },
      async remove(keys) {
        const changes = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          if (!Object.hasOwn(state, key)) continue;
          changes[key] = { oldValue: state[key] };
          delete state[key];
        }
        emit(changes);
      }
    },
    onChanged: event
  },
  permissions: {
    async contains() { return false; },
    async request() { return false; }
  },
  commands: { async getAll() { return []; } },
  tabs: { async create() {} },
  runtime: { getURL(path) { return new URL(`../${path}`, location.href).href; } }
};

const [{ mountSettingsForm }, { initTheme }] = await Promise.all([
  import("../js/ui/settings-form.js"), import("../js/ui/theme.js")
]);
initTheme();
await mountSettingsForm(document.getElementById("settings"));
globalThis.__customSchemeHarnessState = state;
