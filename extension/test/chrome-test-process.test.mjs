import assert from "node:assert/strict";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasDomTestReceipt,
  runOwnedChrome,
  spawnOwnedChrome,
  terminateOwnedChrome
} from "./chrome-test-process.mjs";

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitUntilGone(pid) {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(isAlive(pid), false, `process ${pid} survived owned-tree teardown`);
}

const stubbornTree = String.raw`
  const { spawn } = require("node:child_process");
  const leaf = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
    stdio: "ignore"
  });
  process.stdout.write(JSON.stringify({ root: process.pid, leaf: leaf.pid }) + "\n");
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
`;

const child = spawnOwnedChrome(process.execPath, ["-e", stubbornTree], {
  stdio: ["ignore", "pipe", "pipe"]
});
const [chunk] = await once(child.stdout, "data");
const pids = JSON.parse(String(chunk).trim());
assert.equal(isAlive(pids.root), true);
assert.equal(isAlive(pids.leaf), true);

await terminateOwnedChrome(child, { graceMs: 50, forceMs: 1_000 });
await Promise.all([waitUntilGone(pids.root), waitUntilGone(pids.leaf)]);

console.log("PASS: owned Chrome teardown removes a TERM-resistant process tree");

let timeoutError;
try {
  await runOwnedChrome(process.execPath, ["-e", stubbornTree], { timeoutMs: 50 });
} catch (error) {
  timeoutError = error;
}
assert.match(timeoutError?.message ?? "", /timed out/);
const timedPids = JSON.parse(timeoutError.stdout.trim());
await Promise.all([waitUntilGone(timedPids.root), waitUntilGone(timedPids.leaf)]);

console.log("PASS: timed Chrome fixtures remove their complete process tree");

const receiptTree = String.raw`
  process.stdout.write('<pre id="result" data-status="pass">PASS</pre>');
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
`;
const receiptResult = await runOwnedChrome(process.execPath, ["-e", receiptTree], {
  timeoutMs: 1_000,
  completeWhen: hasDomTestReceipt
});
assert.match(receiptResult.stdout, /data-status="pass"/);

console.log("PASS: explicit DOM receipts finish a fixture before a stuck browser teardown");

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const browserSources = (await readdir(testRoot))
  .filter((name) => name.endsWith(".mjs") && name !== "chrome-test-process.mjs")
  .map((name) => path.join(testRoot, name));
// The scheme QA capture script lives in the private workspace, not in the
// public repository; scan it only where it exists.
const privateCapture = path.resolve(testRoot, "../../campaign-assets/capture-p11-scheme-qa.mjs");
const { access } = await import("node:fs/promises");
if (await access(privateCapture).then(() => true, () => false)) browserSources.push(privateCapture);
const directLaunchers = [];
for (const source of browserSources) {
  const text = await readFile(source, "utf8");
  if (/from ["']node:child_process["']/.test(text) && /\b(?:spawn|execFile)\b/.test(text)) {
    directLaunchers.push(path.relative(path.resolve(testRoot, ".."), source));
  }
}
assert.deepEqual(directLaunchers, [], "Chrome fixtures must use the owned-process helper");

console.log("PASS: every repository Chrome fixture uses the owned-process boundary");
