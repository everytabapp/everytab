import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const surface = process.argv[2];

if (surface) {
  const initialState = process.argv[3]
    ? JSON.parse(Buffer.from(process.argv[3], "base64url").toString("utf8"))
    : null;
  const mem = initialState ?? {
    settings: {
      uiScheme: "cream",
      uiMode: "scheme",
      uiGradient: true,
      schemeFavorites: [],
      schemeRotate: "open"
    }
  };
  const listeners = [];
  const get = async (keys) => {
    if (keys == null) return { ...mem };
    if (typeof keys === "string") return { [keys]: mem[keys] };
    if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, mem[key]]));
    return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, mem[key] ?? fallback]));
  };
  const set = async (next) => {
    const changes = {};
    for (const [key, value] of Object.entries(next)) {
      changes[key] = { oldValue: mem[key], newValue: value };
      mem[key] = value;
    }
    for (const listener of listeners) listener(changes, "local");
  };
  const classList = { add() {}, remove() {}, toggle() {} };
  const style = { cssText: "", setProperty() {}, removeProperty() {} };
  const root = {
    dataset: {}, classList, style,
    append() {}
  };
  // The manifest URL is the immutable New Tab identity. Do not pre-mark the
  // fixture: real Chrome can fetch/evaluate the themed module graph before the
  // async entry module has published its convenience data attribute.
  const body = { dataset: {}, classList, style };
  const createElement = () => ({
    dataset: {}, style: { ...style }, remove() {}
  });

  // Store writes take the everytab-store Web Lock. Node 22 (the CI runtime)
  // has no navigator.locks, while Node 24+ does; install the shared mock in
  // every child so each surface sees the same lock contract on every runtime.
  const { createMockLockManager } = await import("./e2-mocks.mjs");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: createMockLockManager() }
  });
  globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  globalThis.location = { pathname: `/${surface}` };
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
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "#fff" });
  globalThis.chrome = {
    runtime: { getURL: (path) => path },
    storage: {
      local: { get, set },
      onChanged: { addListener(listener) { listeners.push(listener); } }
    }
  };

  const { installBrowserMapStorageAuthority } = await import(
    "./storage-authority-fixture.mjs"
  );
  installBrowserMapStorageAuthority();

  Math.random = () => 0.25;

  const { initTheme } = await import(`../js/ui/theme.js?surface=${surface}`);
  initTheme();
  await new Promise((resolve) => setTimeout(resolve, 30));
  process.stdout.write(JSON.stringify({
    scheme: mem.settings.uiScheme,
    painted: root.dataset.scheme,
    prepared: mem.schemeRotationPrepared,
    memory: mem
  }));
  process.exit(0);
}

let failures = 0;
function check(condition, name, detail = "") {
  if (condition) console.log(`  ok: ${name}`);
  else {
    console.error(`FAIL: ${name}${detail ? ` (${detail})` : ""}`);
    failures += 1;
  }
}

const runSurface = (name, initialState = null) => {
  const args = [fileURLToPath(import.meta.url), name];
  if (initialState) {
    args.push(Buffer.from(JSON.stringify(initialState), "utf8").toString("base64url"));
  }
  const run = spawnSync(process.execPath, args, {
    encoding: "utf8"
  });
  if (run.status !== 0) return { error: run.stderr || `exit ${run.status}` };
  try { return JSON.parse(run.stdout); }
  catch { return { error: run.stdout || "no output" }; }
};

const openRotationFixture = () => ({
  settings: {
    uiScheme: "cream",
    uiMode: "scheme",
    uiGradient: true,
    schemeFavorites: [],
    schemeRotate: "open"
  }
});

// A manual choice can legitimately point at a scheme which is still waiting in
// the current shuffle bag. That scheme must be removed from the pending bag,
// not returned as a permanent self-reservation on every later New Tab.
const reservedBeforeManualChoice = runSurface("options.html", openRotationFixture());
const manuallyChosen = reservedBeforeManualChoice.memory?.schemeRotationState?.remaining?.at(-1);
const stateAfterManualChoice = structuredClone(reservedBeforeManualChoice.memory ?? {});
if (manuallyChosen && stateAfterManualChoice.settings) {
  stateAfterManualChoice.settings.uiScheme = manuallyChosen;
}
const reservationAfterManualChoice = runSurface("options.html", stateAfterManualChoice);
check(Boolean(manuallyChosen) && !reservationAfterManualChoice.error &&
  reservationAfterManualChoice.scheme === manuallyChosen &&
  reservationAfterManualChoice.prepared?.from === manuallyChosen &&
  reservationAfterManualChoice.prepared?.next !== manuallyChosen,
"D3: manual selection inside the pending bag repairs the next reservation",
reservationAfterManualChoice.error || JSON.stringify({ manuallyChosen, reservationAfterManualChoice }));
const afterManualChoice = runSurface("newtab.html", reservationAfterManualChoice.memory);
check(Boolean(manuallyChosen) && !afterManualChoice.error &&
  afterManualChoice.scheme !== manuallyChosen &&
  afterManualChoice.painted === afterManualChoice.scheme,
"D3: manual selection inside the pending bag cannot permanently stall On open",
afterManualChoice.error || JSON.stringify({ manuallyChosen, afterManualChoice }));

let consecutiveState = openRotationFixture();
let priorScheme = consecutiveState.settings.uiScheme;
for (let open = 1; open <= 5; open += 1) {
  const result = runSurface("newtab.html", consecutiveState);
  check(!result.error && result.scheme !== priorScheme && result.painted === result.scheme,
    `D3: consecutive New Tab open ${open} consumes the next prepared scheme`,
    result.error || JSON.stringify(result));
  if (result.memory) consecutiveState = result.memory;
  priorScheme = result.scheme ?? priorScheme;
}

for (const name of ["newtab.html"]) {
  const result = runSurface(name);
  check(result.scheme !== "cream" && result.painted === result.scheme &&
    result.prepared?.from === result.scheme && result.prepared?.next !== result.scheme,
  `D3: On open visibly rotates across all schemes with no favorites on ${name}`,
  result.error || JSON.stringify(result));
}

for (const name of [
  "dashboard.html", "popup.html", "sidepanel.html",
  "options.html", "scheme-editor.html", "suspend.html"
]) {
  const result = runSurface(name);
  check(result.scheme === "cream" && result.painted === "cream" &&
    result.prepared?.from === "cream" && result.prepared?.next !== "cream",
  `D3: passive ${name} reserves but does not consume an On open draw`,
  result.error || JSON.stringify(result));
}

if (failures) process.exit(1);
console.log("\nAll scheme-rotation surface tests passed");
