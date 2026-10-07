// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import {
  lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listZipEntries, writeDeterministicZip } from "./zip-archive.mjs";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extension");
const PROJECT_ROOT = path.resolve(SOURCE_ROOT, "..");
const DEFAULT_OUTPUT_ROOT = path.resolve(PROJECT_ROOT, "dist");
const RUNTIME_DIRECTORIES = ["_locales", "css"];
const RUNTIME_FILES = [
  "dashboard.html", "focus.html", "manifest.json", "newtab.html", "options.html",
  "popup.html", "scheme-editor.html", "sidepanel.html", "suspend.html",
  "icon.png", "icon16.png", "icon24.png", "icon32.png", "icon48.png"
];
// Project-root notices copied into the package root so every shipped copy
// carries its license text. Chrome ignores files it does not reference.
const PROJECT_ROOT_FILES = ["LICENSE"];

/** Absolute source path of a packaged entry; root notices come from the project root. */
export function runtimeSourcePath(entry) {
  return path.join(PROJECT_ROOT_FILES.includes(entry) ? PROJECT_ROOT : SOURCE_ROOT, entry);
}

const toPosix = (value) => value.split(path.sep).join("/");

function walkFiles(root, relative = "") {
  const current = path.join(root, relative);
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name);
    const absolute = path.join(root, child);
    if (lstatSync(absolute).isSymbolicLink()) {
      throw new Error(`Runtime package cannot contain a symbolic link: ${toPosix(child)}`);
    }
    return entry.isDirectory() ? walkFiles(root, child) : [toPosix(child)];
  });
}

function referencedModules(file) {
  const source = readFileSync(path.join(SOURCE_ROOT, file), "utf8");
  const references = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s+(?:\{[\s\S]*?\}|\*\s*(?:as\s+\w+)?|\w+(?:\s*,\s*\{[\s\S]*?\})?)\s+from\s+["']([^"']+)["']\s*;/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']\s*;/g,
    /\b(?:await|void|return)\s+import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /=\s*import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /(?:^|\n)\s*import\s*\(\s*["']([^"']+)["']\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (!match[1].startsWith(".")) continue;
      const reference = localReference(file, match[1]);
      if (reference?.endsWith(".js")) references.push(reference);
    }
  }
  for (const match of source.matchAll(
    /chrome\.runtime\.getURL\(\s*["']([^"']+\.js)["']\s*\)/g
  )) {
    references.push(String(match[1]).replace(/^\/+/, ""));
  }
  return references;
}

function reachableModules() {
  const manifest = JSON.parse(readFileSync(path.join(SOURCE_ROOT, "manifest.json"), "utf8"));
  const pending = [manifest.background?.service_worker].filter(Boolean);
  for (const file of RUNTIME_FILES.filter((entry) => entry.endsWith(".html"))) {
    const source = readFileSync(path.join(SOURCE_ROOT, file), "utf8");
    for (const match of source.matchAll(/\bsrc=["']([^"']+\.js)["']/g)) {
      const reference = localReference(file, match[1]);
      if (reference) pending.push(reference);
    }
  }

  const reached = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (!file || reached.has(file)) continue;
    if (!path.resolve(SOURCE_ROOT, file).startsWith(`${SOURCE_ROOT}${path.sep}`)) {
      throw new Error(`Module escapes the runtime root: ${file}`);
    }
    if (!statSync(runtimeSourcePath(file)).isFile()) {
      throw new Error(`Referenced runtime module is missing: ${file}`);
    }
    reached.add(file);
    pending.push(...referencedModules(file));
  }
  return [...reached];
}

function runtimeEntries() {
  const files = [...RUNTIME_FILES, ...PROJECT_ROOT_FILES];
  for (const directory of RUNTIME_DIRECTORIES) files.push(...walkFiles(SOURCE_ROOT, directory));
  files.push(...reachableModules());
  return [...new Set(files)].sort();
}

function localReference(fromFile, target) {
  if (!target || /^(?:[a-z]+:|#|\/\/)/i.test(target)) return null;
  const clean = target.split(/[?#]/, 1)[0];
  return toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), clean)));
}

