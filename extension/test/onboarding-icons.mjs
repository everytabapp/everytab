import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";

const dom = installDomFixture();
globalThis.chrome = { i18n: createChromeI18nMock() };
try {
  const { ONBOARDING_PAGES } = await import("../js/lib/onboarding-copy.js");
  const { icon } = await import("../js/ui/icons.js");
  const names = new Set(ONBOARDING_PAGES.flatMap((page) =>
    [...(page.benefits ?? []), ...(page.definitions ?? [])].map(([name]) => name)));
  for (const path of ["onboarding.js", "onboarding-choices.js"]) {
    const source = readFileSync(new URL(`../js/ui/${path}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/\bicon\("([\w-]+)"/g)) names.add(match[1]);
  }
  for (const name of names) {
    const glyph = icon(name);
    assert.match(glyph.innerHTML, /<(?:path|rect|circle|g)\b/,
      `Onboarding's ${name} icon must contain visible SVG geometry, not an empty slot`);
    assert.equal(glyph.getAttribute("aria-hidden"), "true");
    assert.equal(glyph.getAttribute("viewBox"), "0 0 24 24");
  }
  console.log(`PASS: all ${names.size} onboarding icons have shared SVG geometry`);
} finally { dom.restore(); }
