// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Shared test catalogue validation and execution planning; never launches a test. */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const INVENTORY_ROOTS = ["extension/test", "tools"];
export const PLATFORMS = ["linux", "darwin", "win32"];
export const LANES = ["portable", "performance", "browser", "package"];
const KINDS = ["suite", "helper", "fixture", "manual", "utility", "documentation"];
const EXECUTION_FIELDS = ["id", "lane", "cwd", "nodeArgs", "args", "env", "platforms", "ciPlatforms", "timeoutMs"];
const ENTRY_FIELDS = new Set(["path", "kind", "reason", "owners", "variants", ...EXECUTION_FIELDS]);
// Extend deliberately when a suite needs another runtime flag. Arbitrary Node
// flags can print help or compile only, reporting success without running tests.
const NODE_FLAGS = new Set(["--expose-gc", "--experimental-vm-modules"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && Boolean(value.trim()) && !value.includes("\0");
const inventoryPath = (value) => text(value) &&
  INVENTORY_ROOTS.some((root) => value.startsWith(`${root}/`)) &&
  !value.includes("\\") && value.split("/").every((part) => part && part !== "." && part !== "..");

/** Check source JSON before defaults/spreads can conceal malformed fields. */
function validateExecutionFields(value, label, fail) {
  if (Object.hasOwn(value, "id") && !text(value.id)) fail(`Invalid run ID: ${label}`);
  if (Object.hasOwn(value, "lane") && !LANES.includes(value.lane)) fail(`Invalid lane: ${label}`);
  if (Object.hasOwn(value, "cwd") && ![".", "extension"].includes(value.cwd)) fail(`Invalid working directory: ${label}`);
  for (const field of ["platforms", "ciPlatforms"]) {
    if (!Object.hasOwn(value, field)) continue;
    const platforms = value[field];
    if (!Array.isArray(platforms) || (field === "platforms" && platforms.length === 0) ||
        platforms.some((platform) => !PLATFORMS.includes(platform)) || new Set(platforms).size !== platforms.length) {
      fail(`Invalid ${field}: ${label}`);
    }
  }
  for (const field of ["args", "nodeArgs"]) {
    if (!Object.hasOwn(value, field)) continue;
    const args = value[field];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0") ||
        (field === "nodeArgs" && !NODE_FLAGS.has(arg)))) {
      fail(`Invalid arguments or non-executing Node flag: ${label}`);
    }
  }
  if (Object.hasOwn(value, "env") && (!object(value.env) ||
      Object.entries(value.env).some(([key, item]) => !key || /[=\0]/.test(key) ||
        typeof item !== "string" || item.includes("\0")))) fail(`Invalid environment: ${label}`);
  if (Object.hasOwn(value, "timeoutMs") &&
      (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs <= 0)) fail(`Invalid timeout: ${label}`);
}

