// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Minimal's deck is one short keyboard path: Search, Starred launchers, then
 * the footer actions. Search owns result navigation while it is open; when an
 * empty field hands focus back to the host, this controller enters that path.
 */

const TARGETS = ".minimal-launch, .links a[href], .links button:not([disabled])";

const center = (node) => {
  const rect = node.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

/** Pick by visual geometry, not DOM order. Vertical movement chooses the
 * nearest row first and then the closest column; horizontal movement stays on
 * the current row. Exported for the deterministic layout fixture. */
export function minimalDirectionTarget(items, current, key) {
  const origin = center(current);
  const vertical = key === "ArrowDown" || key === "ArrowUp";
  const positive = key === "ArrowDown" || key === "ArrowRight";
  const candidates = items.filter((item) => item !== current).map((item) => {
    const point = center(item);
    const primaryDelta = vertical ? point.y - origin.y : point.x - origin.x;
    const secondaryDelta = vertical ? point.x - origin.x : point.y - origin.y;
    return { item, primaryDelta, secondaryDelta };
  }).filter(({ primaryDelta, secondaryDelta }) => {
    if ((positive && primaryDelta <= 2) || (!positive && primaryDelta >= -2)) return false;
    // Left and Right belong to one visual lane. Without this guard a launcher
    // at the end of a row could jump diagonally into the footer.
    return vertical || Math.abs(secondaryDelta) <= 8;
  });
  candidates.sort((a, b) =>
    Math.abs(a.primaryDelta) - Math.abs(b.primaryDelta) ||
    Math.abs(a.secondaryDelta) - Math.abs(b.secondaryDelta));
  return candidates[0]?.item ?? null;
}

export function createMinimalNavigation(root, searchInput) {
  const previousTabIndex = root.getAttribute("tabindex");
  root.setAttribute("tabindex", "-1");

  const targets = () => [...root.querySelectorAll(TARGETS)]
    .filter((node) => node.offsetParent !== null);

  const focusFirst = () => {
    const target = targets()[0];
    target?.focus({ preventScroll: true });
    return Boolean(target);
  };

  // Escape closes Search while its launchers are still visually yielding for
  // one transition frame. Keep focus on the deck itself instead of trying to
  // focus a temporarily hidden child. The next forward arrow enters the first
  // visible launcher or, when Starred is empty, the first footer destination.
  const focusBoundary = () => {
    root.focus({ preventScroll: true });
    return document.activeElement === root;
  };

  const onKeydown = (event) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    if (event.target === root) {
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        event.preventDefault();
        focusFirst();
      }
      return;
    }
    const items = targets();
    const index = items.indexOf(event.target);
    if (index < 0) return;
    const target = minimalDirectionTarget(items, items[index], event.key);
    if (target) {
      event.preventDefault();
      target.focus({ preventScroll: true });
      return;
    }
    if (event.key === "ArrowUp" && searchInput) {
      event.preventDefault();
      searchInput.focus({ preventScroll: true });
    }
  };

  root.addEventListener("keydown", onKeydown);
  return {
    focusFirst,
    focusBoundary,
    destroy() {
      root.removeEventListener?.("keydown", onKeydown);
      if (previousTabIndex === null) root.removeAttribute("tabindex");
      else root.setAttribute("tabindex", previousTabIndex);
    }
  };
}
