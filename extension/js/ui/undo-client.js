// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Worker-owned Undo client shared by every extension document. */

/**
 * @param {string} [id]
 * @returns {Promise<{ok:boolean,status:"undone"|"stale"|"unavailable"|"busy"|"incomplete",entry:any|null}>}
 */
export async function requestUndo(id) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "undo-last",
      ...(id ? { id } : {})
    });
    if (response?.status) return response;
    return {
      ok: Boolean(response?.ok),
      status: response?.ok ? "undone" : "unavailable",
      entry: response?.entry ?? null
    };
  } catch {
    return { ok: false, status: "unavailable", entry: null };
  }
}

/**
 * Clear Activity only after the worker has recovered or completed any claimed
 * browser effect. This keeps one owner for the Journal lifecycle.
 * @returns {Promise<boolean>}
 */
export async function requestClearJournal() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "clear-journal" });
    return response?.ok === true;
  } catch {
    return false;
  }
}
