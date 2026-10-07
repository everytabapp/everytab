// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Visual arrival for Dashboard's absolute results; query and focus stay with Search. */
export function bindSearchReveal(results, overlay) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let open = false;
  let animation = null;
  let deadline = 0;
  let targetHeight = 0;
  const content = overlay.firstElementChild;
  const finish = () => {
    animation?.cancel(); animation = null;
    overlay.classList.remove("is-search-opening");
  };
  const measureHeight = () => {
    const style = getComputedStyle(overlay);
    return [...content.children].reduce((height, child) => height + child.getBoundingClientRect().height, 0) +
      parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  };
  const animateTo = (from, to, duration) => {
    animation?.cancel();
    targetHeight = to;
    const effect = overlay.animate([{ blockSize: `${from}px` }, { blockSize: `${to}px` }],
      { duration, easing: "cubic-bezier(.32, 0, .2, 1)" });
    animation = effect;
    effect.finished.then(() => { if (animation === effect) finish(); }, () => {});
  };
  const retarget = () => {
    if (!animation) return;
    const nextHeight = measureHeight();
    if (Math.abs(nextHeight - targetHeight) < .5) return;
    const remaining = deadline - performance.now();
    if (remaining <= 0) { finish(); return; }
    // Cached suggestions and the first query can resolve during this same
    // opening. Follow their actual height from the current frame, keeping the
    // original deadline, so releasing the shell cannot introduce a final jump.
    animateTo(overlay.getBoundingClientRect().height, nextHeight, remaining);
  };
  const observe = () => {
    const next = results.childNodes.length > 0;
    if (next === open) { retarget(); return; }
    open = next;
    finish();
    if (!open || reduced.matches || !overlay.isConnected || document.hidden) return;
    const style = getComputedStyle(overlay);
    const duration = parseFloat(style.getPropertyValue("--motion-continuity")) || 180;
    // The absolute shell grows without shifting the sticky hero. Clip its
    // content inside a separate wrapper so the rounded outline/shadow follows
    // the moving lower edge and the field's connected outline stays intact.
    const height = measureHeight();
    overlay.classList.add("is-search-opening");
    deadline = performance.now() + duration;
    animateTo(0, height, duration);
  };
  const observer = new MutationObserver(observe);
  observer.observe(results, { childList: true });
  const sizes = new ResizeObserver(retarget);
  for (const child of content.children) sizes.observe(child);
  const onPreference = () => { if (reduced.matches) finish(); };
  const onKeyboard = event => {
    if (["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) finish();
  };
  const host = overlay.parentElement;
  host.addEventListener("keydown", onKeyboard, true);
  host.addEventListener("pointerdown", finish, true);
  reduced.addEventListener("change", onPreference);
  const destroy = () => {
    finish();
    observer.disconnect();
    sizes.disconnect();
    host.removeEventListener("keydown", onKeyboard, true);
    host.removeEventListener("pointerdown", finish, true);
    reduced.removeEventListener("change", onPreference);
  };
  window.addEventListener("pagehide", destroy, { once: true });
  return { destroy };
}
