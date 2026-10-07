// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { el, isComposingKey } from "./dom.js";

/** One small, focus-stable text filter shared by Open and Inbox. */
/**
 * `debounceMs` may be a number or a function returning one, so a host with a
 * large mounted list can wait a little longer for the typing burst to end and
 * rebuild once instead of after every character.
 */
export function createTabFilterControl({
  placeholder, ariaLabel, rerender, onInput, onClear, shortcut = null, debounceMs = 60
}) {
  let value = "";
  let timer = 0;
  let generation = 0;
  const input = el("input", {
    type: "search",
    class: "open-filter-input",
    placeholder,
    "aria-label": ariaLabel
  });
  const element = el("div", { class: "open-filter-control" }, input);
  if (shortcut) {
    input.setAttribute("aria-keyshortcuts", shortcut);
    input.setAttribute("data-tip", `${ariaLabel} (${shortcut.toUpperCase()})`);
  }

  // Hosts route their single key listener here only while this section is active.
  function handleShortcut(event) {
    if (!shortcut || event.key !== shortcut || event.defaultPrevented || isComposingKey(event) ||
        event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
    const typing = [event.target, document.activeElement, ...(event.composedPath?.() ?? [])]
      .some(target => target?.isContentEditable || target?.matches?.("textarea, select") ||
        (target?.tagName === "INPUT" && !["checkbox", "radio", "button", "submit", "reset"]
          .includes((target.type || "text").toLowerCase())));
    if (typing || !input.isConnected || input.getClientRects().length === 0) return false;
    // A visible dialog or popover keeps its own keyboard scope, even if it has
    // not yet moved focus away from the page that opened it.
    const layers = document.querySelectorAll('[popover], [role="dialog"], [role="listbox"], [role="menu"], .tagmenu');
    if ([...layers].some(node => node.getClientRects().length > 0 &&
        !["hidden", "collapse"].includes(getComputedStyle(node).visibility))) return false;
    event.preventDefault();
    input.focus();
    input.select();
    return true;
  }

  const commit = (ownGeneration) => {
    clearTimeout(timer);
    const caret = input.selectionStart ?? value.length;
    return Promise.resolve(rerender()).then(() => requestAnimationFrame(() => {
      if (ownGeneration !== generation) return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(caret, caret);
    }));
  };

  const clear = () => {
    const ownGeneration = ++generation;
    value = "";
    input.value = "";
    onClear?.();
    return commit(ownGeneration);
  };

  input.addEventListener("input", () => {
    const ownGeneration = ++generation;
    value = input.value;
    onInput?.(value);
    clearTimeout(timer);
    const wait = typeof debounceMs === "function" ? debounceMs(value) : debounceMs;
    timer = setTimeout(() => commit(ownGeneration), Math.max(0, Number(wait) || 0));
  });
  input.addEventListener("keydown", (event) => {
    if (isComposingKey(event)) return;
    if (event.key !== "Escape" || !value) return;
    event.preventDefault();
    void clear();
  });

  return { element, input, clear, handleShortcut, value: () => value };
}
