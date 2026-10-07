// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Stable, per-surface ordering for live Open-window cards.
 *
 * Chrome exposes live windows but no user-controlled window-list position.
 * EveryTab therefore keeps the last visible order for the lifetime of one
 * Dashboard/side-panel surface. A new window created from a between-card drop
 * may name the card it followed; later refreshes retain that placement while
 * closed windows disappear and externally created windows append.
 */

const idOf = (group) => group?.data?.id;

/**
 * @typedef {{windowId:number,afterWindowId:number}} OpenWindowPlacement
 */

/**
 * Reconcile fresh live groups with the surface's last visible order and one
 * optional drop placement.
 * @param {any[]} groups fresh named/current-promoted Open groups
 * @param {number[]} previousIds previous visible order
 * @param {OpenWindowPlacement|null} [placement]
 * @returns {any[]}
 */
export function orderOpenWindowGroups(groups, previousIds = [], placement = null) {
  const live = new Map();
  for (const group of groups ?? []) {
    const id = idOf(group);
    if (Number.isInteger(id) && !live.has(id)) live.set(id, group);
  }

  const ids = [];
  for (const id of previousIds ?? []) {
    if (live.has(id) && !ids.includes(id)) ids.push(id);
  }
  for (const group of groups ?? []) {
    const id = idOf(group);
    if (live.has(id) && !ids.includes(id)) ids.push(id);
  }

  if (Number.isInteger(placement?.windowId) && Number.isInteger(placement?.afterWindowId) &&
      live.has(placement.windowId) && live.has(placement.afterWindowId) &&
      placement.windowId !== placement.afterWindowId) {
    const current = ids.indexOf(placement.windowId);
    if (current >= 0) ids.splice(current, 1);
    const anchor = ids.indexOf(placement.afterWindowId);
    ids.splice(anchor + 1, 0, placement.windowId);
  }

  return ids.map((id) => live.get(id));
}
