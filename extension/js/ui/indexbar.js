// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * EveryTab — createIndexBar: the compact section index bar (filter box +
 * sort toggle + clickable jump chips), extracted from the Labels page
 * (L-nav, v0.8.41) so Sessions gets the exact same navigation (N32).
 *
 * Pure DOM component, no chrome.*; the CALLER owns filter-state persistence,
 * sort persistence, and what a jump does. Reuses the L-nav CSS classes
 * (.label-index / .label-filter / .label-sort / .label-chips) so both
 * sections look identical by construction.
 *
 * config:
 *   placeholder, filterAria      — filter input placeholder + aria-label
 *   filterValue                  — initial filter text (caller-persisted)
 *   onFilter(text)               — every filter change, incl. Esc clear
 *                                  (the caller narrows its cards, no re-render)
 *   sortModes [{id, label}]      — segmented sort buttons, in order
 *   sortMode, sortAria           — active id + group aria-label
 *   onSort(id)                   — persist + re-render (caller); only fires on change
 *   items [{key, text, count}]   — chip source, already sorted
 *   matcher(item, q)             — filter predicate; default substring of text
 *   onJump(key)                  — chip activation
 *   chipTitle(item)              — chip tooltip (default `Jump to "text"`)
 *   emptyText(q)                 — no-match note text
 *   chipCap                      — chips before "+N more" (default 10)
 *   groupRow                    — optional organization lens row between the
 *                                 filter/sort controls and item jump chips
 *   chipLabel                   — optional visible label for the jump-chip row
 *   facetSelection              — optional additive exact-label selection:
 *     {selectedKeys, onChange(keys)}. Typing narrows only the chooser; checked
 *     options toggle the AND set. The jump-chip row remains navigation only.
 */
import { el, isComposingKey } from "./dom.js";
import { msg } from "../lib/i18n.js";

let indexSequence = 0;

