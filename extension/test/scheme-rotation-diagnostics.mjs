import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const backgroundUrl = new URL("../js/background.js", import.meta.url);
const source = await readFile(backgroundUrl, "utf8");
const startMarker = "/* scheme-rotation-diagnostics:test-seam:start */";
const endMarker = "/* scheme-rotation-diagnostics:test-seam:end */";
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker);
assert.ok(start >= 0 && end > start, "background exposes the diagnostics test seam");

const context = vm.createContext({ structuredClone });
vm.runInContext(
  `${source.slice(start + startMarker.length, end)}\n` +
  "globalThis.createDiagnostics = createSchemeRotationDiagnostics;",
  context
);
const createDiagnostics = context.createDiagnostics;
const themeUrl = new URL("../js/ui/theme.js", import.meta.url);
const themeSource = await readFile(themeUrl, "utf8");
const pageStartMarker = "/* scheme-rotation-page-paint:test-seam:start */";
const pageEndMarker = "/* scheme-rotation-page-paint:test-seam:end */";
const pageStart = themeSource.indexOf(pageStartMarker);
const pageEnd = themeSource.indexOf(pageEndMarker);
assert.ok(pageStart >= 0 && pageEnd > pageStart, "New Tab exposes the paint masking test seam");
const pageContext = vm.createContext({
  SCHEMES: ["cream", "matcha", "dracula", "forest"],
  sent: [],
  Date: { now: () => 5_000 },
  document: { documentElement: { dataset: { scheme: "custom", customScheme: "private-id" } } },
  chrome: { runtime: { sendMessage: async (message) => pageContext.sent.push(message) } },
  NEW_TAB_ROTATION_DIAGNOSTIC_PAINT_MESSAGE: "scheme-rotation-diagnostics-page-paint"
});
const reportStart = themeSource.indexOf("async function reportNewTabDiagnosticPaint");
const reportEnd = themeSource.indexOf("\nfunction clearCustomProperties", reportStart);
assert.ok(reportStart >= 0 && reportEnd > reportStart, "New Tab exposes its armed paint reporter");
vm.runInContext(
  `${themeSource.slice(pageStart + pageStartMarker.length, pageEnd)}\n` +
  `${themeSource.slice(reportStart, reportEnd)}\n` +
  "globalThis.maskSelection = schemeRotationDiagnosticSelection;\n" +
  "globalThis.reportPaint = reportNewTabDiagnosticPaint;",
  pageContext
);

let now = 1_000;
const diagnostics = createDiagnostics({
  version: "0.8.test",
  builtInSchemes: ["cream", "forest"],
  now: () => now,
  limit: 24,
  armForMs: 8_000,
  protocol: 1
});

diagnostics.record("task-start", { tabId: 1 });
let report = diagnostics.report(0, 0);
assert.deepEqual(
  structuredClone(report.trace),
  [{ at: 1_000, event: "worker-start", version: "0.8.test" }],
  "ordinary runtime events stay silent until diagnostics are explicitly armed"
);
assert.equal(diagnostics.capture(), null, "an unarmed worker offers no page capture lease");

assert.deepEqual(
  structuredClone(pageContext.maskSelection("forest")),
  { kind: "built-in", id: "forest" },
  "New Tab preserves only a known built-in id"
);
assert.deepEqual(
  structuredClone(pageContext.maskSelection("everforest")),
  { kind: "built-in", id: "matcha" },
  "New Tab masks through the permanent built-in aliases"
);
assert.deepEqual(
  structuredClone(pageContext.maskSelection("custom:11111111-1111-4111-8111-111111111111")),
  { kind: "custom" },
  "New Tab removes a custom UUID before messaging"
);
assert.deepEqual(
  structuredClone(pageContext.maskSelection("private-arbitrary-value")),
  { kind: "unknown" },
  "New Tab never forwards an arbitrary selection string"
);

pageContext.__everyTabBootThemeSelection = "custom:11111111-1111-4111-8111-111111111111";
await pageContext.reportPaint(null);
await pageContext.reportPaint({ armedUntil: 4_999 });
assert.equal(pageContext.sent.length, 0, "an unarmed or expired New Tab emits no extra message");
await pageContext.reportPaint({ armedUntil: 9_000 });
assert.equal(pageContext.sent.length, 1, "an armed New Tab emits one settled paint message");
assert.deepEqual(structuredClone(pageContext.sent[0]), {
  type: "scheme-rotation-diagnostics-page-paint",
  bootSelection: { kind: "custom" },
  finalSelection: { kind: "custom" }
});
assert.equal(JSON.stringify(pageContext.sent[0]).includes("11111111"), false);
assert.equal(JSON.stringify(pageContext.sent[0]).includes("private-id"), false);

report = diagnostics.arm(2, 3);
assert.equal(report.protocol, 1, "arm response declares its diagnostics protocol");
assert.deepEqual(
  structuredClone(report.worker),
  { startedAt: 1_000, version: "0.8.test" },
  "arm response identifies the exact worker instance and build"
);
assert.equal(report.armed, true, "arm response confirms the bounded capture window");
assert.equal(report.armedUntil, 9_000, "arm response exposes the capture deadline");
assert.equal(report.activeCount, 2);
assert.equal(report.handledCount, 3);
assert.deepEqual(
  structuredClone(diagnostics.capture()),
  { protocol: 1, armedUntil: 9_000 },
  "the existing readiness response can carry a bounded capture lease"
);

