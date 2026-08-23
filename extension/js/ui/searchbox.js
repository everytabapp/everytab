import {
  searchResultTarget, createSearchSession, bindSearchSnapshotInvalidation,
  createRunGeneration, SEARCH_DEBOUNCE_MS
} from "../lib/search.js";
import {
  searchCount, searchResultAction, searchResultMeta
} from "../lib/search-copy.js";
import { msg } from "../lib/i18n.js";
import { hasHistoryAccess, onHistoryAccessChanged } from "../lib/history-access.js";
import { el } from "./dom.js";
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
 * ghost suggestion chips — ever moves page content. Ghosts render *inside* the
 * dropdown as its empty-query state: the two static `in:` chips paint
 * synchronously; one frequent `domain:` example and two recent `label:`
 * examples fill reserved slots once their local counts resolve (cached per
 * page-load, so later focuses are instant).
 * Every focused, empty Search host shows the same two-level state: navigation
 * chips first, then the six most recently used open tabs. `autofocusWhen` is a
 * focus-only hook for the popup's keyboard command; it does not change content.
 * @param {{placeholder?: string, historyPlaceholder?: string, exitToList?: Function, enterFallback?: boolean,
 *   navigate?: (url:string)=>void, webSearchDisposition?: "CURRENT_TAB"|"NEW_TAB",
 *   autofocusWhen?: ()=>Promise<boolean>, footer?: boolean}} [opts]
 * @returns {HTMLElement & {dismissSearch: (opts?: {blur?: boolean})=>void}}
 */
let boxSeq = 0;

