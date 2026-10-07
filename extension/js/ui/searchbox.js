// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import {
  searchResultTarget, createSearchSession, bindSearchSnapshotInvalidation,
  createRunGeneration, SEARCH_DEBOUNCE_MS
} from "../lib/search.js";
import {
  searchCount, searchResultAction, searchResultMeta
} from "../lib/search-copy.js";
import { msg } from "../lib/i18n.js";
import { hasHistoryAccess, onHistoryAccessChanged } from "../lib/history-access.js";
import { el, isComposingKey } from "./dom.js";
// F21's label-recency register: the ghost `label:` examples are ordered by it.
import { getLabelMeta } from "../lib/label-meta.js";
import { recentOpenTabResults } from "../lib/search-popup.js";
import { browserHandoffForInput } from "../lib/search-handoff.js";
// E3-0: dev-only perf spans (B7 search compute + paint); guarded no-ops in prod.
import { pspan } from "../lib/perf.js";

/**
 * Activate a result. M0 lesson: tab mutations go through the background
 * worker — the popup dies as soon as focus shifts.
 * @param {import("../lib/search.js").SearchResult} r
 */
function activate(r) {
  const target = searchResultTarget(r);
  if (target) chrome.runtime.sendMessage(target);
}

/**
 * Compatibility alias for callers which only need an explicit destination.
 * Search text now travels through Chrome's default-provider Search API rather
 * than a hard-coded provider, so it deliberately returns null for that case.
 * @param {string} text
 */
export function toNavigationUrl(text) {
  const handoff = browserHandoffForInput(text);
  return handoff?.type === "open-url" ? handoff.url : null;
}

/**
 * Shared universal-search component (popup + dashboard + newtab + side panel).
 *
 * S5: the results dropdown is an absolute overlay (positioned by the surface CSS
 * against `.search-box`), so nothing it contains — result rows OR the empty-query
 * ghost suggestion controls — ever moves page content. Ghosts render *inside*
 * the dropdown as its empty-query state: navigation shortcuts stay in one row,
 * while recent labels live in a separate additive-filter row. Frequency data
 * resolves once per page-load, so later focuses are instant.
 * Every focused, empty Search host shows the same two-level state: navigation
 * chips first, then the ten most recently used open tabs. `autofocusWhen` is a
 * focus-only hook for the popup's keyboard command; it does not change content.
 * @param {{placeholder?: string, historyPlaceholder?: string, exitToList?: Function,
 *   escapeToList?: Function, emptyArrowExit?: boolean, enterFallback?: boolean,
 *   navigate?: (url:string)=>void, webSearchDisposition?: "CURRENT_TAB"|"NEW_TAB",
 *   autofocusWhen?: ()=>Promise<boolean>, footer?: boolean,
 *   preloadEmptySuggestions?: boolean|"after-paint",
 *   searchSession?: ReturnType<typeof createSearchSession>}} [opts]
 * @returns {HTMLElement & {dismissSearch: (opts?: {blur?: boolean})=>void,
 *   setInputValue:(value:string, opts?:{commit?:boolean})=>void,
 *   prepareEmptySuggestions:()=>Promise<void>}}
 */
let boxSeq = 0;

