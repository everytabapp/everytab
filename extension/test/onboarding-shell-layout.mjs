/** Layout ownership contract. Final geometry is verified in the installed tour. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../css/onboarding.css", import.meta.url), "utf8");
const declarations = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `Missing rule: ${selector}`);
  return match[1];
};

for (const selector of [".ob-head", ".ob-progress-line", ".ob-save-status", ".ob-foot"]) {
  assert.match(declarations(selector), /flex:\s*(?:none|0 0 auto)\s*;/,
    `${selector} must not shrink when a tour disclosure opens`);
}
assert.match(declarations(".ob-body-host"), /flex:\s*1 1 0(?:%)?\s*;/,
  "The body fills remaining space without its content height shrinking the tour header");
assert.match(declarations(".ob-body-host"), /min-height:\s*0\s*;/);
assert.match(declarations(".ob-body-host"), /overflow-y:\s*auto\s*;/);
assert.match(declarations(".ob-card.tour"), /height:\s*min\(760px, 90vh\)/,
  "Disclosure changes keep the existing viewport-bounded tour size");
console.log("PASS: tour fixed bands and independent scroll-body layout contract");
