/**
 * N42 — which device drove the last interaction.
 *
 * The purposeful-interaction rule (interaction-model.md v0.4) gives POINTER
 * destinations the Ring and Wash arrival cue and gives keyboard destinations
 * nothing, because the focus ring is already the cue. That decision used to be
 * inferred from `document.activeElement.matches(":focus-visible")`, which is
 * not the same question: a text field matches `:focus-visible` whenever it is
 * focused, however it was focused. On a fresh Dashboard or New Tab the search
 * box is focused before the user touches anything, so the very first jump of a
 * session was read as keyboard-driven and its highlight was suppressed.
 *
 * Tracking the modality directly answers the real question. The default is
 * "pointer" so a first click cues; the first keydown flips it, and a pointer
 * event flips it back.
 */

let modality = "pointer";

/** Install once per document. Passive listeners, capture phase, no state read. */
export function initInputModality(doc = globalThis.document) {
  if (!doc?.addEventListener) return;
  const pointer = () => { modality = "pointer"; };
  doc.addEventListener("pointerdown", pointer, { capture: true, passive: true });
  doc.addEventListener("mousedown", pointer, { capture: true, passive: true });
  doc.addEventListener("keydown", (e) => {
    // A bare modifier press is not navigation; it precedes a click as often as
    // it precedes a shortcut.
    if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
    modality = "keyboard";
  }, { capture: true, passive: true });
}

/** True when the last interaction came from a pointer — the arrival-cue gate. */
export function pointerDriven() {
  return modality === "pointer";
}

/** Test seam. */
export function setInputModality(next) {
  modality = next === "keyboard" ? "keyboard" : "pointer";
}