function assertReferences(entries) {
  const available = new Set(entries);
  // Chrome exposes this permission-backed endpoint under the extension origin;
  // it is not a file that belongs in the package.
  const browserProvidedPaths = new Set(["_favicon/"]);
  const missing = [];
  const expect = (from, target) => {
    const resolved = localReference(from, target);
    if (resolved && !available.has(resolved)) missing.push(`${from} -> ${resolved}`);
  };
  const expectRoot = (from, target) => {
    const resolved = String(target ?? "").split(/[?#]/, 1)[0].replace(/^\/+/, "");
    if (resolved && !browserProvidedPaths.has(resolved) && !available.has(resolved)) {
      missing.push(`${from} -> ${resolved}`);
    }
  };

  for (const file of entries.filter((entry) => entry.endsWith(".html"))) {
    const source = readFileSync(path.join(SOURCE_ROOT, file), "utf8");
    for (const match of source.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) expect(file, match[1]);
    if (/<script[^>]+src=["']https?:\/\//i.test(source)) {
      throw new Error(`Remote script found in ${file}`);
    }
  }

  for (const file of entries.filter((entry) => entry.endsWith(".js"))) {
    const source = readFileSync(path.join(SOURCE_ROOT, file), "utf8");
    const imports = [
      /(?:^|\n)\s*(?:import|export)\s+(?:\{[\s\S]*?\}|\*\s*(?:as\s+\w+)?|\w+(?:\s*,\s*\{[\s\S]*?\})?)\s+from\s+["']([^"']+)["']\s*;/g,
      /(?:^|\n)\s*import\s*["']([^"']+)["']\s*;/g,
      /\b(?:await|void|return)\s+import\s*\(\s*["']([^"']+)["']\s*\)/g,
      /=\s*import\s*\(\s*["']([^"']+)["']\s*\)/g,
      /(?:^|\n)\s*import\s*\(\s*["']([^"']+)["']\s*\)/g
    ];
    for (const pattern of imports) {
      for (const match of source.matchAll(pattern)) expect(file, match[1]);
    }
    for (const match of source.matchAll(/chrome\.runtime\.getURL\(\s*["']([^"']+)["']\s*\)/g)) {
      expectRoot(file, match[1]);
    }
    if (/\b(?:eval\s*\(|new\s+Function\s*\()/u.test(source)) {
      throw new Error(`Dynamic code execution found in ${file}`);
    }
    if (/\bimport\s*\(\s*["']https?:\/\//iu.test(source)) {
      throw new Error(`Remote module import found in ${file}`);
    }
  }

  for (const file of entries.filter((entry) => entry.endsWith(".css"))) {
    const source = readFileSync(path.join(SOURCE_ROOT, file), "utf8");
    for (const match of source.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) expect(file, match[1]);
  }

  const manifest = JSON.parse(readFileSync(path.join(SOURCE_ROOT, "manifest.json"), "utf8"));
  const manifestPaths = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_page,
    manifest.side_panel?.default_path,
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    ...Object.values(manifest.chrome_url_overrides ?? {})
  ];
  for (const target of manifestPaths) expect("manifest.json", target);

  if (missing.length) throw new Error(`Missing packaged runtime references:\n${missing.join("\n")}`);
  return manifest;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function buildCwsPackage({ outputRoot = DEFAULT_OUTPUT_ROOT } = {}) {
  const entries = runtimeEntries();
  const manifest = assertReferences(entries);
  const version = String(manifest.version ?? "").trim();
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error("Manifest version is invalid");

  mkdirSync(outputRoot, { recursive: true });
  const archiveName = `everytab-${version}.zip`;
  const archivePath = path.join(outputRoot, archiveName);
  const receiptPath = path.join(outputRoot, `everytab-${version}-package.json`);
  for (const entry of PROJECT_ROOT_FILES) {
    if (!statSync(runtimeSourcePath(entry)).isFile()) throw new Error(`Package notice is missing: ${entry}`);
  }
  writeDeterministicZip(archivePath, entries.map((entry) => ({
    name: entry,
    data: readFileSync(runtimeSourcePath(entry))
  })));

  const archivedEntries = listZipEntries(archivePath).sort();
  if (JSON.stringify(archivedEntries) !== JSON.stringify(entries)) {
    throw new Error("Archive inventory differs from the verified runtime allowlist");
  }
  if (!archivedEntries.includes("_locales/en/messages.json") || !archivedEntries.includes("manifest.json") ||
    !PROJECT_ROOT_FILES.every((entry) => archivedEntries.includes(entry))) {
    throw new Error("The archive does not place manifest.json and its notices at its root");
  }
  if (archivedEntries.some((entry) => /(^|\/)(?:test|tools|\.impeccable)(?:\/|$)/.test(entry) ||
    entry === "package.json" || entry === "README.md" || entry.endsWith(".DS_Store"))) {
    throw new Error("The archive contains a development-only file");
  }

  const uncompressedBytes = entries.reduce((total, entry) =>
    total + statSync(runtimeSourcePath(entry)).size, 0);
  const receipt = {
    app: "everytab",
    kind: "chrome-web-store-package",
    formatVersion: 1,
    version,
    archive: archiveName,
    sha256: sha256(archivePath),
    byteLength: statSync(archivePath).size,
    uncompressedBytes,
    fileCount: entries.length,
    manifestAtRoot: true,
    developmentFilesExcluded: true,
    referencesVerified: true,
    entries
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return { archivePath, receiptPath, receipt };
}

const isDirectRun = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  const outputArgIndex = process.argv.indexOf("--output-dir");
  const outputRoot = outputArgIndex >= 0
    ? path.resolve(process.cwd(), process.argv[outputArgIndex + 1] ?? "")
    : DEFAULT_OUTPUT_ROOT;
  const { archivePath, receiptPath, receipt } = buildCwsPackage({ outputRoot });
  console.log(`PASS: ${receipt.fileCount} runtime files packaged for EveryTab ${receipt.version}`);
  console.log(`ZIP: ${archivePath}`);
  console.log(`SHA-256: ${receipt.sha256}`);
  console.log(`Receipt: ${receiptPath}`);
}
