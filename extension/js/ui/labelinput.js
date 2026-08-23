/**
 * M6 — tag-style label input (labeling is the center of the product, so this
 * is a real component, not a text field):
 *   · typing filters a dropdown of all existing labels
 *   · ↑/↓ navigate, Enter picks the highlighted suggestion
 *   · Enter/Tab on typed text creates a new label
 *   · chosen labels become chips inside the frame, removable with ×
 *   · Backspace on an empty input removes the last chip
 *   · Enter on an empty input confirms (opts.onSubmit) — type, Enter, Enter
 *     applies without reaching for the mouse (P2f N13)
 */
import { el } from "./dom.js";
import { collectLabels, sortLabelGroups } from "../lib/labels.js";

let seq = 0;

/**
 * @param {{placeholder?: string, ariaLabel?: string, onSubmit?: () => void, onCancel?: () => void,
 *   loadOptions?: () => Promise<string[]>|string[]}} [opts]
 *   `onSubmit`: called when Enter is pressed on an empty input (nothing left
 *   to commit into a chip) — the caller wires it to its Apply action.
 *   `onCancel` (N22): called when Escape is pressed with the dropdown already
 *   closed — the caller closes its panel / restores focus. Without it, Esc
 *   blurs the input, so keyboard navigation resumes (bulk bars).
 * @returns {{element: HTMLElement, getLabels: () => string[], clear: () => void}}
 */
export function createLabelInput(opts = {}) {
  // P2g-2: same ARIA 1.2 combobox semantics as combobox.js (the P2 pattern) —
  // this is the multi-value chip flavor of the same control family.
  const cid = `lbl-${++seq}`;
  /** @type {string[]} */
  const chips = [];
  const chipsWrap = el("span", { class: "tagchips" });
  const input = el("input", {
    type: "text",
    class: "taginput",
    placeholder: opts.placeholder ?? "Labels…",
    role: "combobox", "aria-label": opts.ariaLabel ?? "Labels", "aria-autocomplete": "list",
    "aria-expanded": "false", "aria-controls": `${cid}-list`
  });
  const menu = el("div", { class: "tagmenu hidden", role: "listbox", id: `${cid}-list` });
  const box = el("span", { class: "tagbox" }, chipsWrap, input, menu);
  box.addEventListener("click", () => input.focus());

  /** @type {string[]} all existing labels (refreshed on focus) */
  let options = [];
  /** @type {string[]} current dropdown entries */
  let filtered = [];
  let sel = -1;
  let navigated = false; // has the user arrowed into the menu?
  let optionLoad = null;

  async function loadOptions() {
    if (typeof opts.loadOptions === "function") {
      options = [...new Set(((await opts.loadOptions()) ?? []).map(String).map((value) => value.trim())
        .filter(Boolean))];
      return;
    }
    // Suggest most-recently-used labels first, not alphabetically — typeahead
    // should surface what you just applied. sortLabelGroups "recent" = latest
    // carrier `modifiedAt` (L-nav-5), ties → A–Z.
    options = sortLabelGroups(await collectLabels(), "recent").map((g) => g.label);
  }

  async function loadAndRenderOptions() {
    optionLoad ??= loadOptions();
    await optionLoad;
    renderMenu();
  }

  function renderChips() {
    chipsWrap.replaceChildren(
      ...chips.map((l) =>
        el("span", { class: "chip" }, l,
          el("button", { class: "x", type: "button", "aria-label": `Remove label ${l}`,
            onclick: (e) => {
              e.stopPropagation();
              chips.splice(chips.indexOf(l), 1);
              renderChips();
            } }, "×"))
      )
    );
  }

  function add(label) {
    const v = label.trim();
    if (!v || chips.includes(v)) {
      input.value = "";
      closeMenu();
      return;
    }
    chips.push(v);
    renderChips();
    input.value = "";
    closeMenu();
    input.focus();
  }

  function closeMenu() {
    menu.classList.add("hidden");
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    sel = -1;
    navigated = false;
  }

  function renderMenu() {
    const q = input.value.trim().toLowerCase();
    filtered = options.filter((o) => !chips.includes(o) && (!q || o.toLowerCase().includes(q)));
    if (filtered.length === 0) {
      closeMenu();
      return;
    }
    if (sel >= filtered.length) sel = filtered.length - 1;
    menu.replaceChildren(
      ...filtered.map((o, i) =>
        el("div", {
          class: `tagopt${i === sel ? " on" : ""}`,
          role: "option", id: `${cid}-opt-${i}`, "aria-selected": i === sel ? "true" : "false",
          // mousedown, not click: fire before the input's blur closes the menu
          onmousedown: (e) => { e.preventDefault(); add(o); }
        }, o))
    );
    menu.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
    if (sel >= 0) input.setAttribute("aria-activedescendant", `${cid}-opt-${sel}`);
    else input.removeAttribute("aria-activedescendant");
  }

  input.addEventListener("input", () => {
    // Don't pre-highlight the first suggestion while typing: Enter creates the
    // typed text (a new label), so a highlighted-looking row that Enter WON'T
    // pick is misleading. The highlight appears only once the user arrows in.
    sel = -1;
    navigated = false;
    renderMenu();
  });
  input.addEventListener("focus", () => loadAndRenderOptions());
  input.addEventListener("blur", () => setTimeout(closeMenu, 150));
  input.addEventListener("keydown", (e) => {
    const menuOpen = !menu.classList.contains("hidden");
    if (e.key === "ArrowDown" && menuOpen) {
      e.preventDefault();
      sel = Math.min(sel + 1, filtered.length - 1);
      navigated = true;
      renderMenu();
    } else if (e.key === "ArrowUp" && menuOpen) {
      e.preventDefault();
      sel = Math.max(sel - 1, 0);
      navigated = true;
      renderMenu();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (menuOpen && sel >= 0 && (navigated || !input.value.trim())) add(filtered[sel]);
      else if (input.value.trim()) add(input.value);
      // N13: empty input + Enter = confirm. The chips are the pending value;
      // a second Enter after typing a label applies without the mouse.
      else if (opts.onSubmit) { closeMenu(); opts.onSubmit(); }
    } else if (e.key === "Tab" && input.value.trim()) {
      e.preventDefault();
      add(input.value);
    } else if (e.key === "Backspace" && !input.value && chips.length > 0) {
      chips.pop();
      renderChips();
    } else if (e.key === "Escape") {
      // N22: first Esc closes the dropdown; the next (or an Esc with it
      // already closed) LEAVES the label UI instead of trapping the user.
      const menuWasOpen = !menu.classList.contains("hidden");
      closeMenu();
      if (!menuWasOpen) {
        if (opts.onCancel) opts.onCancel();
        else input.blur();
      }
    }
  });

  // Like the single-value shared combobox, this control is created only when
  // its picker is being revealed. Prime suggestions once so native popover
  // autofocus cannot leave a visually empty list if it absorbs the focus event.
  queueMicrotask(() => { void loadAndRenderOptions(); });

  return {
    element: box,
    // N5: commit any typed-but-uncommitted text first (same normalize path as
    // Enter), so "type a label then click Apply" works everywhere, not just when
    // the user remembers to press Enter/Tab.
    getLabels: () => {
      if (input.value.trim()) add(input.value);
      return [...chips];
    },
    clear: () => {
      chips.length = 0;
      input.value = "";
      renderChips();
      closeMenu();
    }
  };
}
