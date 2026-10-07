// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Shared pointer-drag mechanics for tab lists.
 *
 * A surface owns the meaning of a move and the shape of its payload. This
 * module owns the gesture details that must stay identical everywhere:
 * delayed destination reveal (so dragstart never moves its source), selected
 * count preview, source/home styling, cleanup, and drop-zone feedback.
 */
import { el } from "./dom.js";
import { icon } from "./icons.js";
import { listUnit } from "./list-copy.js";

/**
 * @param {{bodyClass: string, scopeHome?: boolean, onReset?: () => void}} options
 */
export function createTabDragController({ bodyClass, scopeHome = false, onReset = () => {} }) {
  let state = null;
  let revealTimer = 0;
  let preview = null;
  let home = null;

  const reset = () => {
    clearTimeout(revealTimer);
    state?.sourceRowEl?.classList.remove("dragging");
    home?.classList.remove("drag-home");
    preview?.remove();
    document.body.classList.remove(bodyClass);
    state = null;
    preview = null;
    home = null;
    onReset();
  };

  const start = (ctx, event, payload, count = 1, transferValue = "") => {
    reset();
    state = { ...payload, count, sourceRowEl: ctx.rowEl };
    ctx.rowEl.classList.add("dragging");
    if (scopeHome) {
      home = ctx.rowEl.closest("[data-tablist-card]");
      home?.classList.add("drag-home");
    }
    preview = el("div", { class: "tab-drag-preview", "aria-hidden": "true" },
      icon("open", 16), el("span", {}, listUnit("tab", count)));
    document.body.append(preview);
    revealTimer = setTimeout(() => document.body.classList.add(bodyClass), 0);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(transferValue));
    event.dataTransfer.setDragImage?.(preview, 18, 18);
    return state;
  };

  return { start, reset, current: () => state };
}

/**
 * Build a destination whose visibility is controlled by the surface body
 * class. `canDrop` is checked on both hover and drop so stale DOM cannot turn
 * an invalid destination into a mutation.
 */
export function createTabDropZone({ className, text = "", label = "", canDrop, onDrop }) {
  const zone = el("div", {
    class: className,
    ...(label ? { role: "separator", "aria-orientation": "horizontal", "aria-label": label, title: label } : {})
  }, text);
  zone.addEventListener("dragover", (event) => {
    if (!canDrop()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    zone.classList.add("on");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("on"));
  zone.addEventListener("drop", async (event) => {
    event.preventDefault();
    zone.classList.remove("on");
    if (!canDrop()) return;
    await onDrop(event);
  });
  return zone;
}
