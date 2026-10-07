// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Measure actual motion while the glow is visible, not a paused opacity fade. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnOwnedChrome, terminateOwnedChrome } from "../extension/test/chrome-test-process.mjs";
import { chromeBin, extensionRoot as currentExtensionRoot, debuggingUrl, detectExtension, createTarget,
  evaluate, prepareSession, waitFor } from "./capture-store-screenshots.mjs";

const output = path.resolve(process.env.EVERYTAB_MOTION_OUTPUT || "review-evidence/startup-cohesion-v0.8.600/gradient");
const extensionRoot = path.resolve(process.env.EVERYTAB_GLOW_EXTENSION_ROOT || currentExtensionRoot);
const foregroundOnly = process.env.EVERYTAB_GLOW_FOREGROUND_ONLY === "1";
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), "everytab-visible-motion-"));
const chrome = spawnOwnedChrome(chromeBin, ["--headless=new", "--remote-debugging-port=0",
  `--user-data-dir=${profile}`, `--load-extension=${extensionRoot}`,
  `--disable-extensions-except=${extensionRoot}`, "--no-first-run", "--disable-background-networking", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] });
const cases = [];
let page;
try {
  const debug = await debuggingUrl(chrome);
  const id = await detectExtension(debug);
  page = await createTarget(debug, `chrome-extension://${id}/dashboard.html`);
  await prepareSession(page);
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  await evaluate(page, `(async()=>{await chrome.storage.local.set({onboardingDone:true});
    await import(chrome.runtime.getURL('js/lib/store.js')).then(s=>s.patchSettings({
      newTabMode:'minimal',newTabFocus:'omnibox',uiGradient:true,uiScheme:'matcha'}));})()`);
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__glowFrames = [];
    const start = performance.now();
    const frame = () => {
      const orbs = [...document.querySelectorAll('.orb')];
      if (document.querySelector('.minimal-clock') && orbs.length) {
        window.__glowFrames.push({at: performance.now()-start, visible: !document.hidden,
          orbs: orbs.map(orb => { const s=getComputedStyle(orb), r=orb.getBoundingClientRect();
            return {x:r.x,y:r.y,opacity:Number(s.opacity),display:s.display,layer:s.zIndex}; })});
      }
      if (performance.now()-start < 6000) requestAnimationFrame(frame);
    }; requestAnimationFrame(frame);
  ` });
  for (const scheme of foregroundOnly ? [] : ["matcha", "nautilus", "ink"]) {
    await evaluate(page, `(async()=>{await chrome.storage.local.set({onboardingDone:true});
      await import(chrome.runtime.getURL('js/lib/store.js')).then(s=>s.patchSettings({
        newTabMode:'minimal',newTabFocus:'omnibox',uiGradient:true,uiScheme:'${scheme}'}));})()`);
    await page.send("Page.navigate", { url: `chrome-extension://${id}/newtab.html` });
    await waitFor(page, "window.__glowFrames?.length && window.__glowFrames.at(-1).at > 5200", "native glow timeline", 8000);
    const frames = await evaluate(page, "window.__glowFrames");
    const painted = frames.filter(f => f.visible && f.orbs.every(o => o.opacity >= .8 && o.display !== 'none' && Number(o.layer) >= 0));
    const travel = [0, 1].map(i => painted.length ? Math.hypot(
      Math.max(...painted.map(f => f.orbs[i].x)) - Math.min(...painted.map(f => f.orbs[i].x)),
      Math.max(...painted.map(f => f.orbs[i].y)) - Math.min(...painted.map(f => f.orbs[i].y))) : 0);
    cases.push({ scheme, travel, frames });
  }
  await writeFile(path.join(output, "visible-motion.json"), JSON.stringify({ cases }, null, 2));
  for (const c of cases) {
    console.log(`${c.scheme}: visible travel ${c.travel.map(v => v.toFixed(1)).join('/')}px`);
    assert.ok(c.travel.every(v => v >= 80), "both glows must visibly travel at least 80px while substantially opaque");
  }
  const hidden = await createTarget(debug, `chrome-extension://${id}/newtab.html`, { background: true });
  await prepareSession(hidden);
  await hidden.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  await hidden.send("Page.reload");
  await waitFor(hidden, "document.querySelector('.minimal-clock')", "background Minimal mount");
  assert.equal(await evaluate(hidden, "matchMedia('(prefers-reduced-motion: reduce)').matches"), false);
  assert.equal(await evaluate(hidden, "document.visibilityState"), "hidden");
  assert.equal(await evaluate(hidden, "document.getAnimations().filter(a=>a.effect?.target?.classList.contains('orb')).length"), 0);
  await hidden.send("Page.bringToFront");
  await waitFor(hidden, "document.visibilityState === 'visible'", "first foreground");
  await waitFor(hidden, "document.getAnimations().some(a=>a.effect?.target?.classList.contains('orb'))", "first visible gradient arrival", 1000);
  await writeFile(path.join(output, "first-foreground.json"), JSON.stringify({ reduced: false,
    startsOnFirstForeground: true, extensionRoot }, null, 2));
  hidden.close();
  console.log(foregroundOnly ? "PASS: gradient starts on first foreground" : "PASS: visible movement in three schemes and first foreground");
} finally {
  page?.close();
  await terminateOwnedChrome(chrome);
  await rm(profile, { recursive: true, force: true });
}
