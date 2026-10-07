// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * pending.js — a tiny DOM-parameterized "one action in flight" helper (F8-R2r C8).
 *
 * While an async action initiated by `btn` is running, the control is disabled and marked
 * `aria-busy` so a duplicate activation cannot double-send; it is restored when the action
 * settles (on success a surface usually closes/navigates, in which case the restore is a
 * harmless no-op). DOM-free of any specific page, so it is directly testable with a button
 * shim exposing `dataset`, `disabled`, and `setAttribute`/`removeAttribute`.
 * @param {{dataset:object, disabled:boolean, setAttribute:Function, removeAttribute:Function}} btn
 * @param {() => Promise<void>} fn
 */
export async function withPending(btn, fn) {
  if (btn.dataset.busy === "1") return; // a second activation while pending is ignored
  btn.dataset.busy = "1";
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  try {
    await fn();
  } finally {
    btn.dataset.busy = "";
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  }
}
