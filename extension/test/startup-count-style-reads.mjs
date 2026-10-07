/** Actual startup-count owner: truthful DOM without reel/style work under reduced motion. */
import test from "node:test";
import assert from "node:assert/strict";
import { installDomFixture } from "./dom-fixture.mjs";
import { createStartupArrival } from "../js/ui/startup-arrival.js";

function harness(reducedMotion = false) {
  const fixture = installDomFixture();
  const previousMatchMedia = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
  const previousPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
  const listeners = new Set(), reads = [], animations = [];
  let now = 100;
  const media = { matches: reducedMotion,
    addEventListener(type, listener) { assert.equal(type, "change"); listeners.add(listener); },
    removeEventListener(type, listener) { assert.equal(type, "change"); listeners.delete(listener); }
  };
  Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: query => {
    assert.equal(query, "(prefers-reduced-motion: reduce)"); return media;
  } });
  Object.defineProperty(globalThis, "performance", { configurable: true,
    value: { now: () => now, getEntriesByType: () => [] } });
  document.visibilityState = "visible";
  const createElement = document.createElement.bind(document);
  document.createElement = tag => {
    const node = createElement(tag);
    node.animate = (frames, options) => {
      let finish;
      const animation = { finished: new Promise(resolve => { finish = resolve; }), cancelCalls: 0,
        cancel() { this.cancelCalls++; finish(); }, finish: () => finish() };
      animations.push({ node, frames, options: { ...options }, animation });
      return animation;
    };
    return node;
  };
  globalThis.getComputedStyle = (node, pseudo) => {
    reads.push({ node, pseudo: pseudo ?? null, pending: node.dataset.startupPending,
      hidden: node.getAttribute("aria-hidden"), text: node.textContent });
    return { transform: "matrix(1, 0, 0, 1, 0, -37.5)", display: "inline-block", visibility: "visible",
      getPropertyValue: name => name === "--motion-continuity" ? "180ms" : name === "--ease-out" ? "ease-out" : "" };
  };
  const owner = createStartupArrival();
  const pending = () => {
    const node = owner.pendingCount(); document.body.append(node);
    assert.equal(node.textContent, "", "pending reel exposes no invented numeric content");
    assert.equal(node.getAttribute("aria-hidden"), "true");
    assert.equal(node.isConnected, true);
    return node;
  };
  return { owner, pending, reads, animations, media, listeners,
    advance: milliseconds => { now += milliseconds; },
    reduce() { media.matches = true; for (const listener of [...listeners]) listener({ matches: true }); },
    restore() {
      owner.destroy();
      fixture.restore();
      if (previousMatchMedia) Object.defineProperty(globalThis, "matchMedia", previousMatchMedia);
      else delete globalThis.matchMedia;
      if (previousPerformance) Object.defineProperty(globalThis, "performance", previousPerformance);
      else delete globalThis.performance;
    }
  };
}

function truthful(node, text, { rolling = false } = {}) {
  assert.equal(node.textContent, text);
  assert.equal(node.querySelectorAll(".startup-count-value").length, 1);
  assert.equal(node.dataset.startupPending, undefined);
  assert.equal(node.getAttribute("aria-hidden"), null, "resolved count returns to the accessible tree");
  assert.equal(node.dataset.startupRolling, rolling ? "true" : undefined);
  if (!rolling) {
    assert.equal(node.style.getPropertyValue("--startup-reel-offset"), "");
    assert.equal(node.style.getPropertyValue("--startup-count-elapsed"), "");
  }
}

test("reduced motion settles connected counters with zero style or reel work", () => {
  const h = harness(true);
  try {
    const node = h.pending();
    h.owner.settleCount(node, "1,234", "inbox");
    truthful(node, "1,234");
    assert.equal(h.animations.length, 0);
    assert.equal(h.reads.length, 0, "reduced-motion pending count must not read any computed style, including ::before");
    h.owner.settleCount(node, "0", "inbox");
    truthful(node, "0");
    const replacement = h.pending();
    h.owner.settleCount(replacement, "25", "inbox");
    truthful(replacement, "25");
    assert.equal(h.reads.length, 0, "settled and replacement counts also avoid reduced-motion style reads");
    assert.equal(h.animations.length, 0);
    h.owner.destroy();
    assert.equal(node.dataset.startupStopped, undefined, "settled counters leave pending-owner cleanup");
    assert.equal(replacement.dataset.startupStopped, undefined);
    assert.equal(h.listeners.size, 0);
  } finally { h.restore(); }
});

test("normal motion captures the pending pseudo reel before replacing it, then animates truthful content", async () => {
  const h = harness();
  try {
    const node = h.pending();
    h.owner.settleCount(node, "300", "inbox");
    truthful(node, "300", { rolling: true });
    const reelReads = h.reads.filter(read => read.pseudo === "::before");
    assert.deepEqual(reelReads, [{ node, pseudo: "::before", pending: "true", hidden: "true", text: "" }],
      "reel transform must come from the decorative pending state before any count DOM mutation");
    assert.equal(node.style.getPropertyValue("--startup-reel-offset"), "-37.5px");
    assert.equal(node.style.getPropertyValue("--startup-count-elapsed"), "0ms");
    assert.equal(h.animations.length, 1);
    assert.equal(h.animations[0].node, node.querySelector(".startup-count-value"));
    assert.deepEqual(h.animations[0].frames, [
      { opacity: 0, transform: "translateY(100%)" }, { opacity: 1, transform: "translateY(0)" }
    ]);
    assert.deepEqual(h.animations[0].options, { duration: 180, easing: "ease-out" });
    h.advance(180);
    h.animations[0].animation.finish();
    await h.animations[0].animation.finished;
    truthful(node, "300");
    assert.equal(h.animations[0].animation.cancelCalls, 1);
  } finally { h.restore(); }
});

test("settled counts update without replay and replacements cannot restart an expired arrival", async () => {
  const h = harness();
  try {
    const node = h.pending(); h.owner.settleCount(node, "25", "cards");
    h.advance(180); h.animations[0].animation.finish();
    await h.animations[0].animation.finished;
    const readCount = h.reads.length;
    h.owner.settleCount(node, "26", "cards");
    truthful(node, "26");
    assert.equal(h.reads.length, readCount, "same settled node needs no further motion/style calculation");
    const replacement = h.pending(); h.owner.settleCount(replacement, "27", "cards");
    truthful(replacement, "27");
    assert.equal(h.animations.length, 1, "a replacement respects the original expired animation deadline");
  } finally { h.restore(); }
});

test("switching to reduced motion cancels active reels and retains count/accessibility cleanup", () => {
  const h = harness();
  try {
    const node = h.pending(); h.owner.settleCount(node, "12", "bundle");
    assert.equal(h.animations.length, 1);
    h.reduce();
    truthful(node, "12");
    assert.equal(h.animations[0].animation.cancelCalls, 1);
    h.reads.length = 0;
    const later = h.pending(); h.owner.settleCount(later, "4", "hidden");
    truthful(later, "4");
    assert.equal(h.reads.length, 0, "new counters after the preference change cannot read reel styles");
    assert.equal(h.animations.length, 1);
    const unresolved = h.pending();
    h.owner.destroy();
    assert.equal(unresolved.dataset.startupStopped, "true");
    assert.equal(unresolved.getAttribute("aria-hidden"), "true");
    assert.equal(h.listeners.size, 0);
    assert.equal(document.listeners.get("visibilitychange")?.length ?? 0, 0);
  } finally { h.restore(); }
});
