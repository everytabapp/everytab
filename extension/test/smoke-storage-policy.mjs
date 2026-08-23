import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SANCTIONED_STORAGE_WRITERS = new Set([
  "js/lib/store.js",
  "js/lib/journal.js",
  "js/lib/counters.js",
  "js/lib/label-meta.js",
  "js/vault/sync.js",
  "js/lib/focus-guard.js",
  "js/lib/focus-retirement.js",
  "js/lib/suspend.js",
  "js/lib/actions.js",
  "js/lib/export.js",
  "js/ui/onboarding.js",
  "js/ui/dashboard.js"
]);

function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(file);
    return entry.name.endsWith(".js") ? [file] : [];
  });
}

/** Enforce the storage write-ownership boundary from ENGINEERING.md. */
export function runSmokeStoragePolicy(check) {
  const jsRoot = fileURLToPath(new URL("../js/", import.meta.url));
  const relative = (file) =>
    "js/" + path.relative(jsRoot, file).split(path.sep).join("/");
  const writers = javascriptFiles(jsRoot)
    .filter((file) => fs.readFileSync(file, "utf8").includes("chrome.storage.local.set"))
    .map(relative);
  const violations = writers.filter((file) => !SANCTIONED_STORAGE_WRITERS.has(file));
  for (const violation of violations) {
    console.log(`  GUARDRAIL VIOLATION: unsanctioned chrome.storage.local.set in ${violation}`);
  }
  check(
    writers.includes("js/lib/store.js") && writers.includes("js/vault/sync.js"),
    "E2-0 §5.4 guardrail scanner finds the known core writers"
  );
  check(
    violations.length === 0,
    `E2-0 §5.4 guardrail (ENFORCING): every chrome.storage.local.set is in a sanctioned module — ${violations.length} violation(s)`
  );
  check(
    !writers.includes("js/lib/sessions.js") && !writers.includes("js/lib/smartviews.js"),
    "E2-0e: sessions.js + smartviews.js hold no raw chrome.storage.local.set (bindings/seed route through mutateStores)"
  );
}
