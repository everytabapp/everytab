// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

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
import { el, isComposingKey } from "./dom.js";
import { collectLabels, sortLabelGroups } from "../lib/labels.js";
import { msg as localeMessage } from "../lib/i18n.js";

let seq = 0;

/**
 * @param {{placeholder?: string, ariaLabel?: string, onSubmit?: () => void, onCancel?: () => void,
 *   onChange?: (labels:string[]) => void,
 *   loadOptions?: () => Promise<string[]>|string[]}} [opts]
 *   `onSubmit`: called when Enter is pressed on an empty input (nothing left
 *   to commit into a chip) — the caller wires it to its Apply action.
 *   `onCancel` (N22): called when Escape is pressed with the dropdown already
 *   closed — the caller closes its panel / restores focus. Without it, Esc
 *   blurs the input, so keyboard navigation resumes (bulk bars).
 * @returns {{element: HTMLElement, getLabels: () => string[],
 *   getEntries: () => Promise<{name:string,isNew:boolean}[]>, clear: () => void}}
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
    placeholder: opts.placeholder ?? localeMessage("list_labels_placeholder"),
    role: "combobox", "aria-label": opts.ariaLabel ?? localeMessage("list_labels_input_aria"), "aria-autocomplete": "list",
    "aria-expanded": "false", "aria-controls": `${cid}-list`
  });
  const menu = el("div", { class: "tagmenu hidden", role: "listbox", id: `${cid}-list` });
  const box = el("span", { class: "tagbox" }, chipsWrap, input, menu);
  box.addEventListener("click", () => input.focus());

  /** @type {string[]} all existing labels (refreshed on focus) */
  let options = [];
  /** @type {{value:string, create:boolean}[]} current dropdown entries */
  let filtered = [];
  let sel = -1;
  let navigated = false; // has the user arrowed into the menu?
  let optionLoad = null;
  // Chromium may restore the combobox's pre-click value after a pointer-down
  // handler has already selected an option and cleared the field. Remember
  // that consumed query until a real beforeinput event proves the user started
  // another edit; Apply must never turn the stale query into a second Label.
  let consumedQuery = "";

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

  async function ensureOptions() {
    optionLoad ??= loadOptions();
    await optionLoad;
  }

  async function loadAndRenderOptions() {
    await ensureOptions();
    renderMenu();
  }

  function renderChips() {
    chipsWrap.replaceChildren(
      ...chips.map((l) =>
        el("span", { class: "chip" }, l,
          el("button", { class: "x", type: "button", "aria-label": localeMessage("list_remove_label_chip", [l]),
            onclick: (e) => {
              e.stopPropagation();
              chips.splice(chips.indexOf(l), 1);
              renderChips();
            } }, "×"))
      )
    );
    opts.onChange?.([...chips]);
  }

  function add(label, { fromExistingQuery = "" } = {}) {
    const v = label.trim();
    consumedQuery = String(fromExistingQuery ?? "").trim();
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
    const raw = input.value.trim();
    const q = raw.toLowerCase();
    const existing = options.filter((o) => !chips.includes(o) && (!q || o.toLowerCase().includes(q)));
    const exact = options.some((o) => o.toLowerCase() === q) ||
      chips.some((o) => o.toLowerCase() === q);
    filtered = [
      ...(!raw || exact ? [] : [{ value: raw, create: true }]),
      ...existing.map((value) => ({ value, create: false }))
    ];
    if (filtered.length === 0) {
      closeMenu();
      return;
    }
    if (sel >= filtered.length) sel = filtered.length - 1;
    menu.replaceChildren(
      ...filtered.map((entry, i) =>
        el("div", {
          class: `tagopt${entry.create ? " create" : ""}${i === sel ? " on" : ""}`,
          role: "option", id: `${cid}-opt-${i}`, "aria-selected": i === sel ? "true" : "false",
          // mousedown, not click: fire before the input's blur closes the menu
          onmousedown: (e) => {
            e.preventDefault();
            add(entry.value, { fromExistingQuery: entry.create ? "" : raw });
          }
        }, entry.create
          ? localeMessage("list_create_new_label_named", [entry.value])
          : entry.value))
    );
    menu.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
    if (sel >= 0) input.setAttribute("aria-activedescendant", `${cid}-opt-${sel}`);
    else input.removeAttribute("aria-activedescendant");
  }

  input.addEventListener("beforeinput", () => { consumedQuery = ""; });
  input.addEventListener("input", () => {
    if (consumedQuery && input.value.trim() === consumedQuery) {
      input.value = "";
      closeMenu();
      return;
    }
    consumedQuery = "";
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
    if (isComposingKey(e)) return;
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
      if (menuOpen && sel >= 0 && (navigated || !input.value.trim())) {
        const entry = filtered[sel];
        add(entry.value, { fromExistingQuery: entry.create ? "" : input.value });
      }
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
      if (consumedQuery && input.value.trim() === consumedQuery) input.value = "";
      else if (input.value.trim()) add(input.value);
      return [...chips];
    },
    // Inline organization uses the distinction already owned by this combobox
    // to describe each selected Label. Wait for the same option snapshot the
    // menu uses so a fast click cannot misclassify an existing Label as new.
    getEntries: async () => {
      if (consumedQuery && input.value.trim() === consumedQuery) input.value = "";
      else if (input.value.trim()) add(input.value);
      await ensureOptions();
      closeMenu();
      return chips.map((name) => ({
        name,
        isNew: !options.some((option) => option.toLocaleLowerCase() === name.toLocaleLowerCase())
      }));
    },
    clear: () => {
      chips.length = 0;
      input.value = "";
      consumedQuery = "";
      renderChips();
      closeMenu();
    }
  };
}