export function createSearchBox(opts = {}) {
  const searchSession = createSearchSession();
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
  /** @type {import("../lib/search.js").SearchResult[]} */
  let current = [];
  /** @type {HTMLElement[]} */
  let rows = [];
  /** @type {({kind: "suggest", index: number}|{kind: "result", result: import("../lib/search.js").SearchResult}|{kind: "handoff", handoff: ReturnType<typeof browserHandoffForInput>})[]} */
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
    if (document.activeElement === input && (activeScope || input.value.trim())) refresh();
  });

  const unbindInvalidation = bindSearchSnapshotInvalidation({
    invalidate() {
      searchSession.invalidate();
      domainNamesCache = null;
      labelCountsCache = null;
      suggestionCacheGeneration += 1;
      ghostGeneration += 1;
      runGeneration.invalidate();
      if (document.activeElement !== input) return;
      if (!activeScope && !input.value.trim()) showGhosts();
      else refresh();
    }
  });
  // The component is document-lifetime today. Keep the cleanup reachable for
  // harnesses/future hosts without adding a second lifecycle abstraction.
  void unbindInvalidation;

  const scopeLabel = () => (activeScope ? `${activeScope.type}:${activeScope.value}` : "");

  function announce(text) {
    liveStatus.textContent = text;
  }

  function updateFooter(text = "") {
    if (!footer) return;
    footerCount.textContent = text;
    footer.classList.toggle("is-empty", !text);
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
    if (!activeScope) return;
    const chip = el(
      "span",
      { class: "chip search-scope-chip", title: scopeLabel() },
      el("span", { class: "search-scope-label", title: scopeLabel() }, scopeLabel()),
      el("button", {
        class: "x",
        type: "button",
        "aria-label": msg("search_remove_scope", [scopeLabel()]),
        onclick: () => { input.focus(); clearScope(); }
      }, "×")
    );
    chipHost.append(chip);
  }

  function setScope(scope) {
    activeScope = scope;
    renderChip();
    run(); // scope active → results (or an empty dropdown), never ghosts
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
    if (refreshGeneration !== inputGeneration || activeScope || input.value !== query) return;
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
    if (!activeScope && !input.value.trim()) {
      inputGeneration += 1;
      showGhosts();
    }
    else if (activeScope) {
      inputGeneration += 1;
      void run();
    }
    else void refreshCompletions();
  }

  function setSelected(i) {
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
    rows[selectedIndex]?.scrollIntoView({ block: "nearest" });
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
    inlineSuggestions, complete, preserveSelection = false
  }) {
    const priorSelection = preserveSelection ? selectedIndex : 0;
    current = next;
    // `in:` scope makes the source part of the meta redundant; drop it there.
    const showMeta = !(activeScope && activeScope.type === "in" && activeScope.value !== "history");
    const suggestionRows = buildSuggestRows(inlineSuggestions);
    const resultRows = buildResultRows(current, showMeta, suggestionRows.length);
    // A browser handoff only follows a true unscoped local miss. Filter
    // completions remain the next action while the person is still composing.
    const handoff = complete && !activeScope && current.length === 0 && suggestionRows.length === 0
      ? browserHandoffForInput(input.value)
      : null;
    const handoffRows = handoff ? [buildHandoffRow(handoff, suggestionRows.length)] : [];
    rows = [...suggestionRows, ...resultRows, ...handoffRows];
    rowEntries = [
      ...inlineSuggestions.map((_, index) => ({ kind: "suggest", index })),
      ...current.map((result) => ({ kind: "result", result })),
      ...(handoff ? [{ kind: "handoff", handoff }] : [])
    ];
    if (!activeScope && input.value.trim().length === 1 && current.length === 0 &&
        suggestionRows.length === 0) {
      showOneCharacterFallback();
      return rows.length;
    }
    const noMatches = complete && current.length === 0 && suggestionRows.length === 0 && !handoff &&
      (Boolean(activeScope) || input.value.trim().length >= 2);
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
    results.replaceChildren();
    mountOptionRows(groups, msg("search_aria_results"));
    if (noMatches) {
      if (activeScope) {
        results.append(
          el(
            "div",
            { class: "empty search-empty-actions" },
            msg("search_no_matches_scope", [scopeLabel()]),
            el("button", { type: "button", class: "linklike",
              onclick: () => { input.focus(); clearScope(); } }, msg("search_everywhere"))
          )
        );
      } else {
        results.append(el("div", { class: "empty" }, msg("search_no_matches")));
      }
    }
    if (noMatches) announce(activeScope
      ? msg("search_no_matches_scope", [scopeLabel()])
      : msg("search_no_matches"));
    else if (handoff) announce(msg("search_handoff_available"));
    else if (rows.length) announce(searchCount("result", rows.length, { announcement: true }));
    updateFooter(searchCount("result", rows.length));
    setSelected(Math.min(priorSelection, Math.max(0, rows.length - 1)));
    return rows.length;
  }

  async function run(waitForComplete = false) {
    const runToken = runGeneration.next();
    const runSpan = pspan("search:run(B7)"); // keystroke handler → first useful rows in the DOM
    const includeHistory = await hasHistoryAccess();
    if (!runToken.isCurrent()) return;
    const computeSpan = pspan("search:compute");
    const query = input.value;
    const scope = activeScope;
    // `showSuggest` paints immediately, then this debounced search replaces
    // that transient list with the same suggestion rows followed by results.
    // The query identity keeps an older prefix's suggestions out of a newer
    // query even before the input-generation guard has another chance to run.
    const inlineSuggestions = !scope && suggestionQuery === query ? suggestions : [];
    const progressive = await searchSession.searchProgressively(
      query, { scope, includeHistory }
    );
    if (!runToken.isCurrent() || input.value !== query || activeScope !== scope) return;
    const next = progressive.results.slice(0, 15);
    computeSpan(`${input.value.length} chars → ${next.length} primary results`);
    const rowCount = paintSearchResults(next, {
      inlineSuggestions,
      complete: !progressive.complete
    });
    runSpan(`${rowCount} primary rows`);

    if (!progressive.complete) return;
    const settleComplete = async () => {
      const finalResults = await progressive.complete;
      if (!finalResults || !runToken.isCurrent() ||
          input.value !== query || activeScope !== scope) return;
      paintSearchResults(finalResults.slice(0, 15), {
        inlineSuggestions,
        complete: true,
        preserveSelection: true
      });
    };
    if (waitForComplete) await settleComplete();
    else void settleComplete();
  }

  function bindGhostKeyboard(button) {
    button.addEventListener("keydown", (event) => {
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
      results.replaceChildren(el("div", { class: "empty" }, empty));
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
      names = await searchSession.scopeNames("domain");
    } catch {
      /* saved/live sources unavailable: the static in: suggestions still stand */
    }
    if (generation !== suggestionCacheGeneration) return warmDomainNames();
    domainNamesCache = names.slice(0, 1);
    return domainNamesCache;
  }

  /** Compute the top-2 labels (by tab count) once per page-load (cached). */
  async function warmLabelCounts() {
    if (labelCountsCache) return labelCountsCache;
    const generation = suggestionCacheGeneration;
    let groups = [];
    try {
      groups = await searchSession.labelCounts();
    } catch {
      /* labels unavailable — the in: suggestions still stand */
    }
    if (generation !== suggestionCacheGeneration) return warmLabelCounts();
    /* N41: the two examples are the two labels the user applied MOST RECENTLY,
     * not the two with the most tabs — a big old label is not the one you are
     * about to search for. Recency is F21's `labelMeta` register, which is
     * bumped only on apply/rename. A label with no recorded use yet (or a
     * pre-F21 one) falls back to tab count, then to name, so the order is
     * always total. */
    let recency = {};
    try { recency = await getLabelMeta(); } catch { /* recency unavailable → counts */ }
    labelCountsCache = [...groups].sort((a, b) =>
      (recency[b.label] ?? 0) - (recency[a.label] ?? 0) ||
      b.tabs - a.tabs ||
      a.label.localeCompare(b.label)).slice(0, 2);
    return labelCountsCache;
  }

  /** Ghost suggestion chips + recent tabs — every focused empty Search host's
   *  shared state. Navigation remains first; recents are a clearly separated
   *  second region and never replace the chips while loading. */
  function showGhosts() {
    if (activeScope || input.value.trim()) return;
    const ghostRun = ++ghostGeneration;
    suggestions = [];
    suggestionQuery = "";
    current = [];
    rows = [];
    rowEntries = [];
    selectedIndex = 0;
    recentPending = true;
    clearOptionRows();
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
    results.replaceChildren(
      el(
        "div",
        { class: "ghost-chips" },
        el("span", { class: "ghost-hint" }, msg("search_jump_to")),
        // S7 (1): lead with in:open; in:inbox/in:archive dropped from the examples
        // (still typeable). The reserved slots offer one frequent domain and
        // the two most recently used labels.
        ghostChip({ type: "in", value: "open" }),
        ghostChip({ type: "in", value: "snoozed" }),
        domainSlot,
        labelSlot
      ),
      recentSlot
    );
    const stillEmpty = (slot) =>
      ghostRun === ghostGeneration &&
      !(activeScope || input.value.trim() || !slot.isConnected);
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
      setSelected(0);
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
    if (domainNamesCache) fillDomains(domainNamesCache);
    if (labelCountsCache) fillLabels(labelCountsCache);
    if (!domainNamesCache || !labelCountsCache) {
      // E3-5: static in: ghosts paint synchronously, while the data-backed
      // suggestions warm at idle. Empty search focus must not compete with
      // cold Open for storage clones and tab normalization.
      const warm = () => {
        if (!domainNamesCache) warmDomainNames().then(fillDomains);
        if (!labelCountsCache) warmLabelCounts().then(fillLabels);
      };
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(warm, { timeout: 1000 });
      } else {
        setTimeout(warm, 0);
      }
    }
    Promise.all([
      chrome.tabs.query({ active: true, currentWindow: true }),
      chrome.windows.getAll({ populate: true, windowTypes: ["normal"] })
    ]).then(([active, windows]) => fillRecents(recentOpenTabResults(windows, {
      activeTabId: active[0]?.id,
      currentWindowId: active[0]?.windowId
    }))).catch(() => fillRecents([]));
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
    results.replaceChildren(
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
    results.replaceChildren();
    mountOptionRows([optionGroup(msg("search_group_suggestions"), "search-suggestion-group", rows)],
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
    results.replaceChildren();
    rows = [];
    rowEntries = [];
    updateFooter();
    announce("");
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
    results.replaceChildren(
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
  function clearPendingRows() {
    current = [];
    rows = [];
    rowEntries = [];
    selectedIndex = 0;
    clearOptionRows();
    results.replaceChildren();
    updateFooter();
  }

  input.addEventListener("input", () => {
    const inputRun = ++inputGeneration;
    clearTimeout(timer);
    // Invalidate immediately, not after the debounce: an older async search
    // must not paint during the 90 ms before this newer query starts.
    runGeneration.invalidate();
    ghostGeneration += 1;
    recentPending = false;
    clearPendingRows();
    // The interaction budget starts at the keystroke. Scope completion may
    // finish before this timer and replace/cancel it, but snapshot work can no
    // longer silently add itself in front of the approved 90 ms debounce.
    timer = setTimeout(run, SEARCH_DEBOUNCE_MS);
    inputPreparation = (async () => {
      // Prefix completion starts at i/l/s/d and continues through actual values.
      const sug = await scopeSuggestions(input.value);
      if (inputRun !== inputGeneration) return;
      if (sug) {
        showSuggest(sug);
        return;
      }
      suggestions = [];
      suggestionQuery = "";
      // A completed scope token is consumed into a chip (Gmail-style) — reached via
      // a trailing space or a pasted "in:open foo".
      const parsed = await searchSession.resolveScope(input.value);
      if (inputRun !== inputGeneration) return;
      if (parsed.scope) {
        clearTimeout(timer);
        input.value = parsed.query;
        setScope(parsed.scope);
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
  input.addEventListener("keydown", (e) => {
    // N23: an EMPTY search box hands ↓ to the page — it jumps to the first row
    // of whatever list is visible (the dashboard passes `exitToList`; the minimal
    // new-tab page doesn't and keeps its arrows). S7: "empty" means no text AND no
    // active scope chip — with a chip, ↓ navigates the scope's browse dropdown.
    if (e.key === "ArrowDown" && !input.value.trim() && !activeScope &&
        opts.exitToList && rows.length === 0 && !recentPending) {
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
      activeScope &&
      input.selectionStart === 0 &&
      input.selectionEnd === 0
    ) {
      // Backspace at the very start removes the scope chip (Gmail behavior).
      e.preventDefault();
      clearScope();
    } else if (e.key === "Escape") {
      // S7 Esc ladder: (1) clear typed text first; (2) then drop the scope chip;
      // (3) only when the box is truly empty (no text, no chip) leave search
      // entirely (N23 — focus to the page). Backspace-at-start still removes the
      // chip directly, so both exits stay available.
      e.preventDefault();
      if (input.value) {
        input.value = "";
        refresh(); // chip active → browse that scope; else → suggestion chips
      } else if (activeScope) {
        clearScope(); // → refresh() → suggestion chips (no text, no chip left)
      } else {
        close();
        input.blur();
      }
    }
  });

  /** @type {HTMLElement & {dismissSearch: (opts?: {blur?: boolean})=>void}} */
  const box = el("div", { class: "search-box" }, field, results, footer, liveStatus);
  // Content navigation can retire an open Search without synthesizing a key
  // event. Blur only when Search itself owns focus, so routing never steals
  // focus from another Dashboard control.
  box.dismissSearch = ({ blur = false } = {}) => {
    close();
    if (blur && box.contains(document.activeElement)) input.blur();
  };
  // Dismiss only when the click misses the *visible interactive* surface (the
  // field and the dropdown) — not the full-width wrapper, whose empty margins
  // used to swallow outside clicks and leave the dropdown stuck open.
  document.addEventListener("click", (e) => {
    if (!field.contains(e.target) && !results.contains(e.target) && !footer?.contains(e.target)) close();
  });
  // The keyboard command changes focus only. Content remains the same shared
  // chips-then-recents state used by every other Search focus.
  if (typeof opts.autofocusWhen === "function") {
    Promise.resolve().then(async () => {
      const autofocus = await opts.autofocusWhen();
      if (!autofocus || activeScope || input.value.trim()) return;
      input.focus({ preventScroll: true });
    }).catch(() => {});
  }
  return box;
}