function validateRawInventory(inventory) {
  if (!object(inventory) || inventory.schemaVersion !== 1 || inventory.nodeVersion !== 22 ||
      !Array.isArray(inventory.entries)) throw new Error("Unsupported test inventory schema");
  const errors = [];
  const fail = (message) => errors.push(message);
  for (const entry of inventory.entries) {
    if (!object(entry)) { fail("Invalid inventory entry"); continue; }
    if (!inventoryPath(entry.path)) fail(`Invalid inventory path: ${entry.path}`);
    for (const key of Object.keys(entry)) if (!ENTRY_FIELDS.has(key)) fail(`Invalid entry field ${key}: ${entry.path}`);
    if (Object.hasOwn(entry, "owners") && (!Array.isArray(entry.owners) ||
        entry.owners.some((owner) => !inventoryPath(owner)))) fail(`Invalid owners: ${entry.path}`);
    validateExecutionFields(entry, entry.path, fail);
    if (!Object.hasOwn(entry, "variants")) continue;
    if (entry.kind !== "suite" || !Array.isArray(entry.variants) || entry.variants.length === 0) {
      fail(`Empty or invalid suite variants: ${entry.path}`);
      continue;
    }
    for (const variant of entry.variants) {
      if (!object(variant)) { fail(`Invalid variant: ${entry.path}`); continue; }
      for (const key of Object.keys(variant)) {
        if (!EXECUTION_FIELDS.includes(key)) fail(`Invalid variant field ${key}: ${entry.path}`);
      }
      if (entry.lane === "package" && Object.hasOwn(variant, "lane") && variant.lane !== "package") {
        fail(`Packaging variant must stay in the package lane: ${entry.path}`);
      }
      validateExecutionFields(variant, `${entry.path} variant`, fail);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
}

function validateRun(run, fail) {
  validateExecutionFields(run, run.id, fail);
  if (!text(run.id)) fail(`Invalid run ID: ${run.id}`);
  if (!inventoryPath(run.path)) fail(`Invalid executable path: ${run.path}`);
  if (!LANES.includes(run.lane)) fail(`Invalid lane: ${run.id}`);
  if (![".", "extension"].includes(run.cwd)) fail(`Invalid working directory: ${run.id}`);
  for (const field of ["platforms", "ciPlatforms"]) {
    if (!Array.isArray(run[field])) fail(`Explicit ${field} required: ${run.id}`);
  }
  if (Array.isArray(run.platforms) && Array.isArray(run.ciPlatforms) &&
      run.ciPlatforms.some((platform) => !run.platforms.includes(platform))) fail(`CI platform cannot execute run: ${run.id}`);
  if (!Array.isArray(run.nodeArgs) || !Array.isArray(run.args) || !object(run.env)) fail(`Invalid arguments/environment: ${run.id}`);
  if (!Number.isSafeInteger(run.timeoutMs) || run.timeoutMs <= 0) fail(`Invalid timeout: ${run.id}`);
  if (run.path?.includes("cws-package") && run.lane !== "package") fail(`Packaging must stay explicit: ${run.id}`);
}

/** Enumerate all maintained test/tool files, including support assets. */
export function inventoryFiles(root) {
  const walk = (relative) => readdirSync(path.resolve(root, relative), { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.name === ".DS_Store") return [];
      const file = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Inventory does not follow symlinks: ${file}`);
      return entry.isDirectory() ? walk(file) : [file];
    });
  return INVENTORY_ROOTS.flatMap(walk).sort();
}

export function readInventory(root) {
  return JSON.parse(readFileSync(path.resolve(root, "test-inventory.json"), "utf8"));
}

/** Expand explicit variants without inheriting flags from the process environment. */
export function inventoryRuns(inventory) {
  validateRawInventory(inventory);
  return inventory.entries.filter((entry) => entry.kind === "suite").flatMap((entry) =>
    (entry.variants ?? [{}]).map((variant) => ({
      ...entry,
      ...variant,
      id: variant.id ?? entry.id ?? path.posix.basename(entry.path),
      nodeArgs: [...(entry.nodeArgs ?? []), ...(variant.nodeArgs ?? [])],
      args: [...(entry.args ?? []), ...(variant.args ?? [])],
      env: { ...(entry.env ?? {}), ...(variant.env ?? {}) },
      platforms: variant.platforms ?? entry.platforms ?? PLATFORMS,
      ciPlatforms: variant.ciPlatforms ?? entry.ciPlatforms,
      timeoutMs: variant.timeoutMs ?? entry.timeoutMs ?? 180_000
    })));
}

/** A missing, deleted or silently unclassified file is an inventory failure. */
export function validateInventory(inventory, files) {
  validateRawInventory(inventory);
  const errors = [];
  const fail = (message) => errors.push(message);
  const covered = new Set(files);
  const entries = new Map();
  for (const entry of inventory.entries) {
    if (!entry || typeof entry.path !== "string") { fail("Entry needs a path"); continue; }
    if (entries.has(entry.path)) fail(`Duplicate classification: ${entry.path}`);
    entries.set(entry.path, entry);
    if (!covered.has(entry.path)) fail(`Missing or out-of-scope file: ${entry.path}`);
    if (!KINDS.includes(entry.kind)) fail(`Invalid kind: ${entry.path}`);
    if (typeof entry.reason !== "string" || !entry.reason.trim()) fail(`Missing decision reason: ${entry.path}`);
    if (/\.test\.mjs$/.test(entry.path) && entry.kind !== "suite") {
      fail(`Tool test must have an execution decision: ${entry.path}`);
    }
    if (["helper", "fixture"].includes(entry.kind) &&
        (!Array.isArray(entry.owners) || entry.owners.length === 0)) {
      fail(`Support file needs an owner: ${entry.path}`);
    }
  }
  for (const file of covered) if (!entries.has(file)) fail(`Unclassified file: ${file}`);
  for (const entry of entries.values()) {
    for (const owner of entry.owners ?? []) {
      if (owner === entry.path || !entries.has(owner)) fail(`Invalid owner ${owner}: ${entry.path}`);
    }
  }
  // Avoid expanding malformed variants before returning their useful validation error.
  if (errors.length) throw new Error(errors.join("\n"));
  const ids = new Set();
  for (const run of inventoryRuns(inventory)) {
    if (ids.has(run.id)) fail(`Duplicate or invalid run ID: ${run.id}`);
    ids.add(run.id);
    validateRun(run, fail);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return { files: covered.size, runs: ids.size };
}

/** Select executable runs. Packaging is never selected by the ordinary gate. */
export function selectRuns(inventory, {
  lanes = ["portable", "performance"], id = null,
  platform = process.platform, ci = false, allowPackaging = false
} = {}) {
  if (!Array.isArray(lanes) || lanes.length === 0 || lanes.some((lane) => !LANES.includes(lane))) throw new Error("Invalid or unknown test lane");
  if (!PLATFORMS.includes(platform)) throw new Error(`Unknown test platform: ${platform}`);
  if ((id !== null && !text(id)) || typeof ci !== "boolean" || typeof allowPackaging !== "boolean") {
    throw new Error("Invalid test selection options");
  }
  validateRawInventory(inventory);
  // Selection also validates the catalogue structure; the runner separately
  // supplies the on-disk file list for complete coverage/missing-file checks.
  validateInventory(inventory, inventory.entries.map((entry) => entry.path));
  const all = inventoryRuns(inventory);
  if (id && !all.some((run) => run.id === id)) throw new Error(`Unknown executable suite: ${id}`);
  const requested = all.filter((run) => id ? run.id === id : lanes.includes(run.lane));
  if (!allowPackaging && requested.some((run) => run.lane === "package")) {
    throw new Error("Packaging is paused. Only use --allow-packaging after explicit release authorization.");
  }
  const selected = requested.filter((run) =>
    run.platforms.includes(platform) && (!ci || run.ciPlatforms.includes(platform)));
  if (id && selected.length === 0) throw new Error(`Suite is not enabled on ${platform}: ${id}`);
  return selected;
}

/** Pass arguments as an array: test configuration is never interpreted by a shell. */
export function nodeInvocation(root, run) {
  const errors = [];
  if (!object(run)) throw new Error("Invalid executable run");
  validateRun(run, (message) => errors.push(message));
  if (errors.length) throw new Error(errors.join("\n"));
  return {
    args: [...run.nodeArgs, path.resolve(root, run.path), ...run.args],
    cwd: path.resolve(root, run.cwd),
    env: run.env,
    timeout: run.timeoutMs
  };
}
