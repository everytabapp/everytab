// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * F14-2b — the shared undo/notice toast (one per document).
 *
 * `showToast` renders a journaled action with an Undo button; `showNotice` renders
 * a one-off alert (sync failures, copy results) with an optional action. Both
 * auto-dismiss. `createUndoToast()` returns the fixed-position element plus the
 * three functions — destructure into the same names so existing call sites are
 * unchanged. `bindUndoShortcut(showToast)` wires Ctrl/⌘+Z to "undo latest + toast".
 * Both the dashboard and the side panel use these, so undo behaves identically.
 */
import { el } from "./dom.js";
import { msg as localeMessage } from "../lib/i18n.js";
import { requestUndo } from "./undo-client.js";

/** @returns {{ element: HTMLElement, showToast: Function, showNotice: Function, hideToast: () => void }} */
export function createUndoToast({ afterUndo = null } = {}) {
  const element = el("div", { class: "toast hidden", role: "status", "aria-live": "polite" });
  let toastTimer = 0;
  let generation = 0;
  let animation = null;
  let lastOutsideFocus = null;
  let shown = false;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const cancelMotion = () => { animation?.cancel(); animation = null; };
  const move = (visible) => {
    const wasHidden = element.classList.contains("hidden");
    const style = !wasHidden ? getComputedStyle(element) : null;
    const from = { opacity: style?.opacity ?? "0", transform: style?.transform ?? "translateY(6px)" };
    cancelMotion();
    shown = visible;
    element.inert = !visible;
    element.setAttribute("aria-hidden", String(!visible));
    if (visible) element.classList.remove("hidden");
    const finish = () => { if (!shown) element.classList.add("hidden"); };
    if (reduced.matches || typeof element.animate !== "function" || !element.isConnected) {
      finish();
      return;
    }
    const motionStyle = getComputedStyle(element);
    const configuredDuration = Number.parseFloat(motionStyle.getPropertyValue(
      visible ? "--motion-continuity" : "--motion-reveal"
    ));
    const duration = Number.isFinite(configuredDuration) && configuredDuration >= 0
      ? configuredDuration : visible ? 180 : 140;
    const easing = motionStyle.getPropertyValue("--ease-out").trim() || "cubic-bezier(.2,.8,.2,1)";
    const effect = element.animate([from,
      { opacity: visible ? 1 : 0, transform: visible ? "none" : "translateY(4px)" }
    ], { duration, easing });
    animation = effect;
    effect.onfinish = () => {
      if (animation !== effect) return;
      animation = null;
      finish();
    };
  };
  reduced.addEventListener("change", () => {
    if (!reduced.matches) return;
    cancelMotion();
    if (!shown) element.classList.add("hidden");
  });
  function hideToast() {
    generation += 1;
    clearTimeout(toastTimer);
    if (element.contains(document.activeElement)) {
      if (lastOutsideFocus?.isConnected) lastOutsideFocus.focus({ preventScroll: true });
      else document.activeElement?.blur();
    }
    move(false);
  }
  const replace = (children) => {
    const heldFocus = element.contains(document.activeElement);
    if (!heldFocus) lastOutsideFocus = document.activeElement;
    element.replaceChildren(...children);
    move(true);
    if (heldFocus) element.querySelector("button")?.focus({ preventScroll: true });
  };
  function showToast(entry, undone = false) {
    const token = ++generation;
    let undoPending = false;
    element.classList.remove("toast-alert");
    // N42: filter falsy children. An undone toast has no Undo button, and
    // `replaceChildren` stringifies a raw `null` to the text "null" — which is
    // exactly how "Undone: Saved 1 labeled copy null" reached the user. Same
    // defect the notice path already fixed.
    replace(
      [
        el("span", {}, undone ? localeMessage("toast_undone", [entry.label]) : entry.label),
        undone
          ? null
          : el("button", { class: "mini2", onclick: async (event) => {
              if (undoPending) return;
              undoPending = true;
              const button = event.currentTarget;
              button.setAttribute("aria-disabled", "true");
              const result = await requestUndo(entry.id);
              if (result.status === "undone" && result.entry) afterUndo?.(result.entry);
              if (token !== generation) return;
              undoPending = false;
              button.removeAttribute("aria-disabled");
              if (result.status === "undone" && result.entry) {
                showToast(result.entry, true);
              } else if (result.status === "stale") {
                showNotice(localeMessage("undo_stale"));
              } else if (result.status === "incomplete") {
                showNotice(localeMessage("undo_incomplete"));
              }
            } }, localeMessage("action_undo")),
        el("button", { class: "mini2", "aria-label": localeMessage("toast_dismiss"), onclick: hideToast }, "×")
      ].filter(Boolean)
    );
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 8000);
  }
  /** One-off alert toast (no undo) with an optional action — used for sync failures. */
  function showNotice(message, action, actionLabel) {
    generation += 1;
    element.classList.add("toast-alert");
    // Filter falsy children: replaceChildren stringifies a raw `null` to the text
    // "null" (it appeared after no-action notices like "Copied N links").
    replace(
      [
        el("span", {}, message),
        action ? el("button", { class: "mini2", onclick: () => { hideToast(); action(); } }, actionLabel ?? localeMessage("toast_open_action")) : null,
        el("button", { class: "mini2", "aria-label": localeMessage("toast_dismiss"), onclick: hideToast }, "×")
      ].filter(Boolean)
    );
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 10000);
  }
  return { element, showToast, showNotice, hideToast };
}

/**
 * Bind Ctrl/⌘+Z on the document to "undo the latest journaled action + toast it".
 * Call once per surface. Ignores the shortcut while the user is typing in a field.
 * @param {(entry: any, undone?: boolean) => void} showToast
 * @param {((entry: any) => void)|null} [afterUndo] runs once the undo committed
 */
export function bindUndoShortcut(showToast, afterUndo = null) {
  document.addEventListener("keydown", async (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z" || e.shiftKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    e.preventDefault();
    const result = await requestUndo();
    if (result.status === "undone" && result.entry) {
      showToast(result.entry, true);
      afterUndo?.(result.entry);
    }
  });
}
