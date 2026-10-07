// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Sticky caps rely on live compositor clipping while the page is scrolled.
 * A document View Transition snapshots them as flat layers and can briefly
 * reveal rows that are already behind the cap, so rail continuity is reserved
 * for the top-of-page state.
 */
export function shouldTransitionStarredRail({ reduced = false, scrollTop = 0, hasApi = false } = {}) {
  return !reduced && hasApi && Number(scrollTop) <= 0;
}
