import fs from "node:fs";

/** Static manifest and shared Search-surface contracts. */
export function runSmokeSearchContracts(check) {
  const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const commands = manifest.commands || {};
  for (const name of ["dump-tab", "snooze-tab", "suspend-tab"]) {
    check(!!commands[name], `manifest defines the ${name} command`);
    check(
      commands[name] && !commands[name].suggested_key,
      `${name} ships with no default key (opt-in)`
    );
    check(
      !!commands[name]?.description,
      `${name} has a description for chrome.commands.getAll()`
    );
  }
  check(
    !commands._execute_action &&
      commands["open-search-popup"]?.suggested_key?.default === "Alt+Shift+K" &&
      commands["open-search-popup"]?.suggested_key?.mac === "MacCtrl+Shift+K",
    "P11-05: named Search-popup command replaces _execute_action and keeps its suggested keys"
  );
  check(
    !!commands["dump-window"]?.suggested_key,
    "dump-window command keeps its suggested key"
  );

  const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
  const background = read("../js/background.js");
  const popup = read("../js/ui/popup.js");
  const searchbox = read("../js/ui/searchbox.js");
  const dashboard = read("../js/ui/dashboard.js");
  const dashboardCss = read("../css/dashboard.css");
  const shortcuts = read("../js/ui/shortcuts.js");
  const primitives = read("../css/primitives.css");
  const shellHarness = read("../tools/shell-harness.html");

  check(
    background.includes('command === "open-search-popup"') &&
      background.includes("armSearchPopupMode()") &&
      background.includes("chrome.action.openPopup") &&
      background.includes("clearSearchPopupMode()") &&
      background.includes('openDashboard("search")'),
    "P11-05: the named command arms one-shot mode, opens the popup, and has a cleaned dashboard fallback"
  );
  check(
    popup.includes("autofocusWhen: consumeSearchPopupMode") &&
      !popup.includes("recentOpenTabResults"),
    "P11-05r: the keyboard handoff changes popup focus only; it no longer owns a separate result state"
  );
  check(
    searchbox.includes('typeof opts.autofocusWhen === "function"') &&
      searchbox.includes("input.focus({ preventScroll: true })") &&
      searchbox.includes("recentOpenTabResults(windows") &&
      searchbox.includes('class: "search-recent"') &&
      searchbox.includes('),\n      recentSlot\n    );') &&
      searchbox.includes("ghostRun === ghostGeneration") &&
      primitives.includes(".search-recent {") && primitives.includes(".search-recent-label"),
    "P11-05r: every focused Search shares chips first, then guarded recent tabs; keyboard mode only autofocuses"
  );
  check(
    searchbox.includes('const prefixes = ["in", "label", "session", "domain"]') &&
      searchbox.includes('/^(in|label|session|domain):') &&
      searchbox.includes('msg("search_keep_typing_filter")') &&
      searchbox.includes("showOneCharacterFallback()"),
    "P11-18/P11-20: one-character misses stay useful and filter keywords autocomplete before the colon"
  );
  check(
    searchbox.includes("suggestionQuery === query") &&
      searchbox.includes("const suggestionRows = buildSuggestRows(inlineSuggestions)") &&
      searchbox.includes("const resultRows = buildResultRows(current, showMeta, suggestionRows.length)") &&
      searchbox.includes('optionGroup(msg("search_group_suggestions"), "search-suggestion-group", suggestionRows)') &&
      searchbox.includes('`search-result-group${suggestionRows.length ? " has-separator" : ""}`') &&
      searchbox.includes('entry.kind === "suggest"') &&
      searchbox.includes("async function refreshCompletions()") &&
      searchbox.includes("input.value !== query") &&
      searchbox.includes("else void refreshCompletions()") &&
      primitives.includes(".search-option-group.has-separator {") &&
      !searchbox.includes("search-suggestion-separator"),
    "P11-20r/P11-24: completion and result groups stay ordered in one valid keyboard listbox"
  );
  check(
    shellHarness.includes('"session-long", "scope-long", "meta-long", "empty", "ghosts"') &&
      shellHarness.includes("rtype-session-entity") &&
      shellHarness.includes("3 windows · 18 tabs") &&
      shellHarness.includes("ghost-domain-slot") &&
      shellHarness.includes("ghost-label-slot") &&
      shellHarness.includes('heroPanel.style.width = "380px"'),
    "P11-19/P11-24: the visual harness covers long Session, scope, metadata, empty, and filter-syntax states"
  );
  check(
    searchbox.includes('const results = el("div", { class: "search-results" })') &&
      searchbox.includes('class: "search-option-list"') &&
      searchbox.includes('role: "listbox"') &&
      searchbox.includes('input.setAttribute("aria-controls", optionList.id)') &&
      searchbox.includes('input.removeAttribute("aria-controls")') &&
      searchbox.includes('role: "group"') &&
      searchbox.includes('class: "search-status sr-only"') &&
      searchbox.includes('"aria-live": "polite"') &&
      searchbox.includes('"aria-atomic": "true"'),
    "P11-24: the neutral visual shell exposes one dynamic controlled listbox plus a polite atomic status"
  );
  check(
    searchbox.includes("footer?: boolean") &&
      searchbox.includes('class: "search-footer-count"') &&
      searchbox.includes('class: "search-footer-hints"') &&
      searchbox.includes('msg("search_keyboard_hints")') &&
      searchbox.includes('searchCount("result", rows.length)') &&
      dashboard.includes("footer: true") &&
      dashboard.includes('searchFooter.classList.add("has-history-invite")') &&
      dashboard.includes("searchFooter.append(historyBtn)") &&
      dashboardCss.includes(".hero-search-overlay > .search-footer {") &&
      dashboardCss.includes("0 2px 6px color-mix") &&
      shellHarness.includes('class="search-footer-count"') &&
      shellHarness.includes("6 recent tabs") &&
      shellHarness.includes('p.get("history") === "off"'),
    "P11-24 polish: Dashboard Search keeps a truthful persistent footer and a tighter contact shadow"
  );
  check(
    /function close\(\) \{\s*clearTimeout\(timer\);\s*timer = 0;/.test(searchbox) &&
      searchbox.includes('class: "chip search-scope-chip"') &&
      searchbox.includes('class: "search-scope-label"') &&
      searchbox.includes('class: metaClass, title: meta') &&
      searchbox.includes('"rmeta rmeta-count"'),
    "P11-24: dismissal cancels pending work and long scope/meta anatomy retains full text plus fixed count lanes"
  );
  check(
    primitives.includes(".scope-chip-host .search-scope-chip {") &&
      primitives.includes("max-width: min(56%, 240px)") &&
      primitives.includes(".scope-chip-host .search-scope-label {") &&
      primitives.includes(".search-results .linklike {") &&
      primitives.includes(".search-results .search-empty-actions {") &&
      primitives.includes("min-height: 28px") &&
      primitives.includes(".rmeta-count {") &&
      dashboardCss.includes("0 0 0 4px var(--focus-ring)") &&
      dashboardCss.includes(".hero-panel:has(.search-results:not(:empty)):focus-within"),
    "P11-24: shared compact styling bounds names, preserves 28px actions and counts, and keeps Dashboard focus visible"
  );
  const resultTypeRule = primitives.match(/\.rtype \{([^}]*)\}/)?.[1] ?? "";
  check(
    /class: "rtitle"[\s\S]*class: metaClass[\s\S]*class: `rtype rtype-\$\{r\.type\}`/.test(searchbox) &&
      primitives.includes("border-radius: var(--shape-row);") &&
      primitives.includes(".search-row:hover { background: var(--nav-hover); }") &&
      primitives.includes(".search-row.selected { background: var(--accent-soft); }") &&
      !resultTypeRule.includes("background:") && !resultTypeRule.includes("border-radius:") &&
      primitives.includes(".ghost-label-slot { display: contents; }") &&
      primitives.includes("background: transparent;") &&
      primitives.includes("border-radius: var(--shape-control);") &&
      dashboard.includes('"Use browser History"'),
    "P11-24 polish: Search is a flat command list with aligned text outcomes and lightweight filter syntax"
  );
  check(
    dashboard.includes("const searchDeepLink = routeSearchIntent.searchDeepLink") &&
      dashboard.includes("searchInput.focus({ preventScroll: true })") &&
      shortcuts.includes('"open-search-popup": msg("command_search_description")') &&
      shortcuts.match(/const ORDER = \[[^\]]*"open-search-popup"/),
    "P11-05: older Chromium falls back to focused dashboard Search and live shortcut copy uses the named command"
  );
}
