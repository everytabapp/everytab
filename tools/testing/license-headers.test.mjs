// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Every public runtime, style and maintained tool file starts with the MPL-2.0 header. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPublicPath } from "../export-public-repo.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const JS_HEADER = ["// Copyright 2026 Hadrien Gelas and EveryTab contributors", "// SPDX-License-Identifier: MPL-2.0"];
export const CSS_HEADER = ["/* Copyright 2026 Hadrien Gelas and EveryTab contributors */", "/* SPDX-License-Identifier: MPL-2.0 */"];

const walk = (directory, extension) => readdirSync(path.join(root, directory), { withFileTypes: true })
  .flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    return entry.isDirectory() ? walk(relative, extension) : relative.endsWith(extension) ? [relative] : [];
  }).sort();

/** Public maintained tool modules: the exporter's allowlist decides what counts. */
export function headerSets() {
  return {
    runtime: walk("extension/js", ".js"),
    styles: walk("extension/css", ".css"),
    tools: readdirSync(path.join(root, "tools")).filter((name) => name.endsWith(".mjs") && isPublicPath(`tools/${name}`))
      .map((name) => `tools/${name}`).sort(),
    testing: walk("tools/testing", ".mjs"),
    codebase: walk("tools/codebase", ".mjs")
  };
}

/** A shebang may precede the header; nothing else may. */
export function hasHeader(text, header) {
  const lines = text.split(/\r?\n/);
  const start = lines[0]?.startsWith("#!") ? 1 : 0;
  return lines[start] === header[0] && lines[start + 1] === header[1];
}

test("header check accepts exact headers and rejects everything else", () => {
  assert.equal(hasHeader(`${JS_HEADER.join("\n")}\n\nimport x from "y";\n`, JS_HEADER), true);
  assert.equal(hasHeader(`#!/usr/bin/env node\n${JS_HEADER.join("\n")}\n`, JS_HEADER), true);
  assert.equal(hasHeader(`${CSS_HEADER.join("\n")}\n:root {}\n`, CSS_HEADER), true);
  assert.equal(hasHeader(`/** doc */\n${JS_HEADER.join("\n")}\n`, JS_HEADER), false);
  assert.equal(hasHeader(`${JS_HEADER[0]}\n// SPDX-License-Identifier: MIT\n`, JS_HEADER), false);
  assert.equal(hasHeader("", JS_HEADER), false);
});

test("every covered file carries the two-line MPL-2.0 header", () => {
  const sets = headerSets();
  const missing = [];
  let checked = 0;
  for (const [name, files] of Object.entries(sets)) {
    assert.ok(files.length > 0, `header set ${name} must not be empty`);
    const header = name === "styles" ? CSS_HEADER : JS_HEADER;
    for (const file of files) {
      checked++;
      if (!hasHeader(readFileSync(path.join(root, file), "utf8"), header)) missing.push(file);
    }
  }
  assert.deepEqual(missing, [], `files without the MPL-2.0 header: ${missing.join(", ")}`);
  assert.ok(checked >= 250, `expected the runtime and tools to cover at least 250 files, saw ${checked}`);
});
