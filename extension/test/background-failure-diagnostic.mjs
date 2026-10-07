import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { classifyFailure, reportFailure } from "../js/lib/failure-diagnostic.js";

const warnings = [];
const warn = (...args) => warnings.push(args);
const secret = "Synthetic private page title https://private.example/account?token=secret";
const privateError = new Error(secret, { cause: { title: secret } });
privateError.stack = secret;
assert.equal(classifyFailure(privateError), "name:Error");
assert.equal(reportFailure("tab activity initialization", privateError, warn), undefined);
assert.deepEqual(warnings.pop(), ["EveryTab: tab activity initialization failed [name:Error]"]);

const authorityError = Object.assign(new Error(secret), {
  name: "TypeError", code: "storage-authority-not-initialized"
});
reportFailure("pending live-close recovery", authorityError, warn);
assert.deepEqual(warnings.pop(), [
  "EveryTab: pending live-close recovery failed [code:storage-authority-not-initialized]"
], "a stable allowlisted code takes precedence over the generic class");

for (const error of [
  { name: secret, code: secret, message: secret },
  secret, null, undefined, 42, Symbol(secret),
  { name: { toString() { throw Error(secret); } }, code: { toString() { throw Error(secret); } } },
  new Proxy({}, { get() { throw new Error(secret); } }),
  Proxy.revocable({}, {}).proxy
]) {
  reportFailure("runtime message", error, warn);
  assert.deepEqual(warnings.pop(), ["EveryTab: runtime message failed [name:UnknownError]"]);
}
const revoked = Proxy.revocable({}, {});
revoked.revoke();
assert.equal(classifyFailure(revoked.proxy), "name:UnknownError");

const readProperties = [];
const hostile = new Proxy({}, {
  get(_target, key) {
    readProperties.push(key);
    if (key === "name") return "NotAllowedError";
    throw new Error(secret);
  }
});
reportFailure("runtime message", hostile, warn);
assert.deepEqual(readProperties, ["code", "name"], "never inspect message, stack, cause or coercion hooks");
assert.deepEqual(warnings.pop(), ["EveryTab: runtime message failed [name:NotAllowedError]"]);

for (const label of [
  "Private customer planning", "operation\nhttps://private.example", secret,
  null, Symbol(secret), { toString() { throw Error(secret); } }
]) {
  reportFailure(label, privateError, warn);
  assert.deepEqual(warnings.pop(), ["EveryTab: operation failed [name:Error]"],
    "arbitrary plain titles are unsafe even when they contain only ordinary characters");
}
assert.doesNotThrow(() => reportFailure("runtime message", hostile, () => { throw Error(secret); }),
  "a broken sink must not replace the original recovery outcome");
const originalWarn = console.warn;
try {
  console.warn = warn;
  reportFailure("runtime message", privateError);
  assert.deepEqual(warnings.pop(), ["EveryTab: runtime message failed [name:Error]"]);
} finally { console.warn = originalWarn; }

const backgroundSource = await readFile(new URL("../js/background.js", import.meta.url), "utf8");
assert.match(backgroundSource, /import \{ reportFailure \}/);
for (const operation of [
  "tab activity initialization", "interrupted Undo recovery",
  "pending live-close recovery", "interrupted Snooze delivery recovery"
]) assert.ok(backgroundSource.includes(`reportFailure("${operation}"`));
assert.match(backgroundSource, /onError: \(error\) => reportFailure\("runtime message", error\)/,
  "runtime messages do not interpolate a sender-supplied type into logs");

async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    return entry.isDirectory() ? sources(url) : entry.name.endsWith(".js") ? [url] : [];
  }));
  return nested.flat();
}
for (const file of await sources(new URL("../js/", import.meta.url))) {
  const source = await readFile(file, "utf8");
  // Opt-in performance output has its own field/metadata privacy tests. All
  // ordinary failures use the shared boundary, including injected sink paths.
  if (file.pathname.endsWith("/lib/perf.js")) continue;
  assert.doesNotMatch(source, /console\.(?:warn|error|log|info|debug|table|trace)\s*\(/,
    `${file.pathname}: direct console calls bypass the shared diagnostic boundary`);
  assert.doesNotMatch(source, /\bwarn\s*\(\s*["`']EveryTab:/,
    `${file.pathname}: an injected warning sink must receive a sanitized string`);
  for (const match of source.matchAll(/(?:reportFailure|diagnosticReportFailure)\("([^"\n]+)"/g)) {
    reportFailure(match[1], undefined, warn);
    assert.deepEqual(warnings.pop(), [`EveryTab: ${match[1]} failed [name:UnknownError]`],
      `${file.pathname}: a new literal diagnostic label needs an allowlist entry`);
  }

}
console.log("PASS: shared diagnostics reject private payloads, arbitrary labels and hostile errors; runtime sinks use the boundary");
