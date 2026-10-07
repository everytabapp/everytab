import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const messages = JSON.parse(read("_locales/en/messages.json"));
const icons = read("js/ui/icons.js");
const css = read("css/dashboard.css");

assert.equal(messages.new_tab_choice_native_detail.message,
  "If Chrome offers “Change it back,” choosing it disables the whole EveryTab extension.");

assert.match(icons,
  /settings: '<path d="M12\.22 2h-\.44[^"]+"\/><circle cx="12" cy="12" r="3"\/>'/,
  "Settings uses the shared 24px line-cog geometry");
assert.doesNotMatch(icons,
  /settings: '<path d="M4 21v-6"/,
  "The former sliders glyph is retired globally");

assert.match(css,
  /\.navitem:hover \{ background: var\(--nav-hover\); color: var\(--ink\); \}/,
  "Sidebar hover stays a quiet flat navigation tint");
assert.match(css,
  /\.sidebar \.navitem:focus-visible \{\s*outline: 2px solid var\(--focus-accent\);\s*outline-offset: -2px;/,
  "Sidebar keyboard focus is inset, including clipped sub-navigation");
assert.match(css,
  /\[data-emphasis="bold"\] \.sidebar \.navitem\.active:focus-visible \{\s*outline-color: var\(--accent-ink\);/,
  "A focused bold active item uses its audited contrast ink over the accent fill");
assert.match(css,
  /\[data-nav="expanded"\] \.sidebar \.navitem \{\s*min-height: 32px;\s*padding-block: var\(--sp-2\);\s*line-height: 1\.25;/,
  "Expanded desktop rows settle at 32px while retaining the 24px disclosure target");
assert.match(css,
  /\[data-nav="expanded"\] \.side-scroll > \.nav \+ \.navlabel \{ padding-top: 24px; \}/,
  "Only later expanded-sidebar group labels receive the larger group seam");
assert.doesNotMatch(css,
  /\[data-nav="(?:rail|header)"\][^{]*\.side-scroll > \.nav \+ \.navlabel/,
  "Rail and header navigation do not inherit the group-spacing adjustment");

console.log("PASS: onboarding palette, native note, line cog, and sidebar polish source contracts");
