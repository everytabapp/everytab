export async function runSmokePresentationContracts({ check, local }) {
  const mem = local;
  const { createMockLockManager } = await import("./e2-mocks.mjs");
  const { getFreshSettings } = await import("../js/lib/store.js");

  /* -- P9 quick-fix batch (N29/N30/N31) source contracts -- */
  {
    const fs = await import("node:fs");
    const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  
    // N31: the row-chip "+N"/"–" expander swaps its chips span in place. The old
    // behavior fired the section-wide onChange, re-rendering every card and
    // jumping the scroll away from the row being read (worst on the uncapped
    // Labels page).
    const tl = strip(read("../js/ui/tablist.js"));
    const expander = tl.slice(tl.indexOf("function rowChipsNode"), tl.indexOf("function chipText"));
    check(expander.includes("replaceWith"), "N31: row-chip expander swaps the chips span in place");
    check(!expander.includes("onChange()"), "N31: row-chip expander no longer fires the section-wide re-render");
    check(expander.includes(".focus()"), "N31: the replacement toggle receives focus (focus-never-dies)");
  
    const db = strip(read("../js/ui/dashboard.js"));
    const lc = strip(read("../js/ui/list-configs.js"));
    const labelsSurface = strip(read("../js/ui/labels-surface.js"));
    // N30: the Labels section wires chip navigation like every other section.
    // F14: the labels config moved to the shared list-configs module, so scan it
    // there (assertion preserved, not weakened).
    const cfgAt = lc.indexOf('section: "labels"');
    check(cfgAt !== -1 && lc.slice(cfgAt, cfgAt + 400).includes("onChipOpen: goToLabel"),
      "N30: Labels-page rows wire onChipOpen (label chips are clickable there)");
    // N29 (E3-1): programmatic label jumps are instant and paint the target first.
    const pos = labelsSurface.slice(labelsSurface.indexOf("function positionLabelCard"), labelsSurface.indexOf("async function goToLabel"));
    check(pos.includes('behavior: "auto"') && !pos.includes("smooth"),
      "N29: label-card positioning is instant (no smooth travel)");
    const rli = labelsSurface.slice(labelsSurface.indexOf("const render = coalesce"));
    check(rli.includes("buildList([quickTarget])"),
      "N29: a jump from another page renders the target card first (quick pass)");
    check(rli.includes("positionLabelCard(jump)"),
      "N29: the jumped-to card is re-anchored after the full list swap");
  }
  
  /* -- D4-2a: behavior-preserving design-foundation source contracts -- */
  {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = fileURLToPath(new URL("../", import.meta.url));
    const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
  
    const topLevelHtml = [
      "dashboard.html", "newtab.html", "sidepanel.html", "popup.html",
      "options.html", "focus.html", "suspend.html"
    ];
    check(
      topLevelHtml.every((p) => /<html\b[^>]*\blang="en"/i.test(read(p))),
      "D4-2a: every top-level extension HTML document declares lang=en"
    );
  
    const shippedCssAndHtml = [
      ...fs.readdirSync(path.join(root, "css"))
        .filter((name) => name.endsWith(".css"))
        .map((name) => `css/${name}`),
      ...topLevelHtml
    ];
    const transitionAll = shippedCssAndHtml.filter((p) =>
      /\btransition\s*:\s*all\b/i.test(read(p))
    );
    check(
      transitionAll.length === 0,
      `D4-2a: shipped CSS/HTML contains zero transition: all declarations (${transitionAll.join(", ") || "none"})`
    );
  
    const tokens = read("css/tokens.css");
    const expectedTokens = new Map([
      ["--sp-1", "2px"], ["--sp-2", "4px"], ["--sp-3", "6px"],
      ["--sp-4", "8px"], ["--sp-5", "10px"], ["--sp-6", "12px"],
      ["--sp-8", "16px"], ["--sp-10", "20px"], ["--sp-12", "24px"],
      ["--sp-16", "32px"],
      ["--text-micro", "10px"], ["--text-meta", "11px"],
      ["--text-control", "12px"], ["--text-body", "14px"],
      ["--text-section", "16px"], ["--text-page", "24px"],
      ["--shape-mini", "3px"], ["--shape-row", "0"],
      ["--shape-nav", "3px"], ["--shape-focus", "2px"],
      ["--shape-control", "5px"], ["--shape-search", "4px"],
      ["--shape-keeper", "7px"], ["--shape-panel", "9px"],
      ["--shape-card", "10px"], ["--shape-pill", "999px"],
      ["--motion-feedback", "80ms"], ["--motion-reveal", "140ms"],
      ["--motion-continuity", "180ms"],
      ["--ease-out", "cubic-bezier(.2, .8, .2, 1)"],
      ["--row-h-ultra", "34px"], ["--row-h-tight", "39px"],
      ["--row-h-default", "var(--row-h-ultra)"],
      ["--control-h-compact", "28px"], ["--control-h-default", "34px"],
      ["--search-h", "42px"]
    ]);
    check(
      [...expectedTokens].every(([name, value]) =>
        tokens.includes(`${name}: ${value};`)
      ),
      "D4-2a: tokens.css exposes the complete approved Layer-2 token API"
    );
    const softBlock = tokens.slice(
      tokens.indexOf('[data-corner-style="soft"]'),
      tokens.indexOf("\nbody {")
    );
    check(
      [
        "--shape-mini: 7px;", "--shape-nav: 8px;", "--shape-focus: 9px;",
        "--shape-control: 12px;", "--shape-search: 18px;", "--shape-keeper: 13px;",
        "--shape-panel: 14px;", "--shape-card: 14px;"
      ].every((decl) => softBlock.includes(decl)),
      "D4-2a: Soft corner profile overrides the approved seven shape roles"
    );
  
    const primitives = read("css/primitives.css");
    check(
      ["button.iconbtn", ".tagbox", ".chip", ".tagmenu", ".focus-strip",
        ".toast.toast-alert", ":where(button, a[href], summary, [tabindex])"]
        .every((selector) => primitives.includes(selector)),
      "D4-2a: shared primitives cover button/icon, field, chip, Float, feedback, and focus roles"
    );
    // D4-3b moved focus.html into the shared layer: the Focus guard page now
    // consumes the button-variant, link, panel, sr-only, and focus-ring roles
    // instead of restating them, so it necessarily loads the primitive sheet.
    const primitiveHosts = ["dashboard.html", "newtab.html", "sidepanel.html",
      "popup.html", "focus.html"];
    const isolatedHosts = ["options.html", "suspend.html"];
    check(
      primitiveHosts.every((p) => read(p).includes('href="css/primitives.css"')) &&
        isolatedHosts.every((p) => !read(p).includes('href="css/primitives.css"')),
      "D4-2a: the primitive stylesheet loads only in hosts consuming extracted shared roles"
    );
  }
  
  /* -- D4-2b: shared Tab Row, grouping, direct-action, and keeper contracts -- */
  {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { DEFAULT_SETTINGS } = await import("../js/lib/types.js");
    const { normalizeAppearanceSettings } = await import("../js/lib/store.js");
    const root = fileURLToPath(new URL("../", import.meta.url));
    const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
  
    check(
      DEFAULT_SETTINGS.uiScheme === "ink" && DEFAULT_SETTINGS.uiMode === "scheme" &&
      DEFAULT_SETTINGS.snapshotKeep === 200 && DEFAULT_SETTINGS.uiEmphasis === "bold" &&
      DEFAULT_SETTINGS.uiCheckboxShape === "round" &&
      DEFAULT_SETTINGS.uiCornerStyle === "soft" &&
      DEFAULT_SETTINGS.uiRowInfo === "detailed" &&
      DEFAULT_SETTINGS.uiUtilityLayout === "compact" &&
      DEFAULT_SETTINGS.uiWindowGrouping === "space" &&
      DEFAULT_SETTINGS.uiAccentCapStrength === "bold" &&
      DEFAULT_SETTINGS.uiActionLabels === "icons",
      "Settings cleanup: fresh defaults are additive and exact"
    );
    const repaired = normalizeAppearanceSettings({
      ...DEFAULT_SETTINGS,
      uiEmphasis: "loud",
      uiCheckboxShape: "triangle",
      uiCornerStyle: "pill",
      uiRowInfo: "everything",
      uiUtilityLayout: "stacked",
      uiWindowGrouping: "cards",
      uiAccentCapStrength: "huge",
      uiActionLabels: "wordy"
    });
    check(
      repaired.uiEmphasis === "bold" && repaired.uiCheckboxShape === "round" &&
      repaired.uiCornerStyle === "soft" && repaired.uiRowInfo === "detailed" &&
      repaired.uiUtilityLayout === "compact" &&
      repaired.uiWindowGrouping === "space" && repaired.uiAccentCapStrength === "bold" &&
      repaired.uiActionLabels === "icons",
      "D4-2b: invalid Appearance values normalize to safe approved defaults"
    );
  
    const settings = read("js/ui/settings-form.js");
    check(
      ["uiCheckboxShape", "uiCornerStyle", "uiRowInfo", "uiActionLabels"]
        .every((key) => settings.includes(key)) &&
      ["uiQuickTheme", "uiEmphasis", "dedupIgnoreQuery", "snoozeWakeQuiet", "popupDupHint"]
        .every((key) => !settings.includes(key)) &&
      !settings.includes('"Window grouping"') &&
      !settings.includes('"Accent cap weight"'),
      "Settings cleanup: useful controls remain and retired preferences leave the form"
    );
    const theme = read("js/ui/theme.js");
    const boot = read("js/boot.js");
    check(
      theme.includes('uiActionLabels: "actionLabels"') &&
      boot.includes('uiActionLabels: "action-labels"') &&
      settings.includes('settingsOptions("actionLabels")') &&
      read("js/ui/settings-copy.js").includes('named: "settings_option_actions_named"'),
      "D4 motion: Icons only is the cached default and row-action names remain an explicit preference"
    );
    check(
      !theme.includes("uiEmphasis") && !boot.includes("uiEmphasis") &&
        !read("css/tablist-d4.css").includes('data-emphasis="muted"'),
      "Settings cleanup: legacy Muted values cannot affect module, pre-paint, or list CSS"
    );
    const retiredReaders = ["js/ui/dashboard.js", "js/ui/command-box.js", "js/ui/popup.js",
      "js/lib/snooze.js", "js/background.js"];
    check(
      retiredReaders.every((path) =>
        !/uiQuickTheme|uiEmphasis|dedupIgnoreQuery|snoozeWakeQuiet|popupDupHint/.test(read(path))) &&
        !read("js/ui/popup.js").includes("Don't show this again"),
      "Settings cleanup: retired values have no production reader or permanent popup dismissal"
    );
    const fallbackHosts = ["dashboard.html", "newtab.html", "popup.html", "sidepanel.html",
      "options.html", "scheme-editor.html", "focus.html", "suspend.html"];
    check(
      fallbackHosts.every((path) => {
        const html = read(path);
        return /<html\b[^>]*data-scheme="ink"/s.test(html) &&
          /<html\b[^>]*data-mode="light"/s.test(html) &&
          /<html\b[^>]*data-emphasis="bold"/s.test(html) &&
          /<html\b[^>]*data-corner-style="soft"/s.test(html) &&
          /<html\b[^>]*data-row-info="detailed"/s.test(html) &&
          /<html\b[^>]*data-action-labels="icons"/s.test(html);
      }),
      "Settings cleanup: every production surface has the exact empty-cache fallback"
    );
  
    const { settingsFromStored, patchSettings, saveSettings } = await import("../js/lib/store.js");
    const { normalizePortableSettings } = await import("../js/lib/portable-state-registry.js");
    const autoSaveSettingsSource = read("js/ui/settings-form.js");
    const automationControlsSource = read("js/ui/automation-threshold-controls.js");
    const onboardingSource = read("js/ui/onboarding.js");
    const backgroundSource = read("js/background.js");
    check(
      DEFAULT_SETTINGS.autoSaveMaxTabs === 0 &&
        normalizePortableSettings({ autoSaveMaxTabs: 999999 }).autoSaveMaxTabs === 100000,
      "Auto-save max tabs: the portable setting defaults Off and is bounded on Restore"
    );
    check(
      autoSaveSettingsSource.includes("createAutomationThresholdControls") &&
        onboardingSource.includes("createAutomationThresholdControls") &&
        automationControlsSource.includes('number("autoSaveMaxTabs", 0, 999)') &&
        automationControlsSource.includes('number("snapshotKeep", 0, 10000)') &&
        backgroundSource.includes("scheduleAutoSaveCapSweep") &&
        backgroundSource.includes("autoSaveMaxTabs"),
      "Auto-save max tabs: shared Settings, Tune automation, and the responsive worker trigger are wired"
    );
    const previousSettings = await getFreshSettings();
    mem.settings = {
      ...DEFAULT_SETTINGS,
      uiScheme: "cream",
      uiMode: "system",
      uiCornerStyle: "crisp",
      uiRowInfo: "useful",
      uiActionLabels: "named",
      snapshotKeep: 0,
      uiQuickTheme: false,
      uiEmphasis: "muted",
      dedupIgnoreQuery: true,
      snoozeWakeQuiet: true,
      popupDupHint: false
    };
    await patchSettings({ uiSectionIntros: false });
    const preserved = mem.settings;
    const portable = normalizePortableSettings(preserved);
    check(
      preserved.uiScheme === "cream" && preserved.uiMode === "system" &&
        preserved.uiCornerStyle === "crisp" && preserved.uiRowInfo === "useful" &&
        preserved.uiActionLabels === "named" && preserved.snapshotKeep === 0,
      "Settings cleanup: new defaults never migrate existing non-retired preferences"
    );
    check(
      preserved.uiQuickTheme === false && preserved.uiEmphasis === "muted" &&
        preserved.dedupIgnoreQuery === true && preserved.snoozeWakeQuiet === true &&
        preserved.popupDupHint === false && portable.uiQuickTheme === false &&
        portable.uiEmphasis === "muted" && portable.dedupIgnoreQuery === true &&
        portable.snoozeWakeQuiet === true && portable.popupDupHint === false,
      "Settings cleanup: retired values survive unrelated patch and portable normalization byte-for-byte"
    );
    const missing = settingsFromStored({ snapshotKeep: 0 });
    check(
      missing.uiScheme === "ink" && missing.uiMode === "scheme" &&
        missing.uiCornerStyle === "soft" && missing.uiRowInfo === "detailed" &&
        missing.uiActionLabels === "icons" && missing.snapshotKeep === 0,
      "Settings cleanup: missing values receive new defaults while explicit snapshotKeep 0 stays unlimited"
    );
    await saveSettings(previousSettings);
  
    const shared = read("css/tablist-d4.css");
    const tablistSrcF34 = read("js/ui/tablist.js");
    const hosts = ["dashboard.html", "newtab.html", "sidepanel.html"];
    check(
      hosts.every((p) => read(p).includes('href="css/tablist-d4.css"')) &&
      shared.includes(".tablist .trow") && shared.includes(".tablist .item-head") &&
      shared.includes(".tablist > .bulk-bar.has-selection"),
      "D4-2b: Dashboard, New Tab Dashboard, and side panel consume one shared list presentation"
    );
    check(
      shared.includes('[data-action-labels="icons"] .tablist .action-label') &&
      shared.includes('.tablist[data-compact] .action-label') &&
      shared.includes('@container (max-width: 720px)') &&
      shared.includes(':is([data-action-id="suspend"], [data-action-id="wake"])') &&
      shared.includes("width: 76px;"),
      "D4 motion: names stay stable on wide rows while compact, narrow, and user-clean modes use icons"
    );
    check(
      shared.includes("min-height: var(--row-h-default)") &&
      shared.includes(".tablist .trow.sel::before") &&
      shared.includes("position: absolute") &&
      shared.includes(".tablist .tacts") &&
      shared.includes("visibility: hidden") &&
      shared.includes(".tablist .trow:hover .tacts"),
      "D4-2b: the selection rail and direct-action reveal occupy no row layout space"
    );
    check(
      !shared.includes('[data-corner-style="soft"] .tablist .trow') &&
      shared.includes('[data-checkbox-shape="round"]') &&
      shared.includes('[data-row-info="clean"]') &&
      shared.includes('[data-row-info="detailed"]') &&
      !shared.includes('[data-window-grouping="divider"]') &&
      !shared.includes('[data-window-grouping="accent-cap"]') &&
      shared.includes('.tablist:not([data-compact]) .trow') &&
      shared.includes("grid-template-columns: 17px 24px minmax(0, 1fr) auto auto") &&
      shared.includes(".tablist .row-copy {\n  display: contents;") &&
      shared.includes(".tablist .row-subline"),
      "F28: Workbench and compact hosts keep the approved row anatomy and square selection bands"
    );
  
    const tablist = read("js/ui/tablist.js");
    check(
      tablist.includes('class: "gacts"') &&
      tablist.includes('"aria-label": a.label') &&
      tablist.includes('"data-action-id": a.id') &&
      tablist.includes('class: "keeper-count"'),
      "D4-2b: shared DOM has stable header/action lanes, full accessible names, and count-first keeper markup"
    );
    const { fromOpenWindows } = await import("../js/ui/tablist.js");
    const openGroups = fromOpenWindows([{
      id: 9, focused: false, tabs: [
        { id: 10, windowId: 9, index: 0, url: "https://example.com", title: "Example", lastAccessed: 1234 }
      ]
    }], null, 9);
    check(
      openGroups[0].title === "Window 1" &&
      openGroups[0].meta === "1 tab" &&
      openGroups[0].badge === "(current window)" &&
      openGroups[0].live[0].lastAccessed === 1234,
      "D4-2b/F47: Open numbers real windows, marks its host window even while Chrome is unfocused, and keeps Detailed recency"
    );
    /* F47: naming and ordering. Chrome exposes no window name to extensions, and a
       name of ours would die with the session-scoped windowId, so a bound session
       lends its durable name. The window you are in comes first; nothing else
       moves. */
    {
      const { nameAndOrderOpenWindows } = await import("../js/ui/tablist.js");
      const { orderOpenWindowGroups } = await import("../js/ui/open-window-order.js");
      const raw = [
        { id: "1", title: "Window 1", glyph: "open", data: { id: 1 } },
        { id: "2", title: "Window 2", glyph: "open", data: { id: 2 } },
        { id: "3", title: "Window 3", glyph: "open", data: { id: 3, focused: false } }
      ];
      const out = nameAndOrderOpenWindows(raw,
        { 2: { sessionId: "s1" } }, new Map([["s1", { name: "Monday research" }]]), 3);
      check(out.map((g) => g.title).join(" | ") === "Window 3 | Window 1 | Monday research",
        "F47: the Dashboard host window leads even while unfocused, a bound window takes its session's durable name, and the rest keep Chrome's order");
      check(out[2].glyph === "sessions" && out[1].glyph === "open" &&
          raw[1].title === "Window 2",
        "F47: a named window is marked as one and the caller's groups are never mutated in place");
      const untouched = nameAndOrderOpenWindows(raw, {}, new Map(), 3);
      check(untouched.map((g) => g.title).join() === "Window 3,Window 1,Window 2",
        "F47: with no bindings the only change is promoting the window that contains this EveryTab surface");
      const inserted = { id: "4", title: "Window 4", glyph: "open", data: { id: 4 } };
      const placed = orderOpenWindowGroups([...raw, inserted], [1, 2, 3], {
        windowId: 4, afterWindowId: 1
      });
      check(placed.map((g) => g.data.id).join() === "1,4,2,3",
        "F47/P5: a new window created between cards retains that visible insertion slot");
    }
    /* F47r (MH's pick, option D): the name area is the fold control, so no glyph
       is added; a folded card shows its favicons, and past the strip cap says it
       in words instead. */
    {
      const tl = fs.readFileSync(new URL("../js/ui/tablist.js", import.meta.url), "utf8");
      const listCss = fs.readFileSync(new URL("../css/tablist-d4.css", import.meta.url), "utf8");
      check(
        // F47r2: BOTH must be MODULE level. Declared inside `createTabList` they
        // sat below the point where `renderGroup` already runs, so the `const` cap
        // was in its temporal dead zone and every render of a folded card threw,
        // killing the re-render that folding AND selection both depend on.
        /^const FOLD_STRIP_CAP = 8;$/m.test(tl) &&
        /^function foldedSummary\(g\) \{$/m.test(tl) &&
        !/\n  (?:const FOLD_STRIP_CAP|function foldedSummary)/.test(tl) &&
        tl.includes("refs.length === 0 || refs.length > FOLD_STRIP_CAP") &&
        tl.includes('class: "item-folded-mark" }, msg("list_folded"))') &&
        tl.includes("g.windows.flatMap((w) => w.refs ?? [])") &&
        tl.includes('class: "item-head-toggle", type: "button"') &&
        !tl.includes('class: "item-fold"') &&
        !/\.tablist \.item-fold[\s{.:]/.test(listCss),
        "F47r/F47r4: the name area is the fold control, a folded card shows its favicons or its count, and the state is said beside the name"
      );
      check(
        /\.tablist \.item-head-toggle \{[^}]*flex: 1/s.test(listCss) &&
        /\.tablist \.item-head-toggle > \.item-title \{ flex: 0 1 auto; \}/.test(listCss) &&
        /\.tablist \.fold-strip img\.fv,\s*\.tablist \.fold-strip \.fv-placeholder \{[^}]*margin-left: -5px/s.test(listCss) &&
        /\.tablist \.item-badge \{[^}]*color: var\(--accent-strong-ink\)/s.test(listCss) &&
        !/\.tablist \.item-badge \{[^}]*background:/s.test(listCss),
        "F47r: the accented mark is bare text that stays beside the name, and the folded favicons read as one stack"
      );
      check(
        // F47r3: the strip sizes its OWN favicons. The row rules are scoped to
        // `.trow`, so these reached none of them and every icon rendered at
        // whatever size the site served.
        /\.tablist \.fold-strip img\.fv,\s*\.tablist \.fold-strip \.fv-placeholder \{[^}]*width: 16px !important[^}]*height: 16px/s.test(listCss) &&
        /\.tablist \.fold-strip img\.fv,\s*\.tablist \.fold-strip \.fv-placeholder \{[^}]*object-fit: contain/s.test(listCss) &&
        !/\.tablist \.item-head-toggle:hover \{ background/.test(listCss) &&
        /\.tablist \.item-head-toggle:hover \.item-title \{ color: var\(--accent-strong-ink\); \}/.test(listCss) &&
        /\.tablist \.item-head-toggle:focus-visible \{[^}]*outline: 2px solid var\(--focus-accent\)/s.test(listCss),
        "F47r3: the folded strip sizes its own favicons at tab-strip scale, and the header hover is ink on the name rather than a row-sized wash"
      );
      check(
        /^function holdCardInPlace\(cardId, before\) \{$/m.test(tl) &&
        tl.includes("const before = head.getBoundingClientRect().top;") &&
        tl.includes("Promise.resolve(onChange()).then(() => raf(() => holdCardInPlace(g.id, before)));") &&
        tl.includes("if (before < 0) {") &&
        tl.includes('card.scrollIntoView({ block: "start", behavior: "auto" });') &&
        tl.includes("CSS.escape(cardId) : cardId"),
        "F47r3: folding holds its own header still, and brings it to the top when you were reading inside that window"
      );
    }
    const { fromDuplicateGroups } = await import("../js/ui/tablist.js");
    const duplicateGroups = fromDuplicateGroups([{
      key: "https://example.com/",
      keep: { id: 10, windowId: 9, index: 0, url: "https://example.com", title: "Example" },
      close: [{ id: 11, windowId: 12, index: 3, url: "https://example.com", title: "Example" }],
      tabs: [
        { id: 10, windowId: 9, index: 0, url: "https://example.com", title: "Example" },
        { id: 11, windowId: 12, index: 3, url: "https://example.com", title: "Example" }
      ]
    }]);
    check(
      duplicateGroups.length === 1 && duplicateGroups[0].refs.length === 2 &&
        duplicateGroups[0].live.length === 2 &&
        duplicateGroups[0].data.keepId === 10 &&
        duplicateGroups[0].data.closeIds.has(11),
      "F28: Duplicates adapts one canonical page to a survivor plus individually closable rows"
    );
  
    /* ---------------- F29: installed collection finishing pass ---------------- */
    const dashboardSrc = read("js/ui/dashboard.js");
    const duplicatesSrc = read("js/ui/duplicates-surface.js");
    const homeCss = read("css/dashboard.css");
    // (1) The floating palette is identified by its own marker, so a static
    // section toolbar that happens to carry .bulk-bar cannot be mistaken for the
    // keeper and pin the block after it to the viewport.
    check(
      tablist.includes('const panelSlot = el("div", { class: "keeper-panel-slot" });') &&
      !shared.includes(".bulk-bar + div") &&
      // F30 took the second sanctioned direction too: the static toolbar no
      // longer borrows the keeper's class at all.
      !duplicatesSrc.includes("bulk-bar duplicate-toolbar") &&
      duplicatesSrc.includes('class: "dup-toolbar"'),
      "F29: the static Duplicates toolbar cannot match the keeper panel-slot relation"
    );
    // (2) Only the explicitly marked slot floats, on both hosts.
    check(
      shared.includes(".tablist > .keeper-panel-slot:not(:empty) {") &&
      shared.includes('[data-surface="sidepanel"] .tablist > .keeper-panel-slot:not(:empty) {') &&
      shared.split(".keeper-panel-slot:not(:empty)").length - 1 === 2 &&
      shared.includes(".tablist > .bulk-bar.has-selection"),
      "F29: only the marked selection panel slot receives fixed palette positioning"
    );
    // (3) Both overflow controls are disclosure ROWS that publish their state;
    // the per-container one also names what it reveals.
    check(
      tablist.includes('class: "disclosure-row"') &&
      tablist.includes('class: "disclosure-row disclosure-section"') &&
      tablist.includes('"aria-expanded": expanded ? "true" : "false"') &&
      tablist.includes('"aria-expanded": st.sectionExpanded ? "true" : "false"') &&
      tablist.includes('btn.setAttribute("aria-controls", controls.id)') &&
      tablist.includes("moreBtn(g.id, g.refs.length - rowCap, expanded, body)") &&
      tablist.includes("moreBtn(key, w.refs.length - rowCap, expanded, block)") &&
      !tablist.includes('class: "mini2 show-more"'),
      "F29: per-group and section overflow controls are full disclosure rows with expansion state"
    );
    check(
      shared.includes(".tablist .disclosure-row {") &&
      shared.includes("width: 100%;") &&
      shared.includes(".tablist .disclosure-row:hover,\n.tablist .disclosure-row:focus-visible {") &&
      shared.includes(".tablist:not([data-compact]) .disclosure-row {") &&
      !homeCss.includes(".show-more {"),
      "F29: the disclosure row fills its width and takes row hover, not a chip highlight"
    );
    // (4) F34-4 removed Home, so its ledger cells are gone. F38 gives the
    // persistent Starred rail the collection family's flat ledger seams.
    check(
      ![".star-card", ".star-launch", ".home-signal", ".star-overflow", ".starred-shelf"]
        .some((sel) => homeCss.includes(sel)) &&
      /\.pu-star-row \{[^}]*border-radius: 0/s.test(homeCss) &&
      homeCss.includes(".pu-star-row + .pu-star-row { border-top: var(--bw) solid var(--border); }") &&
      /\.pu-row-action \{[^}]*border-radius: var\(--r-mini\)/s.test(homeCss),
      "F29/F38: Home's cells are gone and Starred uses flat ledger rows with standard controls"
    );
    // (5)+(6) Only the seam BETWEEN two selected rows goes; the run's outer
    // boundary, rail, and checkbox remain.
    check(
      shared.includes(".tablist .trow.sel:has(+ div:empty + .trow.sel) {\n  border-bottom-color: transparent;\n}") &&
      !shared.includes('[data-corner-style="soft"] .tablist .trow') &&
      shared.includes(".tablist:not([data-compact]) .trow {") &&
      shared.includes("border-bottom: var(--bw) solid color-mix(in srgb, var(--border) 72%, transparent);") &&
      shared.includes(".tablist:not([data-compact]) .trow.sel::before") &&
      !shared.includes(".tablist .trow.sel { border-bottom-color: transparent"),
      "F29: adjacent selected rows stay square, suppress only their seam, and keep the outer boundary"
    );
    // (7) The Duplicates behaviour this batch must not disturb.
    check(
      duplicatesSrc.includes('type: "close-duplicates", tabId: ctx.live.id') &&
      duplicatesSrc.includes('type: "close-duplicates", key: ctx.group.data.key') &&
      duplicatesSrc.includes('await msg({ type: "close-duplicates" });') &&
      duplicatesSrc.includes('id: "switch"') &&
      duplicatesSrc.includes("`tab ${(tab.index ?? 0) + 1} · ${role}`"),
      "F29: Duplicates keeps its per-tab, per-group, and global close paths after the layout repair"
    );
  
    /* ------------- F30: installed polish on chrome and Duplicates ------------- */
    // (1) A keeper control only collapses to a square when it has an icon to
    // show instead of its label, and it centres that icon.
    check(
      shared.includes(".tablist > .bulk-bar button {\n  display: inline-flex;") &&
      shared.includes('[data-action-labels="icons"] .tablist > .bulk-bar button:has(> .action-icon) {') &&
      shared.includes('[data-surface="sidepanel"] .tablist > .bulk-bar button:has(> .action-icon) {') &&
      !/\[data-surface="sidepanel"\] \.tablist > \.bulk-bar button \{/.test(shared),
      "F30: keeper buttons centre their icon and only icon-bearing ones become square"
    );
    // (2) The pane's footer is a flex sibling of a scrolling nav region, so it
    // cannot scroll out of reach, and it needs no opaque sticky patch.
    check(
      dashboardSrc.includes('el("div", { class: "side-scroll" },') &&
      /\.side-scroll \{[^}]*overflow-y: auto/s.test(homeCss) &&
      /\.sidebar \{[^}]*overflow: visible/s.test(homeCss) &&
      /\.side-foot \{[^}]*flex: none[^}]*border-top: var\(--bw\) solid var\(--border\)/s.test(homeCss) &&
      homeCss.includes('[data-nav="header"] .side-scroll { display: contents; }') &&
      dashboardSrc.includes('sidebar.querySelector(".side-scroll")?.addEventListener("scroll", closeThemePop)'),
      "F30: vault, appearance, and settings stay reachable below a separated scrolling nav"
    );
    check(
      // The depth cue is INSET, so the content column is the nearer surface and
      // the pane is the recess behind it. A cast shadow would say the opposite.
      /\.sidebar \{[^}]*box-shadow: inset -5px 0 5px -6px/s.test(homeCss) &&
      !/\.sidebar \{[^}]*box-shadow: 1px 0/s.test(homeCss) &&
      // F32: a shadow anchored to `--ink` is a white glow in dark schemes.
      /\.sidebar \{[^}]*var\(--shadow-ink\)/s.test(homeCss) &&
      homeCss.includes('[data-nav="header"] .sidebar { box-shadow: none; }'),
      "F30: the pane carries one soft inset edge shadow, and the horizontal header carries none"
    );
    // (3) Duplicates explains its survivor rule from one source and never calls
    // closing "duplicate".
    check(
      duplicatesSrc.includes("export const DUPLICATE_KEEP_RULE =") &&
      duplicatesSrc.includes('el("span", {}, DUPLICATE_KEEP_RULE)') &&
      duplicatesSrc.includes('class: "dup-role", title: DUPLICATE_KEEP_RULE') &&
      duplicatesSrc.includes('id: "close-extras", label: "Close extras", danger: true, key: "d",') &&
      !/id: "close-extras"[^}]*icon:/.test(duplicatesSrc),
      "F30: the keep rule is stated once and the close action no longer wears the copy glyph"
    );
    check(
      duplicatesSrc.includes('class: "dup-window"') &&
      shared.includes(".tablist .dup-window {") &&
      /\.tablist \.dup-role \{[^}]*background: var\(--accent\);[^}]*color: var\(--accent-ink\)/s.test(shared) &&
      shared.includes(".tablist .dup-toolbar {") &&
      shared.includes(".tablist .dup-toolbar-acts {"),
      "F30: the survivor is accented and every copy names its window on the row"
    );
    // (4) Search alone owns measured sticky geometry. Starred is an edge rail and
    // Needs you remains fixed in the wide top-right utility position.
    check(
      dashboardSrc.includes('const searchOverlay = el("div", { class: "hero-search-overlay" }, searchResults, searchFooter);') &&
      dashboardSrc.includes('const heroPanel = el("div", { class: "hero-panel" }, searchBox, searchOverlay);') &&
      dashboardSrc.includes('el("div", { class: "hero-top" }, heroPanel)') &&
      dashboardSrc.includes('pageUtilities.starred,') &&
      dashboardSrc.includes('const dailyStage = el("div", { class: "daily-stage" },') &&
      dashboardSrc.includes('const main = el("main", { class: "content", id: "main", tabindex: "-1" },\n  hero, dailyStage);') &&
      /\.hero-panel \{[^}]*border: var\(--bw\) solid var\(--border\)/s.test(homeCss) &&
      homeCss.includes(".hero-panel:focus-within { border-color: var(--focus-accent);") &&
      // F33: the field AND the input are both neutralized, or a second frame
      // appears inside the panel in light schemes.
      /\.hero-panel \.search-field,\s*\n\s*\.hero-panel \.search-field:focus-within,\s*\n\s*\.hero-panel \.search-input,\s*\n\s*\.hero-panel \.search-input:focus \{[^}]*border: none[^}]*box-shadow: none[^}]*outline: none/s.test(homeCss) &&
      // F37: the connected overlay, not the hero, owns the growing results.
      /\.hero-search-overlay \{[^}]*position: absolute[^}]*z-index: 30/s.test(homeCss) &&
      /\.hero-search-overlay \.search-results \{[^}]*position: static/s.test(homeCss) &&
      // The old stats line and all three F35 presentation systems are retired.
      !homeCss.includes(".statsline") &&
      !homeCss.includes('data-utility-layout') &&
      !homeCss.includes('.pu-shelf') && !homeCss.includes('.pu-rail') &&
      !homeCss.includes('.pu-compact') &&
      /\[data-mode="dark"\] \.hero-panel \{[^}]*background: var\(--surface-2\)/s.test(homeCss),
      "F38: Search keeps the F37 overlay while workspace utilities stay outside sticky geometry"
    );
    check(
      homeCss.includes('body[data-workbench="true"] .hero .hero-panel { max-width: 760px; }') &&
      homeCss.includes('.hero-top, .daily-stage { width: 100%; max-width: none; margin: 0; }') &&
      homeCss.includes('body[data-workbench="true"] .daily-stage .sections { max-width: none; }') &&
      !/\.hero \.search-field \{[^}]*border-radius: 999px/s.test(homeCss),
      "F38: Search stays 760px while structured collections use the available workspace width"
    );
    // F32: elevation darkens in BOTH modes, and the sticky shell paints the page
    // background rather than a band of its own.
    const tokensCss = read("css/tokens.css");
    check(
      tokensCss.includes("--shadow-ink: var(--ink);") &&
      /\[data-mode="dark"\] \{[^}]*--shadow-ink: #000;/s.test(tokensCss) &&
      tokensCss.includes("--shadow-1: 0 1px 3px color-mix(in srgb, var(--shadow-ink) 8%, transparent);") &&
      !/box-shadow:[^;]*var\(--ink\)/.test(homeCss) &&
      !/box-shadow:[^;]*var\(--ink\)/.test(shared),
      "F32: every elevation is anchored to --shadow-ink so dark schemes cast shadow, not glow"
    );
    check(
      /\.hero \{[^}]*background: var\(--bg-solid\); background-attachment: fixed/s.test(homeCss) &&
      homeCss.includes("body.gradient .hero,") &&
      /body\.gradient \.hero,[^}]*background: var\(--bg-grad, var\(--bg-solid\)\)/s.test(homeCss),
      "F32: the sticky shell paints the page background at the viewport, so it reads as no band"
    );
    // F39 restores one page-owned 12px shelf after the installed build proved
    // that a transparent sticky offset makes passing row text legible.
    check(
      /\.hero::after \{ content: ""; position: absolute; z-index: 0; top: 100%;[^}]*height: var\(--sp-10\)[^}]*background: var\(--bg-solid\); background-attachment: fixed/s.test(homeCss) &&
      /body\.gradient \.hero::after,[^}]*background: var\(--bg-grad, var\(--bg-solid\)\)/s.test(homeCss) &&
      !/\.hero::after \{[^}]*mask/s.test(homeCss) &&
      /\.hero \{[^}]*padding: var\(--sp-10\) var\(--pad-x\) 0;/s.test(homeCss) &&
      /\.hero \{[^}]*background: var\(--bg-solid\); background-attachment: fixed/s.test(homeCss) &&
      homeCss.includes("body.gradient .hero,"),
      "F39: one viewport-anchored page shelf occludes rows across the sticky-header gap"
    );
  
    /* ---------------- F34-1: the command box at rest ---------------- */
    const cmdSrc = read("js/ui/command-box.js");
    const {
      attentionItems, countOverdueSnoozes, sessionDriftFact,
      recentAutomaticAttention, ATTENTION_LIMIT, RECENT_AUTOMATIC_MS,
      INBOX_ATTENTION_COUNT, INBOX_ATTENTION_AGE_MS
    } = await import("../js/ui/command-box.js");
    const attentionNow = 10 * 24 * 60 * 60 * 1000;
    const recentAuto = {
      id: "auto-save", at: attentionNow - 5 * 60 * 1000, auto: true,
      label: "Auto-saved 3 tabs to the Inbox", reopen: [[{ url: "https://saved.example" }]]
    };
    // (1) The queue vanishes when empty, caps at three, and never lets automatic
    // activity displace a ranked unresolved action.
    check(
      attentionItems({}, attentionNow).length === 0 && ATTENTION_LIMIT === 3 &&
      attentionItems({
        vaultIssue: "reconnect", overdueSnoozes: 2,
        sessionDrift: { windows: 1, tabs: 3, sessionName: "Work" },
        duplicates: 9, automaticActions: [recentAuto]
      }, attentionNow).map((i) => i.id).join() === "vault,snoozed,session-drift" &&
      attentionItems({ duplicates: 2, automaticActions: [recentAuto] }, attentionNow)
        .map((i) => i.id).join() === "duplicates,automatic:auto-save" &&
      attentionItems({ duplicates: 2 }, attentionNow)[0].label === "2 duplicates" &&
      attentionItems({ inboxItems: Array.from({ length: 20 }, (_, i) => ({
        id: String(i), modifiedAt: attentionNow - 60_000
      })) }, attentionNow)[0].label === "20 Inbox items",
      "P11-25: Needs you is an empty-when-clear three-entry queue with actionables before automatic activity"
    );
    // (2) A planned future wake is not attention; only an overdue record is.
    check(
      countOverdueSnoozes([{ dueAt: 1000 }, { dueAt: 3000 }], 2000) === 1 &&
      countOverdueSnoozes([{ dueAt: 2000 }], 2000) === 1 &&
      countOverdueSnoozes([{ dueAt: 2001 }], 2000) === 0,
      "P11-25: future snoozes remain plans and only overdue snoozes ask for attention"
    );
    // (3) Inbox is quiet below both thresholds, then becomes actionable by
    // volume or age without turning every ordinary item into a permanent count.
    check(
      INBOX_ATTENTION_COUNT === 20 && INBOX_ATTENTION_AGE_MS === 7 * 86400_000 &&
      attentionItems({ inboxItems: Array.from({ length: 19 }, (_, i) => ({
        id: String(i), modifiedAt: attentionNow - 60_000
      })) }, attentionNow).length === 0 &&
      attentionItems({ inboxItems: Array.from({ length: 20 }, (_, i) => ({
        id: String(i), modifiedAt: attentionNow - 60_000
      })) }, attentionNow)[0].id === "inbox" &&
      attentionItems({ inboxItems: [{ id: "old", modifiedAt: attentionNow - INBOX_ATTENTION_AGE_MS }] },
        attentionNow)[0].label === "Inbox waiting 7d",
      "P11-25: Inbox appears only when its age or volume makes triage useful"
    );
    // (4) Automatic snapshots, older/undone actions, and manual work never enter
    // the automatic tail. The same fallback also protects imported old entries.
    check(
      RECENT_AUTOMATIC_MS === 86400_000 &&
      recentAutomaticAttention([
        recentAuto,
        { ...recentAuto, id: "snapshot-kind", category: "snapshot", label: "Automatic recovery" },
        { ...recentAuto, id: "snapshot-label", label: "Auto-snapshot saved" },
        { ...recentAuto, id: "old", at: attentionNow - RECENT_AUTOMATIC_MS - 1 },
        { ...recentAuto, id: "undone", undone: true },
        { ...recentAuto, id: "manual", auto: false }
      ], attentionNow).map((i) => i.entryId).join() === "auto-save",
      "P11-25: the recent automatic tail excludes snapshots, stale entries, undone entries, and manual work"
    );
    // (5) Session drift reads only named identities. One saved URL plus one new
    // URL becomes a direct Open action; a matching window stays quiet.
    const driftSession = {
      id: "session-1", name: "Client review",
      windowUrls: [["https://saved.example/page"]]
    };
    check(
      JSON.stringify(sessionDriftFact([
        { id: 9, tabs: [
          { url: "https://saved.example/page" }, { url: "https://new.example/page" }
        ] }
      ], { 9: { sessionId: "session-1", windowIndex: 0 } }, [driftSession])) ===
        JSON.stringify({ windows: 1, tabs: 1, sessionName: "Client review" }) &&
      sessionDriftFact([
        { id: 9, tabs: [{ url: "https://saved.example/page" }] }
      ], { 9: { sessionId: "session-1", windowIndex: 0 } }, [driftSession]) === null,
      "P11-25: restored Session drift becomes attention only when a live window has new URLs"
    );
    // (6) Needs you has one fixed responsive home to Search's right. It
    // disappears when the available width cannot hold the line, but not on scroll.
    check(
      cmdSrc.includes('class: "page-attention", "aria-label": "Needs you", hidden: true') &&
      cmdSrc.includes('attentionLine.hidden = attention.length === 0;') &&
      /const heroUtility = el\("div", \{ class: "hero-utility" \},\s*pageUtilities\.attention, focusUtility\)/.test(dashboardSrc) &&
      /\.page-attention \{ display: none;[^}]*justify-content: flex-end/s.test(homeCss) &&
      /\.content \{[^}]*--utility-right: clamp\(18px, 2vw, 28px\)/s.test(homeCss) &&
      /\.hero-utility \{ position: fixed;[^}]*top: var\(--sp-10\);[^}]*right: var\(--utility-right\);[^}]*max-width: calc\(100vw - var\(--nav-w, 204px\) - var\(--pad-x\) - 780px/s.test(homeCss) &&
      /@media \(min-width: 1600px\)[\s\S]*\.page-attention:not\(\[hidden\]\) \{[^}]*display: flex/s.test(homeCss) &&
      !homeCss.includes(".page-attention.is-scrolled-away") &&
      !dashboardSrc.includes("attentionSentinel") &&
      !dashboardSrc.includes("IntersectionObserver"),
      "F40: Needs you stays fixed at Search's right edge whenever that line fits"
    );
    // (4) Starred stays anchored by the hero on the sticky-window axis. Wide
    // layouts yield a real 300px row inset; the layout commit uses snapshots.
    check(
      /const hero = el\([\s\S]{0,300}pageUtilities\.starred,[\s\S]{0,80}focusStrip/.test(dashboardSrc) &&
      /\.starred-edge \{ position: absolute; z-index: 24;/.test(homeCss) &&
      /\.starred-edge\.is-open \{ width: min\(280px,[^}]*overflow: clip/s.test(homeCss) &&
      /\.starred-edge \{[^}]*top: calc\(100% \+ var\(--sp-10\) \+ var\(--section-lead-h, 44px\)[^}]*var\(--section-local-h, 0px\)\)[^}]*right: calc\(-1 \* var\(--bw\)\)/s.test(homeCss) &&
      /\.starred-edge:not\(\.is-open\) \.starred-edge-toggle \{[^}]*border-right: 0[^}]*border-radius: var\(--shape-panel\) 0 0 var\(--shape-panel\)/s.test(homeCss) &&
      /@media \(min-width: 1280px\)[\s\S]*\.content:has\(\.starred-edge\.is-open\) \.daily-stage \{[^}]*padding-right: calc\(300px - var\(--pad-x\)\)/s.test(homeCss) &&
      /\.starred-edge\.is-open \{[^}]*box-shadow: none/s.test(homeCss) &&
      homeCss.includes("view-transition-name: starred-workspace;") &&
      homeCss.includes("view-transition-name: starred-rail;") &&
      dashboardSrc.includes("document.startViewTransition(update)") &&
      /\.starred-edge-toggle \.ic \{ fill: currentColor; \}/.test(homeCss) &&
      !/\.content \{[^}]*grid-template-columns:[^}]*240px/s.test(homeCss),
      "F39: the flat filled-star edge tab aligns to sticky rows and pushes wide collections"
    );
    // (5) The rail's open/reduced form is a persistent user state, not a route
    // state, so changing collection pages cannot collapse it.
    check(
      cmdSrc.includes('const STARRED_RAIL_OPEN_KEY = "tvStarredRailOpen";') &&
      cmdSrc.includes('localStorage.getItem(STARRED_RAIL_OPEN_KEY) === "true"') &&
      cmdSrc.includes('localStorage.setItem(STARRED_RAIL_OPEN_KEY, String(railOpen))') &&
      !dashboardSrc.includes('classList.remove("is-open")'),
      "F36: Starred remembers its expanded state across collection routes and reloads"
    );
    // (6) The F35 presentation chooser is retired from markup, prepaint, live
    // appearance application, and Settings while its stored key remains safe.
    check(
      !read("dashboard.html").includes("data-utility-layout") &&
      !read("newtab.html").includes("data-utility-layout") &&
      !read("js/boot.js").includes('"data-utility-layout"') &&
      !read("js/ui/theme.js").includes("uiUtilityLayout") &&
      !read("js/ui/settings-form.js").includes("uiUtilityLayout"),
      "F36: the superseded Shelf, Rail, and Compact appearance setting is no longer exposed"
    );
    // (7) The box refreshes on every route, and its two rows keep the split that
    // keeps live-tab events off the starred path.
    check(
      // F34-4: starred is its own task now that Home is gone, and it is
      // deliberately NOT a tab-refresh task, because the launcher reads no live
      // tabs. The attention row is the one that follows live tabs.
      dashboardSrc.includes("const renderStarred = coalesce(() => pageUtilities.refreshStarred());") &&
      dashboardSrc.includes("const renderAttention = coalesce(() => pageUtilities.refreshAttention());") &&
      dashboardSrc.includes("  starred: renderStarred,") &&
      dashboardSrc.includes("  attention: renderAttention,") &&
      read("js/ui/refresh-scheduler.js").includes('"open", "attention", "duplicates", "nav"') &&
      !read("js/ui/refresh-scheduler.js").includes('tasks.add("home")') &&
      read("js/ui/refresh-scheduler.js").includes('if (changes.starred) tasks.add("starred");') &&
      !cmdSrc.includes("chrome.tabs.query"),
      "F36: Starred is its own task and never depends on a live-tab query"
    );
    // (8) --hero-h is still measured and published after the shell changed shape.
    check(
      dashboardSrc.includes('document.documentElement.style.setProperty("--hero-base-h", `${baseHeight}px`)') &&
      dashboardSrc.includes('"calc(var(--hero-base-h) + var(--focus-layout-h, 0px))"') &&
      dashboardSrc.includes("new ResizeObserver(() => measureHero()).observe(hero)"),
      "F34-1: the measured sticky geometry survives the command box"
    );
  
    /* ---------------- F34-2: rename and unstar ---------------- */
    const starredSrc = read("js/lib/starred.js");
    // (1) Rename is one atomic commit carrying the PREVIOUS record, so Undo
    // restores the old name exactly, and it refuses a name that says nothing.
    check(
      starredSrc.includes("export async function renameStarred(id, title)") &&
      /renameStarred[\s\S]{0,700}mutateStores\(\[STORE_KEYS\.starred, JOURNAL_KEY\]/.test(starredSrc) &&
      /renameStarred[\s\S]{0,700}puts: \[\{ store: STORE_KEYS\.starred, item \}\]/.test(starredSrc) &&
      /renameStarred[\s\S]{0,400}if \(!next\) return false;/.test(starredSrc) &&
      /renameStarred[\s\S]{0,700}item\.title === next\) return null;/.test(starredSrc),
      "F34-2: renameStarred commits the new name and its undo entry in one atomic set"
    );
    const { renameStarred } = await import("../js/lib/starred.js");
    check(
      typeof renameStarred === "function" &&
      await renameStarred("missing-id", "   ") === false,
      "F34-2: a blank rename is refused before any storage work"
    );
    /* F45: shortcuts are a list the user arranges. Reordering is a real store
       commit, is NOT journaled (its inverse is the opposite arrow, and every
       entry would raise the undo toast), and rewrites only the records whose
       index actually moved. */
    {
      const { moveStarred, byStarredOrder, listStarred: listS } =
        await import("../js/lib/starred.js");
      const { createInterleavableStorage } = await import("./e2-mocks.mjs");
      const savedLocal = chrome.storage.local;
      const savedChanged = chrome.storage.onChanged;
      const seed = (positions) => {
        const map = {};
        positions.forEach((title, index) => {
          map[`id-${index}`] = { id: `id-${index}`, title, url: `https://${title}.test/`,
            position: index, createdAt: 1000 + index, modifiedAt: 1000 + index };
        });
        return map;
      };
      navigator.locks = createMockLockManager();
      const ist = createInterleavableStorage({ deviceId: "dev-star-order" });
      chrome.storage.local = ist.local;
      chrome.storage.onChanged = ist.onChanged;
      await ist.local.set({ starred: seed(["a", "b", "c"]) });
      ist.setLog.length = 0;
  
      const namesNow = async () => (await listS()).map((item) => item.title).join(",");
      check(await moveStarred("id-2", -1) !== false && await namesNow() === "a,c,b",
        "F45: moving a shortcut up puts it before its neighbour");
      check(await moveStarred("id-2", 1) !== false && await namesNow() === "a,b,c",
        "F45: the opposite arrow is the exact inverse");
      check(await moveStarred("id-0", -1) === false && await namesNow() === "a,b,c",
        "F45: the first shortcut cannot move up, and nothing is written");
      check(await moveStarred("id-2", 1) === false && await namesNow() === "a,b,c",
        "F45: the last shortcut cannot move down");
      check(await moveStarred("gone", -1) === false,
        "F45: a shortcut removed elsewhere moves nothing");
      ist.setLog.length = 0;
      const untouchedBefore = ist.snapshot().starred["id-2"].modifiedAt;
      await moveStarred("id-0", 1);
      const s = ist.snapshot();
      check(!("journal" in s) && ist.setLog.length === 1 &&
          JSON.stringify(ist.setLog[0]) === JSON.stringify(["starred"]) &&
          await namesNow() === "b,a,c" &&
          // the record whose index never changed is never rewritten, so a reorder
          // stays cheap to merge through the vault
          s.starred["id-2"].modifiedAt === untouchedBefore && s.starred["id-2"].position === 2,
        "F45: a reorder is one un-journaled commit that leaves the records it did not move untouched");
      check(byStarredOrder({ position: 0, createdAt: 2, id: "b" }, { position: 0, createdAt: 1, id: "a" }) > 0,
        "F45: two shortcuts sharing a merged position still order totally, by age then id");
      /* F45r: the pointer path drops at an index and CLAMPS, because releasing
         below the last row plainly means "put it last". */
      const { reorderStarred } = await import("../js/lib/starred.js");
      check(await namesNow() === "b,a,c" &&
          await reorderStarred("id-0", 0) !== false && await namesNow() === "a,b,c",
        "F45r: a drop moves the dragged shortcut to the index it was released at");
      check(await reorderStarred("id-0", 99) !== false && await namesNow() === "b,c,a",
        "F45r: a drop past the end is clamped to last, not refused");
      check(await reorderStarred("id-0", -5) !== false && await namesNow() === "a,b,c",
        "F45r: a drop above the first row is clamped to first");
      check(await reorderStarred("id-0", 0) === false,
        "F45r: dropping a shortcut where it already sits writes nothing");
      chrome.storage.local = savedLocal;
      chrome.storage.onChanged = savedChanged;
    }
    // (2) Unstar is direct, shares the row-action badge with Rename, exits
    // optimistically, and journals so the shell can offer Undo.
    check(
      cmdSrc.includes('title: `Unstar ${name}`, "aria-label": `Unstar ${name}`') &&
      cmdSrc.split('class: "pu-row-action"').length - 1 === 2 &&
      cmdSrc.includes('wrap.classList.add("leaving");') &&
      cmdSrc.includes("await unstarTab(item.id)") &&
      /\.pu-row-action \{[^}]*width: 26px; height: 26px[^}]*border-radius: var\(--r-mini\)/s.test(homeCss) &&
      /unstarTab[\s\S]{0,400}puts: \[\{ store: STORE_KEYS\.starred, item \}\]/.test(starredSrc),
      "F36: Starred rename and unstar share one badge style and unstar journals its undo"
    );
    // (3) F36 replaces cramped chips with stable rail rows: the name flexes and
    // ellipsizes while its two controls keep a fixed lane.
    check(
      /\.pu-star-link \{[^}]*min-width: 0[^}]*flex: 1/s.test(homeCss) &&
      /\.pu-star-link > span:last-child \{[^}]*text-overflow: ellipsis[^}]*white-space: nowrap/s.test(homeCss) &&
      /\.pu-row-actions \{[^}]*flex: none/s.test(homeCss),
      "F36: Starred rows ellipsize the name without shrinking or moving their action lane"
    );
    // (4) Rename edits in place. No modal, and Esc restores.
    check(
      cmdSrc.includes('function startRename(item, wrap)') &&
      cmdSrc.includes('else if (event.key === "Escape") { event.preventDefault(); finish(false); }') &&
      cmdSrc.includes('if (event.key === "Enter") { event.preventDefault(); finish(true); }') &&
      cmdSrc.includes('input.addEventListener("blur", () => finish(true));') &&
      cmdSrc.includes('if (wrap.querySelector(".pu-rename")) return;') &&
      homeCss.includes(".pu-rename {") && !homeCss.includes(".cmd-rename {"),
      "F36: the Starred rail keeps one in-place rename editor with Enter, Escape, and blur"
    );
    check(
      cmdSrc.includes('class: "pu-row-action"') &&
      cmdSrc.includes('title: `Rename ${name}`, "aria-label": `Rename ${name}`') &&
      cmdSrc.includes('wrap.append(launch, el("span", { class: "pu-row-actions" }, rename, remove));') &&
      // F2 stays as an accelerator on the focused launcher, not the only way in.
      !cmdSrc.includes("ondblclick") &&
      cmdSrc.includes('if (event.key === "F2")') &&
      /\.pu-row-action:hover, \.pu-row-action:focus-visible \{[^}]*opacity: 1/s.test(homeCss),
      "F36: Starred rename has a visible control and F2 remains its accelerator"
    );
  
    /* ---------------- F37: results overlay the page ---------------- */
    // The open state is derived from the shared results region having content, so
    // every existing open/close path stays correct without new JS state.
    check(
      // Results and History live in one absolute child. Its content can change
      // without contributing a pixel to the ResizeObserver-measured hero.
      !homeCss.includes(".cmd-rows { display: none; }") &&
      /\.hero-search-overlay \{[^}]*position: absolute[^}]*top: calc\(100% - var\(--bw\)\)/s.test(homeCss) &&
      /\.hero-search-overlay \.search-results \{[^}]*max-height: 46vh[^}]*overflow-y: auto/s.test(homeCss) &&
      /\.hero-search-overlay > \.search-footer \{[^}]*min-height: 30px/s.test(homeCss) &&
      dashboardSrc.includes('const searchResults = searchBox.querySelector(".search-results");') &&
      dashboardSrc.includes('const searchOverlay = el("div", { class: "hero-search-overlay" }, searchResults, searchFooter);') &&
      !dashboardSrc.includes("commandBox.element"),
      "F37: Search results and History grow in an absolute overlay without changing sticky geometry"
    );
  
    /* ---------------- F34-7: rhythm, sticky window headers, play glyph -------- */
    // One inset and one row height across every row the box holds, including the
    // suggestion rows, which centre rather than sitting on a baseline.
    check(
      /\.hero-panel \{[^}]*--cmd-inset: 14px;[^}]*--cmd-row-h: 40px;[^}]*--search-inset: var\(--cmd-inset\);[^}]*--search-row-block: 5px;/s.test(homeCss) &&
      /\.hero-panel \.search-field \{[^}]*min-height: var\(--cmd-row-h\)/s.test(homeCss) &&
      /\.hero-panel \.ghost-chips \{ min-height: var\(--cmd-row-h\); \}/.test(homeCss) &&
      !/\.hero-panel \.search-row \{[^}]*padding:/s.test(homeCss),
      "F36: the one-row Search and its inserted result rows keep one inset and centred rhythm"
    );
    // The window header sticks below the box and its own card pushes it out. The
    // card must CLIP rather than hide, or it becomes a scroll container and the
    // header never sticks at all.
    check(
      /\.tablist:not\(\[data-compact\]\) > \.item \{[^}]*overflow: clip/s.test(shared) &&
      !/\.tablist:not\(\[data-compact\]\) > \.item \{[^}]*overflow: hidden/s.test(shared) &&
      /\.tablist:not\(\[data-compact\]\) > \.item > \.item-head-shell \{[^}]*position: sticky/s.test(shared) &&
      /\.tablist:not\(\[data-compact\]\) > \.item > \.item-head-shell \{[^}]*top: calc\(var\(--hero-h, 108px\) \+ var\(--sp-10\)[^}]*var\(--section-lead-h, 44px\)[^}]*var\(--section-local-h, 0px\)\)[^}]*z-index: 6[^}]*isolation: isolate/s.test(shared) &&
      !/\.tablist:not\(\[data-compact\]\) > \.item \{[^}]*overflow-clip-margin/s.test(shared) &&
      /\.tablist:not\(\[data-compact\]\) > \.item \{[^}]*border: 0[^}]*background: transparent[^}]*box-shadow: none/s.test(shared) &&
      !/\[data-mode="dark"\] \.tablist:not\(\[data-compact\]\) > \.item \{[^}]*box-shadow/s.test(shared) &&
      /\.tablist:not\(\[data-compact\]\) > \.item > \.item-head-shell > \.item-head \{[^}]*position: relative[^}]*z-index: 1[^}]*margin-inline: 0[^}]*border: var\(--bw\) solid var\(--border\)[^}]*border-radius: var\(--cap-radius\) var\(--cap-radius\) 0 0/s.test(shared) &&
      /\.tablist:not\(\[data-compact\]\) > \.item > \.item-body-frame \{[^}]*overflow: clip[^}]*border: var\(--bw\) solid var\(--border\)[^}]*border-top: 0[^}]*border-radius: 0 0 var\(--shape-panel\) var\(--shape-panel\)/s.test(shared) &&
      /const bodyFrame = groupPanelTop[\s\S]*class: "item-body-frame"[\s\S]*const headShell = el\("div", \{ class: "item-head-shell" \}, head\)[\s\S]*headShell, folded \? null : bodyFrame\)/.test(tablistSrcF34) &&
      /\.hero::after \{ content: ""; position: absolute; z-index: 0; top: 100%;[^}]*height: var\(--sp-10\)/s.test(homeCss) &&
      /\.item > \.item-head-shell::before,\s*\.tablist:not\(\[data-compact\]\) > \.item > \.item-head-shell::after \{[^}]*z-index: 0[^}]*width: var\(--cap-radius\)[^}]*height: var\(--cap-radius\)[^}]*background: var\(--bg-solid\)[^}]*pointer-events: none/s.test(shared) &&
      !/\.item > \.item-head::(?:before|after)/.test(shared) &&
      !/-webkit-mask:|(?:^|\s)mask:/m.test(shared) &&
      /\[data-mode="dark"\] \.tablist:not\(\[data-compact\]\) > \.item > \.item-head-shell > \.item-head \{[^}]*border-color: color-mix\(in srgb, var\(--ink\) 24%, var\(--border\)\)/s.test(shared) &&
      /\.tablist\[data-compact\] > \.item > \.item-head-shell,\s*\.tablist\[data-compact\] > \.item > \.item-body-frame \{ display: contents; \}/s.test(shared) &&
      // Under the command box, never over it.
      /\.hero \{[^}]*z-index: 20/s.test(homeCss),
      "F39/F34-17: the shared shelf occludes passing rows before the rounded foreground cap"
    );
    check(
      // F34-7r: the section body was the REAL blocker. `overflow: hidden` there
      // made it a scroll container, so the sticky header anchored to a box that
      // never scrolls and landed mid-page. Both it and the card must CLIP.
      /\.sec-body \{[^}]*min-width: 0;[^}]*min-height: 0;[^}]*overflow: clip;[^}]*\}/s.test(homeCss) &&
      !/\.sec-body \{[^}]*overflow: hidden/s.test(homeCss) &&
      /\.page-attention \{ display: none;[^}]*justify-content: flex-end/s.test(homeCss),
      "F34-7r/F39: no sticky ancestor scroll container returns and Needs you has no narrow fallback row"
    );
    check(
      read("js/ui/icons.js").includes('play: \'<path d="M7 4.5v15l12-7.5z"/>\',') &&
      dashboardSrc.includes('ready: focusActionState("ready", "play", "Start Focus", true)') &&
      dashboardSrc.includes('active: focusActionState("active", "stop", "End Focus")') &&
      read("js/ui/icons.js").includes('stop: \'<rect x="6" y="6" width="12" height="12" rx="2"/>\',') &&
      !dashboardSrc.includes('ready ? "suspend"') &&
      !dashboardSrc.includes('active ? "snooze"'),
      "F36/F44: the utility Focus control plays when ready and stops when active, never reusing the snooze moon"
    );
    check(
      homeCss.includes(".hero-panel:has(.search-results:not(:empty)):focus-within {") &&
      // Search behaviour itself is untouched: this stage is presentation only.
      !read("js/ui/searchbox.js").includes("cmd-rows") &&
      !read("js/ui/searchbox.js").includes("hero-panel"),
      "F34-3: the open box stands its focus ring down and searchbox.js is unchanged"
    );
  
    const configs = read("js/ui/list-configs.js");
    const openStart = configs.indexOf("export function buildOpenListConfig");
    const inboxStart = configs.indexOf("export function buildInboxListConfig");
    const open = configs.slice(openStart, inboxStart);
    const headerIds = ["dump-window", "save-session", "copy", "organize", "close-window"];
    check(
      headerIds.every((id, i) => open.indexOf(`id: "${id}"`) >= 0 &&
        (i === 0 || open.indexOf(`id: "${headerIds[i - 1]}"`) < open.indexOf(`id: "${id}"`))) &&
      !open.includes('id: "label-window"') && !open.includes('id: "focus-window"'),
      "P11-03/D4-2b: Open window actions end with Close and keep no Focus, Label, or More"
    );
    const bulkStart = open.indexOf("bulkActions: (ctx)");
    const bulk = open.slice(bulkStart);
    const bulkIds = ["inbox", "label", "snooze", "suspend", "wake", "move", "session", "close"];
    check(
      bulkIds.every((id) => bulk.includes(`"${id}"`)) &&
      bulk.includes('keeperButton("move", localeMessage("action_move"), "move"') &&
      bulk.includes('type: "move-tabs", tabIds: ids, destination'),
      "D4-2b: Open keeper exposes one set-based Move action beside the established actions"
    );
  }
  
  /* -- D4-3a: responsive Dashboard/New Tab Dashboard shell contracts -- */
  {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { DEFAULT_SETTINGS } = await import("../js/lib/types.js");
    const { normalizeAppearanceSettings } = await import("../js/lib/store.js");
    const { resolveNavMode, NAV_COMPACT_MAX, NAV_HEADER_MAX } =
      await import("../js/lib/nav-mode.js");
    const root = fileURLToPath(new URL("../", import.meta.url));
    const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
    const dash = read("js/ui/dashboard.js");
    const css = read("css/dashboard.css");
    const boot = read("js/boot.js");
    const theme = read("js/ui/theme.js");
  
    /* 1. The preference is additive, strictly boolean, and self-repairing. */
    check(
      DEFAULT_SETTINGS.uiSidebarCollapsed === false &&
      Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, "uiSidebarCollapsed"),
      "D4-3a: the sidebar-collapse preference is additive and defaults to the full sidebar"
    );
    check(
      normalizeAppearanceSettings({ ...DEFAULT_SETTINGS, uiSidebarCollapsed: "true" })
        .uiSidebarCollapsed === false &&
      normalizeAppearanceSettings({ ...DEFAULT_SETTINGS, uiSidebarCollapsed: 1 })
        .uiSidebarCollapsed === false &&
      normalizeAppearanceSettings({ ...DEFAULT_SETTINGS, uiSidebarCollapsed: undefined })
        .uiSidebarCollapsed === false &&
      normalizeAppearanceSettings({ ...DEFAULT_SETTINGS, uiSidebarCollapsed: true })
        .uiSidebarCollapsed === true,
      "D4-3a: a malformed stored collapse value normalizes to the boolean default"
    );
    const toggle = dash.slice(dash.indexOf("const navCollapse = el("), dash.indexOf("function applyNavMode"));
    check(
      toggle.includes("patchSettings({ uiSidebarCollapsed: sidebarCollapsed })") &&
      !toggle.includes("saveSettings("),
      "D4-3a: the collapse control persists through patchSettings, never a stale whole-settings write"
    );
  
    /* 2. Pre-paint from the cache, then live reconciliation from settings. */
    check(
      theme.includes("uiSidebarCollapsed: s.uiSidebarCollapsed === true") &&
      theme.includes('root.dataset.sidebar = source.uiSidebarCollapsed ? "collapsed" : "expanded"'),
      "D4-3a: the theme engine caches and applies the remembered collapse choice"
    );
    check(
      boot.includes("t.uiSidebarCollapsed === true") &&
      boot.includes('root.setAttribute("data-sidebar"') &&
      boot.includes('root.setAttribute("data-nav"') &&
      boot.includes(`w <= ${NAV_HEADER_MAX} ? "header" : (w <= ${NAV_COMPACT_MAX} || collapsed) ? "rail" : "expanded"`),
      "D4-3a: pre-paint boot resolves the same nav mode synchronously, so a remembered rail never flashes expanded"
    );
    check(
      dash.includes("if (!navWritePending) sidebarCollapsed = settings.uiSidebarCollapsed === true;") &&
      dash.includes("applyNavMode();"),
      "D4-3a: renderNav reconciles the collapse state on every settings change"
    );
  
    /* 3. One sidebar, one route source, no second navigation model. */
    check(
      (dash.match(/class: "sidebar"/g) ?? []).length === 1 &&
      (css.match(/^\s*\.sidebar \{/gm) ?? []).length === 1 &&
      (dash.match(/function navBtn\(/g) ?? []).length === 1 &&
      (dash.match(/function navGroup\(/g) ?? []).length === 1 &&
      !/keeper-rail|nav-rail-2|secondary-nav/.test(css),
      "D4-3a: every state presents one sidebar built by one nav source, with no duplicate rail"
    );
  
    /* 4+5. The four presentations, and a forced state never rewrites the choice. */
    check(
      resolveNavMode(false, false, false) === "expanded" &&
      resolveNavMode(true, false, false) === "rail" &&
      resolveNavMode(false, true, false) === "rail" &&
      resolveNavMode(false, true, true) === "header" &&
      resolveNavMode(true, true, true) === "header",
      "D4-3a: full, manually collapsed, automatic rail, and anchored-header states resolve exactly"
    );
    check(
      resolveNavMode(true, true, true) === "header" &&
      resolveNavMode(true, true, false) === "rail" &&
      resolveNavMode(true, false, false) === "rail" &&
      resolveNavMode(false, true, true) === "header" &&
      resolveNavMode(false, false, false) === "expanded",
      "D4-3a: a forced narrow state is transient, so widening returns the user's own choice"
    );
    const modeBlock = dash.slice(
      dash.indexOf("const navCompactQuery"), dash.indexOf("const sidebar = el(")
    );
    check(
      modeBlock.includes('navCompactQuery.addEventListener("change", applyNavMode)') &&
      modeBlock.includes('navHeaderQuery.addEventListener("change", applyNavMode)') &&
      !/addEventListener\("change", [^)]*\)[\s\S]*patchSettings/.test(
        modeBlock.slice(modeBlock.indexOf('navCompactQuery.addEventListener'))
      ),
      "D4-3a: a viewport change only re-resolves the presentation and writes nothing"
    );
    check(
      css.includes('[data-nav="expanded"] .app { --nav-w: 204px; }') &&
      css.includes('[data-nav="rail"] .app { --nav-w: 60px; }') &&
      css.includes('[data-nav="header"] .app { grid-template-columns: 1fr;') &&
      css.includes('[data-nav="header"] .sidebar { position: static;'),
      "D4-3a: the shell sizes the approved 200-210px sidebar, 56-64px rail, and full-width header state"
    );
  
    /* 6. Names, tooltips, and keyboard order survive the collapse. */
    check(
      dash.includes("function navName(label, count)") &&
      dash.includes('"aria-label": name, "data-tip": name') &&
      dash.includes('"aria-label": navName(label, count), "data-tip": navName(label, count)') &&
      dash.includes('vaultPill.setAttribute("aria-label", `Vault: ${pill.text}`)'),
      "D4-3a: every nav item and the vault pill keep a complete accessible name when labels collapse"
    );
    check(
      read("js/ui/tooltip.js").includes('[data-nav="rail"] .navitem'),
      "D4-3a: the icon rail explains itself through the shared tooltip, not through a hidden label"
    );
    const railHide = css.slice(
      css.indexOf('[data-nav="rail"] .brandname,'),
      css.indexOf('[data-nav="rail"] .nav-collapse')
    );
    check(
      ["[data-nav=\"rail\"] .brandname,", ".navitem .navtext,", ".navitem .n,",
        ".navitem .twist,", ".subnav,", ".vault-pill .vp-text { display: none; }"]
        .every((part) => railHide.includes(part)) &&
      !/\[data-nav="(rail|header)"\][^{]*\{[^}]*order:/.test(css),
      "D4-3a: collapsing hides visible text only; no state reorders the navigation"
    );
    check(
      dash.includes('navCollapse.setAttribute("aria-expanded", String(!sidebarCollapsed))') &&
      dash.includes('const label = shellSidebarToggleLabel(sidebarCollapsed);') &&
      dash.includes("navCollapse.hidden = navCompactQuery.matches || navHeaderQuery.matches;"),
      "D4-3a: the collapse control exposes its action and state, and withdraws when the viewport decides"
    );
  
    /* 7. Hero order: Search, non-measuring Starred overlay, then active Focus. */
    const heroBlock = dash.slice(dash.indexOf("const hero = el("), dash.indexOf("document.body.append(focusAnnouncer)"));
    check(
      heroBlock.indexOf("heroPanel") < heroBlock.indexOf("pageUtilities.starred") &&
      heroBlock.indexOf("pageUtilities.starred") < heroBlock.indexOf("focusStrip"),
      "F36: the hero renders Search, the Starred edge overlay, then active Focus"
    );
  
    /* 8+9. Emphasis-aware navigation and the full-width square Focus band. */
    check(
      css.includes('[data-emphasis="bold"] .navitem.active { background: var(--accent); color: var(--accent-ink); }') &&
      css.includes(".navitem.active { background: var(--accent-soft); color: var(--accent-soft-ink); font-weight: 600; }") &&
      css.includes(".navitem { display: flex; align-items: center; gap: 10px; padding: 7px 10px;\n             border-radius: var(--shape-nav);"),
      "D4-3a: active navigation is a Bold accent fill or a Muted accent-soft state on the shared nav shape"
    );
    check(
      css.includes('[data-emphasis="bold"] .hero .focus-strip-layout {') &&
      css.includes('--focus-recess-bg: var(--accent);') &&
      !css.includes(".hero .focus-strip.ready {") &&
      /\.hero \.focus-strip \{[^}]*border-radius: 0;[^}]*border-color: transparent;[^}]*background: transparent;/s.test(css) &&
      /\.hero \.focus-strip-layout-inner \{[^}]*padding-top: var\(--sp-8\);/s.test(css) &&
      !dash.includes("showInactive:"),
      "D4-3a/F27: only active Focus uses the global Bold band"
    );
  
    /* 10. Opaque sticky shell, and the measured hero geometry is preserved. */
    check(
      // F30 replaced the hairline with a floating field, so the contract is the
      // opacity itself: a solid page-coloured shell, never a translucent or
      // gradient one that scrolled rows can read through.
      /\.hero \{[^}]*background: var\(--bg-solid\)/s.test(css) &&
      !/\.hero \{[^}]*linear-gradient/.test(css) &&
      !/\.hero \{[^}]*color-mix/.test(css) &&
      dash.includes('document.documentElement.style.setProperty("--hero-base-h", `${baseHeight}px`)') &&
      dash.includes('"calc(var(--hero-base-h) + var(--focus-layout-h, 0px))"') &&
      dash.includes("new ResizeObserver(() => measureHero()).observe(hero)"),
      "D4-3a: the sticky shell is opaque and --hero-h is still measured and published"
    );
  
    /* 11+12. One Dashboard module and stylesheet; Minimal and Blank untouched. */
    const entry = read("js/ui/newtab-entry.js");
    check(
      entry.includes('await import("./dashboard.js")') &&
      read("newtab.html").includes('href="css/dashboard.css"') &&
      read("dashboard.html").includes('href="css/dashboard.css"') &&
      read("newtab.html").includes('data-sidebar="expanded" data-nav="expanded"') &&
      read("dashboard.html").includes('data-sidebar="expanded" data-nav="expanded"'),
      "D4-3a: New Tab Dashboard mounts the same module, stylesheet, and shell defaults as Dashboard"
    );
    check(
      !read("css/newtab.css").includes("data-nav") &&
      !read("css/sidepanel.css").includes("data-nav") &&
      entry.includes('location.replace(chrome.runtime.getURL("newtab.html") + "?focus=search")'),
      "D4-3a: Minimal, Blank, and the side panel are untouched by the Dashboard shell states"
    );
  
    /* 13. Web Interface Guidelines review findings, fixed in v0.8.183. */
    check(
      dash.includes('const skipLink = el("button", { class: "skip-link", type: "button",') &&
      dash.includes("onclick: () => searchInput.focus()") &&
      dash.includes('el("div", { class: "app" }, skipLink, sidebar, main)') &&
      dash.includes('id: "main", tabindex: "-1"') &&
      !dash.includes('class: "skip-link", href:'),
      "D4-3a/N40: a skip control precedes the navigation and moves focus without touching the hash router"
    );
    check(
      dash.includes("if (e.relatedTarget && e.relatedTarget !== document.body) return;") &&
      dash.includes('skipLink.addEventListener("focus", (e) => {') &&
      dash.includes('}, "Skip to search")'),
      "N40: focus arriving from outside the document is forwarded to the command box, so Tab from the address bar lands on search"
    );
    check(
      css.includes("overscroll-behavior-x: contain;") &&
      css.includes("min-width: 24px; min-height: 24px;"),
      "D4-3a: the header switcher contains its scroll chain and small glyphs keep a 24px hit target"
    );
  
    /* 14. Defects found by rendering the shell in real Chrome. */
    check(
      css.includes(".nav-collapse[hidden] { display: none; }"),
      "D4-3a: withdrawing the collapse control is stated explicitly, since an author display beats [hidden]"
    );
    check(
      /\[data-nav="rail"\] \.navlabel \{[^}]*border-top: var\(--bw\) solid var\(--border\)/.test(css) &&
      !/\[data-nav="rail"\] \.navlabel,/.test(css),
      "D4-3a: the rail keeps its group boundaries as a hairline instead of dropping them"
    );
    const harness = read("tools/shell-harness.html");
    check(
      harness.includes('import { icon } from "../js/ui/icons.js"') &&
      harness.includes('href="../css/') &&
      harness.includes('class="action-icon"') && harness.includes('class="action-label"') &&
      !harness.includes("<script src=") &&
      harness.includes("NAV_COMPACT_MAX = 900, NAV_HEADER_MAX = 620"),
      "D4-3a: the visual harness renders the real stylesheets, icons, and action markup at the real breakpoints"
    );
  
    /* 14. No invented controls, and no new layout or smooth-scroll motion. */
    check(
      !/Group ?▾|Recent ?▾|id: "group-open"|id: "sort-recent"/.test(dash) &&
      !/\[data-nav=[^{]*\{[^}]*transition:/.test(css) &&
      !/behavior: ?"smooth"/.test(dash),
      "D4-3a: the shell invents no Group/Recent controls and adds no layout or smooth-scroll motion"
    );
  }
  
  /* -- D4-3b: popup + Focus guard on the shared component system -- */
  {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = fileURLToPath(new URL("../", import.meta.url));
    const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
    const primitives = read("css/primitives.css");
    const popupHtml = read("popup.html");
    const popupJs = read("js/ui/popup.js");
    const focusHtml = read("focus.html");
    const focusJs = read("js/ui/focus-page.js");
  
    /* 1. One button vocabulary, owned centrally. */
    check(
      ["button.primary", "button.danger", "button.warn", "button.quiet",
        "button:disabled", "button.primary:disabled", ".linklike, button.linkbtn",
        ".panel {", ".panel-q", ".panel-actions", ".sr-only", ".tooltip {"]
        .every((sel) => primitives.includes(sel)),
      "D4-3b: primitives own the button variants, link role, inline panel, sr-only, and tooltip"
    );
    check(
      // Geometry for the primary stays host-local; what must NOT come back is the
      // variant's color material, which primitives owns.
      !/button\.primary[^{]*\{[^}]*background:\s*var\(--accent\)/.test(popupHtml) &&
      !/button\.warn \{|button:disabled \{/.test(popupHtml) &&
      !/\.linklike \{/.test(popupHtml) &&
      !/\.tooltip \{/.test(popupHtml) &&
      !/\.primary \{[^}]*background: var\(--accent\)/.test(focusHtml) &&
      !/\.sr-only \{/.test(focusHtml),
      "D4-3b: neither host restates a shared variant, link, tooltip, or sr-only rule"
    );
    check(
      popupHtml.includes("min-height: var(--control-h-default)") &&
      popupHtml.includes("min-height: var(--control-h-compact)") &&
      focusHtml.includes("min-height: var(--control-h-default)") &&
      focusHtml.includes("min-height: var(--control-h-compact)"),
      "D4-3b: both surfaces use the approved 34px default and 28px compact control heights"
    );
  
    /* 2. Both surfaces resolve the appearance-keyed shared roles. */
    check(
      ["popup.html", "focus.html"].every((p) => {
        const html = read(p);
        return /<html\b[^>]*data-emphasis="bold"/s.test(html) &&
          /<html\b[^>]*data-corner-style="soft"/s.test(html);
      }),
      "D4-3b: the popup and guard page declare the appearance attributes their shared roles key off"
    );
    check(
      focusHtml.includes('href="css/primitives.css"') &&
      !focusHtml.includes("var(--shadow, none)") &&
      focusHtml.includes("box-shadow: var(--shadow-1)"),
      "D4-3b: the guard page joins the shared layer and its card elevation resolves to a real token"
    );
  
    /* 3. Popup journeys, groups, and footer separation are intact. */
    check(
      popupJs.includes('el("h2", { class: "group-head" }, popupStatic.thisTab())') &&
      popupJs.includes('el("h2", { class: "group-head" }, popupStatic.thisWindow())') &&
      popupJs.includes('const dumpWinBtn = actionRow("inbox", popupStatic.saveWindowInbox())') &&
      popupJs.includes('dumpWinBtn.classList.add("window-save")') &&
      !/const dump(?:Tab|Win)Btn = el\("button", \{ class: "primary"/.test(popupJs),
      "P11-12r: Save window to Inbox stays first and full-width without a standing accent block"
    );
    check(
      /\.linkrow \{[^}]*border-top: var\(--bw\) solid var\(--border\)/.test(popupHtml) &&
      (popupJs.match(/el\("button", \{ class: "quiet"/g) ?? []).length === 3,
      "D4-3b: the footer is quiet navigation, separated from the acting groups (J8)"
    );
    check(
      popupJs.includes("const INLINE_PANELS = [labelPanelTab]") &&
      (popupJs.match(/createAnchoredPanel\(/g) ?? []).length === 3 &&
      popupJs.includes("dismissAnchoredPanel();"),
      "D4-3b: every inline popup panel reuses the shared panel role and the one-open rule"
    );
  
    check(
      popupJs.includes('class: "msg popup-msg", role: "status", "aria-live": "polite"') &&
      popupJs.includes('class: "msg tabmsg", role: "status", "aria-live": "polite"') &&
      (popupJs.match(/el\("h2", \{ class: "group-head"/g) ?? []).length === 4 &&
      popupHtml.includes("min-width: 24px"),
      "D4-3b: confirmations announce politely, groups are real headings, and the dismiss target is 24px"
    );
  
    /* 4. The settled guard-page contract is untouched. */
    check(
      focusJs.includes("if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;") &&
      focusHtml.includes('href="dashboard.html#settings-focus"') &&
      // The quiet ACTION role is button-only in primitives, so an anchor wearing
      // it would fall back to the UA's blue link color inside a themed card.
      focusHtml.includes('<a class="linklike" id="settings-link"') &&
      primitives.includes("button.quiet {"),
      "D4-3b: the guard's settings link is a real link using the link role, not the button-only quiet role"
    );
    check(
      focusJs.includes('localeMessage("focus_return_question")') &&
      focusJs.includes('el("div", { class: "panel-q" }, returnQuestion)') &&
      focusJs.includes('class: "panel-actions"') &&
      !/<dialog|showModal/.test(focusJs) && !/<dialog|showModal/.test(popupJs),
      "D4-3b: the Return decision stays an inline panel and no surface introduces a modal"
    );
  
    /* D4-3d: the popup's Quiet-command-surface composition. */
    check(
      /button \{ display: flex;[^}]*border: none;[^}]*background: none;/.test(popupHtml) &&
      popupHtml.includes("button > .lbl") && popupHtml.includes("button > .k") &&
      popupHtml.includes(".tab-actions {") && popupHtml.includes(".actgrid {") &&
      popupHtml.includes(".tab-actions[hidden] { display: none; }") &&
      popupHtml.includes(".tab-star {"),
      "D4-3d: the popup's default control is a quiet row, not a bordered box"
    );
    check(
      /\.group \{ padding: [^}]*border-top: var\(--bw\) solid var\(--border\);/.test(popupHtml) &&
      !/\.group \{[^}]*background: var\(--surface-2\)/.test(popupHtml),
      "D4-3d: popup sections are flat, so no action sits in a card inside a card"
    );
    check(
      // Standing tab/window/Focus commands are quiet. The user-approved global
      // duplicate cleanup may carry accent alongside transient alert/form decisions.
      popupJs.includes('const dumpWinBtn = actionRow("inbox", popupStatic.saveWindowInbox())') &&
      !/const dumpWinBtn = el\("button", \{ class: "primary"/.test(popupJs) &&
      !/const dumpTabBtn = actionRow\([^)]*primary/.test(popupJs) &&
      popupJs.includes('const dumpTabBtn = actionRow("inbox", popupStatic.saveTabInbox(), "I")') &&
      popupJs.includes('class: "focus-end"') && popupJs.includes('class: "focus-start"') &&
      !/class: "primary", onclick: openSettings/.test(popupJs),
      "P11-12r: tab, window, and Focus commands stay quiet while the explicit duplicate cleanup may carry accent"
    );
    check(
      popupJs.includes("function actionRow(iconName, label, key)") &&
      popupJs.includes("function setLabel(btn, text)") &&
      popupJs.includes('setLabel(suspendBtn, popupStatic.wakeTab())') &&
      !/suspendBtn\.textContent/.test(popupJs),
      "D4-3d: a dynamic relabel writes to the label span, so it cannot wipe the icon"
    );
    check(
      popupJs.includes('const TAB_KEYS = { i: () => dumpTabBtn, s: () => snoozeBtn, z: () => suspendBtn, l: () => labelTabBtn }') &&
      popupJs.includes("if (!btn || btn.disabled) return;") &&
      popupJs.includes("if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;") &&
      popupHtml.includes("button:disabled > .k { display: none; }"),
      "D4-3d: the shown key hints are real bindings, skip disabled actions, and never fire while typing"
    );
    check(
      popupJs.includes('el("h1", { class: "sr-only" }, localeMessage("manifest_name"))'),
      "D4-3d: the redundant title line is reclaimed without losing the document heading"
    );
    check(
      popupJs.includes('const tabActions = el("div", { class: "actgrid tab-actions" }') &&
        popupJs.includes("tabActions.hidden = true") &&
        popupJs.includes("tabActions.hidden = false"),
      "Popup unsupported pages replace unavailable tab actions instead of overflowing below them"
    );
  
    /* 5. The harness covers this wave's surfaces from the real documents. */
    const surfaceHarness = read("tools/surface-harness.html");
    check(
      surfaceHarness.includes('fetch(`../${surface}.html') &&
      surfaceHarness.includes('doc.indexOf("<style>")') &&
      surfaceHarness.includes('import { icon } from "../js/ui/icons.js"'),
      "D4-3b: the surface harness lifts the shipped inline stylesheet rather than copying it"
    );
    check(
      popupJs.indexOf("  search,") < popupJs.indexOf("  dupHintSlot,") &&
        popupJs.indexOf("  dupHintSlot,") < popupJs.indexOf("  vaultWarnSlot,") &&
        /class: "tabhead" \},\s*el\("h2", \{ class: "group-head" \}, popupStatic\.thisTab\(\)\), tabFav, tabTitle, starTabBtn/s.test(popupJs) &&
        popupJs.includes('const tabActions = el("div", { class: "actgrid tab-actions" }') &&
        popupJs.includes("    tabActions,"),
      "P11-12: Search precedes warnings and This tab keeps identity plus Star on one line above a complete 2-by-2 action grid"
    );
    check(
      /class: "group-title-row" \},\s*el\("h2", \{ class: "group-head" \}, popupStatic\.thisWindow\(\)\), copyWinBtn/s.test(popupJs) &&
        /class: "actgrid" \},\s*saveBtn, winSnoozeBtn, suspendOthersBtn, sortWinBtn/s.test(popupJs) &&
        /class: "group-title-row focus-title-row"/.test(popupJs) &&
        popupHtml.includes(".banner button:not(.primary) {") &&
        popupHtml.includes("white-space: nowrap;") &&
        !popupJs.includes("buildQuickSettings") && !popupHtml.includes("quick-settings"),
      "P11-12: Copy links is a window utility, secondary window actions form a 2-by-2 grid, Focus is compact, warning primaries retain material, and Quick settings is retired"
    );
    check(
      surfaceHarness.indexOf('<div class="search-box">') < surfaceHarness.indexOf('<div class="banner">') &&
        surfaceHarness.includes('class="tab-star is-starred"') &&
        surfaceHarness.includes('class="actgrid tab-actions"') &&
        surfaceHarness.includes('class="group-title-row focus-title-row"') &&
        !surfaceHarness.includes('class="quick-settings"'),
      "P11-12: the popup harness mirrors the final search-first compact hierarchy"
    );
    check(
      /class: "group duplicates-group"/.test(popupJs) &&
        /onclick: \(\) => openDashboard\("duplicates"\)/.test(popupJs) &&
        popupJs.includes('popupStatic.seeDuplicates()') &&
        popupJs.includes('popupCloseDuplicates(dupCount)') &&
        /\.linkrow \{[^}]*position: sticky;[^}]*bottom: 0;[^}]*border-top: var\(--bw\) solid var\(--border\)/.test(popupHtml) &&
        !popupHtml.includes(".group:first-of-type") &&
        surfaceHarness.includes('class="group duplicates-group"'),
      "P11-12r: Duplicates is a separated conditional section with review and bulk-close routes, and every section/footer uses the same hairline rhythm"
    );
    check(
      popupJs.includes('class: "msg popup-msg"') &&
        popupJs.includes('class: "primary duplicate-close"') &&
        /\.popup-msg:empty \{[^}]*display: none;[^}]*min-height: 0;/.test(popupHtml) &&
        /\.group \{ padding: 12px 0;[^}]*border-top: var\(--bw\) solid var\(--border\);/.test(popupHtml) &&
        /\.group-head \{[^}]*color: var\(--accent-strong-ink\)/.test(popupHtml) &&
        /\.statusstrip \{[^}]*margin-bottom: 12px;/.test(popupHtml) &&
        /\.linkrow \{[^}]*padding: 10px 12px 12px;/.test(popupHtml) &&
        /\.duplicate-close:hover \{[^}]*background: var\(--accent\);[^}]*filter: none;/.test(popupHtml) &&
        surfaceHarness.includes('state === "feedback"') &&
        surfaceHarness.includes('class="primary duplicate-close"'),
      "P11-12r2: section boundaries breathe 12px on both sides, empty feedback cannot distort one seam, headings use accent ink, and duplicate cleanup keeps its accent on hover"
    );
  }
  
  /* -- D4-3c-1: shared search family + responsive setting rows -- */
  {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = fileURLToPath(new URL("../", import.meta.url));
    const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
    const primitives = read("css/primitives.css");
    const dash = read("css/dashboard.css");
    const hosts = { popup: read("popup.html"), panel: read("css/sidepanel.css"), newtab: read("css/newtab.css") };
  
    check(
      [".search-box {", ".search-field {", ".search-field:focus-within",
        ".search-field .search-input", ".search-results {", ".ghost-chips",
        ".ghost-chip {", ".search-row {", ".rtype {", ".rtitle", ".rmeta"]
        .every((sel) => primitives.includes(sel)),
      "D4-3c: one search field, result overlay, ghost chip, and result row for every host"
    );
    check(
      // The overlay floats, so it carries a border AND a shadow everywhere. Two
      // hosts had lost the border; the correct rule won, not the union.
      /\.search-results \{[^}]*border: var\(--bw\) solid var\(--border\);[^}]*box-shadow: var\(--shadow-1\)/s.test(primitives) &&
      // A host may REPOSITION the shared overlay (the dashboard drops it below
      // its composer panel); what it must not do is restate the definition.
      !/^\s*\.search-results \{/m.test(dash) && !/^\s*\.search-results \{/m.test(hosts.newtab) &&
      !/^\s*\.search-row \{/m.test(dash) && !/^\s*\.ghost-chips \{/m.test(dash) &&
      !/\.rtype \{/.test(hosts.panel),
      "D4-3c: no host restates the search overlay or result row; the floating border is shared"
    );
    check(
      // A two-class shared rule must not reach into type, or it silently outranks
      // each host's own `.search-input` size.
      !/\.search-field \.search-input \{[^}]*font:/s.test(primitives) &&
      /\.search-input \{[^}]*font-size: 16px/s.test(dash) &&
      hosts.popup.includes(".search-field .search-input { padding: 9px 0; font-size: 13px; }") &&
      hosts.panel.includes(".search-field .search-input { padding: 8px 10px 8px 0; font-size: 13px; }"),
      "D4-3c: the shared field neutralizes the boundary only, so each host keeps its own type scale"
    );
  
    check(
      dash.includes("container-type: inline-size") &&
      /@container \(max-width: 560px\) \{[\s\S]*\.setrow \{ flex-direction: column;/.test(dash) &&
      dash.includes('.setrow:has(> input[type="checkbox"]) { flex-direction: row;') &&
      !/\[data-nav="header"\] \.setrow \{/.test(dash),
      "D4-3c: setting rows answer to their own column and retire the D4-3a shell-level guard"
    );
    check(
      dash.includes('body[data-page="settings"] .sections > section > .section-lead { max-width: 680px;') &&
      /\.setrow \.d \{[^}]*overflow-wrap: anywhere/.test(dash) &&
      primitives.includes('input[type="checkbox"], input[type="radio"] { accent-color: var(--accent); }'),
      "D4-3c: the Settings heading shares its list's axis, long paths wrap, and checkboxes follow the scheme"
    );
  }
  
  /* -- D4-3c-2: one outcome grammar across Vault, Data, and onboarding -- */
  {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = fileURLToPath(new URL("../", import.meta.url));
    const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
    const dashCss = read("css/dashboard.css");
    const dashJs = read("js/ui/dashboard.js");
    const dataJs = read("js/ui/data-surface.js");
    const vaultJs = read("js/ui/vault-surface.js");
    const onboard = read("js/ui/onboarding.js");
  
    check(
      // Three near-identical tints were the only signal; a marker carries it now.
      /\.status::before \{[^}]*border-radius: 50%/s.test(dashCss) &&
      dashCss.includes(".status.ok::before { background: var(--ok); }") &&
      dashCss.includes(".status.warn::before { background: var(--warn); }") &&
      dashCss.includes(".status.danger::before { background: var(--danger); }") &&
      vaultJs.includes('el("span", { class: "status danger" }, `error: ${status.message}`)'),
      "D4-3c: vault state reads from a marker plus words, and an error is not a warning"
    );
    check(
      /\.note\.bad, \.note\.good, \.item-meta\.bad, \.item-meta\.good/.test(dashCss) &&
      dataJs.includes("const outcome = (node, base, text, kind") &&
      dataJs.includes('outcome(importInfo, "item-meta",') &&
      dataJs.includes('"bad")') && dataJs.includes('"good")') &&
      vaultJs.includes('el("div", { class: meta && !meta.ok ? "note bad" : "note" }, lastSync)'),
      "D4-3c: import and sync outcomes differ by more than their sentence"
    );
    check(
      // Copy guides the exit instead of shouting at the user.
      !vaultJs.includes("} FAILED: ${meta.error}") &&
      vaultJs.includes("didn't complete: ${meta.error}") &&
      vaultJs.includes("Try Sync now, or reconnect the folder if the permission was lost."),
      "D4-3c: a failed sync names what happened and how to recover"
    );
    check(
      onboard.includes("onboardingStatic.pageAria(indexInList + 1, ONBOARDING_PAGES.length, entry.title)") &&
      onboard.includes('role: "group", "aria-label": onboardingStatic.progressAria()') &&
      onboard.includes('const next = el("button", { class: "primary"') &&
      onboard.includes("HELP_TOPICS"),
      "D4-3c: six-step progress announces its total, Next stays primary, and Help is separate"
    );
  }
  
  /* -- D4-4: the motion vocabulary is the only motion that ships -- */
  {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = fileURLToPath(new URL("../", import.meta.url));
    const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
    const cssFiles = fs.readdirSync(path.join(root, "css"))
      .filter((n) => n.endsWith(".css")).map((n) => `css/${n}`);
    const htmlFiles = ["dashboard.html", "newtab.html", "sidepanel.html", "popup.html",
      "options.html", "focus.html", "suspend.html"];
    const shipped = [...cssFiles, ...htmlFiles];
    const jsFiles = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        if (e.isDirectory()) walk(`${dir}/${e.name}`);
        else if (e.name.endsWith(".js")) jsFiles.push(`${dir}/${e.name}`);
      }
    })("js");
  
    // Every duration comes from the approved vocabulary. A raw number or the
    // legacy 170ms --dur means something skipped the audit.
    const offenders = [];
    for (const f of shipped) {
      for (const m of read(f).matchAll(/(?:transition|animation):\s*([^;}]+)/g)) {
        const decl = m[1];
        if (/\bnone\b/.test(decl)) continue;
        if (!/var\(--motion-(feedback|reveal|continuity)\)/.test(decl)) offenders.push(`${f}: ${decl.trim()}`);
      }
    }
    check(offenders.length === 0,
      `D4-4: every shipped transition and animation uses the approved vocabulary (${offenders.slice(0, 3).join(" | ") || "clean"})`);
  
    // Layout-property animation on routine rendering is rejected outright.
    const layoutAnim = shipped.filter((f) =>
      /transition:[^;}]*(grid-template|width|height|margin|padding|top|left)\b/.test(read(f)));
    check(layoutAnim.length === 0,
      `D4-4: no routine rendering animates a layout property (${layoutAnim.join(", ") || "clean"})`);
  
    // No ambient movement. Pending feedback is a solid, one-shot reveal too.
    const ambient = [];
    for (const f of shipped) {
      for (const m of read(f).matchAll(/animation:\s*([^;}]+)/g)) {
        const decl = m[1];
        if (/\b(infinite|alternate)\b/.test(decl)) {
          ambient.push(`${f}: ${decl.trim()}`);
        }
      }
    }
    check(ambient.length === 0,
      `D4-4: no ambient looping motion ships (${ambient.join(" | ") || "clean"})`);
  
    // A JS `behavior: "smooth"` argument beats the global reduced-motion CSS rule,
    // so it is the one kind of motion that can ignore the user's preference.
    const smooth = jsFiles.filter((f) => /scrollIntoView\(\{[^}]*behavior:\s*"smooth"/.test(read(f)));
    check(smooth.length === 0,
      `D4-4: no programmatic smooth scrolling can escape reduced motion (${smooth.join(", ") || "clean"})`);
  
    const tokens = read("css/tokens.css");
    check(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,220}animation-duration: 0\.001ms !important/.test(tokens) &&
      /transition-duration: 0\.001ms !important/.test(tokens) &&
      /scroll-behavior: auto !important/.test(tokens),
      "D4-4: one global reduced-motion rule collapses animation, transition, and scrolling"
    );
  }
  
  /* -- Motion polish: purposeful cues preserve instant layout and routing -- */
  {
    const fs = await import("node:fs");
    const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
    const dash = read("../js/ui/dashboard.js");
    const labels = read("../js/ui/labels-surface.js");
    const sessions = read("../js/ui/sessions-surface.js");
    const tablist = read("../js/ui/tablist.js");
    const listConfigs = read("../js/ui/list-configs.js");
    const listHelpers = read("../js/ui/list-helpers.js");
    const icons = read("../js/ui/icons.js");
    const tooltip = read("../js/ui/tooltip.js");
    const dashCss = read("../css/dashboard.css");
    const listCss = read("../css/tablist-d4.css");
  
    /* 001: the shared panel funnel mounts one top-layer palette without touching
       list flow, then focuses its first control. */
    const slotToggle = tablist.slice(
      tablist.indexOf('toggle(factory, name = "_")'),
      tablist.indexOf("close() {", tablist.indexOf('toggle(factory, name = "_")'))
    );
    check(
      slotToggle.includes("const panel = factory();") &&
      slotToggle.includes("activePanelController?.close();") &&
      slotToggle.includes("openPopover(panel, name)") &&
      !slotToggle.includes("slotEl.replaceChildren") &&
      tablist.includes('popover: "manual"') &&
      tablist.includes("document.body.append(popover)") &&
      tablist.includes("popover.showPopover()") &&
      tablist.includes('anchor.querySelector(`[data-action-id="${CSS.escape(action.id)}"]`)') &&
      tablist.includes("meta.ctx.panel?.anchor(actionButton ?? anchor);") &&
      tablist.includes('popover.querySelectorAll("[title]")') &&
      tablist.includes('node.setAttribute("aria-description", detail)') &&
      tablist.includes("const firstBodyControl = popover?.querySelector") &&
      tablist.includes("(firstBodyControl ?? closeButton).focus({ preventScroll: true })") &&
      tablist.includes('source = opener?.closest?.(".trow, .item") ?? null;') &&
      tablist.includes('source?.classList.add("palette-source")') &&
      tablist.includes('source?.classList.remove("palette-source")') &&
      tablist.includes("if (!slotEl.isConnected || !opener?.isConnected) close();"),
      "Motion 001: list workflows share one lifecycle-guarded top-layer palette and never insert into row flow"
    );
    check(
      /\.action-popover \{[^}]*position: fixed;[^}]*overflow: visible;[^}]*animation: action-popover-in var\(--motion-reveal\) var\(--ease-out\) both;/s.test(listCss) &&
      listCss.includes(".action-popover-stem") &&
      listCss.includes(".action-popover-header") &&
      listCss.includes(".action-popover .palette-form") &&
      listCss.includes(".tablist .trow.palette-source .tacts") &&
      !listCss.includes(".inline-panel-enter") &&
      tablist.includes('if (slotEl.closest("[data-compact]")) popover.dataset.compact = "";'),
      "Motion 001: the 140ms anchored palette keeps a visible stem, unclipped label menu, and compact-surface adaptation"
    );
    check(
      tooltip.includes('node?.matches?.(":focus-visible")') &&
      tooltip.includes('!node.closest(".action-popover")') &&
      tooltip.includes('node?.closest(".action-popover")') &&
      tooltip.includes("textFor(node);"),
      "Motion 001: palette controls cannot arm a detached-looking custom or native tooltip"
    );
  
    /* 002: explicit label/session jumps alone request a non-moving cue. */
    const labelPosition = labels.slice(
      labels.indexOf("function positionLabelCard"),
      labels.indexOf("async function goToLabel")
    );
    const labelJump = labels.slice(
      labels.indexOf("async function goToLabel"),
      labels.indexOf("function buildLabelIndex")
    );
    const sessionPosition = sessions.slice(
      sessions.indexOf("function positionSessionCard"),
      sessions.indexOf("async function goToSession")
    );
    const sessionJump = sessions.slice(
      sessions.indexOf("async function goToSession"),
      sessions.indexOf("async function setGroupLens")
    );
    check(
      labelPosition.includes('behavior: "auto"') && !labelPosition.includes("smooth") &&
      sessionPosition.includes('behavior: "auto"') && !sessionPosition.includes("smooth") &&
      labelJump.includes("const cue = pointerDriven();") &&
      labelJump.includes("if (already && cue) cueJumpArrival(presentCard)") &&
      labelJump.includes("jumpCueLabel = cue ? label : null;") &&
      labelJump.includes("positionLabelCard(label, { cue });") &&
      labels.includes("positionLabelCard(jump, { cue: cueJump });") &&
      !labels.includes("jumpCued") &&
      sessionJump.includes("const cue = pointerDriven();") &&
      !sessionJump.includes("cueSessionJumpArrival(presentCard)") &&
      sessionJump.includes("if (cue) settleCue(() => sessionCardEl(id), cueSessionJumpArrival);") &&
      /openLabelDeepLink[\s\S]*?positionLabelCard\(label\);/.test(dash),
      "Motion 002: pointer label/session jumps cue the final post-refresh card; keyboard and deep-link paths stay uncued"
    );
    const arrivalKeyframes = dashCss.slice(
      dashCss.indexOf("@keyframes jump-arrival {"),
      dashCss.indexOf("@media (prefers-reduced-motion: reduce)", dashCss.indexOf("@keyframes jump-arrival {"))
    );
    check(
      dashCss.includes("animation: jump-arrival calc(var(--motion-continuity) * 3) var(--ease-out);") &&
      dashCss.includes("animation: jump-arrival-settle var(--motion-continuity) cubic-bezier(.16, 1, .3, 1);") &&
      dashCss.includes("animation: jump-arrival-title calc(var(--motion-continuity) * 3) var(--ease-out);") &&
      dashCss.includes("inset: 1px;") &&
      dashCss.includes("inset 0 0 0 1px var(--accent)") &&
      dashCss.includes("pointer-events: none;") &&
      /20% \{[\s\S]*?opacity: 1;[\s\S]*?inset 0 0 0 7px var\(--focus-ring\)/.test(arrivalKeyframes) &&
      /62% \{[\s\S]*?opacity: 1;/.test(arrivalKeyframes) &&
      /100% \{[\s\S]*?opacity: 0;[\s\S]*?inset 0 0 0 1px transparent/.test(arrivalKeyframes) &&
      /prefers-reduced-motion: reduce[\s\S]*?\.item\.jump-arrival,[\s\S]*?animation: none;[\s\S]*?\.item\.jump-arrival::after \{ animation: none; opacity: 1;/.test(dashCss) &&
      labels.includes("jumpCueTimers") && labels.includes("}, 540);") &&
      sessions.includes("jumpCueTimers") && sessions.includes("}, 540);"),
      "Motion 002: Ring and Wash adds a 4px compositor settle, title emphasis, a held ring, and a timed static reduced-motion cue"
    );
  
    /* 003: only the manual wide-nav control enables the fluid grid transition. */
    const navMode = dash.slice(
      dash.indexOf("const navCompactQuery"),
      dash.indexOf("let libOpen")
    );
    const manualToggle = navMode.slice(
      navMode.indexOf("const navCollapse = el("),
      navMode.indexOf("function applyNavMode")
    );
    check(
      manualToggle.includes("onclick: async (event)") &&
      manualToggle.includes("applyNavMode({ animate: true })") &&
      (navMode.match(/applyNavMode\(\{ animate:/g) ?? []).length === 1 &&
      navMode.includes('navCompactQuery.addEventListener("change", applyNavMode)') &&
      navMode.includes('navHeaderQuery.addEventListener("change", applyNavMode)') &&
      dash.includes("if (!navWritePending) sidebarCollapsed = settings.uiSidebarCollapsed === true;\n  applyNavMode();"),
      "Motion 003: manual collapse/expand alone opts into fluid resizing; boot, responsive, and settings paths stay instant"
    );
    check(
      /\.app \{[^}]*grid-template-columns:[^}]*\}/s.test(dashCss) &&
      dashCss.includes(".nav-resize-backdrop {") &&
      dashCss.includes("transform-origin: left center;") &&
      dashCss.includes("html.nav-morphing .sidebar { z-index: 4; }") &&
      /\.nav-resize-backdrop\s*\{[^}]*z-index:\s*3;/s.test(dashCss) &&
      navMode.includes('root.classList.add("nav-morphing")') &&
      navMode.includes('classList.remove("nav-morphing")') &&
      navMode.includes("backdrop.animate(") &&
      !navMode.includes("main.animate(") &&
      navMode.includes("sidebar.animate(") &&
      navMode.includes('motionStyle.getPropertyValue("--motion-continuity")') &&
      navMode.includes('motionStyle.getPropertyValue("--ease-out")') &&
      navMode.includes("sidebar.animate([{ opacity: .16 }, { opacity: 1 }], timing)") &&
      !navMode.includes("liveContentLeft") &&
      navMode.includes("for (const animation of motion.animations) animation.cancel();") &&
      navMode.includes('matchMedia("(prefers-reduced-motion: reduce)").matches') &&
      navMode.includes("if (navMotion?.targetMode === nextMode)") &&
      !dashCss.includes("transition: grid-template-columns") &&
      !navMode.includes("document.startViewTransition") &&
      !/\.app \{[^}]*view-transition-name/s.test(dashCss),
      "F40/Motion 003: the moving nav edge reveals a stationary final page with Starred's continuity timing and easing"
    );
    check(
      icons.includes("rename:") && icons.includes("delete:") &&
      listConfigs.includes('"data-action-id": "rename"') &&
      (listConfigs.match(/icon\("rename", 14\)/g) ?? []).length === 2 &&
      listHelpers.includes('"data-action-id": "delete"') &&
      listHelpers.includes('icon(iconName, 14)') &&
      listCss.includes(".confirm-inline.armed button") &&
      listCss.includes(".confirm-inline.armed .action-label"),
      "Motion 003 follow-up: rendered Rename/Delete actions preserve icons and readable armed choices in Icons-only mode"
    );
  
    /* 004: the persistent zero/nonzero boundary gates the keeper entrance. */
    check(
      tablist.includes("keeperVisible: false") &&
      tablist.includes("keeperMotionAllowed: false") &&
      tablist.includes('st.keeperMotionAllowed = !document.activeElement?.matches?.(":focus-visible");') &&
      (tablist.match(/noteKeeperTrigger\(\);/g) ?? []).length === 5 &&
      tablist.includes("const keeperEntering = bulkCount > 0 && !st.keeperVisible && st.keeperMotionAllowed;") &&
      tablist.includes("st.keeperVisible = bulkCount > 0;") &&
      tablist.includes("st.keeperMotionAllowed = false;") &&
      tablist.includes('${keeperEntering ? " keeper-enter" : ""}'),
      "Motion 004: keeper-enter crosses zero only after a non-focus-visible selection trigger; keyboard selection stays still"
    );
    check(
      listCss.includes("transition: opacity var(--motion-continuity) var(--ease-out),") &&
      listCss.includes("transform: translateX(-50%) translateY(6px);") &&
      /\[data-surface="sidepanel"\] \.tablist > \.bulk-bar\.keeper-enter \{\s*transform: translateY\(6px\);/.test(listCss),
      "Motion 004: the 180ms keeper reveal preserves dashboard and side-panel horizontal positioning"
    );
  
    /* 005: fine-pointer presses move one pixel; keyboard and drag do not. */
    check(
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*button:not\(:disabled\):not\(\.move-handle\):active:not\(:focus-visible\)[\s\S]*translateY\(1px\)/.test(dashCss),
      "Motion 005: pointer press feedback is fine-pointer-only, 1px, and excludes keyboard focus + move handles"
    );
    const buttonStart = dashCss.indexOf("button { padding:");
    const buttonRule = dashCss.slice(buttonStart, dashCss.indexOf("\n  button:hover", buttonStart));
    const navItemRule = dashCss.slice(dashCss.indexOf(".navitem {"), dashCss.indexOf("/* Hover stays"));
    check(
      [buttonRule, navItemRule].every((rule) =>
        rule.includes("transform var(--motion-feedback) var(--ease-out)")),
      "Motion 005: buttons and overriding nav items share the exact 80ms transform transition"
    );
  }
  
}