const customUuid = "11111111-1111-4111-8111-111111111111";
diagnostics.record("readiness-received", { tabId: 42 });
diagnostics.record("page-paint", {
  tabId: 42,
  source: "page",
  before: diagnostics.safeScheme({ kind: "custom", id: customUuid }),
  after: diagnostics.safeScheme({ kind: "built-in", id: "forest", extra: customUuid })
});
diagnostics.recordStorageChange({
  settings: {
    oldValue: { uiScheme: "cream", schemeRotate: "open", unrelated: "secret" },
    newValue: {
      uiScheme: `custom:${customUuid}`,
      schemeRotate: "daily",
      unrelated: "still-secret"
    }
  },
  settingsModifiedAt: { oldValue: 123, newValue: 456 },
  schemeRotationPrepared: {
    oldValue: { commitToken: "secret-token" },
    newValue: { commitToken: "another-secret-token" }
  },
  vaultMeta: {
    oldValue: {
      lastSyncAt: 111,
      ok: false,
      pulled: 1,
      pushed: 2,
      conflictCopies: 3,
      error: "private filesystem error"
    },
    newValue: {
      lastSyncAt: 222,
      ok: true,
      pulled: 4,
      pushed: 5,
      conflictCopies: 6,
      error: "must never leave the worker"
    }
  }
}, "local");

report = diagnostics.report(1, 4);
const storageEvent = report.trace.find(({ event }) => event === "storage-change");
const paintEvent = report.trace.find(({ event }) => event === "page-paint");
assert.deepEqual(structuredClone(paintEvent), {
  tabId: 42,
  source: "page",
  before: { kind: "custom" },
  after: { kind: "built-in", id: "forest" },
  at: 1_000,
  event: "page-paint"
}, "the worker records only masked boot and final paint identities");
assert.deepEqual(structuredClone(storageEvent.settings), {
  old: { uiScheme: { kind: "built-in", id: "cream" }, schemeRotate: "open" },
  new: { uiScheme: { kind: "custom" }, schemeRotate: "daily" }
});
assert.deepEqual(structuredClone(storageEvent.settingsModifiedAt), { old: 123, new: 456 });
assert.equal(storageEvent.preparedInChange, true);
assert.deepEqual(structuredClone(storageEvent.vaultMeta), {
  old: { lastSyncAt: 111, ok: false, pulled: 1, pushed: 2, conflicts: 3 },
  new: { lastSyncAt: 222, ok: true, pulled: 4, pushed: 5, conflicts: 6 }
});
const serialized = JSON.stringify(report);
for (const forbidden of [customUuid, "secret-token", "filesystem error", "still-secret"]) {
  assert.equal(serialized.includes(forbidden), false, `diagnostics redact ${forbidden}`);
}

const beforeRead = JSON.stringify(report.trace);
const readAgain = diagnostics.report(1, 4);
assert.equal(JSON.stringify(readAgain.trace), beforeRead, "read-only reports do not append trace events");
readAgain.trace[0].event = "tampered";
assert.notEqual(
  diagnostics.report(1, 4).trace[0].event,
  "tampered",
  "reports return a copy rather than exposing mutable worker state"
);

for (let index = 0; index < 30; index += 1) {
  diagnostics.record("bounded-event", { index });
}
report = diagnostics.report(0, 0);
assert.equal(report.trace.length, 24, "the in-memory trace never exceeds 24 events");
assert.equal(report.trace.at(-1).index, 29, "the ring retains the newest event");

now = 9_001;
diagnostics.record("after-expiry", {});
report = diagnostics.report(0, 0);
assert.equal(report.armed, false, "capture expires after the bounded arm window");
assert.equal(report.trace.some(({ event }) => event === "after-expiry"), false);

now = 10_000;
report = diagnostics.arm(0, 7);
assert.deepEqual(
  structuredClone(report.trace),
  [{ at: 1_000, event: "worker-start", version: "0.8.test" }],
  "re-arming clears prior operational events but keeps worker identity"
);

assert.match(source, /scheme-rotation-diagnostics-arm/);
assert.match(source, /scheme-rotation-diagnostics/);
assert.match(source, /scheme-rotation-diagnostics-page-paint/);
assert.match(source, /schemeRotationDiagnostics\.recordStorageChange\(changes, area\)/);
for (const event of [
  "readiness-received",
  "task-missing-tab",
  "task-coalesced",
  "task-already-handled",
  "task-start",
  "task-complete",
  "task-failure",
  "page-paint"
]) {
  assert.ok(source.includes(`"${event}"`), `background records ${event}`);
}
assert.match(
  source,
  /return \{ ok: true, result \};/,
  "the successful New Tab readiness response stays behavior-compatible"
);
assert.match(
  source,
  /return Promise\.resolve\(\{ ok: true, alreadyHandled: true \}\)/,
  "the already-handled response stays behavior-compatible"
);
assert.match(
  themeSource,
  /diagnosticsCapture = response\?\.diagnosticsCapture \?\? null/,
  "New Tab reuses its required readiness response to discover an armed capture"
);
assert.match(
  themeSource,
  /await apply\(\);\s*await reportNewTabDiagnosticPaint\(diagnosticsCapture\)/,
  "New Tab reports only after its authoritative final paint"
);

console.log("PASS: bounded, armed, privacy-safe New Tab rotation diagnostics");
