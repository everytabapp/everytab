// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Allow/deny decisions and the sensitive-content guard of the public exporter, plus a dry plan of this tree. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DENY_PATTERNS, PUBLIC_INVENTORY_OVERRIDES, PUBLIC_ROOT_FILES, filterInventory, findSensitive, isPublicPath,
  listPublicFiles, planExport, verifyExport } from "../export-public-repo.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("allowlisted roots and files are public", () => {
  for (const file of ["LICENSE", "README.md", "CONTRIBUTING.md", "SECURITY.md", "TRADEMARKS.md", "CODE_OF_CONDUCT.md",
    ".gitattributes", ".gitignore", ".nvmrc", "test-inventory.json", "CODEBASE-ATLAS.json", "docs/launch/open-source-license-research.md",
    "extension/manifest.json", "extension/js/background.js", "extension/test/smoke.mjs", "extension/_locales/fr/messages.json",
    "tools/test.mjs", "tools/testing/inventory.mjs", "tools/codebase/source-graph.mjs", "tools/package-cws.mjs",
    "tools/capture-store-screenshots.mjs", "tools/check-data-import.mjs", "tools/measure-native-storage.mjs",
    "tools/perf-seed.mjs", "tools/pseudo-locale.mjs", "tools/export-public-repo.mjs",
    ".github/workflows/extension-cross-platform.yml", ".github/ISSUE_TEMPLATE/bug_report.md",
    "site/privacy.md", "docs/localization/fr-glossary.md"]) {
    assert.equal(isPublicPath(file), true, file);
  }
});

test("private planning, evidence, media, personal data and campaign tools stay private", () => {
  for (const file of ["handoff-prompt.md", "backlog.md", "CLAUDE.md", "AGENTS.md", "skills-lock.json", "extension.zip",
    "perfect-street-fighter-sound-effect.mp3", "archive/README.md", "review-evidence/x/README.md", "dist/everytab-1.zip",
    "campaign-assets/logo.svg", "design/ui-proposals.html", "docs/launch/campaign-2026-09/index.html",
    "docs/launch/assets/store-beta/README.md", "docs/launch/store-listing.md", "docs/prototypes/open-tab-groups/a.md",
    "plans/001.md", "perf-seed/everytab-perf-t2.json", "screenshots/a.png", "EveryTab V2 speed test/library.json",
    ".recovery-backups/a/b", ".claude/settings.local.json", ".agents/skills/x", ".codex/hooks.json", ".impeccable/a",
    "extension/.impeccable/hook.cache.json", "extension/.DS_Store", "extension/js/.DS_Store", ".DS_Store",
    "tools/production/elevenlabs.mjs", "tools/production/credential-input.test.mjs", "tools/build-campaign-gallery.mjs",
    "tools/build-video-proposals.py", "tools/capture-marketing-details.mjs", "tools/capture-store-overview-20260929.mjs",
    "tools/render-launch-campaign.mjs", "tools/render-store-overview-20260929.mjs", "tools/verify-launch-campaign.mjs",
    "tools/store-beta-upload-wizard.sh", "tools/store-beta-dashboard-wizard.sh", "tools/minimal-personalization-prototype.js",
    "extension/test/fixture.mp4", "site/clip.wav", "tools/node_modules/x/index.js", ".env", "tools/.env.local",
    ".git/config", "unknown-root-file.md", "docs/other.md", "", "/LICENSE", "extension/../LICENSE", "extension\\js\\a.js"]) {
    assert.equal(isPublicPath(file), false, file);
  }
  assert.ok(DENY_PATTERNS.length > 20);
});

test("sensitive guard flags personal data and allows the project contact and fixtures", () => {
  const kinds = (text) => findSensitive(text, "f").map((hit) => hit.kind);
  assert.deepEqual(kinds("contact everytabapp@gmail.com"), []);
  assert.deepEqual(kinds("https://user:pass@example.com/ and bob@sub.example.org and x@fixture.invalid"), []);
  assert.deepEqual(kinds('url: "file:///Users/example/notes.html"'), []);
  // Samples are assembled from fragments so this file never contains what the guard hunts.
  assert.deepEqual(kinds("mail someone@" + "gmail.com"), ["email"]);
  assert.deepEqual(kinds("const root = '/Use" + "rs/someone/project';"), ["home path"]);
  assert.deepEqual(kinds("~/Library/Mobile " + "Documents/com~apple~CloudDocs"), ["local tool path"]);
  assert.deepEqual(kinds(`token ghp_${"a".repeat(36)}`), ["api key shape"]);
  assert.deepEqual(kinds(`key AIza${"b".repeat(35)} and -----BEGIN RSA ${"PRIVATE"} KEY-----`), ["api key shape", "api key shape"]);
  assert.deepEqual(kinds(`header xi-api-${"key"}`), ["api key shape"]);
  assert.deepEqual(kinds("nothing here"), []);
});

