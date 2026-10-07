/** Source geometry contract. Installed rendering remains the visual proof. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../css/tablist-d4.css", import.meta.url), "utf8");
const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `Missing rule: ${selector}`);
  return match[1];
};

const memberships = rule(".close-day-labels .session-memberships");
const link = rule(".close-day-labels .session-membership-link");
assert.match(memberships, /overflow:\s*hidden/);
assert.match(memberships, /padding:\s*1px/,
  "The outer clip leaves room for glyph ink");
assert.match(memberships, /line-height:\s*1\.3/,
  "The metadata phrase reserves descender clearance");
assert.match(link, /padding:\s*1px/,
  "The ellipsizing link leaves room for left overhang and descenders");
assert.match(link, /font:\s*inherit/);
assert.match(link, /max-width:\s*130px/);
assert.match(link, /overflow:\s*hidden/);
assert.match(link, /text-overflow:\s*ellipsis/);
assert.match(css, /\.tablist:not\(\[data-compact\]\) \.trow \{[^}]*min-height:\s*40px;[^}]*height:\s*40px;/s,
  "The established desktop row height is unchanged");

console.log("PASS: Session membership ink-clearance and unchanged row-height contracts");
