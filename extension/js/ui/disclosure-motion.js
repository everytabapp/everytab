// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Measured, interruptible geometry for an explicit disclosure action. */
const running = new WeakMap();

export function finishDisclosure(element) {
  running.get(element)?.finish();
}

/** Publish state immediately, then let the visible block reach its new size. */
export function animateDisclosure(element, change, { fromHeight, afterFinish } = {}) {
  const from = fromHeight ?? element.getBoundingClientRect().height;
  finishDisclosure(element);
  change();
  const to = element.getBoundingClientRect().height;
  if (!element.isConnected || typeof element.animate !== "function" ||
      matchMedia("(prefers-reduced-motion: reduce)").matches || Math.abs(to - from) < 0.5) {
    afterFinish?.();
    return;
  }
  const saved = ["block-size", "display", "overflow", "min-block-size"]
    .map((property) => [property, element.style.getPropertyValue(property)]);
  // A collapsed grid has a zero track. During motion the natural-size contents
  // stay visible through this clipped block, without scaling text or controls.
  element.style.display = "block";
  element.style.overflow = "clip";
  element.style.minBlockSize = "0";
  element.style.blockSize = `${to}px`;
  const motionStyle = getComputedStyle(element);
  const configuredDuration = Number.parseFloat(motionStyle.getPropertyValue("--motion-continuity"));
  const duration = Number.isFinite(configuredDuration) && configuredDuration >= 0 ? configuredDuration : 180;
  const easing = motionStyle.getPropertyValue("--ease-out").trim() || "cubic-bezier(.2,.8,.2,1)";
  const animation = element.animate([
    { blockSize: `${from}px` }, { blockSize: `${to}px` }
  ], { duration, easing });
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    animation.cancel();
    for (const [property, value] of saved) {
      if (value) element.style.setProperty(property, value);
      else element.style.removeProperty(property);
    }
    running.delete(element);
    reduced.removeEventListener("change", onPreference);
    afterFinish?.();
  };
  const onPreference = () => { if (reduced.matches) finish(); };
  running.set(element, { finish });
  animation.onfinish = finish;
  animation.oncancel = finish;
  reduced.addEventListener("change", onPreference);
}
