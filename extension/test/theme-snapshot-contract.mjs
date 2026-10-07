/** Static snapshot-ownership contract. This does not simulate Chrome compositing. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const tokens = readFileSync(new URL("../css/tokens.css", import.meta.url), "utf8");
const sharedSnapshot = tokens.match(
  /html\[data-scheme-transition="true"\] \*,\s*html\[data-scheme-transition="true"\] \*::before,\s*html\[data-scheme-transition="true"\] \*::after\s*\{([^}]+)\}/
)?.[1] ?? "";
assert.match(sharedSnapshot, /view-transition-name:\s*none\s*!important/,
  "Scheme previews must keep unrelated named regions in the root snapshot, below modal content");
assert.match(sharedSnapshot, /transition-property:\s*none\s*!important/,
  "Individual controls cannot stagger the whole-page colour transition");
assert.match(tokens,
  /html\[data-scheme-transition="true"\]:not\(:has\(\[aria-modal="true"\]\)\) \.theme-pop:not\(\.hidden\)\s*\{\s*view-transition-name:\s*everytab-theme-picker\s*!important/,
  "The stationary theme-picker exception must never lift a picker above a modal");
assert.match(tokens, /animation-duration:\s*190ms/,
  "Snapshot isolation must retain the accepted crossfade timing");
console.log("PASS: scheme snapshot ownership, modal layering policy and unchanged fade timing");
