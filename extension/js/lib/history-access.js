// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** One reversible optional capability used by Search and its suggestions. */
const HISTORY_PERMISSION = Object.freeze({ permissions: ["history"] });

export async function hasHistoryAccess() {
  try {
    return Boolean(await chrome.permissions.contains(HISTORY_PERMISSION));
  } catch {
    return false;
  }
}

/** Must be called from a direct user gesture. */
export async function requestHistoryAccess() {
  try {
    return Boolean(await chrome.permissions.request(HISTORY_PERMISSION));
  } catch {
    return false;
  }
}

/** Revocation changes no EveryTab saved data. */
export async function removeHistoryAccess() {
  try {
    return Boolean(await chrome.permissions.remove(HISTORY_PERMISSION));
  } catch {
    return false;
  }
}

/**
 * Subscribe to browser-level permission changes without persisting duplicate state.
 * @param {(enabled:boolean) => void} listener
 * @returns {() => void}
 */
export function onHistoryAccessChanged(listener) {
  const added = (permissions) => {
    if (permissions?.permissions?.includes("history")) listener(true);
  };
  const removed = (permissions) => {
    if (permissions?.permissions?.includes("history")) listener(false);
  };
  chrome.permissions.onAdded?.addListener(added);
  chrome.permissions.onRemoved?.addListener(removed);
  return () => {
    chrome.permissions.onAdded?.removeListener(added);
    chrome.permissions.onRemoved?.removeListener(removed);
  };
}
