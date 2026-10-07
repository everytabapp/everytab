#!/usr/bin/env node
// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { LANES, inventoryFiles, readInventory, validateInventory,
  selectRuns, nodeInvocation } from "./testing/inventory.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A typo must never fall back to the full gate. */
export function parseOptions(args) {
  const options = { lanes: ["portable", "performance"], id: null,
    list: false, all: false, ci: false, allowPackaging: false, check: false };
  let laneSpecified = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--lane") {
      if (laneSpecified || !LANES.includes(args[index + 1])) throw new Error("Choose one valid --lane");
      options.lanes = [args[++index]];
      laneSpecified = true;
    } else if (arg === "--list") options.list = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--ci") options.ci = true;
    else if (arg === "--allow-packaging") options.allowPackaging = true;
    else if (arg === "--check-inventory") options.check = true;
    else if (arg.startsWith("--") || options.id) throw new Error(`Unknown argument: ${arg}`);
    else options.id = arg;
  }
  if (options.all && !options.list) throw new Error("--all requires --list; it never runs all lanes");
  if (options.id && (laneSpecified || options.list || options.check)) throw new Error("Choose a suite ID or listing/lane options");
  if (options.check && args.length !== 1) throw new Error("--check-inventory runs on its own");
  return options;
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : file.endsWith(".js") ? [file] : [];
  });
}

export function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  const inventory = readInventory(root);
  const coverage = validateInventory(inventory, inventoryFiles(root));
  if (options.check) {
    console.log(`PASS: ${coverage.files} classified files; ${coverage.runs} explicit executable runs`);
    return 0;
  }
  if (options.list && options.all) {
    for (const entry of inventory.entries) {
      console.log(`${entry.kind}\t${entry.lane ?? "-"}\t${entry.path}\t${entry.reason}`);
    }
    return 0;
  }
  const selected = selectRuns(inventory, {
    ...options, allowPackaging: options.list || options.allowPackaging
  });
  if (options.list) {
    for (const run of selected) console.log(run.id);
    return 0;
  }
  if (selected.length === 0) throw new Error("No runs selected for this lane and platform");
  let failures = 0;
  for (const run of selected) {
    const command = nodeInvocation(root, run);
    const result = spawnSync(process.execPath, command.args, {
      cwd: command.cwd, env: { ...process.env, ...command.env }, encoding: "utf8",
      timeout: command.timeout, maxBuffer: 16 * 1024 * 1024
    });
    if (result.status === 0) console.log(`PASS ${run.id}`);
    else {
      failures++;
      console.log(`FAIL ${run.id}`);
      console.log(result.error?.message ?? (result.stdout + result.stderr).slice(-5000));
    }
  }
  // The portable gate owns runtime syntax once. Targeted and browser/performance
  // runs stay focused on their declared evidence.
  const sources = !options.id && options.lanes.includes("portable")
    ? sourceFiles(resolve(root, "extension/js")) : [];
  for (const source of sources) {
    const result = spawnSync(process.execPath, ["--check", source], { encoding: "utf8" });
    if (result.status !== 0) {
      failures++;
      console.log(`FAIL syntax ${source}\n${result.stderr}`);
    }
  }
  const manifest = JSON.parse(readFileSync(resolve(root, "extension/manifest.json"), "utf8"));
  console.log(JSON.stringify({ node: process.version, platform: process.platform,
    arch: process.arch, version: manifest.version, classifiedFiles: coverage.files,
    suites: selected.length, syntaxFiles: sources.length, failures,
    lanes: [...new Set(selected.map((run) => run.lane))],
    realBrowserExecuted: selected.some((run) => run.lane === "browser" || run.path.endsWith("cws-package-chrome.mjs")),
    packagingExecuted: selected.some((run) => run.lane === "package")
  }, null, 2));
  return failures ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) { console.error(`FAIL ${error.message}`); process.exitCode = 1; }
}
