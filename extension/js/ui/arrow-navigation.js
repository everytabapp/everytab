// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Shared arrow-key navigation for compact extension surfaces. */

const ARROW_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
const LAYERED_ARROW_OWNERS =
  '[popover], .action-popover, [role="listbox"], [role="dialog"], .tagmenu';

function visible(node) {
  return node instanceof HTMLElement && !node.disabled && node.offsetParent !== null;
}

function textEntry(node) {
  if (!(node instanceof HTMLElement)) return false;
  if (node.isContentEditable || node.matches("textarea, select")) return true;
  if (!node.matches("input")) return false;
  return !["checkbox", "radio", "button", "submit", "reset"].includes(
    String(node.type || "text").toLocaleLowerCase()
  );
}

function overlaps(a, b, axis) {
  return axis === "x"
    ? Math.min(a.right, b.right) > Math.max(a.left, b.left)
    : Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
}

/** Pick the nearest visible control in the physical direction of an arrow. */
export function spatialArrowTarget(current, candidates, key) {
  const horizontal = key === "ArrowLeft" || key === "ArrowRight";
  const forward = key === "ArrowRight" || key === "ArrowDown";
  const axis = horizontal ? "x" : "y";
  const crossAxis = horizontal ? "y" : "x";
  const currentRect = current.getBoundingClientRect();
  const currentCenter = {
    x: currentRect.left + currentRect.width / 2,
    y: currentRect.top + currentRect.height / 2
  };
  return candidates
    .filter((candidate) => candidate !== current)
    .map((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const primary = (center[axis] - currentCenter[axis]) * (forward ? 1 : -1);
      return {
        candidate,
        primary,
        cross: Math.abs(center[crossAxis] - currentCenter[crossAxis]),
        aligned: overlaps(currentRect, rect, horizontal ? "y" : "x")
      };
    })
    .filter(({ primary }) => primary > 1)
    .sort((a, b) => Number(b.aligned) - Number(a.aligned) ||
      a.primary - b.primary || a.cross - b.cross)[0]?.candidate ?? null;
}

function visualOrder(nodes) {
  return [...nodes].sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return ar.top - br.top || ar.left - br.left;
  });
}

/**
 * Install two-dimensional navigation over a compact action surface.
 * Search, popovers and text fields retain their own arrow semantics.
 */
export function createSpatialArrowNavigator({ root = document, candidateSelector }) {
  let lastFocused = null;
  const candidates = () => visualOrder(
    [...root.querySelectorAll(candidateSelector)].filter(visible)
  );

  const remember = (event) => {
    const candidate = event.target.closest?.(candidateSelector);
    if (candidate && visible(candidate)) lastFocused = candidate;
  };
  root.addEventListener("focusin", remember, true);

  const focusEntry = ({ preferLast = true, fromEnd = false } = {}) => {
    const available = candidates();
    const target = preferLast && visible(lastFocused) && available.includes(lastFocused)
      ? lastFocused
      : (fromEnd ? available.at(-1) : available[0]);
    target?.focus({ preventScroll: true });
    return target ?? null;
  };

  root.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || !ARROW_KEYS.has(event.key) ||
        event.metaKey || event.ctrlKey || event.altKey) return;
    if (textEntry(event.target) || event.target.closest?.(LAYERED_ARROW_OWNERS)) return;
    const available = candidates();
    if (!available.length) return;
    const current = event.target.closest?.(candidateSelector);
    if (!current || !available.includes(current)) {
      const entryOrigin = event.target === root || event.target === document ||
        event.target === document.body || event.target === document.documentElement;
      if (!entryOrigin) return;
      event.preventDefault();
      focusEntry({ preferLast: false,
        fromEnd: event.key === "ArrowUp" || event.key === "ArrowLeft" });
      return;
    }
    const next = spatialArrowTarget(current, available, event.key);
    if (!next) return;
    event.preventDefault();
    next.focus({ preventScroll: true });
  });

  return { focusEntry };
}

/**
 * Install the vertical list walk used by the Side Panel. Left/Right remain
 * owned by section tabs and row action lanes.
 */
export function createListArrowNavigator({
  root = document,
  unitSelector,
  entrySelector = "input:not([disabled]), button:not([disabled]), a[href]",
  headerTarget
}) {
  let lastPosition = null;
  let pendingEntryDirection = null;
  const units = () => [...root.querySelectorAll(unitSelector)].filter(visible);

  function controlsFor(unit) {
    return [...unit.querySelectorAll(entrySelector)]
      .filter((control) => visible(control) && control.closest(unitSelector) === unit);
  }

  function focusUnit(unit, controlIndex = 0) {
    if (!unit) return null;
    const controls = controlsFor(unit);
    const target = controls[Math.min(controlIndex, controls.length - 1)] ?? unit;
    if (target === unit) unit.tabIndex = -1;
    target.focus({ preventScroll: true });
    return target;
  }

  root.addEventListener("focusin", (event) => {
    const unit = event.target.closest?.(unitSelector);
    if (!unit || !visible(unit)) return;
    const available = units();
    const controls = controlsFor(unit);
    lastPosition = {
      unit,
      ordinal: available.indexOf(unit),
      key: unit.dataset.tablistRow ?? unit.dataset.tablistCard ?? "",
      kind: unit.matches(".trow") ? "row" : "card",
      controlIndex: Math.max(0, controls.indexOf(event.target))
    };
  }, true);

  const focusEntry = ({ preferLast = true } = {}) => {
    const available = units();
    if (preferLast && lastPosition) {
      let unit = available.includes(lastPosition.unit) ? lastPosition.unit : null;
      if (!unit && lastPosition.key) {
        unit = available.find((candidate) =>
          (lastPosition.kind === "row"
            ? candidate.dataset.tablistRow
            : candidate.dataset.tablistCard) === lastPosition.key) ?? null;
      }
      unit ??= available[Math.max(0, Math.min(lastPosition.ordinal, available.length - 1))];
      if (unit) return focusUnit(unit, lastPosition.controlIndex);
    }
    return focusUnit(available[0]);
  };

  const pendingEntryObserver = new MutationObserver(() => {
    if (!pendingEntryDirection) return;
    const available = units();
    if (!available.length) return;
    const direction = pendingEntryDirection;
    pendingEntryDirection = null;
    focusUnit(direction === "ArrowUp" ? available.at(-1) : available[0]);
  });
  pendingEntryObserver.observe(root === document ? document.body : root, {
    childList: true, subtree: true
  });

  root.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || !["ArrowDown", "ArrowUp"].includes(event.key) ||
        event.metaKey || event.ctrlKey || event.altKey) return;
    if (textEntry(event.target) || event.target.closest?.(LAYERED_ARROW_OWNERS)) return;
    const canEnter = event.target === root || event.target === document ||
      event.target === document.body || event.target === document.documentElement ||
      event.target.closest?.(".switcher, .panel-section-lead");
    const available = units();
    if (!available.length) {
      if (canEnter) {
        event.preventDefault();
        pendingEntryDirection = event.key;
      }
      return;
    }
    const unit = event.target.closest?.(unitSelector);
    if (unit && available.includes(unit)) {
      const index = available.indexOf(unit);
      const next = event.key === "ArrowDown" ? available[index + 1] : available[index - 1];
      event.preventDefault();
      if (next) focusUnit(next);
      else if (event.key === "ArrowUp") headerTarget?.()?.focus({ preventScroll: true });
      else focusUnit(available[0]);
      return;
    }
    if (!canEnter) return;
    event.preventDefault();
    focusUnit(event.key === "ArrowUp" ? available.at(-1) : available[0]);
  }, true);

  return { focusEntry };
}
