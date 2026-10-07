// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Keyboard bridge between Dashboard content and its persistent sidebar.
 *
 * Lists keep ownership of horizontal movement inside a row. The bridge acts
 * only at the row's left edge (decided by the host) or from a section-level
 * control. It remembers one exact content position for the current route;
 * choosing another route deliberately starts that section at its first useful
 * control instead of restoring an unrelated position.
 */

const EDITING_CONTROL = "textarea, select, [contenteditable='true'], " +
  "input:not([type='checkbox']):not([type='radio']):not([type='button'])";

export function createDashboardFocusBridge({
  sidebar,
  content,
  getCurrentPage,
  activatePage,
  enterContent,
  isContentLeftEdge
}) {
  let returnTarget = null;
  let returnPage = null;

  const visibleDestinations = () => [...sidebar.querySelectorAll(".navitem[data-page]")]
    .filter((node) => !node.hidden && node.style?.display !== "none");

  const activeDestination = () => visibleDestinations().find((node) =>
    node.dataset.page === getCurrentPage()) ?? null;

  const canReturnTo = (node) => node?.isConnected !== false && !node?.hidden &&
    node?.style?.display !== "none" && !node?.closest?.("[hidden]");

  const onDocumentKeydown = (event) => {
    if (event.key !== "ArrowLeft" || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (!content.contains(target) || target.closest?.(EDITING_CONTROL)) return;
    if (!isContentLeftEdge(target)) return;
    const destination = activeDestination();
    if (!destination) return;
    event.preventDefault();
    event.stopPropagation();
    returnTarget = target;
    returnPage = getCurrentPage();
    destination.focus({ preventScroll: true });
  };

  const activateFromSidebar = (destination) => {
    const nextPage = destination?.dataset.page;
    if (!nextPage) return;
    const changed = nextPage !== getCurrentPage();
    if (changed) {
      returnTarget = null;
      returnPage = null;
      activatePage(nextPage);
      enterContent();
      return;
    }
    if (returnPage === nextPage && canReturnTo(returnTarget)) {
      returnTarget?.focus({ preventScroll: true });
      return;
    }
    enterContent();
  };

  const returnToActiveContent = () => {
    const currentPage = getCurrentPage();
    if (returnPage === currentPage && canReturnTo(returnTarget)) {
      returnTarget?.focus({ preventScroll: true });
      return;
    }
    enterContent();
  };

  const onSidebarKeydown = (event) => {
    if (!["ArrowUp", "ArrowDown", "ArrowRight", "Enter", " "].includes(event.key)) return;
    const destination = event.target.closest?.(".navitem[data-page]");
    if (!destination || !sidebar.contains(destination)) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const destinations = visibleDestinations();
      const index = destinations.indexOf(destination);
      if (index < 0 || destinations.length < 2) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      destinations[(index + delta + destinations.length) % destinations.length]
        ?.focus({ preventScroll: true });
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "ArrowRight") {
      returnToActiveContent();
      return;
    }
    activateFromSidebar(destination);
  };

  content.addEventListener("keydown", onDocumentKeydown, true);
  sidebar.addEventListener("keydown", onSidebarKeydown);
  return {
    destroy() {
      content.removeEventListener?.("keydown", onDocumentKeydown, true);
      sidebar.removeEventListener?.("keydown", onSidebarKeydown);
    }
  };
}
