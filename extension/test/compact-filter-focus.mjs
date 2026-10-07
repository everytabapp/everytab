/** Shared focus-paint contract, not a rendered-browser clipping test. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../css/primitives.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../css/tokens.css", import.meta.url), "utf8");
const focus = css.match(/\.open-filter-control:has\(\.open-filter-input:focus\)\s*\{([^}]+)\}/)?.[1];
assert.ok(focus, "The shared filter owns the focus boundary");
assert.match(focus, /border-color:\s*var\(--focus-accent\)/);
assert.match(focus, /box-shadow:\s*var\(--field-focus-shadow\)/,
  "Compact filters must reuse the inset field cue, not paint beyond sticky boundaries");
assert.match(tokens, /--field-focus-shadow:\s*inset 0 0 0 2px var\(--focus-ring\)/);
assert.match(css, /\.open-filter-input\s*\{[^}]*outline:\s*0\s*;/,
  "The input and its shared wrapper must not paint two focus rings");
console.log("PASS: compact filters use the shared inset focus boundary");
