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
 */
import { el } from "./dom.js";
import { msg } from "../lib/i18n.js";

let indexSequence = 0;

export function createIndexBar(config) {
  const {
    placeholder, filterAria, filterValue = "", onFilter,
    sortModes = [], sortMode, onSort, sortAria = msg("list_sort"),
    items, matcher = (it, q) => it.text.toLowerCase().includes(q),
    onJump, chipTitle = (it) => msg("list_jump_to_named", [it.text]),
    emptyText = (q) => msg("list_no_matches_named", [q]),
    chipCap = 10, groupRow = null
  } = config;

  let filter = filterValue;
  let expanded = false;

  const filterInput = el("input", {
    type: "search", class: "label-filter", placeholder,
    "aria-label": filterAria, value: filter
  });
  const chipRowId = `section-index-chips-${++indexSequence}`;
  const chipRow = el("div", { class: "label-chips", id: chipRowId });
  const chipViewport = el("div", { class: "label-chip-viewport" }, chipRow);
  const chipToggle = el("button", {
    class: "chip label-index-toggle", type: "button", hidden: true,
    "aria-controls": chipRowId, "aria-expanded": "false"
  });
  const chipLine = el("div", { class: "label-chip-line" }, chipViewport, chipToggle);
  const sortBtn = (m) => el("button", {
    class: "seg" + (sortMode === m.id ? " on" : ""),
    "aria-pressed": sortMode === m.id ? "true" : "false",
    onclick: () => { if (m.id !== sortMode) onSort(m.id); }
  }, m.label);
  const seg = el("div", { class: "label-sort", role: "group", "aria-label": sortAria },
    ...sortModes.map(sortBtn));

  function renderChips() {
    const q = filter.trim().toLowerCase();
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
    onFilter?.(filter); // narrows the caller's cards too (no re-render → keeps focus)
  });
  // N23-style Esc ladder: clear the text first, then blur out to the page.
  filterInput.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (filterInput.value) {
      filterInput.value = ""; filter = ""; expanded = false; renderChips(); onFilter?.("");
    } else filterInput.blur();
  });

  renderChips();
  return el("div", { class: "label-index section-local-sticky" },
    el("div", { class: "label-index-bar" }, filterInput, seg),
    groupRow,
    chipLine
  );
}