test("the public inventory reclassifies suites whose fixture is not published", () => {
  const inventory = { schemaVersion: 1, nodeVersion: 22, entries: [
    { path: "extension/test/upgrade-from-0.8.632.mjs", kind: "suite", lane: "portable", cwd: "extension",
      ciPlatforms: ["linux"], reason: "needs dist/everytab-0.8.632.zip" }
  ] };
  const [entry] = filterInventory(inventory, ["extension/test/upgrade-from-0.8.632.mjs"]).entries;
  assert.equal(entry.kind, "manual");
  assert.equal(entry.lane, undefined);
  assert.equal(entry.cwd, undefined);
  assert.equal(entry.ciPlatforms, undefined);
  assert.match(entry.reason, /dist\//);
  assert.deepEqual(Object.keys(PUBLIC_INVENTORY_OVERRIDES), ["extension/test/upgrade-from-0.8.632.mjs"]);
});

test("inventory filtering drops private entries and prunes their ownership", () => {
  const inventory = { schemaVersion: 1, nodeVersion: 22, entries: [
    { path: "extension/test/a.mjs", kind: "suite" },
    { path: "tools/production/x.mjs", kind: "utility" },
    { path: "extension/test/helper.mjs", kind: "helper", owners: ["extension/test/a.mjs", "tools/production/x.mjs"] },
    { path: "tools/testing/lonely.mjs", kind: "helper", owners: ["tools/production/x.mjs"] }
  ] };
  const kept = filterInventory(inventory, ["extension/test/a.mjs", "extension/test/helper.mjs"]);
  assert.deepEqual(kept.entries.map((entry) => entry.path), ["extension/test/a.mjs", "extension/test/helper.mjs"]);
  assert.deepEqual(kept.entries[1].owners, ["extension/test/a.mjs"]);
  assert.equal(inventory.entries[2].owners.length, 2, "input is not mutated");
  assert.throws(() => filterInventory(inventory, ["extension/test/a.mjs", "extension/test/helper.mjs", "tools/testing/lonely.mjs"]),
    /lose every owner/);
});

test("the public plan of this tree is clean and self-contained", () => {
  const files = listPublicFiles(root);
  for (const file of PUBLIC_ROOT_FILES) assert.ok(files.includes(file), file);
  assert.ok(files.includes("extension/manifest.json"));
  assert.ok(files.includes("tools/test.mjs"));
  assert.ok(files.every((file) => isPublicPath(file)));
  assert.ok(!files.some((file) => file.startsWith("tools/production/") || file.endsWith(".DS_Store")));
  const plan = planExport(root);
  assert.equal(plan.files.length, plan.manifest.length);
  assert.ok(plan.manifest.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256)));
  const paths = new Set(plan.inventory.entries.map((entry) => entry.path));
  for (const file of files.filter((file) => file.startsWith("extension/test/") || file.startsWith("tools/"))) {
    assert.ok(paths.has(file), `exported file keeps its inventory decision: ${file}`);
  }
  for (const file of paths) assert.ok(files.includes(file), `inventory entry points at an exported file: ${file}`);
});

test("output verification rejects a stray denied path and a leaked address", () => {
  const target = mkdtempSync(path.join(tmpdir(), "everytab-export-verify-"));
  try {
    mkdirSync(path.join(target, "extension"), { recursive: true });
    writeFileSync(path.join(target, "LICENSE"), "Mozilla Public License Version 2.0\n");
    writeFileSync(path.join(target, "extension/manifest.json"), "{}\n");
    const clean = verifyExport(target);
    assert.equal(clean.fileCount, 2);
    assert.equal(clean.largest[0].path, "LICENSE");
    writeFileSync(path.join(target, "extension/.DS_Store"), "x");
    assert.throws(() => verifyExport(target), /Denied or unlisted paths/);
    rmSync(path.join(target, "extension/.DS_Store"));
    writeFileSync(path.join(target, "extension/manifest.json"), '{"author":"someone@' + 'gmail.com"}\n');
    assert.throws(() => verifyExport(target), /Sensitive content in the output/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
  assert.equal(existsSync(target), false);
});