export function createSearchBox(opts = {}) {
  const searchSession = opts.searchSession ?? createSearchSession();
  const runGeneration = createRunGeneration();
  const uid = `sb${++boxSeq}`;
  const placeholderOff = opts.placeholder ?? msg("newtab_search_placeholder");
  const placeholderOn = opts.historyPlaceholder ?? msg("newtab_search_history_placeholder");
  const input = el("input", {
    type: "search",
    class: "search-input",
    placeholder: placeholderOff,
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-keyshortcuts": "/",
    "aria-expanded": "false",
    "aria-label": msg("search_aria_everything")
  });
  // S4: the active scope renders as a removable chip inside the field's left edge.
  const chipHost = el("span", { class: "scope-chip-host" });
  const field = el("div", { class: "search-field" }, chipHost, input);
  // The visual shell deliberately has no listbox role. It can contain filter
  // chips, an empty state, and a list of recent tabs; only actual option rows
  // belong to the one listbox that the combobox controls.
  const results = el("div", { class: "search-results" });
  const optionList = el("div", {
    class: "search-option-list",
    id: `${uid}-list`,
    role: "listbox",
    "aria-label": msg("search_aria_results")
  });
  const liveStatus = el("div", {
    class: "search-status sr-only",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true"
  });
  // Dashboard opts into a persistent lower boundary below its overlay. Search
  // owns the truthful summary; the host may occupy this same footer with the
  // optional History invitation without duplicating query state.
  const footerCount = opts.footer
    ? el("span", { class: "search-footer-count", "aria-hidden": "true" })
    : null;
  const footerHints = opts.footer
    ? el("span", { class: "search-footer-hints", "aria-hidden": "true" },
      msg("search_keyboard_hints"))
    : null;
  const footer = opts.footer
    ? el("div", { class: "search-footer is-empty" }, footerCount, footerHints)
    : null;

  /** @type {import("../lib/search.js").SearchScope|null} */
  let activeScope = null;
  /** Labels are additive AND facets; source/session/domain remains exclusive. */
  /** @type {string[]} */
  let activeLabels = [];
  /** @type {import("../lib/search.js").SearchResult[]} */
  let current = [];
  /** @type {HTMLElement[]} */
  let rows = [];
  /** @type {({kind: "suggest", index: number}|{kind: "result", result: import("../lib/search.js").SearchResult}|{kind: "handoff", handoff: ReturnType<typeof browserHandoffForInput>}|{kind:"command",entry:object})[]} */
  let rowEntries = [];
  let selectedIndex = 0;
  let timer = 0;
  let inputGeneration = 0;
  let recentPending = false;
  let handoffPending = false;
  let inputPreparation = Promise.resolve();
  /** @type {string[]|null} top domains by saved/live frequency, cached per page-load. */
  let domainNamesCache = null;
  /** @type {{label: string, tabs: number}[]|null} top-2 labels by tab count, cached per page-load. */
  let labelCountsCache = null;
  let labelGroupsCache = null;
  let labelRecencyCache = null;
  let labelRecencyPending = null;
  /** @type {import("../lib/search.js").SearchResult[]|null} */
  let recentResultsCache = null;
  /** @type {Promise<import("../lib/search.js").SearchResult[]|null>|null} */
  let recentResultsPending = null;
  /** @type {{generation:number, promise:Promise<void>}|null} */
  let emptySuggestionsPending = null;
  let suggestionCacheGeneration = 0;
  let ghostGeneration = 0;
  let preserveGhostsOnFocus = false;
  // S7: autocomplete options stay separately addressable from ordinary results
  // so one selected-row list can contain both kinds of action.
  /** @type {{label: string, scope?: import("../lib/search.js").SearchScope, prefix?: string}[]} */
  let suggestions = [];
  let suggestionQuery = "";

  const showHistoryPlaceholder = (enabled) => {
    input.placeholder = enabled ? placeholderOn : placeholderOff;
  };
  void hasHistoryAccess().then(showHistoryPlaceholder);
  onHistoryAccessChanged((enabled) => {
    showHistoryPlaceholder(enabled);
    runGeneration.invalidate();
    if (document.activeElement === input && (activeScope || activeLabels.length || input.value.trim())) refresh();
  });

  const unbindInvalidation = bindSearchSnapshotInvalidation({
    invalidate(reason = { repaint: true }) {
      searchSession.invalidate();
      domainNamesCache = null;
      labelCountsCache = null;
      labelGroupsCache = null;
      labelRecencyCache = null;
      labelRecencyPending = null;
      recentResultsCache = null;
      suggestionCacheGeneration += 1;
      ghostGeneration += 1;
      // Title/favicon changes, commonly unread-message notifications, affect
      // the next Search snapshot but must not replace the result DOM under a
      // focused field. The next keystroke or focus reads the fresh snapshot.
      if (reason.repaint === false) return;
      runGeneration.invalidate();
      if (opts.preloadEmptySuggestions) void prepareEmptySuggestions();
      if (document.activeElement !== input) return;
      refresh();
    }
  });
  // The component is document-lifetime today. Keep the cleanup reachable for
  // harnesses/future hosts without adding a second lifecycle abstraction.
  void unbindInvalidation;

  const scopeLabel = () => (activeScope ? `${activeScope.type}:${activeScope.value}` : "");
  const hasFilters = () => Boolean(activeScope || activeLabels.length);
  const labelsKey = () => activeLabels.map((label) => label.toLocaleLowerCase()).join("\u0000");

  function announce(text) {
    liveStatus.textContent = text;
  }

  function updateFooter(text = "") {
    if (!footer) return;
    footerCount.textContent = text;
    footer.classList.toggle("is-empty", !text);
  }

  /** Keep the last complete result surface visible while a newer query is
   * resolving, but remove it from pointer, keyboard, and accessibility action
   * models. The replacement then lands atomically instead of flashing blank. */
  function setResultsPending(pending) {
    results.toggleAttribute("inert", pending);
    if (pending) results.setAttribute("aria-busy", "true");
    else results.removeAttribute("aria-busy");
  }

  function replaceResults(...children) {
    setResultsPending(false);
    results.replaceChildren(...children);
  }

  /** Detach the sole controlled listbox, leaving any non-option visual state
   * in place. A combobox must not claim it controls a list that is absent. */
  function clearOptionRows() {
    optionList.replaceChildren();
    optionList.remove();
    input.removeAttribute("aria-controls");
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function optionGroup(label, className, children) {
    return el("div", {
      class: `search-option-group ${className}`,
      role: "group",
      "aria-label": label
    }, ...children);
  }

  /** Mount option rows in their one valid listbox. `container` lets the
   * focused-empty state place the same list inside its Recent tabs region. */
  function mountOptionRows(groups, label, container = results) {
    optionList.replaceChildren(...groups);
    if (!rows.length) {
      clearOptionRows();
      return;
    }
    optionList.setAttribute("aria-label", label);
    container.append(optionList);
    input.setAttribute("aria-controls", optionList.id);
    input.setAttribute("aria-expanded", "true");
  }

  function renderChip() {
    chipHost.replaceChildren();
    const makeChip = (label, remove, ariaKey) => el(
      "span",
      { class: "chip search-scope-chip", title: label },
      el("span", { class: "search-scope-label", title: label }, label),
      el("button", {
        class: "x",
        type: "button",
        "aria-label": msg(ariaKey, [label]),
        onclick: () => { input.focus(); remove(); }
      }, "×")
    );
    if (activeScope) {
      chipHost.append(makeChip(scopeLabel(), clearScope, "search_remove_scope"));
    }
    for (const label of activeLabels) {
      chipHost.append(makeChip(`label:${label}`, () => removeLabel(label),
        "search_remove_label_filter"));
    }
  }

  function setScope(scope) {
    if (scope?.type === "label") {
      addLabel(scope.value);
      return;
    }
    activeScope = scope;
    renderChip();
    runAfterFilterChange();
  }

  function addLabel(label) {
    const clean = String(label ?? "").trim();
    if (!clean || activeLabels.some((item) =>
      item.toLocaleLowerCase() === clean.toLocaleLowerCase())) return;
    activeLabels = [...activeLabels, clean];
    renderChip();
    runAfterFilterChange();
  }

  /** Consume pasted or completed filters as one state change. Repeated
   * `label:` filters must not paint intermediate one-label result sets. */
  function applyFilters(parsed) {
    const labels = [...activeLabels];
    for (const raw of parsed.labels ?? []) {
      const label = String(raw ?? "").trim();
      if (label && !labels.some((item) =>
        item.toLocaleLowerCase() === label.toLocaleLowerCase())) labels.push(label);
    }
    activeScope = parsed.scope ?? activeScope;
    activeLabels = labels;
    renderChip();
    runAfterFilterChange();
  }

  /** A filter choice changes the meaning of every visible row. Retire the old
   * action model before the first async Search boundary, then let the scoped
   * result repopulate it. */
  function runAfterFilterChange() {
    clearTimeout(timer);
    timer = 0;
    ghostGeneration += 1;
    recentPending = false;
    suggestions = [];
    suggestionQuery = "";
    clearPendingRows();
    void run();
  }

  function removeLabel(label) {
    const key = String(label).toLocaleLowerCase();
    const next = activeLabels.filter((item) => item.toLocaleLowerCase() !== key);
    if (next.length === activeLabels.length) return;
    activeLabels = next;
    renderChip();
    refresh();
  }

  function clearFilters() {
    if (!hasFilters()) return;
    activeScope = null;
    activeLabels = [];
    renderChip();
    refresh();
  }

  function clearScope() {
    if (!activeScope) return;
    activeScope = null;
    renderChip();
    refresh();
  }

  /** Rebuild prefix/value completion for a preserved typed query. This is the
   * focus/invalidation counterpart to the input handler: it deliberately runs
   * the ordinary search immediately after the suggestion paint, as `refresh`
   * always did, while keystrokes keep their debounce below. */
  async function refreshCompletions() {
    const refreshGeneration = ++inputGeneration;
    const query = input.value;
    clearTimeout(timer);
    runGeneration.invalidate();
    const next = await scopeSuggestions(query);
    if (refreshGeneration !== inputGeneration || hasFilters() || input.value !== query) return;
    if (next) showSuggest(next);
    else {
      suggestions = [];
      suggestionQuery = "";
    }
    void run();
  }

  /** Show ghosts when there's nothing to search, otherwise refresh the query. */
  function refresh() {
    clearTimeout(timer);
    runGeneration.invalidate();
    if (!hasFilters() && !input.value.trim()) {
      inputGeneration += 1;
      showGhosts();
    }
    else if (hasFilters()) {
      inputGeneration += 1;
      void run();
    }
    else void refreshCompletions();
  }

  function setSelected(i, { scroll = true } = {}) {
    if (rows.length === 0) {
      input.removeAttribute("aria-activedescendant");
      return;
    }
    selectedIndex = ((i % rows.length) + rows.length) % rows.length; // wrap around
    rows.forEach((row, idx) => {
      const on = idx === selectedIndex;
      row.classList.toggle("selected", on);
      row.setAttribute("aria-selected", on ? "true" : "false");
    });
    input.setAttribute("aria-activedescendant", rows[selectedIndex]?.id ?? "");
    if (scroll) rows[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }

  /** Return focus to the combobox without letting its focus handler replace
   * the Search state that the current keyboard action is about to commit. */
  function focusInputWithoutRefresh() {
    preserveGhostsOnFocus = true;
    input.focus({ preventScroll: true });
    if (preserveGhostsOnFocus) preserveGhostsOnFocus = false;
  }

  /** @param {import("../lib/search.js").SearchResult[]} list @param {boolean} showMeta */
  function buildResultRows(list, showMeta, offset = 0) {
    return list.map((r, idx) => {
      const meta = showMeta ? searchResultMeta(r) : "";
      const metaClass = ["session-entity", "label-group-entity", "session-group-entity"].includes(r.type)
        ? "rmeta rmeta-count" : "rmeta";
      return el(
        "div",
        {
          class: "search-row",
          id: `${uid}-opt${offset + idx}`,
          role: "option",
          "aria-selected": "false",
          onclick: () => choose(r),
          onmousemove: () => setSelected(offset + idx)
      },
        el("span", { class: "rtitle", title: r.title }, r.title),
        showMeta ? el("span", { class: metaClass, title: meta }, meta) : null,
        el("span", { class: `rtype rtype-${r.type}` }, searchResultAction(r.type))
      );
    });
  }

  /** A local miss can still be a deliberate navigation. This remains a normal
   * result row so mouse, Arrow keys, and Enter share the same action model. */
  function buildHandoffRow(handoff, offset = 0) {
    const isUrl = handoff.type === "open-url";
    const title = isUrl ? handoff.url : handoff.text;
    const meta = isUrl
      ? msg("search_handoff_website") : msg("search_handoff_default_engine");
    const action = isUrl
      ? msg("search_action_open_site") : msg("search_action_search_web");
    return el(
      "div",
      {
        class: "search-row",
        id: `${uid}-opt${offset}`,
        role: "option",
        "aria-selected": "false",
        onclick: () => void chooseHandoff(handoff),
        onmousemove: () => setSelected(offset)
      },
      el("span", { class: "rtitle", title }, title),
      el("span", {
        class: "rmeta",
        title: meta
      }, meta),
      el("span", { class: "rtype" }, action)
    );
  }

  function paintSearchResults(next, {
    inlineSuggestions, complete, preserveSelection = false, offerHandoff = false
  }) {
    const priorSelection = preserveSelection ? selectedIndex : 0;
    current = next;
    // `in:` scope makes the source part of the meta redundant; drop it there.
    const showMeta = !(activeScope && activeScope.type === "in" && activeScope.value !== "history");
    const suggestionRows = buildSuggestRows(inlineSuggestions);
    const resultRows = buildResultRows(current, showMeta, suggestionRows.length);
    // A browser handoff follows an unscoped primary miss. Filter completions
    // remain the next action while the person is still composing.
    const handoff = !hasFilters() && suggestionRows.length === 0 &&
      (offerHandoff || (complete && current.length === 0))
      ? browserHandoffForInput(input.value)
      : null;
    const handoffRows = handoff
      ? [buildHandoffRow(handoff, suggestionRows.length + resultRows.length)]
      : [];
    rows = [...suggestionRows, ...resultRows, ...handoffRows];
    rowEntries = [
      ...inlineSuggestions.map((_, index) => ({ kind: "suggest", index })),
      ...current.map((result) => ({ kind: "result", result })),
      ...(handoff ? [{ kind: "handoff", handoff }] : [])
    ];
    if (!hasFilters() && input.value.trim().length === 1 && current.length === 0 &&
        suggestionRows.length === 0) {
      showOneCharacterFallback();
      return rows.length;
    }
    const noMatches = complete && current.length === 0 && suggestionRows.length === 0 && !handoff &&
      (hasFilters() || input.value.trim().length >= 2);
    const actionRows = [...resultRows, ...handoffRows];
    const groups = [
      ...(suggestionRows.length
        ? [optionGroup(msg("search_group_suggestions"), "search-suggestion-group", suggestionRows)]
        : []),
      ...(actionRows.length
        ? [optionGroup(
          msg("search_group_results"),
          `search-result-group${suggestionRows.length ? " has-separator" : ""}`,
          actionRows
        )]
        : [])
    ];
    replaceResults();
    mountOptionRows(groups, msg("search_aria_results"));
    if (noMatches) {
      if (hasFilters()) {
        results.append(
          el(
            "div",
            { class: "empty search-empty-actions" },
            activeLabels.length
              ? msg("search_no_matches_labels")
              : msg("search_no_matches_scope", [scopeLabel()]),
            el("button", { type: "button", class: "linklike",
              onclick: () => { input.focus(); clearFilters(); } }, msg("search_everywhere"))
          )
        );
      } else {
        results.append(el("div", { class: "empty" }, msg("search_no_matches")));
      }
    }
    if (noMatches) announce(hasFilters()
      ? (activeLabels.length
        ? msg("search_no_matches_labels")
        : msg("search_no_matches_scope", [scopeLabel()]))
      : msg("search_no_matches"));
    else if (handoff) announce(msg("search_handoff_available"));
    else if (rows.length) announce(searchCount("result", rows.length, { announcement: true }));
    updateFooter(searchCount("result", rows.length));
    setSelected(Math.min(priorSelection, Math.max(0, rows.length - 1)));
    return rows.length;
  }

  async function run(waitForComplete = false) {
    timer = 0;
    const runToken = runGeneration.next();
    const runSpan = pspan("search:run(B7)"); // keystroke handler → first useful rows in the DOM
    const includeHistory = await hasHistoryAccess();
    if (!runToken.isCurrent()) return;
    const computeSpan = pspan("search:compute");
    const query = input.value;
    const scope = activeScope;
    const labels = [...activeLabels];
    const facetKey = labelsKey();
    // `showSuggest` paints immediately, then this debounced search replaces
    // that transient list with the same suggestion rows followed by results.
    // The query identity keeps an older prefix's suggestions out of a newer
    // query even before the input-generation guard has another chance to run.
    const inlineSuggestions = suggestionQuery === query ? suggestions : [];
    const progressive = await searchSession.searchProgressively(
      query, { scope, labels, includeHistory }
    );
    if (!runToken.isCurrent() || input.value !== query || activeScope !== scope || labelsKey() !== facetKey) return;
    const next = progressive.results.slice(0, 15);
    computeSpan(`${input.value.length} chars → ${next.length} primary results`);
    const waitForUsefulCompletion = Boolean(
      progressive.complete && next.length === 0 && inlineSuggestions.length === 0
    );
    if (!waitForUsefulCompletion) {
      const rowCount = paintSearchResults(next, {
        inlineSuggestions,
        complete: !progressive.complete
      });
      runSpan(`${rowCount} primary rows`);
    } else {
      const rowCount = paintSearchResults(next, {
        inlineSuggestions,
        complete: false,
        offerHandoff: true
      });
      runSpan(`${rowCount} primary rows; completing local result set`);
    }

    if (!progressive.complete) return;
    const settleComplete = async () => {
      const finalResults = await progressive.complete;
      if (!runToken.isCurrent() ||
          input.value !== query || activeScope !== scope || labelsKey() !== facetKey) return;
      // Completion adds large Session/Snapshot and optional History sources.
      // If that secondary read fails, the primary miss is still authoritative
      // enough to settle the UI. Leaving the prior result inert here makes a
      // transient optional failure look like Search has frozen forever.
      if (!finalResults) {
        if (waitForUsefulCompletion) {
          paintSearchResults(next, {
            inlineSuggestions,
            complete: true,
            preserveSelection: true,
            offerHandoff: true
          });
        }
        return;
      }
      paintSearchResults(finalResults.slice(0, 15), {
        inlineSuggestions,
        complete: true,
        preserveSelection: true,
        offerHandoff: waitForUsefulCompletion
      });
    };
    if (waitForComplete) await settleComplete();
    else void settleComplete();
  }

  function bindGhostKeyboard(button) {
    button.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        focusInputWithoutRefresh();
        escapeSearch();
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        button.click();
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const chips = [...results.querySelectorAll(".ghost-chip")]
        .filter((chip) => chip.offsetParent !== null);
      const index = chips.indexOf(button);
      if (event.key === "ArrowDown") {
        focusInputWithoutRefresh();
        if (rows.length) setSelected(0);
        return;
      }
      const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
      const next = chips[index + delta];
      if (next) next.focus();
      else focusInputWithoutRefresh();
    });
    return button;
  }

  function ghostChip(scope) {
    const label = `${scope.type}:${scope.value}`;
    return bindGhostKeyboard(el("button", {
      class: "ghost-chip",
      type: "button",
      "aria-label": label,
      onmousedown: (e) => e.preventDefault(), // keep focus in the input on click
      onclick: () => { focusInputWithoutRefresh(); setScope(scope); }
    },
    el("span", { class: "ghost-prefix", "aria-hidden": "true" }, `${scope.type}:`),
    el("span", { class: "ghost-value", "aria-hidden": "true" }, scope.value)));
  }

  /** Put a scope keyword in the field, then reveal its actual values. */
  async function openPrefix(prefix) {
    const generation = ++inputGeneration;
    ghostGeneration += 1;
    recentPending = false;
    runGeneration.invalidate();
    input.value = `${prefix}:`;
    input.focus();
    const next = await scopeSuggestions(input.value);
    if (generation !== inputGeneration) return;
    if (next) {
      showSuggest(next);
      clearTimeout(timer);
      timer = setTimeout(run, SEARCH_DEBOUNCE_MS);
    }
    else {
      suggestions = [];
      suggestionQuery = "";
      current = [];
      rows = [];
      rowEntries = [];
      clearOptionRows();
      const empty = msg("search_no_filters", [prefix]);
      replaceResults(el("div", { class: "empty" }, empty));
      updateFooter(searchCount("suggestion", 0));
      announce(empty);
    }
  }

  function prefixChip(prefix) {
    return bindGhostKeyboard(el("button", {
      class: "ghost-chip ghost-chip-prefix",
      type: "button",
      "aria-label": `${prefix}:`,
      onmousedown: (e) => e.preventDefault(),
      onclick: () => void openPrefix(prefix)
    }, el("span", { class: "ghost-prefix", "aria-hidden": "true" }, `${prefix}:`)));
  }

  /** Compute the most frequent searchable domains once per page-load (cached). */
  async function warmDomainNames() {
    if (domainNamesCache) return domainNamesCache;
    const generation = suggestionCacheGeneration;
    let names = [];
    try {
      names = searchSession.emptySuggestionFacets
        ? (await searchSession.emptySuggestionFacets()).domainCounts.map(group => group.domain)
        : await searchSession.scopeNames("domain");
    } catch {
      /* saved/live sources unavailable: the static in: suggestions still stand */
    }
    if (generation !== suggestionCacheGeneration) return warmDomainNames();
    domainNamesCache = names.slice(0, 1);
    return domainNamesCache;
  }

  function rankLabelExamples(groups) {
    const recency = labelRecencyCache ?? {};
    return [...groups].sort((a, b) =>
      (recency[b.label] ?? 0) - (recency[a.label] ?? 0) ||
      b.tabs - a.tabs || a.label.localeCompare(b.label)).slice(0, 2);
  }

  /** Recency improves the next opening if it arrives late. It never holds the
   * first complete shelf or inserts another chip after that shelf has opened. */
  function warmLabelRecency() {
    if (labelRecencyCache || labelRecencyPending) return;
    const generation = suggestionCacheGeneration;
    const task = getLabelMeta().catch(() => ({})).then(recency => {
      if (generation !== suggestionCacheGeneration) return;
      labelRecencyCache = recency;
      if (labelGroupsCache) labelCountsCache = rankLabelExamples(labelGroupsCache);
    }).finally(() => {
      if (labelRecencyPending === task) labelRecencyPending = null;
    });
    labelRecencyPending = task;
  }

  /** Actual primary-source labels, ordered by available recency then count. */
  async function warmLabelCounts() {
    if (labelCountsCache) return labelCountsCache;
    const generation = suggestionCacheGeneration;
    let groups = [];
    try {
      groups = searchSession.emptySuggestionFacets
        ? (await searchSession.emptySuggestionFacets()).labelCounts
        : await searchSession.labelCounts();
    } catch {
      /* labels unavailable — the in: suggestions still stand */
    }
    if (generation !== suggestionCacheGeneration) return warmLabelCounts();
    // Prefer actual recent label use when its small register is ready. With
    // delayed or missing recency, count then name keeps the first shelf useful;
    // warmLabelRecency updates only the cache for a later opening.
    labelGroupsCache = groups;
    labelCountsCache = rankLabelExamples(groups);
    return labelCountsCache;
  }

  /** Read the compact Recent-tabs model without opening or painting Search.
   * Concurrent first-focus and preload requests share one browser read. */
  function warmRecentResults() {
    if (recentResultsCache) return Promise.resolve(recentResultsCache);
    if (recentResultsPending) return recentResultsPending;
    const generation = suggestionCacheGeneration;
    const task = Promise.all([
      chrome.tabs.query({ active: true, currentWindow: true }),
      chrome.windows.getAll({ populate: true, windowTypes: ["normal"] })
    ]).then(([active, windows]) => recentOpenTabResults(windows, {
      activeTabId: active[0]?.id,
      currentWindowId: active[0]?.windowId
    })).catch(() => []);
    const pending = task.then((list) => {
      if (generation !== suggestionCacheGeneration) return null;
      recentResultsCache = list;
      return list;
    }).finally(() => {
      if (recentResultsPending === pending) recentResultsPending = null;
    });
    recentResultsPending = pending;
    return pending.then((list) => list ?? warmRecentResults());
  }

  /** Prepare every data-backed part of the focused-empty Search model. This
   * performs no DOM work and never moves focus, so Minimal can start it during
   * its ordinary first paint and later open the complete model synchronously. */
  function prepareEmptySuggestions() {
    warmLabelRecency();
    const generation = suggestionCacheGeneration;
    if (emptySuggestionsPending?.generation === generation) {
      return emptySuggestionsPending.promise;
    }
    const promise = Promise.all([
      warmDomainNames(),
      warmLabelCounts(),
      warmRecentResults()
    ]).then(() => {}).catch(() => {});
    emptySuggestionsPending = { generation, promise };
    promise.finally(() => {
      if (emptySuggestionsPending?.promise === promise) emptySuggestionsPending = null;
    });
    return promise;
  }

  /** Ghost suggestion chips + recent tabs. Every focused empty Search keeps
   * navigation first and recents last. */
  function showGhosts() {
    if (hasFilters() || input.value.trim()) return;
    const ghostRun = ++ghostGeneration;
    suggestions = [];
    suggestionQuery = "";
    current = [];
    rows = [];
    rowEntries = [];
    selectedIndex = 0;
    recentPending = true;
    clearOptionRows();
    if (!domainNamesCache || !labelCountsCache || !recentResultsCache) {
      replaceResults();
      updateFooter();
      announce(msg("search_suggestions_loading_recent"));
      void prepareEmptySuggestions().then(() => {
        if (ghostRun === ghostGeneration && document.activeElement === input &&
            !hasFilters() && !input.value.trim()) showGhosts();
      });
      return;
    }
    updateFooter(msg("search_recent_tabs"));
    announce(msg("search_suggestions_loading_recent"));
    const domainSlot = el("span", { class: "ghost-domain-slot" });
    const labelSlot = el("span", { class: "ghost-label-slot" });
    const recentList = el("div", { class: "search-recent-list" });
    const recentSlot = el(
      "div",
      { class: "search-recent" },
      el("div", { class: "search-recent-label", "aria-hidden": "true" },
        msg("search_recent_tabs")),
      recentList
    );
    const ghostSections = [
      el(
        "div",
        { class: "ghost-chips" },
        el("span", { class: "ghost-hint" }, msg("search_jump_to")),
        // S7 (1): lead with in:open; in:inbox/in:archive dropped from the examples
        // (still typeable). The domain is an actual frequent primary source.
        // Labels have their own additive facet row below.
        ghostChip({ type: "in", value: "open" }),
        ghostChip({ type: "in", value: "snoozed" }),
        domainSlot
      ),
      el(
        "div",
        { class: "ghost-chips search-label-facets" },
        el("span", { class: "ghost-hint" }, msg("search_filter_by_labels")),
        prefixChip("label"),
        labelSlot
      ),
      recentSlot
    ];
    replaceResults(...ghostSections);
    const stillEmpty = (slot) =>
      ghostRun === ghostGeneration &&
      !(hasFilters() || input.value.trim() || !slot.isConnected);
    const fillRecents = (list) => {
      if (!stillEmpty(recentSlot)) return;
      recentPending = false;
      current = list;
      rows = buildResultRows(current, true);
      rowEntries = current.map((result) => ({ kind: "result", result }));
      recentList.replaceChildren();
      if (rows.length) {
        mountOptionRows([optionGroup(msg("search_recent_tabs"), "search-recent-group", rows)],
          msg("search_recent_tabs"), recentList);
        updateFooter(searchCount("recent", rows.length));
        announce(searchCount("recent", rows.length, { announcement: true }));
      } else {
        clearOptionRows();
        recentList.append(el("div", { class: "empty" }, msg("search_no_other_open_tabs")));
        updateFooter(searchCount("recent", 0));
        announce(msg("search_no_other_open_tabs"));
      }
      setSelected(0, { scroll: false });
    };
    const fillDomains = (domains) => {
      if (!stillEmpty(domainSlot)) return;
      domainSlot.replaceChildren(
        ...domains.map((domain) => ghostChip({ type: "domain", value: domain }))
      );
    };
    const fillLabels = (labels) => {
      if (!stillEmpty(labelSlot)) return;
      labelSlot.replaceChildren(
        ...labels.map((g) => ghostChip({ type: "label", value: g.label }))
      );
    };
    fillDomains(domainNamesCache);
    fillLabels(labelCountsCache);
    fillRecents(recentResultsCache);
  }

  /** A one-character miss is an invitation to continue or narrow the source,
   *  never a visually broken empty dropdown. */
  function showOneCharacterFallback() {
    suggestions = [];
    suggestionQuery = "";
    current = [];
    rows = [];
    rowEntries = [];
    selectedIndex = 0;
    clearOptionRows();
    updateFooter(searchCount("result", 0));
    replaceResults(
      el(
        "div",
        { class: "ghost-chips" },
        el("span", { class: "ghost-hint" }, msg("search_keep_typing_filter")),
        prefixChip("in"),
        prefixChip("label"),
        prefixChip("session"),
        prefixChip("domain")
      )
    );
    announce(msg("search_keep_typing_announcement"));
  }

  /** Suggest scope keywords before the colon, then their actual values after it. */
  async function scopeSuggestions(raw) {
    const text = String(raw ?? "");
    const keyword = text.match(/^([a-z]+)$/i);
    if (keyword) {
      const partial = keyword[1].toLowerCase();
      const prefixes = ["in", "label", "session", "domain"]
        .filter((name) => name.startsWith(partial))
        .map((name) => ({ label: `${name}:`, prefix: name }));
      return prefixes.length ? prefixes : null;
    }
    const m = text.match(/^(in|label|session|domain):(\S*)$/i);
    if (!m) return null;
    const kind = m[1].toLowerCase();
    const partial = m[2].toLowerCase();
    const names = await searchSession.scopeNames(kind);
    const opts = names
      .filter((n) => kind !== "label" || !activeLabels.some((label) =>
        label.toLocaleLowerCase() === n.toLocaleLowerCase()))
      .filter((n) => n.toLowerCase().startsWith(partial))
      .slice(0, 8)
      .map((n) => ({
        label: `${kind}:${n}`,
        scope: { type: kind, value: kind === "in" ? n.toLowerCase() : n }
      }));
    return opts.length ? opts : null;
  }

  /** Continue a keyword suggestion, or turn an actual value into a scope chip. */
  function pickSuggest(i) {
    const s = suggestions[i];
    if (!s) return;
    if (s.prefix) {
      void openPrefix(s.prefix);
      return;
    }
    input.value = "";
    input.focus();
    setScope(s.scope);
  }

  function buildSuggestRows(list, offset = 0) {
    return list.map((s, idx) =>
      el(
        "div",
        {
          class: "search-row scope-suggest",
          id: `${uid}-opt${offset + idx}`,
          role: "option",
          "aria-selected": "false",
          onmousedown: (e) => e.preventDefault(), // keep focus in the field on click
          onclick: () => pickSuggest(idx),
          onmousemove: () => setSelected(offset + idx)
        },
        el("span", { class: "rtitle" }, s.label)
      )
    );
  }

  /** S7: paint scope completion immediately. The debounced normal search then
   *  calls `run()` and keeps these rows above its ordinary result rows. */
  function showSuggest(list) {
    suggestions = list;
    suggestionQuery = input.value;
    current = [];
    rows = buildSuggestRows(list);
    rowEntries = list.map((_, index) => ({ kind: "suggest", index }));
    replaceResults();
    const labelFacets = list.every((item) => item.scope?.type === "label");
    mountOptionRows([optionGroup(labelFacets
      ? msg("search_filter_by_labels")
      : msg("search_group_suggestions"), "search-suggestion-group", rows)],
      msg("search_aria_suggestions"));
    updateFooter(searchCount("suggestion", rows.length));
    announce(searchCount("suggestion", rows.length, { announcement: true }));
    setSelected(0);
  }

  /** Collapse the dropdown (rows or ghosts), keeping combobox semantics correct. */
  function close() {
    clearTimeout(timer);
    timer = 0;
    inputGeneration += 1;
    ghostGeneration += 1;
    recentPending = false;
    runGeneration.invalidate();
    suggestionQuery = "";
    clearOptionRows();
    replaceResults();
    rows = [];
    rowEntries = [];
    updateFooter();
    announce("");
  }

  /** One Escape ladder serves the combobox field and its keyboard-focused
   * suggestion chips. Focus may move into a chip during arrow navigation, but
   * that must not make Search impossible to dismiss. */
  function escapeSearch() {
    if (input.value) {
      input.value = "";
      refresh();
    } else if (activeLabels.length) {
      removeLabel(activeLabels.at(-1));
    } else if (activeScope) {
      clearScope();
    } else {
      close();
      input.blur();
      opts.escapeToList?.();
    }
  }

  /** Activate a result, then collapse the popup so it doesn't linger with stale
   *  rows when focus returns to the box (refocusing re-runs the search). */
  function choose(r) {
    activate(r);
    close();
  }

  /** Open a direct URL through the host's existing route, or delegate a web
   * query to the background worker so Chrome's own default-provider API owns
   * the navigation. */
  async function chooseHandoff(handoff) {
    if (handoff.type === "open-url") {
      close();
      const openUrl = opts.navigate ?? ((url) => chrome.runtime.sendMessage({ type: "open-url", url }));
      openUrl(handoff.url);
      return;
    }
    if (handoffPending) return;
    handoffPending = true;
    const handoffGeneration = inputGeneration;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "search-web",
        text: handoff.text,
        disposition: opts.webSearchDisposition ?? "NEW_TAB"
      });
      if (response?.ok) {
        handoffPending = false;
        if (handoffGeneration === inputGeneration) close();
        return;
      }
    } catch { /* keep the query and offer a retry below */ }
    handoffPending = false;
    if (handoffGeneration !== inputGeneration) return;
    current = [];
    rows = [];
    rowEntries = [];
    selectedIndex = 0;
    clearOptionRows();
    updateFooter(msg("search_web_unavailable"));
    replaceResults(
      el(
        "div",
        { class: "empty search-empty-actions" },
        msg("search_web_failure"),
        el("button", { type: "button", class: "linklike",
          onclick: () => void chooseHandoff(handoff) }, msg("action_try_again"))
      )
    );
    announce(msg("search_web_failure_retry"));
  }

  /** New text immediately retires the previous query's action model. Keeping
   * stale rows clickable during the debounce can open the wrong local result
   * or resend an older web query. */
  function clearPendingRows({ preserveVisible = false } = {}) {
    current = [];
    rows = [];
    rowEntries = [];
    selectedIndex = 0;
    if (preserveVisible && results.childElementCount) {
      input.removeAttribute("aria-controls");
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      setResultsPending(true);
    } else {
      clearOptionRows();
      replaceResults();
      updateFooter();
    }
  }

  input.addEventListener("input", () => {
    const inputRun = ++inputGeneration;
    clearTimeout(timer);
    // Invalidate immediately, not after the debounce: an older async search
    // must not paint during the 90 ms before this newer query starts.
    runGeneration.invalidate();
    ghostGeneration += 1;
    recentPending = false;
    clearPendingRows({ preserveVisible: true });
    // The interaction budget starts at the keystroke. Scope completion may
    // finish before this timer and replace/cancel it, but snapshot work can no
    // longer silently add itself in front of the approved 90 ms debounce.
    timer = setTimeout(run, SEARCH_DEBOUNCE_MS);
    inputPreparation = (async () => {
      // Prefix completion starts at i/l/s/d and continues through actual values.
      const sug = await scopeSuggestions(input.value);
      if (inputRun !== inputGeneration) return;
      if (sug) {
        suggestions = sug;
        suggestionQuery = input.value;
        // When a complete result surface is already visible, keep it mounted
        // and inert until the debounced search can replace it with one atomic
        // suggestions-plus-results surface. Painting the one-row keyword hint
        // first made `l`, `label`, `in`, and `domain` visibly collapse Search
        // for a frame on every keystroke.
        if (!results.childElementCount) showSuggest(sug);
        // Complete facets can arrive after the debounce has already painted
        // primary results. Publish those actual values with the same atomic
        // suggestions-plus-results path instead of leaving a stale miss.
        if (!timer) void run();
        return;
      }
      suggestions = [];
      suggestionQuery = "";
      // A completed scope token is consumed into a chip (Gmail-style) — reached via
      // a trailing space or a pasted "in:open foo".
      const parsed = await searchSession.resolveFilters(input.value);
      if (inputRun !== inputGeneration) return;
      if (parsed.scope || parsed.labels.length) {
        clearTimeout(timer);
        input.value = parsed.query;
        applyFilters(parsed);
        return;
      }
      // Cleared/empty → browse the active scope, or show the suggestion chips.
      if (!input.value.trim()) {
        clearTimeout(timer);
        refresh();
        return;
      }
    })();
  });

  function activateEntry(entry) {
    if (!entry) return;
    if (entry.kind === "suggest") pickSuggest(entry.index);
    else if (entry.kind === "result") choose(entry.result);
    else void chooseHandoff(entry.handoff);
  }

  /** Enter during the debounce must prove the local query is empty before any
   * browser handoff. Wait for scope completion/parsing, then use the same Search
   * run that paints the visible rows and activate its first action. */
  async function commitCurrentInput() {
    const generation = inputGeneration;
    await inputPreparation;
    if (generation !== inputGeneration) return;
    // Scope parsing may intentionally consume a leading token and rewrite the
    // field without creating a new input generation. Treat that settled value
    // as the query identity; an actual newer keystroke still invalidates below.
    const settledQuery = input.value;
    clearTimeout(timer);
    if (rowEntries[selectedIndex]) {
      activateEntry(rowEntries[selectedIndex]);
      return;
    }
    await run(true);
    if (generation !== inputGeneration || settledQuery !== input.value) return;
    activateEntry(rowEntries[selectedIndex]);
  }
  // Re-focusing the box reopens results (with text) or the scope suggestions (empty).
  input.addEventListener("focus", () => {
    if (preserveGhostsOnFocus) {
      preserveGhostsOnFocus = false;
      return;
    }
    refresh();
  });
  // A host may dismiss the overlay without blurring the field. Clicking that
  // already-focused input does not emit another `focus` event, so reopen the
  // shared empty state from the pointer interaction itself. This is deliberately
  // conditional: an ordinary first click still has one owner (the focus event),
  // and an open result set is never rebuilt under the pointer.
  input.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || document.activeElement !== input || results.childElementCount) return;
    refresh();
  });
  input.addEventListener("keydown", (e) => {
    if (isComposingKey(e)) return;
    // N23: an EMPTY search box hands ↓ to the page — it jumps to the first row
    // of whatever list is visible (the dashboard passes `exitToList`; the minimal
    // new-tab page doesn't and keeps its arrows). S7: "empty" means no text AND no
    // active scope chip — with a chip, ↓ navigates the scope's browse dropdown.
    if (e.key === "ArrowDown" && !input.value.trim() && !hasFilters() &&
        opts.exitToList && (opts.emptyArrowExit || (rows.length === 0 && !recentPending))) {
      e.preventDefault();
      close();
      input.blur();
      opts.exitToList();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected(selectedIndex + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const ghostChips = [...results.querySelectorAll(".ghost-chip")]
        .filter((chip) => chip.offsetParent !== null);
      if (selectedIndex === 0 && ghostChips.length) ghostChips.at(-1).focus();
      else setSelected(selectedIndex - 1);
    } else if (e.key === "Enter" && rowEntries[selectedIndex]) {
      e.preventDefault();
      activateEntry(rowEntries[selectedIndex]);
    } else if (e.key === "Enter" && opts.enterFallback && input.value.trim()) {
      e.preventDefault();
      void commitCurrentInput();
    } else if (
      e.key === "Backspace" &&
      hasFilters() &&
      input.selectionStart === 0 &&
      input.selectionEnd === 0
    ) {
      // Backspace at the very start removes the most recently added facet,
      // then the exclusive scope (Gmail-style token editing).
      e.preventDefault();
      if (activeLabels.length) removeLabel(activeLabels.at(-1));
      else clearScope();
    } else if (e.key === "Escape") {
      // S7 Esc ladder: (1) clear typed text first; (2) then drop the scope chip;
      // (3) only when the box is truly empty (no text, no chip) leave search
      // entirely (N23 — focus to the page). Backspace-at-start still removes the
      // chip directly, so both exits stay available.
      e.preventDefault();
      escapeSearch();
    }
  });

  /** @type {HTMLElement & {dismissSearch: (opts?: {blur?: boolean})=>void,
   * setInputValue:(value:string, opts?:{commit?:boolean})=>void,
   * prepareEmptySuggestions:()=>Promise<void>}} */
  // Compact hosts keep the field and overlay as separate positioned nodes, but
  // their visible outline is one object. A measured, pointer-transparent
  // boundary spans both nodes so Popup, Side panel, and Minimal cannot drift
  // into two subtly different curves or focus rings. Dashboard moves `results`
  // into its own overlay and therefore continues to own its existing shell.
  const connectedBoundary = el("span", {
    class: "search-connected-boundary",
    "aria-hidden": "true"
  });
  const box = el("div", { class: "search-box" },
    field, results, connectedBoundary, footer, liveStatus);
  const syncConnectedBoundary = () => {
    const fieldSize = field.getBoundingClientRect().height;
    const resultsSize = results.getBoundingClientRect().height;
    if (fieldSize > 0) box.style.setProperty("--search-field-block-size", `${fieldSize}px`);
    box.style.setProperty("--search-results-block-size", `${resultsSize}px`);
  };
  if (typeof ResizeObserver === "function") {
    const boundaryObserver = new ResizeObserver(syncConnectedBoundary);
    boundaryObserver.observe(field);
    boundaryObserver.observe(results);
    box._searchBoundaryObserver = boundaryObserver;
  }
  // Content navigation can retire an open Search without synthesizing a key
  // event. Blur only when Search itself owns focus, so routing never steals
  // focus from another Dashboard control.
  box.dismissSearch = ({ blur = false } = {}) => {
    close();
    if (blur && box.contains(document.activeElement)) input.blur();
  };
  box.setInputValue = (value, { commit = false } = {}) => {
    input.value = String(value ?? "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus({ preventScroll: true });
    if (commit) void commitCurrentInput();
  };
  box.prepareEmptySuggestions = prepareEmptySuggestions;
  // Decide pointer dismissal before a focus-triggered host transition can move
  // the field away from the press coordinate. Waiting for `click` made Minimal
  // briefly paint results, then clear them when Chrome targeted the end of the
  // gesture at the moving deck. Keyboard-generated clicks have no pointer-down,
  // so retain their outside-dismiss route through `detail === 0`.
  const dismissFromEvent = (e) => {
    const path = e.composedPath?.() ?? [];
    if (!path.includes(field) && !path.includes(results) && !path.includes(footer)) close();
  };
  document.addEventListener("pointerdown", dismissFromEvent);
  document.addEventListener("click", (e) => {
    if (e.detail === 0) dismissFromEvent(e);
  });
  // The keyboard command changes focus only. Content remains the same shared
  // chips-then-recents state used by every other Search focus.
  const focusAutofocusInput = async () => {
    // A popup document can consume the worker handoff before its Search node is
    // connected. Wait for the first mounted frame, then verify focus once more
    // on the following frame so Chrome's popup initial-focus pass cannot win.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (!input.isConnected) continue;
      input.focus({ preventScroll: true });
      if (document.activeElement === input) return true;
    }
    return false;
  };
  if (typeof opts.autofocusWhen === "function") {
    Promise.resolve().then(async () => {
      const autofocus = await opts.autofocusWhen();
      if (!autofocus || activeScope || input.value.trim()) return;
      await focusAutofocusInput();
    }).catch(() => {});
  }
  if (opts.preloadEmptySuggestions === "after-paint") {
    requestAnimationFrame(() => setTimeout(() => void prepareEmptySuggestions(), 0));
  } else if (opts.preloadEmptySuggestions) {
    void prepareEmptySuggestions();
  }
  return box;
}
