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
import { requestUndo } from "./undo-client.js";

/** @returns {{ element: HTMLElement, showToast: Function, showNotice: Function, hideToast: () => void }} */
export function createUndoToast({ afterUndo = null } = {}) {
  const element = el("div", { class: "toast hidden", role: "status", "aria-live": "polite" });
  let toastTimer = 0;
  function hideToast() {
    element.classList.add("hidden");
  }
  function showToast(entry, undone = false) {
    element.classList.remove("toast-alert");
    // N42: filter falsy children. An undone toast has no Undo button, and
    // `replaceChildren` stringifies a raw `null` to the text "null" — which is
    // exactly how "Undone: Saved 1 labeled copy null" reached the user. Same
    // defect the notice path already fixed.
    element.replaceChildren(
      ...[
        el("span", {}, undone ? `Undone: ${entry.label}` : entry.label),
        undone
          ? null
          : el("button", { class: "mini2", onclick: async () => {
              const result = await requestUndo(entry.id);
              if (result.status === "undone" && result.entry) {
                showToast(result.entry, true);
                afterUndo?.(result.entry);
              } else if (result.status === "stale") {
                showNotice("Newer changes were kept. This action was not undone.");
              } else if (result.status === "incomplete") {
                showNotice("Undo could not finish every browser action.");
              }
            } }, "Undo"),
        el("button", { class: "mini2", "aria-label": "Dismiss", onclick: hideToast }, "×")
      ].filter(Boolean)
    );
    element.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 8000);
  }
  /** One-off alert toast (no undo) with an optional action — used for sync failures. */
  function showNotice(message, action, actionLabel) {
    element.classList.add("toast-alert");
    // Filter falsy children: replaceChildren stringifies a raw `null` to the text
    // "null" (it appeared after no-action notices like "Copied N links").
    element.replaceChildren(
      ...[
        el("span", {}, message),
        action ? el("button", { class: "mini2", onclick: () => { hideToast(); action(); } }, actionLabel ?? "Open") : null,
        el("button", { class: "mini2", "aria-label": "Dismiss", onclick: hideToast }, "×")
      ].filter(Boolean)
    );
    element.classList.remove("hidden");
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
