import assert from "node:assert/strict";

delete globalThis.chrome;
const runtime = await import(`../js/lib/storage/authority-runtime.js?prewarm=${Date.now()}`);

const expected = new Error("Storage authority is not initialized");
expected.code = "storage-authority-not-initialized";
const expectedReports = [];
assert.deepEqual(await runtime.startAuthorityPrewarm({
  readAuthority: async () => { throw expected; },
  reportFailure: (error) => expectedReports.push(error)
}), { status: "not-initialized" },
"an authority absent before first installation is an explicit quiet state");
assert.deepEqual(expectedReports, [],
  "the expected pre-install state does not produce a warning");

const storageFailure = new Error("IndexedDB could not open");
const unexpectedReports = [];
assert.deepEqual(await runtime.startAuthorityPrewarm({
  readAuthority: async () => { throw storageFailure; },
  reportFailure: (error) => unexpectedReports.push(error)
}), { status: "failed", error: storageFailure },
"an unexpected storage failure remains owned by the prewarm result");
assert.deepEqual(unexpectedReports, [storageFailure],
  "an unexpected prewarm failure reaches the named diagnostic path");

const privateFailure = new Error("https://private.example/?secret=page-title");
privateFailure.name = "NotReadableError";
const diagnostics = [];
const originalWarn = console.warn;
try {
  console.warn = (...args) => diagnostics.push(args);
  assert.deepEqual(await runtime.startAuthorityPrewarm({
    readAuthority: async () => { throw privateFailure; }
  }), { status: "failed", error: privateFailure },
  "the caller retains the original failure while the default logger gets only its class");
} finally {
  console.warn = originalWarn;
}
assert.deepEqual(diagnostics, [
  ["EveryTab: storage-authority-prewarm failed [name:NotReadableError]"]
], "default prewarm diagnostics contain neither message, stack nor extra error arguments");

const authority = { runId: "ready" };
assert.deepEqual(await runtime.startAuthorityPrewarm({
  readAuthority: async () => authority,
  reportFailure: assert.fail
}), { status: "ready", authority },
"a successful prewarm returns the authority it loaded");

console.log("PASS: authority prewarm classifies expected absence and reports real failures");