export function createIndexBar(config) {
  const {
    placeholder, filterAria, filterValue = "", onFilter,
    sortModes = [], sortMode, onSort, sortAria = msg("list_sort"),
    items, matcher = (it, q) => it.text.toLowerCase().includes(q),
    onJump, chipTitle = (it) => msg("list_jump_to_named", [it.text]),
    emptyText = (q) => msg("list_no_matches_named", [q]),
    chipCap = 10, groupRow = null, chipLabel = "", facetSelection = null
  } = config;

  let filter = filterValue;
  let expanded = false;

  const filterInput = el("input", {
    type: "search", class: "label-filter", placeholder,
    "aria-label": filterAria, value: filter
  });
  const facetId = `section-index-facets-${indexSequence + 1}`;
  const facetMenu = facetSelection ? el("div", {
    class: "label-facet-suggestions",
    id: facetId,
    role: "listbox",
    "aria-label": filterAria,
    popover: "manual",
    hidden: true
  }) : null;
  let facetIndex = -1;
  let facetObserver = null;
  let facetFrame = 0;
  const selectedKeys = () => [...(facetSelection?.selectedKeys ?? [])];
  const selectedSet = () => new Set(selectedKeys().map((key) => String(key).toLocaleLowerCase()));

  const facetMatches = () => {
    const q = filterInput.value.trim().toLocaleLowerCase();
    return items.filter((item) => !q || matcher(item, q));
  };

  const positionFacetMenu = () => {
    if (!facetMenu?.matches(":popover-open") || !filterInput.isConnected) return;
    const edge = 10;
    const gap = 8;
    const anchor = facetField.getBoundingClientRect();
    const available = Math.max(180, window.innerWidth - edge * 2);
    const width = Math.min(Math.max(Math.min(280, available), anchor.width), available);
    facetMenu.style.width = `${Math.round(width)}px`;
    facetMenu.style.left = `${Math.round(Math.max(edge,
      Math.min(anchor.left, window.innerWidth - width - edge)))}px`;
    facetMenu.style.top = `${Math.round(anchor.bottom + gap)}px`;
    const menuRect = facetMenu.getBoundingClientRect();
    if (menuRect.bottom > window.innerHeight - edge &&
        anchor.top - menuRect.height - gap >= edge) {
      facetMenu.style.top = `${Math.round(anchor.top - menuRect.height - gap)}px`;
      facetMenu.dataset.side = "top";
    } else {
      delete facetMenu.dataset.side;
    }
  };

  const scheduleFacetPosition = (event) => {
    if (event?.type === "scroll" && facetMenu?.contains(event.target)) return;
    cancelAnimationFrame(facetFrame);
    facetFrame = requestAnimationFrame(positionFacetMenu);
  };

  const openFacetMenu = () => {
    if (!facetMenu || facetMenu.hidden || !filterInput.isConnected) return;
    if (facetMenu.parentElement !== document.body) document.body.append(facetMenu);
    try { if (!facetMenu.matches(":popover-open")) facetMenu.showPopover(); }
    catch { facetMenu.dataset.open = "true"; }
    positionFacetMenu();
    window.addEventListener("resize", scheduleFacetPosition);
    window.addEventListener("scroll", scheduleFacetPosition, true);
    facetObserver ??= new MutationObserver(() => {
      if (!filterInput.isConnected) closeFacetMenu({ discard: true });
    });
    facetObserver.observe(document.body, { childList: true, subtree: true });
  };

  const renderFacetMenu = () => {
    if (!facetMenu) return;
    const matches = facetMatches();
    facetIndex = Math.min(facetIndex, matches.length - 1);
    const selected = selectedSet();
    facetMenu.replaceChildren(...matches.map((item, index) => {
      const isSelected = selected.has(String(item.key).toLocaleLowerCase());
      const isActive = index === facetIndex;
      return el("button", {
        type: "button",
        class: `label-facet-option${isSelected ? " is-selected" : ""}${isActive ? " active" : ""}`,
        id: `${facetId}-option-${index}`,
        role: "option",
        "aria-selected": isSelected ? "true" : "false",
        "aria-label": msg(isSelected ? "list_remove_label_filter" : "list_add_label_filter",
          [item.text]),
        onmousedown: (event) => event.preventDefault(),
        onclick: () => void toggleFacet(item.key)
      },
      el("span", { class: "label-facet-option-check", "aria-hidden": "true" }, isSelected ? "✓" : ""),
      el("span", { class: "label-facet-option-name" }, item.text),
      el("span", { class: "item-meta" }, String(item.count)));
    }));
    facetMenu.hidden = matches.length === 0;
    filterInput.setAttribute("aria-expanded", String(matches.length > 0));
    if (matches.length) {
      filterInput.setAttribute("aria-controls", facetMenu.id);
      if (facetIndex >= 0) {
        filterInput.setAttribute("aria-activedescendant", `${facetId}-option-${facetIndex}`);
      } else filterInput.removeAttribute("aria-activedescendant");
      openFacetMenu();
    } else closeFacetMenu();
  };

  function closeFacetMenu({ discard = false } = {}) {
    if (!facetMenu) return;
    cancelAnimationFrame(facetFrame);
    window.removeEventListener("resize", scheduleFacetPosition);
    window.removeEventListener("scroll", scheduleFacetPosition, true);
    facetObserver?.disconnect();
    facetObserver = null;
    try { if (facetMenu.matches(":popover-open")) facetMenu.hidePopover(); }
    catch { delete facetMenu.dataset.open; }
    facetMenu.hidden = true;
    filterInput.setAttribute("aria-expanded", "false");
    filterInput.removeAttribute("aria-controls");
    filterInput.removeAttribute("aria-activedescendant");
    facetMenu.style.removeProperty("left");
    facetMenu.style.removeProperty("top");
    facetMenu.style.removeProperty("width");
    if (discard || !facetWrap?.isConnected) facetMenu.remove();
    else if (facetMenu.parentElement !== facetWrap) facetWrap.append(facetMenu);
  }

  async function toggleFacet(key) {
    if (!facetSelection) return;
    const target = String(key).toLocaleLowerCase();
    const current = selectedKeys();
    const next = current.some((item) => String(item).toLocaleLowerCase() === target)
      ? current.filter((item) => String(item).toLocaleLowerCase() !== target)
      : [...current, key];
    filter = "";
    filterInput.value = "";
    closeFacetMenu();
    await facetSelection.onChange(next);
  }

  async function removeFacet(key) {
    if (!facetSelection) return;
    const target = String(key).toLocaleLowerCase();
    closeFacetMenu();
    await facetSelection.onChange(selectedKeys().filter((item) =>
      String(item).toLocaleLowerCase() !== target));
  }

  const facetField = facetSelection ? el("div", { class: "label-facet-field" },
    ...selectedKeys().map((key) => {
      const item = items.find((candidate) => String(candidate.key).toLocaleLowerCase() ===
        String(key).toLocaleLowerCase());
      const text = item?.text ?? String(key);
      return el("span", { class: "label-facet-token", title: text },
        el("span", { class: "label-facet-token-text" }, text),
        el("button", {
          type: "button", class: "x",
          "aria-label": msg("list_remove_label_filter", [text]),
          onclick: () => void removeFacet(key)
        }, "×"));
    }),
    filterInput
  ) : filterInput;
  const facetWrap = facetSelection
    ? el("div", { class: "label-facet-wrap" }, facetField, facetMenu)
    : null;
  const filterControl = facetWrap ?? filterInput;
  const chipRowId = `section-index-chips-${++indexSequence}`;
  const chipRow = el("div", { class: "label-chips", id: chipRowId });
  const chipViewport = el("div", { class: "label-chip-viewport" }, chipRow);
  const chipToggle = el("button", {
    class: "chip label-index-toggle", type: "button", hidden: true,
    "aria-controls": chipRowId, "aria-expanded": "false"
  });
  const chipLine = el("div", { class: "label-chip-line" },
    chipLabel ? el("span", { class: "label-chip-line-label" }, chipLabel) : null,
    chipViewport, chipToggle);
  const sortBtn = (m) => el("button", {
    class: "seg" + (sortMode === m.id ? " on" : ""),
    "aria-pressed": sortMode === m.id ? "true" : "false",
    onclick: () => { if (m.id !== sortMode) onSort(m.id); }
  }, m.label);
  const seg = el("div", { class: "label-sort", role: "group", "aria-label": sortAria },
    ...sortModes.map(sortBtn));

  function renderChips() {
    const q = facetSelection ? "" : filter.trim().toLowerCase();
    const matches = q ? items.filter((it) => matcher(it, q)) : items;
    chipRow.replaceChildren();
    if (matches.length === 0) {
      chipRow.append(el("span", { class: "item-meta" }, emptyText(filter.trim())));
      chipLine.classList.remove("has-more", "is-expanded");
      chipToggle.hidden = true;
      chipToggle.setAttribute("aria-expanded", "false");
      return;
    }
    const hasMore = matches.length > chipCap;
    for (const it of (expanded ? matches : matches.slice(0, chipCap))) {
      chipRow.append(el("button", { class: "chip label-chip", title: chipTitle(it),
        onclick: () => onJump(it.key) }, `${it.text} ${it.count}`));
    }
    chipLine.classList.toggle("has-more", hasMore);
    chipLine.classList.toggle("is-expanded", hasMore && expanded);
    chipToggle.hidden = !hasMore;
    chipToggle.setAttribute("aria-expanded", String(hasMore && expanded));
    chipToggle.textContent = expanded
      ? msg("list_show_less")
      : msg("list_more_count", [String(matches.length - chipCap)]);
  }

  chipToggle.addEventListener("click", () => {
    expanded = !expanded;
    renderChips();
  });

  filterInput.addEventListener("input", () => {
    filter = filterInput.value;
    expanded = false;
    renderChips();
    if (!facetSelection) onFilter?.(filter);
    facetIndex = -1;
    renderFacetMenu();
  });
  // N23-style Esc ladder: clear the text first, then blur out to the page.
  filterInput.addEventListener("keydown", (e) => {
    if (isComposingKey(e)) return;
    if (facetSelection && ["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) {
      const matches = facetMatches();
      if (!matches.length) return;
      e.preventDefault();
      if (e.key === "ArrowDown") facetIndex = (facetIndex + 1 + matches.length) % matches.length;
      else if (e.key === "ArrowUp") facetIndex = facetIndex < 0
        ? matches.length - 1 : (facetIndex - 1 + matches.length) % matches.length;
      else { void toggleFacet(matches[Math.max(0, facetIndex)].key); return; }
      renderFacetMenu();
      facetMenu.querySelector(".active")?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (e.key === "Backspace" && facetSelection && !filterInput.value &&
        selectedKeys().length && filterInput.selectionStart === 0) {
      e.preventDefault();
      void removeFacet(selectedKeys().at(-1));
      return;
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (filterInput.value) {
      filterInput.value = ""; filter = ""; expanded = false; renderChips();
      if (!facetSelection) onFilter?.("");
      renderFacetMenu();
    } else if (facetSelection && !facetMenu.hidden) closeFacetMenu();
    else filterInput.blur();
  });
  if (facetSelection) {
    filterInput.setAttribute("role", "combobox");
    filterInput.setAttribute("aria-autocomplete", "list");
    filterInput.setAttribute("aria-expanded", "false");
    filterInput.addEventListener("focusin", () => { facetIndex = -1; renderFacetMenu(); });
    filterInput.addEventListener("click", () => {
      facetIndex = -1;
      renderFacetMenu();
    });
    filterInput.addEventListener("blur", () => setTimeout(() => {
      if (!facetField.contains(document.activeElement) && !facetMenu.contains(document.activeElement)) {
        closeFacetMenu();
      }
    }, 0));
  }

  renderChips();
  return el("div", { class: "label-index section-local-sticky" },
    el("div", { class: "label-index-bar" }, filterControl, seg),
    groupRow,
    chipLine
  );
}
