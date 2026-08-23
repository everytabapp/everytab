/**
 * P2g-1 — the P2 combobox (interaction-model.md v0.3): ONE control for every
 * name-or-pick act. Two flavors:
 *   · pick-or-create (a `loadOptions` is given): opens with the full target
 *     list visible, typing filters it, an explicit announced "Create …" entry
 *     creates; picking an existing entry targets it (append / add-to semantics
 *     live in the caller). An exact-name match hides the Create entry, so
 *     duplicate names can't be created by typing.
 *   · plain text (no `loadOptions`): rename-style inline input.
 * ARIA 1.2 combobox (role, aria-expanded, aria-activedescendant). Esc cancels;
 * `swapInCombobox` returns focus to the invoking button. Modals are banned by
 * the spec — this control replaces `promptName` and the add-to-session select.
 */
import { el } from "./dom.js";

let seq = 0;

/**
 * @param {Object} o
 * @param {string} [o.ariaLabel]
 * @param {string} [o.placeholder]
 * @param {string} [o.value] initial text (plain/rename flavor)
 * @param {(() => Promise<Array<{id:string,name:string}>>)|null} [o.loadOptions]
 *   existing targets; presence of this switches on the pick-or-create flavor
 * @param {(v:string)=>string} [o.createLabel] label for the Create entry
 * @param {string|null} [o.emptyCreateLabel] when set, committing an empty input
 *   is allowed and shown as this entry (e.g. "New session (auto-name)")
 * @param {(v:{id:string|null,name:string,isNew:boolean})=>void|Promise<void>} o.onCommit
 * @param {()=>void} [o.onCancel]
 * @returns {{element: HTMLElement, focus: () => void}}
 */
export function createCombobox({
  ariaLabel = "Name or pick",
  placeholder = "",
  value = "",
  loadOptions = null,
  createLabel = (v) => `Create “${v}”`,
  emptyCreateLabel = null,
  onCommit,
  onCancel = () => {}
}) {
  const id = `cbx-${++seq}`;
  const listId = `${id}-list`;
  const input = el("input", { type: "text", class: "taginput", placeholder,
    role: "combobox", "aria-label": ariaLabel, "aria-autocomplete": "list",
    "aria-expanded": "false", "aria-controls": listId });
  input.value = value;
  const menu = el("div", { class: "tagmenu hidden", role: "listbox", id: listId });
  const box = el("span", { class: "tagbox cbx" }, input, menu);
  box.addEventListener("click", () => input.focus());

  const pickOrCreate = typeof loadOptions === "function";
  /** @type {Array<{id:string,name:string}>} */
  let options = [];
  /** @type {Array<{kind:"create"|"create-empty"|"pick", id?:string, name:string, label:string}>} */
  let entries = [];
  let sel = -1;
  let settled = false;
  let optionLoad = null;

  // A pick-or-create combobox is constructed only when its UI is being
  // revealed. Prime that one fresh option list immediately instead of relying
  // exclusively on a focus event: the native Popover API may move focus while
  // opening without dispatching another focus event when our controller then
  // focuses the same field. Every new control still performs a fresh read.
  async function loadAndRenderOptions() {
    if (!pickOrCreate || settled) return;
    optionLoad ??= Promise.resolve().then(loadOptions);
    options = (await optionLoad) ?? [];
    renderMenu();
  }

  function close() {
    menu.classList.add("hidden");
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function renderMenu() {
    if (!pickOrCreate || settled) return; // plain flavor never opens a menu
    const q = input.value.trim();
    const ql = q.toLowerCase();
    const hits = options.filter((o) => !ql || o.name.toLowerCase().includes(ql));
    const exact = q && options.some((o) => o.name.toLowerCase() === ql);
    entries = [];
    if (q && !exact) entries.push({ kind: "create", name: q, label: createLabel(q) });
    if (!q && emptyCreateLabel) entries.push({ kind: "create-empty", name: "", label: emptyCreateLabel });
    entries.push(...hits.map((o) => ({ kind: "pick", id: o.id, name: o.name, label: o.name })));
    if (entries.length === 0) { close(); sel = -1; return; }
    if (sel >= entries.length) sel = entries.length - 1;
    menu.replaceChildren(...entries.map((en, i) =>
      el("div", {
        class: `tagopt${en.kind === "pick" ? "" : " create"}${i === sel ? " on" : ""}`,
        role: "option", id: `${id}-opt-${i}`, "aria-selected": i === sel ? "true" : "false",
        // mousedown, not click: fire before the input's blur cancels the control
        onmousedown: (e) => { e.preventDefault(); commit(entries[i]); }
      }, en.label)));
    menu.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
    if (sel >= 0) input.setAttribute("aria-activedescendant", `${id}-opt-${sel}`);
    else input.removeAttribute("aria-activedescendant");
  }

  async function commit(entry) {
    if (settled) return;
    settled = true;
    input.disabled = true;
    close();
    await onCommit(entry.kind === "pick"
      ? { id: entry.id, name: entry.name, isNew: false }
      : { id: null, name: entry.name, isNew: true });
  }

  function cancel() {
    if (settled) return;
    settled = true;
    close();
    onCancel();
  }

  input.addEventListener("focus", () => loadAndRenderOptions());
  input.addEventListener("input", () => {
    sel = input.value.trim() ? 0 : (emptyCreateLabel ? 0 : -1);
    renderMenu();
  });
  // Blur = cancel (option mousedown preventDefaults, so picks land first).
  input.addEventListener("blur", () => setTimeout(cancel, 150));
  input.addEventListener("keydown", (e) => {
    const open = pickOrCreate && !menu.classList.contains("hidden");
    if (e.key === "ArrowDown" && open) {
      e.preventDefault();
      sel = Math.min(sel + 1, entries.length - 1);
      renderMenu();
    } else if (e.key === "ArrowUp" && open) {
      e.preventDefault();
      sel = Math.max(sel - 1, 0);
      renderMenu();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const text = input.value.trim();
      if (open && sel >= 0) commit(entries[sel]);
      else if (text) commit({ kind: "create", name: text });
      else if (emptyCreateLabel) commit({ kind: "create-empty", name: "" });
      else cancel(); // plain flavor emptied out → nothing to commit
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  });

  if (pickOrCreate) queueMicrotask(() => { void loadAndRenderOptions(); });

  return {
    element: box,
    focus: () => { input.focus(); if (input.select) input.select(); }
  };
}

/**
 * Swap a button for a combobox in place; restore the button (and its focus)
 * on cancel and after commit. This is P2's standard entry: the invoking
 * button IS the anchor, so Esc puts focus back exactly where it was.
 * @param {HTMLElement} button
 * @param {Parameters<typeof createCombobox>[0]} opts
 */
export function swapInCombobox(button, opts) {
  const restore = () => {
    box.element.replaceWith(button);
    button.focus();
  };
  const box = createCombobox({
    ...opts,
    onCommit: async (v) => {
      if (opts.restoreBeforeCommit) restore();
      await opts.onCommit(v);
      if (!opts.restoreBeforeCommit) restore();
    },
    onCancel: () => { opts.onCancel?.(); restore(); }
  });
  button.replaceWith(box.element);
  box.focus();
  return box;
}
