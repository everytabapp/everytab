// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Animate a content-driven block-size change without showing the intrinsic
 * size jump that normally happens before a CSS transition can begin.
 *
 * The caller still owns the DOM mutation. This helper measures the rendered
 * size before it, measures the new intrinsic size with transitions disabled,
 * then moves between those two exact sizes and returns ownership to CSS.
 */
export function createIntrinsicBlockMotion(element, {
  className = "is-hydrating-layout",
  shouldAnimate = () => true
} = {}) {
  let frameId = 0;
  let cleanupTimer = 0;
  let generation = 0;
  let handoffClass = "";
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");

  const clearScheduled = () => {
    cancelAnimationFrame(frameId);
    clearTimeout(cleanupTimer);
    frameId = 0;
    cleanupTimer = 0;
  };

  const release = (expectedGeneration = generation) => {
    if (expectedGeneration !== generation) return;
    clearScheduled();
    element.style.transition = "none";
    element.style.removeProperty("block-size");
    element.style.removeProperty("inline-size");
    element.classList.remove(className);
    if (handoffClass) element.classList.remove(handoffClass);
    handoffClass = "";
    void element.offsetHeight;
    element.style.removeProperty("transition");
  };

  const mutate = (change) => {
    const canAnimate = element.isConnected && shouldAnimate() &&
      !reduced.matches;
    if (!canAnimate) {
      change();
      return;
    }

    const token = ++generation;
    clearScheduled();
    const from = element.getBoundingClientRect().height;
    try {
      change();
    } catch (error) {
      release(token);
      throw error;
    }

    element.classList.add(className);
    element.style.transition = "none";
    element.style.blockSize = "auto";
    const to = element.getBoundingClientRect().height;
    element.style.blockSize = `${from}px`;
    void element.offsetHeight;
    element.style.removeProperty("transition");

    if (Math.abs(to - from) < 0.5) {
      release(token);
      return;
    }

    frameId = requestAnimationFrame(() => {
      if (token !== generation) return;
      frameId = 0;
      element.style.blockSize = `${to}px`;
      cleanupTimer = setTimeout(() => release(token), 360);
    });
  };

  const onTransitionEnd = (event) => {
    if (event.target === element && event.propertyName === "block-size") release();
  };
  element.addEventListener("transitionend", onTransitionEnd);

  // A different layout state can take over while hydration is in flight. Apply
  // that state while transitions are disabled, measure its target, then move
  // both axes from the currently rendered box in the same animation frame.
  // Releasing only block-size one frame later makes a simultaneous width change
  // visibly start first on every cold page.
  // `force` also measures a first explicit expansion when no hydration is in
  // flight; `motionClass` scopes the caller's clipping/easing until release.
  const handoff = (change = () => {}, { force = false, motionClass = "" } = {}) => {
    if (!force && (!element.classList.contains(className) || !element.style.blockSize)) return false;
    if (reduced.matches) {
      release();
      change();
      return true;
    }
    const token = ++generation;
    const rendered = element.getBoundingClientRect();
    clearScheduled();
    element.style.transition = "none";
    if (handoffClass) element.classList.remove(handoffClass);
    handoffClass = motionClass;
    if (handoffClass) element.classList.add(handoffClass);
    element.style.blockSize = `${rendered.height}px`;
    element.style.inlineSize = `${rendered.width}px`;
    try {
      change();
    } catch (error) {
      release(token);
      throw error;
    }
    element.style.removeProperty("block-size");
    element.style.removeProperty("inline-size");
    const target = element.getBoundingClientRect();
    element.style.blockSize = `${rendered.height}px`;
    element.style.inlineSize = `${rendered.width}px`;
    void element.offsetHeight;
    element.style.removeProperty("transition");
    if (Math.abs(target.height - rendered.height) < 0.5 &&
        Math.abs(target.width - rendered.width) < 0.5) {
      release(token);
      return true;
    }
    frameId = requestAnimationFrame(() => {
      if (token !== generation) return;
      frameId = 0;
      element.style.blockSize = `${target.height}px`;
      element.style.inlineSize = `${target.width}px`;
      cleanupTimer = setTimeout(() => release(token), 360);
    });
    return true;
  };
  const onMotionPreference = () => { if (reduced.matches) release(); };
  reduced.addEventListener?.("change", onMotionPreference);

  return {
    mutate,
    finish: release,
    handoff,
    destroy() {
      generation += 1;
      clearScheduled();
      element.removeEventListener("transitionend", onTransitionEnd);
      reduced.removeEventListener?.("change", onMotionPreference);
      release();
    }
  };
}
