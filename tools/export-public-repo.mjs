// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Build the curated public source tree from an explicit allowlist and denylist.
 *
 * The workspace holds private planning, evidence, media and personal data next
 * to the product. Publication is one-way: this tool copies only the listed
 * roots, filters the test inventory to the copied files, regenerates the
 * CODEBASE-* learning files for the exported tree, and refuses to finish when
 * any denied path or sensitive pattern reaches the output.
 *
 *   node tools/export-public-repo.mjs --out <dir> [--replace] [--manifest <file>]
 *   node tools/export-public-repo.mjs --dry-run
 *
 * `--replace` empties a non-empty target first but always keeps its `.git`.
 * Nothing in the workspace is written.
 */
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OUTPUTS as GENERATED_ROOT_FILES, buildGuide } from "./build-codebase-guide.mjs";

export const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Root files copied byte for byte. Every one of them must exist. */
export const PUBLIC_ROOT_FILES = [
  "LICENSE", "README.md", "ARCHITECTURE.md", "ENGINEERING.md", "TESTING.md", "PRODUCT.md",
  "DESIGN.md", "CONTEXT.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "TRADEMARKS.md",
  "CODE_OF_CONDUCT.md", ".gitattributes", ".gitignore", ".nvmrc", "test-inventory.json",
  "docs/launch/open-source-license-research.md"
];
/** Directories walked recursively; the denylist filters inside them. */
export const PUBLIC_DIRECTORIES = ["extension", "tools", ".github", "site", "docs/localization"];
/** Campaign, Store-operations and prototype tools that depend on paid services, personal accounts or carry personal copy. */
export const PRIVATE_TOOLS = [
  "build-campaign-gallery.mjs", "build-video-proposals.py", "capture-marketing-details.mjs",
  "capture-store-overview-20260929.mjs", "render-launch-campaign.mjs", "render-store-overview-20260929.mjs",
  "verify-launch-campaign.mjs", "store-beta-dashboard-wizard.sh", "store-beta-upload-wizard.sh",
  "minimal-personalization-prototype.css", "minimal-personalization-prototype.html",
  "minimal-personalization-prototype.js"
];
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const DENY_PATTERNS = [
  /(^|\/)\.DS_Store$/, /(^|\/)\.impeccable(\/|$)/, /(^|\/)node_modules(\/|$)/, /(^|\/)__pycache__(\/|$)/,
  /(^|\/)\.git(\/|$)/, /(^|\/)\.env(\.[^/]*)?$/,
  /^archive\//, /^review-evidence\//, /^dist\//, /^campaign-assets\//, /^design\//,
  /^docs\/launch\/campaign-2026-09\//, /^docs\/launch\/assets\//, /^docs\/prototypes\//, /^plans\//,
  /^perf-seed\//, /^screenshots\//, /^EveryTab V2 speed test\//, /^\.recovery-backups\//,
  /^\.claude\//, /^\.agents\//, /^\.codex\//, /^\.impeccable\//,
  /^(handoff-prompt|backlog|CLAUDE|AGENTS)\.md$/, /^skills-lock\.json$/, /^extension\.zip$/, /^:memory:\.ses$/,
  /\.(mp3|wav|mp4|mov|m4a|aiff|flac|webm|zip)$/i,
  /^tools\/production\//,
  new RegExp(`^tools/(${PRIVATE_TOOLS.map(escape).join("|")})$`)
];
/** Addresses on reserved documentation domains are synthetic fixtures. */
const join = (...parts) => parts.join("");
const FIXTURE_EMAIL = /@(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|example|invalid|test|localhost)$/i;
export const SENSITIVE_PATTERNS = [
  { name: "email", regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    allowed: (match) => match === "everytabapp@gmail.com" || FIXTURE_EMAIL.test(match) },
  { name: "home path", regex: /\/Users\/[^\s"'`)\]]*/g, allowed: (match) => match.startsWith("/Users/example/") },
  // Tokens are assembled from fragments so this file never contains the literal it hunts.
  { name: "personal identifier", regex: new RegExp(join("hdr", "ngls") + "|" + join("hadrien", "gelas"), "gi"), allowed: () => false },
  { name: "local tool path", regex: new RegExp(join("/private/tmp/", "claude-") + "|" + join("Mobile ", "Documents") + "|" + join("/Volu", "mes/"), "g"), allowed: () => false },
  { name: "api key shape", regex: new RegExp("\\b(?:sk-[A-Za-z0-9]{20,}|sk_(?:live|test)_[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|" + join("xi-api", "-key"), "g"),
    allowed: () => false }
];

const toPosix = (value) => value.split(path.sep).join("/");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Allowlist first, then denylist; anything else stays private. */
export function isPublicPath(relative) {
  if (typeof relative !== "string" || !relative || relative.startsWith("/") || relative.includes("\\") ||
      relative.split("/").some((part) => part === "" || part === "." || part === "..")) return false;
  if (DENY_PATTERNS.some((pattern) => pattern.test(relative))) return false;
  if (PUBLIC_ROOT_FILES.includes(relative) || GENERATED_ROOT_FILES.includes(relative)) return true;
  return PUBLIC_DIRECTORIES.some((directory) => relative.startsWith(`${directory}/`));
}

/** Every match of a sensitive pattern that is not an allowed exception. */
export function findSensitive(text, file) {
  const hits = [];
  for (const { name, regex, allowed } of SENSITIVE_PATTERNS) {
    for (const match of text.matchAll(regex)) {
      if (!allowed(match[0])) hits.push({ file, kind: name, match: match[0].slice(0, 80) });
    }
  }
  return hits;
}

function walk(root, relative, visit) {
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (lstatSync(path.join(root, child)).isSymbolicLink()) throw new Error(`Refusing symbolic link: ${child}`);
    if (entry.isDirectory()) walk(root, child, visit);
    else visit(child);
  }
}

/** Collect the public file set from a workspace without writing anything. */
export function listPublicFiles(root = WORKSPACE_ROOT) {
  const files = [];
  for (const directory of PUBLIC_DIRECTORIES) {
    let stat = null;
    try { stat = lstatSync(path.join(root, directory)); } catch { continue; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Public directory is not a real directory: ${directory}`);
    walk(root, directory, (file) => { if (isPublicPath(file)) files.push(file); });
  }
  for (const file of PUBLIC_ROOT_FILES) {
    let stat = null;
    try { stat = lstatSync(path.join(root, file)); } catch { throw new Error(`Required public file is missing: ${file}`); }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Required public file is not a regular file: ${file}`);
    files.push(file);
  }
  return [...new Set(files)].sort();
}

/**
 * Suites whose fixture stays private are published as explicit manual work, not
 * silently dropped. Execution fields are removed so the runner never selects them.
 */
export const PUBLIC_INVENTORY_OVERRIDES = {
  "extension/test/upgrade-from-0.8.632.mjs": { kind: "manual",
    reason: "Upgrade evidence against the archived 0.8.632 Store package. The package lives under dist/ in the maintainer workspace and is not published; run it there with node tools/test.mjs upgrade-from-0.8.632.mjs." }
};
const EXECUTION_FIELDS = ["id", "lane", "cwd", "nodeArgs", "args", "env", "platforms", "ciPlatforms", "timeoutMs", "variants"];

/** Keep only entries and owners that exist in the exported tree. */
export function filterInventory(inventory, files) {
  const exported = new Set(files);
  const entries = [];
  for (const entry of inventory.entries) {
    if (!exported.has(entry.path)) continue;
    let copy = { ...entry };
    if (PUBLIC_INVENTORY_OVERRIDES[entry.path]) {
      for (const field of EXECUTION_FIELDS) delete copy[field];
      copy = { ...copy, ...PUBLIC_INVENTORY_OVERRIDES[entry.path] };
    }
    if (Array.isArray(copy.owners)) {
      copy.owners = copy.owners.filter((owner) => exported.has(owner));
      if (copy.owners.length === 0) throw new Error(`Exported support file would lose every owner: ${entry.path}`);
    }
    entries.push(copy);
  }
  return { ...inventory, entries };
}

/** Read, scan and hash the public set; throws before any write when a pattern matches. */
export function planExport(root = WORKSPACE_ROOT) {
  const files = listPublicFiles(root);
  const hits = [];
  const manifest = files.map((file) => {
    const bytes = readFileSync(path.join(root, file));
    hits.push(...findSensitive(bytes.toString("latin1"), file));
    return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const inventory = filterInventory(JSON.parse(readFileSync(path.join(root, "test-inventory.json"), "utf8")), files);
  if (hits.length) throw new Error(`Sensitive content in the public set:\n${hits.map((hit) => `${hit.file}: ${hit.kind} ${hit.match}`).join("\n")}`);
  return { files, manifest, inventory };
}

function emptyTarget(target) {
  for (const name of readdirSync(target)) {
    if (name === ".git") continue;
    rmSync(path.join(target, name), { recursive: true, force: true });
  }
}

/** Copy, filter, regenerate, then verify the written tree from scratch. */
export async function exportPublicRepo({ root = WORKSPACE_ROOT, target, replace = false }) {
  if (!target) throw new Error("Choose an output directory with --out");
  target = path.resolve(target);
  if (target === root || root.startsWith(`${target}${path.sep}`) || target.startsWith(`${root}${path.sep}`)) {
    throw new Error("The output directory must be outside the workspace");
  }
  const plan = planExport(root);
  let existing = [];
  try { existing = readdirSync(target).filter((name) => name !== ".git"); } catch { mkdirSync(target, { recursive: true }); }
  if (existing.length) {
    if (!replace) throw new Error(`Output directory is not empty (use --replace): ${target}`);
    emptyTarget(target);
  }
  for (const file of plan.files) {
    const destination = path.join(target, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    if (file === "test-inventory.json") writeFileSync(destination, `${JSON.stringify(plan.inventory, null, 2)}\n`);
    else copyFileSync(path.join(root, file), destination);
  }
  const { outputs } = await buildGuide(target);
  for (const [file, text] of Object.entries(outputs)) writeFileSync(path.join(target, file), text);
  return verifyExport(target);
}

/** Independent walk of the written tree: allowlist, denylist, sensitive scan and manifest. */
export function verifyExport(target) {
  const manifest = [];
  const problems = [];
  const hits = [];
  walk(target, "", (file) => {
    if (file === ".git" || file.startsWith(".git/")) return;
    if (!isPublicPath(file)) problems.push(file);
    const bytes = readFileSync(path.join(target, file));
    hits.push(...findSensitive(bytes.toString("latin1"), file));
    manifest.push({ path: file, bytes: bytes.length, sha256: sha256(bytes) });
  });
  if (problems.length) throw new Error(`Denied or unlisted paths in the output:\n${problems.join("\n")}`);
  if (hits.length) throw new Error(`Sensitive content in the output:\n${hits.map((hit) => `${hit.file}: ${hit.kind} ${hit.match}`).join("\n")}`);
  manifest.sort((a, b) => a.path.localeCompare(b.path));
  const totalBytes = manifest.reduce((sum, entry) => sum + entry.bytes, 0);
  const largest = [...manifest].sort((a, b) => b.bytes - a.bytes).slice(0, 15).map(({ path, bytes }) => ({ path, bytes }));
  return { target, fileCount: manifest.length, totalBytes, largest, manifest };
}

function parseArguments(args) {
  const options = { out: null, replace: false, manifest: null, dryRun: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--out") options.out = args[++index];
    else if (arg === "--manifest") options.manifest = args[++index];
    else if (arg === "--replace") options.replace = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.dryRun && !options.out) throw new Error("Use --out <dir> or --dry-run");
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.dryRun) {
      const plan = planExport();
      for (const entry of plan.manifest) console.log(`${entry.path}\t${entry.bytes}\t${entry.sha256}`);
      console.log(JSON.stringify({ dryRun: true, fileCount: plan.files.length,
        totalBytes: plan.manifest.reduce((sum, entry) => sum + entry.bytes, 0),
        inventoryEntries: plan.inventory.entries.length }, null, 2));
    } else {
      const result = await exportPublicRepo({ target: options.out, replace: options.replace });
      for (const entry of result.manifest) console.log(`${entry.path}\t${entry.bytes}\t${entry.sha256}`);
      if (options.manifest) writeFileSync(path.resolve(options.manifest), `${JSON.stringify(result, null, 2)}\n`);
      console.log(JSON.stringify({ target: result.target, fileCount: result.fileCount,
        totalBytes: result.totalBytes, largest: result.largest }, null, 2));
    }
  } catch (error) { console.error(`FAIL ${error.message}`); process.exitCode = 1; }
}
