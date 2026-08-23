export async function runSmokeDashboardContracts({ check }) {
  const { STORE_KEYS } = await import("../js/lib/types.js");

  /* -- E3-2: sections render when visible; counts are counted, not listed -- */
  {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { countItems, listItems: list } = await import("../js/lib/store.js");
    const root = fileURLToPath(new URL("../", import.meta.url));
    const dash = fs.readFileSync(path.join(root, "js/ui/dashboard.js"), "utf8");
  
    /* countItems agrees with listItems, tombstones included. */
    const key = "e32-count-fixture";
    await chrome.storage.local.set({ [key]: {
      a: { id: "a", modifiedAt: 3 },
      b: { id: "b", modifiedAt: 1, deletedAt: 9 },
      c: { id: "c", modifiedAt: 2 }
    } });
    const counted = await countItems(key);
    check(counted === 2 && counted === (await list(key)).length,
      "E3-2: countItems matches listItems length and skips tombstones");
    check(await countItems("e32-absent-key") === 0,
      "E3-2: counting an absent store is zero, not a throw");
    await chrome.storage.local.set({ [key]: {} }); // the mock has no remove()
  
    /* The gate, and the one place that catches up. */
    check(
      dash.includes("function sectionVisible(id)") &&
      dash.includes("if (!(PAGES[page] ?? []).some") &&
      dash.includes("return true;") &&
      dash.includes("function lazySection(id, inner)") &&
      dash.includes("staleSections.add(id)") &&
      dash.includes("function flushStaleSections()"),
      "E3-2: a hidden section records that it is stale instead of building DOM"
    );
    const dashCss = fs.readFileSync(path.join(root, "css/dashboard.css"), "utf8");
    check(
      dash.includes('const WORKBENCH_PAGES = ["open", "close-day", "inbox", "snoozed", "sessions", "labels", "duplicates", "activity"]') &&
        dash.includes("const DAILY_PAGES = new Set(WORKBENCH_PAGES);") &&
        dash.includes("const visible = new Set(PAGES[currentPage])") &&
        !dash.includes("const foldControls =") &&
        // F34-4: no Home route, no Dashboard navigator, and both surfaces gone
        // from the stylesheet rather than merely unmounted.
        !dash.includes("home: [openSec]") &&
        !dashCss.includes(".home-surface {") &&
        !dashCss.includes(".workbench-bar {"),
      "F23/F34-4: Home is retired and exactly one routed collection mounts"
    );
    const home = fs.readFileSync(path.join(root, "js/ui/home-surface.js"), "utf8");
    check(
      // F34-4: the module is retired in place, because the build environment
      // cannot unlink files. Nothing may import it, and it must export nothing.
      home.includes("RETIRED by F34-4") && home.includes("export {};") &&
        !dash.includes("home-surface.js") &&
        !fs.readFileSync(path.join(root, "js/ui/sidepanel.js"), "utf8").includes("home-surface.js") &&
        !dash.includes('el("h2", {}, "Workbench")') &&
        !dash.includes('"Complete collection"') &&
        !dash.includes('class: "workbench-heading"') &&
        dashCss.includes('body[data-workbench="true"] .daily-stage .sections { max-width: none; }') &&
        dashCss.includes('body[data-workbench="true"] .hero .hero-panel { max-width: 760px; }'),
      "F24/F38: the retired Home module is unreferenced and the fluid Search/collection axes survive"
    );
    check(
      dash.includes("const hero = el(") &&
        /const hero = el\([\s\S]{0,600}class: "hero-top"[\s\S]{0,120}heroUtility,[\s\S]{0,80}pageUtilities\.starred[\s\S]{0,80}focusStrip/.test(dash) &&
        /const dailyStage = el\("div"[\s\S]{0,120}reconnectBanner, sectionsWrap/.test(dash) &&
        /const main = el\("main"[\s\S]{0,180}hero, dailyStage/.test(dash) &&
        !dashCss.includes('body[data-workbench="true"] .pu-'),
      "F40: Search, push Starred, fixed responsive Needs you, and active Focus are global across routes"
    );
    const focusStripSrc = fs.readFileSync(path.join(root, "js/ui/focus-strip.js"), "utf8");
    const boxSrc = fs.readFileSync(path.join(root, "js/ui/command-box.js"), "utf8");
    const { attentionItems: boxAttentionItems } = await import("../js/ui/command-box.js");
    check(
      focusStripSrc.includes("export async function getFocusGuardStatus()") &&
        focusStripSrc.includes("export function startFocusGuard()") &&
        focusStripSrc.includes("export function endFocusGuard()") &&
        focusStripSrc.includes('type: "focus-guard-start"') &&
        // F44: the entry point moved off the sidebar onto the top-right utility
        // line, beside Needs you; the status band stays but owns no action.
        dash.includes('class: "hero-focus-action"') &&
        dash.includes('const focusUtility = el("div", { class: "hero-focus" }, focusPrimary, focusSettingsButton);') &&
        dash.includes('active ? "End Focus" : ready ? "Start Focus" : "Set up Focus"') &&
        dash.includes('const duringCount = Number(focusNavStatus?.duringCount) || 0;') &&
        !dash.includes('el("span", { class: "n" }, String(duringCount))') &&
        dash.includes('const result = await endFocusGuard();') &&
        dash.includes('if (!result?.ok) showNotice("Couldn\'t end Focus.");') &&
        !dash.includes("focusNavButton") &&
        !/navMain\.replaceChildren\(\s*[a-zA-Z]*[Ff]ocus/.test(dash) &&
        dash.includes('go("settings-focus", { origin: "rail" })') &&
        !focusStripSrc.includes('"End focus"') &&
        !boxSrc.includes("getFocusGuardStatus") &&
        !dash.includes('navBtn("home"') &&
        !dash.includes('replaceChildren(\n    icon(active ? "snooze" : ready ? "play" : "settings", 16),\n    el("span", { class: "navtext" }, label),\n    null') &&
        !dash.includes("showInactive:"),
      "F37/F44: one utility Focus control starts or ends a run, jumps to its settings, and the band carries no action"
    );
    check(
      // F34-4: What's happening became the attention row. It still routes to a
      // named collection, and now says nothing at all when nothing is true.
      boxAttentionItems({ duplicates: 1 }).map((i) => i.page).join() === "duplicates" &&
      boxSrc.includes("onclick: () => go(item.page)") &&
      boxSrc.includes('class: "page-attention-link"') &&
      !boxSrc.includes("page-attention-item-dot") &&
      !boxSrc.includes("pu-attention-dot") &&
      boxSrc.includes('onclick: () => go("activity") }, "All activity"') &&
      boxSrc.includes("await requestUndo(item.entryId)"),
      "P11-25: direct Needs-you entries route to their collection and automatic work retains Undo plus Activity"
    );
    check(
      // F34-4: the navigator is gone, but the rule it proved now belongs to the
      // one remaining piece of sticky chrome.
      !dashCss.includes(".workbench-bar") &&
        dashCss.includes("body.gradient .hero,") &&
        dashCss.includes("background: var(--bg-grad, var(--bg-solid));") &&
        !/\.hero \{[^}]*backdrop-filter/.test(dashCss),
      "F25/F34-4: the one sticky shell uses the exact page background in solid and gradient modes"
    );
    const workbenchListCss = fs.readFileSync(path.join(root, "css/tablist-d4.css"), "utf8");
    const tokenCss = fs.readFileSync(path.join(root, "css/tokens.css"), "utf8");
    check(
      workbenchListCss.includes('.tablist:not([data-compact]) > .item') &&
        workbenchListCss.includes("overflow: hidden;") &&
        workbenchListCss.includes("isolation: isolate;") &&
        workbenchListCss.includes('[data-mode="dark"] .tablist') &&
        workbenchListCss.includes("color-mix(in srgb, var(--ink) 24%, var(--border))") &&
        workbenchListCss.includes("background: var(--workbench-row);") &&
        workbenchListCss.includes("background: var(--workbench-header);") &&
        workbenchListCss.includes("background: var(--workbench-hover);") &&
        tokenCss.includes("--workbench-row: color-mix(in srgb, var(--surface-2) 96%, var(--ink) 4%);") &&
        tokenCss.includes("--workbench-header: color-mix(in srgb, var(--surface-2) 86%, var(--ink) 14%);") &&
        tokenCss.includes("--workbench-hover: color-mix(in srgb, var(--workbench-row) 85%, var(--accent) 15%);"),
      "F28: the Clear Ladder is shared by separated Workbench ledgers"
    );
    check(
      // F34-4: Home's cells are gone. Nested collection levels still share the
      // roles, which is the part of this contract that outlived Home.
      !dashCss.includes(".star-card") &&
        !dashCss.includes(".home-focus-footer") &&
        workbenchListCss.includes("background: var(--workbench-row);") &&
        workbenchListCss.includes("background: var(--workbench-header);") &&
        workbenchListCss.includes(".item:has(.window-block) > .item-body-frame > .tl-rows"),
      "F28/F34-4: nested collection levels still reuse the row and neutral-header roles"
    );
    check(
      !dash.includes("const workbenchScroll = new Map()") &&
        // F34-4: no inline navigator, so every real route change is orienting and
        // an inert hash replay scrolls nothing. The retired module is unimported.
        !dash.includes('from "./workbench-navigation.js"') &&
        !dash.includes('origin: "inline"') &&
        dash.includes('onclick: () => go(page, { origin: "rail" })') &&
        dash.includes('const orienting = prev !== currentPage || origin === "rail" || origin === "route";') &&
        dash.includes("stickyOffset: () => dailyStickyOffset()") &&
        dash.includes('getPropertyValue("--sp-10")') &&
        !dash.includes('getPropertyValue("--section-flow-inset")') &&
        dash.includes("return heroOffset() + breath + lead + local;") &&
        // Card jumps clear Search and the measured Canvas-line stack.
        !dashCss.includes("var(--workbench-h)") &&
        dashCss.includes('body[data-workbench="true"] .item {') &&
        dashCss.includes("+ var(--section-lead-h, 44px) + var(--section-local-h, 0px) + var(--sp-6));"),
      "F27/F40: every route is orienting and sticky offsets clear the complete Canvas-line stack"
    );
    const navSrc = fs.readFileSync(path.join(root, "js/ui/workbench-navigation.js"), "utf8");
    check(
      // F34-4 retired the navigator, so its scroll policy has nothing left to
      // decide. The module is a tombstone in place, because the build environment
      // cannot unlink files; it must export nothing and be imported by nobody.
      navSrc.includes("RETIRED by F34-4") && navSrc.includes("export {};") &&
        !navSrc.includes("export function workbenchScrollTarget") &&
        ![dash, fs.readFileSync(path.join(root, "js/ui/sidepanel.js"), "utf8")]
          .some((src) => src.includes("workbench-navigation.js")) &&
        // The side panel keeps its own switcher, which is the surviving instance
        // of this navigation idea (spec §9).
        fs.readFileSync(path.join(root, "js/ui/sidepanel.js"), "utf8").includes('class: "switcher"'),
      "F27/F34-4: the navigator is retired and the side panel keeps its own switcher"
    );
    check(
      // The navigator used to carry the collection's name, so the section heading
      // was hidden on those routes. With it gone the heading is the only thing
      // naming what you are looking at.
      !dashCss.includes('body[data-workbench="true"] .sec-wrap > h2 { display: none; }') &&
        dash.includes('const h2 = el("h2", {}, shellSectionTitle(id));') &&
        // No navigation preserves a scroll position now that inline routing is gone.
        !dash.includes('origin === "inline" ? window.scrollY : null'),
      "F34-4: the collection heading is visible again and no route preserves scroll"
    );
    const lazy = ["close-day", "inbox", "archive", "sessions", "snapshots",
      "snoozed", "duplicates", "stats", "activity", "labels", "data"];
    check(
      lazy.every((id) => dash.includes(`lazySection("${id}"`)) &&
      dash.includes('sectionRenderers.set("open", renderOpen)'),
      "E3-2: every section is gated, and Open registers its own existing gate"
    );
    check(
      /renderOpen\(\);[\s\S]{0,220}flushStaleSections\(\);/.test(dash) &&
      dash.includes("const visible = new Set(PAGES[currentPage])"),
      "F23/E3-2: selecting a Workbench route is what catches its one visible section up"
    );
    check(
      // N33 depends on this: go() routes synchronously so a jump can anchor in the
      // same frame. Lazy rendering must not make route() async.
      /^function route\(\) \{/m.test(dash) && !/^async function route\(\)/m.test(dash) &&
      dash.includes("route(); // kicks off renderOpen()"),
      "E3-2: route() stays synchronous and idempotent, so N33's one-motion jump holds"
    );
    check(
      // The previous subtree is kept while hidden, so returning is never blank.
      dash.includes("// node is null when the section is off-screen") &&
      dash.includes("keep the prior subtree so its height holds (no flash on return)"),
      "E3-2: a hidden section keeps its last subtree, so revisiting never blanks"
    );
  
    /* Counts that only ever wanted a number no longer build and sort a list. */
    check(
      dash.includes("countItems(STORE_KEYS.inbox)") &&
      dash.includes("countItems(STORE_KEYS.snoozes)") &&
      dash.includes("readLabelNavigationSnapshot()") &&
      !/navBtn\("inbox", "Inbox", "inbox", inbox\.length\)/.test(dash) &&
      !/String\(inbox\.length\)\), " in inbox"/.test(dash),
      "E3-2: scalar counts avoid sorting while saved-library counts share one snapshot"
    );
  }
  
  /* -- N32: Sessions navigation parity (pure sort + shared index bar) -- */
  {
    const { sortSessions, sessionTabCount } = await import("../js/lib/sessions.js");
    const S = (id, name, tabs, mod) => ({ id, name, modifiedAt: mod, createdAt: 1,
      windows: [Array.from({ length: tabs }, (_, i) => ({ url: `https://x/${i}` }))] });
    const a = S("a", "Alpha", 2, 10), b = S("b", "beta", 5, 30), c = S("c", "Gamma", 5, 20);
    check(sessionTabCount(b) === 5 && sessionTabCount({ windows: [[1], [2, 3]] }) === 3,
      "N32: sessionTabCount sums tabs across windows");
    check(sortSessions([a, b, c], "az").map((s) => s.id).join("") === "abc",
      "N32: az sort orders by name");
    check(sortSessions([a, b, c], "count").map((s) => s.id).join("") === "bca",
      "N32: count sort is most tabs first with a name tie-break");
    check(sortSessions([a, b, c], "recent").map((s) => s.id).join("") === "bca",
      "N32: recent sort is latest modified first");
    const orig = [a, b, c];
    sortSessions(orig, "az");
    check(orig[0] === a && orig[1] === b && orig[2] === c, "N32: sort does not mutate its input");
    check(sortSessions([{ id: "z", name: "Zed", windows: [] }, a], "recent")[0] === a,
      "N32: a session without timestamps sorts as oldest");
  
    const fs = await import("node:fs");
    const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
    const readProjectEvidence = (primary, ciFixture) => {
      const primaryUrl = new URL(primary, import.meta.url);
      return read(fs.existsSync(primaryUrl) ? primary : ciFixture);
    };
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const db = strip(read("../js/ui/dashboard.js"));
    const labelsSurface = strip(read("../js/ui/labels-surface.js"));
    const sessionsSurface = strip(read("../js/ui/sessions-surface.js"));
    check(labelsSurface.includes('from "./indexbar.js"') && sessionsSurface.includes('from "./indexbar.js"'),
      "N32: both shared surfaces import the shared index bar component");
    const bli = labelsSurface.slice(labelsSurface.indexOf("function buildLabelIndex"), labelsSurface.indexOf("const render = coalesce"));
    check(bli.includes("createIndexBar"), "N32: the Labels index bar uses the shared component");
    const bsi = sessionsSurface.slice(sessionsSurface.indexOf("function buildSessionIndex"),
      sessionsSurface.indexOf("const render = coalesce"));
    check(bsi.includes("createIndexBar") && bsi.includes("uiSessionSort"),
      "N32: the Sessions index bar uses the shared component + persisted uiSessionSort");
    const indexbar = strip(read("../js/ui/indexbar.js"));
    const css = read("../css/dashboard.css");
    const primitiveCss = read("../css/primitives.css");
    const listCss = read("../css/tablist-d4.css");
    check(
      /class: "section-lead"/.test(db) && /class: "section-identity"/.test(db) &&
      /class: "section-actions"/.test(db) &&
      /body\[data-workbench="true"\] \.section-lead \{[^}]*position: sticky[^}]*z-index: 10/s.test(css) &&
      db.includes('style.setProperty("--section-lead-h"') &&
      db.includes('style.setProperty("--section-local-h"'),
      "F40: Canvas line is stable measured page chrome above collection headers"
    );
    check(
      indexbar.includes('class: "label-index section-local-sticky"') &&
      !indexbar.includes('class: "item-meta lix-jump"') &&
      /\.label-index \{[^}]*flex-direction: column[^}]*padding: 0 0 var\(--sp-4\)/s.test(css) &&
      /\.label-chip-line\.has-more:not\(\.is-expanded\) \.label-chips \{ flex-wrap: nowrap; \}/.test(css) &&
      /\.label-chip-line\.is-expanded \.label-chip-viewport \{[^}]*max-height:[^}]*overflow-y: auto/s.test(css) &&
      indexbar.includes('class: "chip label-index-toggle"') &&
      indexbar.includes('"aria-controls": chipRowId') &&
      indexbar.includes('msg("list_show_less")') && indexbar.includes('msg("list_more_count"') &&
      /body\[data-workbench="true"\] \.section-local-sticky \{[^}]*position: sticky[^}]*var\(--section-lead-h, 44px\)/s.test(css),
      "F41: Sessions and Labels use a visible second chip line with explicit expand/collapse"
    );
    check(
      !css.includes("--section-flow-inset") && !listCss.includes("--section-flow-inset") &&
      /\.sec-inner \{ padding: 0 0 8px; \}/.test(css) &&
      /\.section-lead \{[^}]*padding: 0 2px calc\(var\(--sp-4\) \+ var\(--sp-1\)\)/s.test(css) &&
      db.includes("const heightOf = (node) => node?.getBoundingClientRect().height ?? 0;") &&
      /\.starred-edge \{[^}]*var\(--section-lead-h, 44px\)[^}]*var\(--section-local-h, 0px\)/s.test(css) &&
      /\.item-head-shell \{[^}]*var\(--section-lead-h, 44px\)[^}]*var\(--section-local-h, 0px\)/s.test(listCss),
      "F42: the opaque Canvas line owns the complete handoff; no scrolling inset can shimmer"
    );
    check(
      db.includes("sectionActionHost: sessionsSec.actions") &&
      sessionsSurface.includes('localeMessage("list_save_all_to_session")') &&
      sessionsSurface.includes('localeMessage("list_save_all_windows_as_session")') &&
      sessionsSurface.includes("ctx.sectionActionHost.replaceChildren(saveOpenWindows)") &&
      sessionsSurface.includes("toolbar: ctx.sectionActionHost ? null") &&
      /\.starred-edge \{[^}]*var\(--section-lead-h, 44px\)[^}]*var\(--section-local-h, 0px\)/s.test(css) &&
      /\.item-head-shell \{[^}]*var\(--section-lead-h, 44px\)[^}]*var\(--section-local-h, 0px\)/s.test(listCss),
      "F40: Sessions save lives in the section line and Starred follows the first collection-header axis"
    );
    check(
      listCss.includes(".tablist > .keeper-panel-slot:empty { display: none; }") &&
      read("../tools/shell-harness.html").includes('<div class="bulk-bar is-empty"></div><div class="keeper-panel-slot"></div>'),
      "F43: the empty keeper helper cannot create a grid gap before the first sticky cap"
    );
    const tablistKeyboard = read("../js/ui/tablist.js");
    const shortcutsKeyboard = read("../js/ui/shortcuts.js");
    check(
      tablistKeyboard.includes("function rowFocusTargets(row)") &&
      tablistKeyboard.includes(".row-copy a[href]") &&
      tablistKeyboard.includes("const targets = rowFocusTargets(row)") &&
      db.includes("function rowFocusDescriptor(target, row)") &&
      db.includes("const lane = rowFocusDescriptor(t, node)") &&
      db.includes("focusRow(next, lane)") &&
      shortcutsKeyboard.includes('msg("shortcuts_open_row")'),
      "N37: row arrows reach the primary URL and vertical arrows preserve the current focus lane"
    );
    check(
      db.includes('if (t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;') &&
      db.includes("focusRow(next, lane);\n}, true);") &&
      listCss.includes(".tablist .trow .t a:focus-visible") &&
      listCss.includes("text-underline-offset: 3px") &&
      listCss.includes("box-shadow: inset 0 -2px 0 var(--accent)"),
      "N38: vertical row navigation captures button arrows and title focus uses a flat link treatment"
    );
    check(
      db.includes("function focusRow(row, lane = null) {\n  revealRowForKeyboard(row);") &&
      db.includes("function rowEntryControl(row)") &&
      db.includes('kbdRevealRow?.classList.add("kbd-reveal")') &&
      db.includes('kbdRevealRow.classList.remove("kbd-reveal")') &&
      listCss.includes(".tablist .trow.kbd-reveal .tacts") &&
      listCss.includes(":not(:focus-within):not(.kbd-reveal) .tacts"),
      "N39: the destination row reveals its hidden action lane before focus, so vertical arrows from an action button actually land"
    );
    check(
      db.includes("function rowEntryControl(row) {\n  if (row.matches?.(\".trow\")) {") &&
      db.includes("const ARROW_OWNERS =") &&
      db.includes('[popover], .action-popover, .tagmenu, [role="listbox"], [role="dialog"]') &&
      db.includes("if (t.closest?.(ARROW_OWNERS)) return;") &&
      db.includes("if (!vertical) return;") &&
      db.includes("const next = e.key === \"ArrowDown\" ? (units[i + 1] ?? units[0]) : units[i - 1];") &&
      !db.includes("if (t !== document.body) return;"),
      "N40: any arrow enters the list at the first unit's own entry control, arrow-owning surfaces opt out, and the downward walk wraps"
    );
    {
      const tl = strip(read("../js/ui/tablist.js"));
      const sb = strip(read("../js/ui/searchbox.js"));
      check(
        tl.includes("const raf = (fn) =>") &&
        tl.includes("if (++tries > 6) return;") &&
        tl.includes("if (st.pendingFocus === idx) st.pendingFocus = null;") &&
        !tl.includes("if (!root.isConnected) return;"),
        "N41: the post-action focus restore retries until its tree is attached, so an awaited section render cannot strand focus at <body>"
      );
      check(
        sb.includes('import { getLabelMeta } from "../lib/label-meta.js";') &&
        sb.includes("(recency[b.label] ?? 0) - (recency[a.label] ?? 0) ||"),
        "N41: the ghost label examples are the two most recently applied labels, with tab count only as the tie-break"
      );
      check(
        /\.item\.jump-arrival::after \{[^}]*z-index: 7/s.test(css) &&
        /\.item-head-shell \{[^}]*z-index: 6/s.test(listCss),
        "N41: the jump ring and wash paint above the sticky card header, so a jumped-to card highlights completely"
      );
      check(
        /\.tablist input\[type="checkbox"\] \{[^}]*place-content: center/s.test(listCss) &&
        !/input\[type="checkbox"\]:checked::after \{[^}]*left:/s.test(listCss) &&
        !/input\[type="checkbox"\]:indeterminate::after \{[^}]*left:/s.test(listCss),
        "N41: the checkbox mark is centred by the box, so round and square shapes align identically"
      );
      check(
        tl.includes('document.activeElement?.closest?.("[data-tablist-row]")') &&
        tl.includes("if (st.pendingFocus == null && typeof document !== \"undefined\") {") &&
        tl.includes('liveRoot?.getAttribute("data-tablist") === section'),
        "N42: any re-render of a section carries focus from its previous tree, so a delayed tab-event refresh cannot drop focus to <body>"
      );
      const dashSrc = strip(read("../js/ui/dashboard.js"));
      const activitySrc = strip(read("../js/ui/activity-surface.js"));
      const labelsSrc = strip(read("../js/ui/labels-surface.js"));
      const sessionsSrc = strip(read("../js/ui/sessions-surface.js"));
      check(
        sessionsSrc.includes("settleAnchor(() => positionSessionCard(id));") &&
        labelsSrc.includes("settleAnchor(() => positionLabelCard(label));") &&
        strip(read("../js/ui/dom.js")).includes("export function settleAnchor(anchor)"),
        "N42: a cold jump re-anchors as the layout settles, so a multi-window session cannot land past its own first window"
      );
      check(
        strip(read("../js/ui/dom.js")).includes("export function settleCue(findCard, cue)") &&
        strip(read("../js/ui/dom.js")).includes("if (!card || (card === cued && card.isConnected)) return;") &&
        sessionsSrc.includes("if (cue) settleCue(() => sessionCardEl(id), cueSessionJumpArrival);") &&
        labelsSrc.includes("if (cue) settleCue(() => labelCardEl(label), cueJumpArrival);"),
        "N43: the arrival cue is held until it lands on a card a queued render cannot replace, and is not restarted on one that survives"
      );
      const boxSource = strip(read("../js/ui/command-box.js"));
      const listCfg = strip(read("../js/ui/list-configs.js"));
      check(
        boxSource.includes('onclick: () => go("activity") }, "All activity")') &&
        !boxSource.includes('el("span", { "aria-hidden": "true" }, "→")') &&
        /\.page-attention-activity:hover, \.page-attention-activity:focus-visible \{[^}]*text-decoration: underline/s.test(css),
        "P11-25/F45: All activity names the arrow-free full-history route and underlines on hover"
      );
      check(
        strip(read("../js/ui/tablist.js")).includes('? listWindowCardTitle(s.tabs.length)\n        : listSingleTabTitle()') &&
        !/kind: "snooze",[\s\S]{0,400}title: s\.title \|\| s\.url,/.test(strip(read("../js/ui/tablist.js"))),
        "F45: a snoozed single tab heads its card with the structural descriptor, exactly as Inbox and Archive do"
      );
      check(
        listCfg.includes('el("span", { class: "action-icon" }, icon("snooze", 14)),') &&
        listCfg.includes('el("span", { class: "action-label" }, localeMessage("action_snooze"))') &&
        listCfg.includes('"data-action-id": "snooze-session"') &&
        !listCfg.includes('}), "snooze-session") }, "Snooze…");'),
        "F45: the session Snooze action wears the shared card-action anatomy, icon and label included"
      );
      check(
        !dashSrc.includes('makeSec("smartviews")') &&
        !dashSrc.includes("renderSmartViews") &&
        !strip(read("../js/lib/search.js")).includes("STORE_KEYS.smartviews") &&
        strip(read("../js/lib/types.js")).includes('smartviews: "smartviews"') &&
        strip(read("../js/lib/portable-state-registry.js"))
          .includes("key: STORE_KEYS.smartviews, kind: \"record-map\""),
        "F45: Smart Views are retired from navigation and Search while legacy records stay portable"
      );
      check(
        strip(read("../js/ui/dom.js")).includes("const BOOLEAN_ATTRS = new Set([") &&
        strip(read("../js/ui/dom.js")).includes("if (v !== false) node.setAttribute(k, \"\");") &&
        !/BOOLEAN_ATTRS = new Set\(\[[^\]]*"aria-|BOOLEAN_ATTRS = new Set\(\[[^\]]*draggable/s
          .test(strip(read("../js/ui/dom.js"))),
        "F45r: el() drops a false BOOLEAN attribute instead of writing disabled=\"false\", while enumerated ones keep their string"
      );
      check(
        boxSource.includes('class: "pu-star-link", type: "button", draggable: "true",') &&
        boxSource.includes("ondragstart: (event) => {") &&
        boxSource.includes("let to = index + (after ? 1 : 0);") &&
        boxSource.includes("if (from < to) to -= 1;") &&
        boxSource.includes("commitStarredReorder(() => reorderStarred(moving, to), focusSnapshot)") &&
        boxSource.includes("if (!event.altKey || (event.key !== \"ArrowUp\" && event.key !== \"ArrowDown\")) return;") &&
        !boxSource.includes('"Move up"') &&
        /\.pu-star-row\.drop-before \{[^}]*inset 0 2px 0 0 var\(--accent\)/s.test(css),
        "F45r: the shortcut itself is the drag handle, the drop index accounts for the removed row, and Alt+arrows keep the keyboard path"
      );
      check(
        boxSource.includes('let reorderAnimations = [];') &&
        boxSource.includes('let reorderTail = Promise.resolve();') &&
        boxSource.includes('const starredRowPositions = () => new Map(') &&
        boxSource.includes('"data-star-id": item.id') &&
        boxSource.includes('captureStarredFocus({ forceId: item.id })') &&
        !boxSource.includes('event.key === "ArrowUp" ? index - 1 : index + 1]?.focus()') &&
        boxSource.includes('row.animate([') &&
        boxSource.includes('style.getPropertyValue("--motion-continuity")') &&
        boxSource.includes('style.getPropertyValue("--ease-out")') &&
        boxSource.includes('matchMedia?.("(prefers-reduced-motion: reduce)").matches') &&
        boxSource.includes('for (const animation of reorderAnimations) animation.cancel();'),
        "P11-07: Starred commits and focuses its reordered state first, then only displaced rows settle with the shared 180ms compositor motion"
      );
      check(
        /\.pu-star-link \{ cursor: pointer; \}/.test(css) &&
        /\.pu-star-link \.pu-fav \{ cursor: grab; \}/.test(css) &&
        !/\.pu-star-row\.dragging \{ cursor: grabbing/.test(css) &&
        boxSource.includes("starBody.addEventListener(\"dragover\""),
        "F46r: the launcher keeps the ordinary pointer, the favicon is the visible handle, and the whole rail accepts the drop"
      );
      const sidepanelHarness = strip(read("../tools/sidepanel-harness.html"));
      const sidepanelFixtures = strip(read("../tools/sidepanel-fixtures.js"));
      check(
        sidepanelHarness.includes('params.get("folded") === "1"') &&
        sidepanelHarness.indexOf('document.getElementById("rows-one").innerHTML') <
          sidepanelHarness.indexOf('applyFoldedPressureFixture(document)') &&
        sidepanelFixtures.includes("export const FOLDED_PRESSURE_WIDTHS = Object.freeze([320, 400, 520]);") &&
        sidepanelFixtures.includes('node(document, "span", "item-folded-mark", "folded")') &&
        sidepanelFixtures.includes('node(document, "span", "item-badge", "(current window)")') &&
        sidepanelFixtures.includes('image.setAttribute("data-fixture-favicon", index === 3 ? "broken" : "loaded")') &&
        tl.includes('return el("span", { class: "fold-summary" }, strip,') &&
        /@container \(max-width: 390px\) \{[^}]*[\s\S]*\.tablist \.item-head-toggle \.fold-strip \{ display: none; \}[\s\S]*\.tablist \.item-head-toggle \.fold-count \{ display: inline; \}/.test(listCss) &&
        sidepanelHarness.includes('fixtureWidth = Number(params.get("width"))') &&
        !boxSource.includes("ResizeObserver"),
        "P11-06: the executable side-panel fixture uses real folded anatomy and the proven compact count fallback without runtime measurement"
      );
      const typographyTokens = read("../css/tokens.css");
      const popupHtml = read("../popup.html");
      const primitivesCss = read("../css/primitives.css");
      const sidepanelCss = read("../css/sidepanel.css");
      const onboardingCss = read("../css/onboarding.css");
      const typeAudit = JSON.parse(read("../tools/q3-type-role-audit.json"));
      check(
        typographyTokens.includes("--text-section: 16px;") &&
        /\.section-lead h2 \{[^}]*font-size: var\(--text-section\)/s.test(css) &&
        /\.count \{[^}]*font-variant-numeric: tabular-nums/s.test(popupHtml) &&
        /\.rmeta-count \{[^}]*font-variant-numeric: tabular-nums/s.test(primitivesCss) &&
        /\.panel-heading \{[^}]*font-variant-numeric: tabular-nums/s.test(sidepanelCss),
        "P11-08: the approved 16px section role is semantic at runtime and changing popup, Search, and side-panel counts use tabular numerals"
      );
      check(
        typeAudit.sectionRole.approvedPx === 16 &&
        typeAudit.sectionRole.historicalReferences[0].values.length === 2 &&
        typeAudit.surfaceInventory.length === 6 &&
        typeAudit.copyPressure.expansion === 1.4 &&
        /--text-section: 18px/.test(readProjectEvidence(
          "../../d4-design-system-spec.md",
          "./ci-evidence/d4-design-system-spec.md"
        )) &&
        /font-size: 14px/.test(popupHtml) && /font-size: 13\.5px/.test(sidepanelCss) &&
        /\.ob-body h2 \{[^}]*font-size: 22px/s.test(onboardingCss),
        "P11-08: the role inventory reconciles the historical 18px baseline while preserving evidence-based compact and onboarding sizes"
      );
      const designRecord = readProjectEvidence(
        "../../.impeccable/design.json",
        "./ci-evidence/design.json"
      );
      check(
        !designRecord.includes("transition: all 170ms") &&
        designRecord.includes("var(--motion-feedback, 80ms)") &&
        designRecord.includes("var(--ease-out, cubic-bezier(.2,.8,.2,1))"),
        "P11-07: design-record button examples use the closed motion vocabulary rather than stale transition-all snippets"
      );
      /* P11 Q1-Q3 behavior regressions. These execute the production Starred
         renderer/store operations, the Dashboard storage dependency + frame
         scheduler, and the real fixture builders. Source checks above retain only
         the cross-file policy guardrails. */
      {
        const { installDomFixture } = await import("./dom-fixture.mjs");
        const { createInterleavableStorage } = await import("./e2-mocks.mjs");
        const { createPageUtilities } = await import("../js/ui/command-box.js");
        const {
          createFrameRefreshScheduler, dashboardTasksForStorage
        } = await import("../js/ui/refresh-scheduler.js");
        const previousLocal = chrome.storage.local;
        const previousOnChanged = chrome.storage.onChanged;
        const record = (id, position, title) => ({
          id, position, title, url: `https://${id}.example`, favIconUrl: "",
          createdAt: 1000 + position, modifiedAt: 1000 + position,
          deviceId: "visual-policy", schemaVersion: 1
        });
        const ist = createInterleavableStorage({
          [STORE_KEYS.starred]: {
            alpha: record("alpha", 0, "Alpha"),
            bravo: record("bravo", 1, "Bravo"),
            charlie: record("charlie", 2, "Charlie")
          }
        });
        const dom = installDomFixture();
        chrome.storage.local = ist.local;
        chrome.storage.onChanged = ist.onChanged;
        try {
          const frames = [];
          const utilities = createPageUtilities({ go: () => {} });
          dom.document.body.append(utilities.starred);
          await utilities.refreshStarred();
          const order = () => [...utilities.starred.querySelectorAll(".pu-star-row[data-star-id]")]
            .map((row) => row.dataset.starId);
          const rowFor = (id) => [...utilities.starred.querySelectorAll(".pu-star-row[data-star-id]")]
            .find((row) => row.dataset.starId === id);
          const dataOrder = () => Object.values(ist.snapshot()[STORE_KEYS.starred])
            .sort((a, b) => a.position - b.position).map((item) => item.id);
          const animationSnapshots = [];
          dom.document.onAnimate = () => animationSnapshots.push({
            dom: order(), data: dataOrder(),
            focus: dom.document.activeElement?.closest?.(".pu-star-row[data-star-id]")?.dataset.starId ?? ""
          });
          const dashboardScheduler = createFrameRefreshScheduler(async (tasks) => {
            if (tasks.includes("starred")) await utilities.refreshStarred();
          }, { requestFrame: (callback) => frames.push(callback) });
          const dashboardStorageListener = (changes, area) => {
            if (area === "local") dashboardScheduler.request(dashboardTasksForStorage(changes));
          };
          ist.onChanged.addListener(dashboardStorageListener);
  
          const bravo = rowFor("bravo").querySelector(".pu-star-link");
          bravo.focus();
          // Start the reversal without awaiting the first key handler. This is the
          // browser's rapid-repeat shape and used to restore by two stale indexes.
          const down = bravo.dispatch("keydown", { key: "ArrowDown", altKey: true });
          const up = bravo.dispatch("keydown", { key: "ArrowUp", altKey: true });
          await Promise.all([down, up]);
          check(
            order().join() === "alpha,bravo,charlie" && dataOrder().join() === "alpha,bravo,charlie" &&
            dom.document.activeElement?.closest(".pu-star-row[data-star-id]")?.dataset.starId === "bravo" &&
            animationSnapshots.length >= 2 && animationSnapshots.every((snapshot) =>
              snapshot.dom.join() === snapshot.data.join() && snapshot.focus === "bravo"),
            "P11-07 behavior: rapid Alt reversal serializes by stable id, with final data/DOM/focus established before every animation"
          );
  
          const liveCueAnimations = dom.animations.filter(({ animation }) => !animation.cancelled);
          const rowsBeforeSameWrite = order().map((id) => rowFor(id));
          while (frames.length) await frames.shift()();
          check(
            order().every((id, index) => rowFor(id) === rowsBeforeSameWrite[index]) &&
            liveCueAnimations.length > 0 && liveCueAnimations.every(({ animation }) => !animation.cancelled),
            "P11-07 Dashboard behavior: the same-write onChanged frame keeps the final DOM and continuity cue intact"
          );
  
          const external = ist.snapshot()[STORE_KEYS.starred];
          external.charlie = { ...external.charlie, title: "Charlie changed elsewhere", modifiedAt: 9000 };
          await ist.local.set({ [STORE_KEYS.starred]: external });
          while (frames.length) await frames.shift()();
          check(
            rowFor("charlie") !== rowsBeforeSameWrite[2] &&
            rowFor("charlie").textContent.includes("Charlie changed elsewhere") &&
            liveCueAnimations.every(({ animation }) => animation.cancelled),
            "P11-07 Dashboard behavior: a genuinely different external Starred write still replaces the DOM and ends the stale cue"
          );
  
          const dataTransfer = { effectAllowed: "", dropEffect: "", setData() {} };
          let source = rowFor("alpha").querySelector(".pu-star-link");
          source.focus();
          await source.dispatch("dragstart", { dataTransfer });
          let target = rowFor("charlie");
          const targetBox = target.getBoundingClientRect();
          await target.dispatch("drop", { dataTransfer, clientY: targetBox.bottom });
          check(
            dataOrder().join() === "bravo,charlie,alpha" &&
            dom.document.activeElement?.closest(".pu-star-row[data-star-id]")?.dataset.starId === "alpha",
            "P11-07 behavior: pointer reorder preserves the focused shortcut by logical id"
          );
          while (frames.length) await frames.shift()();
  
          const outside = dom.document.createElement("button");
          dom.document.body.append(outside);
          outside.focus();
          source = rowFor("alpha").querySelector(".pu-star-link");
          await source.dispatch("dragstart", { dataTransfer });
          target = rowFor("bravo");
          await target.dispatch("drop", {
            dataTransfer, clientY: target.getBoundingClientRect().top
          });
          check(
            dataOrder().join() === "alpha,bravo,charlie" && dom.document.activeElement === outside,
            "P11-07 behavior: pointer reorder does not steal focus when Starred did not own it"
          );
        } finally {
          chrome.storage.local = previousLocal;
          if (previousOnChanged === undefined) delete chrome.storage.onChanged;
          else chrome.storage.onChanged = previousOnChanged;
          dom.restore();
        }
      }
      {
        const { installDomFixture } = await import("./dom-fixture.mjs");
        const {
          applyExpandedCopyFixture, applyFoldedPressureFixture,
          foldedPressureGeometry, FOLDED_PRESSURE_WIDTHS
        } = await import("../tools/sidepanel-fixtures.js");
        const dom = installDomFixture();
        try {
          const make = (tag, className = "", text = "") => {
            const node = dom.document.createElement(tag);
            node.className = className;
            if (text) node.textContent = text;
            return node;
          };
          const heading = make("h2", "panel-heading", "Open tabs (15)");
          const switcher = make("div", "switcher-tabs");
          for (const label of ["Open", "Inbox", "Sessions", "Labels"]) {
            switcher.append(make("button", "switch-tab", label));
          }
          const tablist = make("div", "tablist");
          const card = make("div", "item");
          const shell = make("div", "item-head-shell");
          const head = make("div", "item-head");
          const toggle = make("button", "item-head-toggle");
          toggle.append(make("span", "item-title", "Window 1"), make("span", "item-meta", "9 tabs"));
          const actions = make("span", "gacts");
          for (const label of ["Inbox", "Session", "Copy", "Organize"]) {
            const button = make("button", "mini", label);
            actions.append(button);
          }
          head.append(toggle, actions); shell.append(head);
          const body = make("div", "item-body-frame");
          const rows = make("div"); rows.id = "rows-one";
          const row = make("div", "trow");
          const titleWrap = make("span", "t"); titleWrap.append(make("a", "", "A tab"));
          const host = make("span", "host", "example.com"); row.append(titleWrap, host); rows.append(row);
          body.append(rows); card.append(shell, body); tablist.append(card);
          dom.document.body.append(heading, switcher, tablist);
  
          const expanded = applyExpandedCopyFixture(dom.document);
          const expandedSwitches = [...switcher.querySelectorAll(".switch-tab")]
            .map((button) => button.textContent);
          check(
            expanded.heading.textContent.includes("1,248") &&
            expandedSwitches.join("|") === expanded.switchCopy.join("|") &&
            expanded.title.textContent.length > 65 &&
            expanded.firstRowTitle.textContent.length > 70 &&
            expanded.firstHost.textContent.length > 45 &&
            actions.children.length === 4,
            "P11-08 behavior: the 40% expanded-copy fixture exercises heading, navigation, title, unbroken domain, and the intact action lane"
          );
  
          const folded = applyFoldedPressureFixture(dom.document);
          const broken = folded.strip.querySelector('[data-fixture-favicon="broken"]');
          await broken.dispatch("error");
          check(
            !card.querySelector(".item-body-frame") && card.classList.contains("is-folded") &&
            toggle.children[0] === folded.title && toggle.children[1] === folded.badge &&
            toggle.children[2] === folded.foldedMark && toggle.children[3] === folded.summary &&
            folded.summary.children[0] === folded.strip && folded.summary.children[1] === folded.count &&
            folded.strip.children.length === 8 &&
            folded.strip.querySelectorAll('[data-fixture-favicon="fallback"]').length === 1 &&
            actions.children.length === 4,
            "P11-06 behavior: the folded fixture fully executes with real marker/badge/favicon fallback anatomy and no body rows"
          );
  
          const geometryCases = [...FOLDED_PRESSURE_WIDTHS.map((width) => ({ width, zoom: 100 })),
            { width: 520, zoom: 200 }];
          const geometryPasses = geometryCases.map(({ width, zoom }) => {
            card.clientWidth = width;
            card.scrollWidth = width;
            head.setRect({ left: 0, width, height: 28 });
            actions.setRect({ left: width - 112, width: 112, height: 28 });
            const toggleWidth = width - 112;
            toggle.setRect({ left: 0, width: toggleWidth, height: 28 });
            const compact = width <= 390;
            const titleWidth = compact ? toggleWidth - 103 : toggleWidth - 218;
            folded.title.setRect({ left: 0, width: titleWidth, height: 20 });
            folded.badge.setRect({ left: titleWidth, width: compact ? 0 : 80, height: 20 });
            folded.foldedMark.setRect({ left: titleWidth + (compact ? 0 : 80), width: 40, height: 20 });
            folded.summary.setRect({ left: toggleWidth - (compact ? 63 : 98), width: compact ? 63 : 98, height: 20 });
            folded.strip.setRect({ left: toggleWidth - 93, width: compact ? 0 : 93, height: 20 });
            folded.count.setRect({ left: toggleWidth - 63, width: compact ? 63 : 0, height: 20 });
            const result = foldedPressureGeometry(dom.document, { zoom });
            return result.pass && result.separated && result.partsSeparated;
          });
          check(
            geometryPasses.every(Boolean),
            "P11-06 behavior: folded geometry evaluates 320/400/520 plus the 200% reachability case without observers or fallback state"
          );
        } finally {
          dom.restore();
        }
      }
      check(
        /\.label-chip-viewport \{[^}]*flex: 0 1 auto/s.test(css) &&
        /\.label-chip-line\.is-expanded \.label-chip-viewport \{ flex: 1; \}/.test(css) &&
        /\.label-index-toggle \{[^}]*border-radius: var\(--r-btn\)[^}]*font-weight: 650/s.test(css),
        "F46: the +N more control sits with the chips it opens and reads as a control, not another label"
      );
      const journalSrc = strip(read("../js/lib/journal.js"));
      const archiveSrc = strip(read("../js/lib/archive.js"));
      check(
        journalSrc.includes('{ auto = false, category = "", forwardReceipt = null,') &&
        journalSrc.includes("...(auto ? { auto: true } : {})") &&
        journalSrc.includes("export function isVisibleActivityEntry(entry)") &&
        /Auto-saved \$\{refs\.length\} tab/.test(archiveSrc) &&
        /Auto-archived \$\{expired\.length\} Inbox item/.test(archiveSrc) &&
        archiveSrc.includes("{ auto: true }") &&
        /mutateStores\(\[STORE_KEYS\.inbox, JOURNAL_KEY\]/.test(archiveSrc) &&
        /mutateStores\(\[STORE_KEYS\.inbox, STORE_KEYS\.archive, COUNTERS_KEY, JOURNAL_KEY\]/.test(archiveSrc),
        "F46: both automatic sweeps journal an inverse in their own atomic commit, marked as the extension's own work"
      );
      check(
        archiveSrc.includes("export function setArchiveUndoRegistrar(fn)") &&
        (archiveSrc.match(/title: localeMessage\("action_undo"\)/g) ?? []).length === 2 &&
        strip(read("../js/background.js")).includes("setArchiveUndoRegistrar((notificationId, entryId) => cmdUndo.set(notificationId, entryId));"),
        "F46: the auto-save notification that already existed now carries the same Undo button the manual commands use"
      );
      check(
        activitySrc.includes('let filter = localStorage.getItem("tvActivityFilter") ?? "all";') &&
        activitySrc.includes("(await listActions()).filter(isVisibleActivityEntry)") &&
        activitySrc.includes('all.filter((entry) => (filter === "auto") === (entry.auto === true))') &&
        activitySrc.includes('el("div", { class: "tablist", "data-tablist": "activity" }') &&
        activitySrc.includes('class: "item-head-shell"') &&
        activitySrc.includes("export function activityDayLabel(at, now = Date.now())") &&
        activitySrc.includes('el("span", { class: "row-select-slot" })') &&
        !/getBody\(\)\.replaceChildren\(\s*el\(\s*"div",\s*\{ class: "bulk-bar" \}/.test(activitySrc),
        "F46: Activity renders as day cards in the shared row anatomy and can be filtered to what EveryTab did itself"
      );
      check(
        activitySrc.includes('class: "activity-controls section-local-sticky"') &&
        activitySrc.includes('class: "activity-filter"') &&
        activitySrc.includes("`EveryTab keeps the last ${JOURNAL_CAP} actions.") &&
        /\.activity-seg\.on \{[^}]*background: var\(--surface\)/s.test(css) &&
        /body\[data-workbench="true"\] \.label-index,\s*body\[data-workbench="true"\] \.activity-controls \{/s.test(css) &&
        !activitySrc.includes('class: "activity-lede"') &&
        !activitySrc.includes("Last 50 actions"),
        "F46r2: Activity's controls are the section's own local sticky strip, on the same axis and spacing as every other collection"
      );
      check(
        activitySrc.includes('el("span", { class: "activity-undo-label" }, "Undo")') &&
        /\.tablist\[data-tablist="activity"\] \.tacts \{\s*opacity: 1; visibility: visible/s.test(css) &&
        /\.tablist\[data-tablist="activity"\] \.activity-undo-label \{ display: inline; \}/.test(css),
        "F46r: history's one action is always visible and always named, whatever the Icons-only preference says"
      );
      check(
        archiveSrc.includes("async function notifyExpired(count, undoId)") &&
        archiveSrc.includes('title: localeMessage("archive_notification_expired_title")') &&
        archiveSrc.includes("if (moved > 0) await notifyExpired(moved, entryId);") &&
        (archiveSrc.match(/registerUndoButton\(id, undoId\)/g) ?? []).length === 2,
        "F46r: Inbox expiry announces itself with the same badge, notification, and Undo button as the auto-save"
      );
    }
    {
      /* N42: the arrival cue is gated on the last INPUT DEVICE, not on whether
         the active element happens to match :focus-visible. */
      const { pointerDriven, setInputModality, initInputModality } =
        await import("../js/ui/input-modality.js");
      setInputModality("pointer");
      check(pointerDriven() === true, "N42: a pointer-driven arrival is cued");
      setInputModality("keyboard");
      check(pointerDriven() === false, "N42: a keyboard-driven arrival is not cued (the focus ring is the cue)");
      const handlers = [];
      initInputModality({ addEventListener: (type, fn) => handlers.push([type, fn]) });
      const on = (type) => handlers.find(([t]) => t === type)?.[1];
      on("pointerdown")?.({});
      check(pointerDriven() === true, "N42: a pointer press restores the cue");
      on("keydown")?.({ key: "Shift" });
      check(pointerDriven() === true, "N42: a bare modifier press is not navigation and keeps the modality");
      on("keydown")?.({ key: "ArrowDown" });
      check(pointerDriven() === false, "N42: a real key press switches the modality");
      setInputModality("pointer");
    }
    const pos = sessionsSurface.slice(sessionsSurface.indexOf("function positionSessionCard"),
      sessionsSurface.indexOf("async function goToSession"));
    check(pos.includes('behavior: "auto"') && !pos.includes("smooth"),
      "N32: session-card positioning is instant (no smooth travel)");
    check(!db.includes('behavior: "smooth"'), "N32: no programmatic smooth scroll remains in the dashboard");
    const ty = strip(read("../js/lib/types.js"));
    check(ty.includes('uiSessionSort: "recent"'), "N32: uiSessionSort default is additive in types.js");
  
    /* N33 — one-motion jumps: go() routes synchronously and jumps anchor the
       stale-DOM card in the same frame as the page switch, so the first paint
       is the final position (no visible two-step). */
    const goFn = db.slice(db.indexOf("function go(page,"), db.indexOf("function route()"));
    check(/location\.hash = page;[\s]*route\(\);/.test(goFn),
      "N33: go() routes synchronously (no paint before a jump can anchor)");
    const gtl = labelsSurface.slice(labelsSurface.indexOf("async function goToLabel"), labelsSurface.indexOf("function buildLabelIndex"));
    const presentLabelBranch = gtl.slice(gtl.indexOf("const presentCard"), gtl.indexOf("if (!already)"));
    check(presentLabelBranch.includes("if (present)") && presentLabelBranch.includes("positionLabelCard(label)"),
      "N33: goToLabel anchors a present All-lens card before its ordinary refresh; a group-lens reset renders All first");
    check(
      gtl.includes('labelFilter = "";') &&
        db.includes('activate: () => go("labels", { origin: "jump" })'),
      "F28: label jumps clear filtering and use a route origin that cannot override their destination"
    );
    const gts2 = sessionsSurface.slice(sessionsSurface.indexOf("async function goToSession"),
      sessionsSurface.indexOf("async function setGroupLens"));
    check(gts2.indexOf("positionSessionCard(id)") !== -1 &&
      gts2.indexOf("positionSessionCard(id)") < gts2.indexOf("await render()"),
      "N33: goToSession anchors the present card BEFORE awaiting the refresh render");
    check(
      gts2.includes('sessionFilter = "";') &&
        db.includes('activate: () => go("sessions", { origin: "jump" })') &&
        bsi.includes("onJump: jumpWithinSessionLens"),
      "F28: external Session jumps clear the destination while same-page index jumps retain its lens"
    );
  
    /* P11-14: Labels and Sessions share one organization grammar. */
    const organizationControls = strip(read("../js/ui/organization-controls.js"));
    const organizationIcons = strip(read("../js/ui/icons.js"));
    const organizationPanels = strip(read("../js/ui/list-copy.js"));
    const sidepanelHost = strip(read("../js/ui/sidepanel.js"));
    const snapshotsSurface = strip(read("../js/ui/snapshots-surface.js"));
    check(
      indexbar.indexOf("groupRow") < indexbar.lastIndexOf("chipLine") &&
        labelsSurface.includes('readOrganizationState("label")') &&
        labelsSurface.includes('projectOrganization("label"') &&
        sessionsSurface.includes('readOrganizationState("session")') &&
        sessionsSurface.includes('projectOrganization("session"'),
      "P11-14: the group lens sits between filter/sort and active-lens item jumps on both shared surfaces"
    );
    check(
        organizationControls.includes("replaceMemberGroups") &&
        organizationControls.includes("replaceGroupMembers") &&
        organizationControls.includes('shortLabel: msg("organization_groups_placeholder")') &&
        organizationControls.includes('icon: "cluster"') &&
        organizationIcons.includes("cluster:") &&
        organizationPanels.includes('"organization-label":') &&
        organizationPanels.includes('icon: "cluster"') &&
        organizationControls.includes('msg("organization_add_group")') &&
        organizationControls.includes('msg("organization_manage")') &&
        organizationControls.includes('"data-tip": msg("organization_create_new_group")') &&
        organizationControls.includes('msg("organization_entry_help")') &&
        organizationControls.includes("group.id, selectedGroup.revision") &&
        organizationControls.includes('danger.textContent = msg("organization_confirm_delete")') &&
        !organizationControls.includes("draggable") && !organizationControls.includes("dragstart"),
      "P11-14: anchored group creation, multi-membership, inverse add, rename, and P4 group-only delete ship without group drag"
    );
    check(
      organizationControls.includes("organizationLensAfterRootCreate(currentLens") &&
        organizationControls.includes("organizationLensAfterMemberCreate(currentLens") &&
        organizationControls.includes("nextLens === activeLens ? null : changeLens(nextLens)") &&
        organizationControls.includes('focusAfter: () => findCommand("add", activeLens) ?? findLens(activeLens)'),
      "P11-14: empty and member-seeded group creation both preserve the current lens and stable focus"
    );
    check(
      organizationControls.includes("organizationMembershipFocusTarget") &&
        organizationControls.includes("return create ??") &&
        organizationControls.includes("revealOrganizationLensResult") &&
        labelsSurface.includes("onLensChange: setGroupLens") &&
        sessionsSurface.includes("onLensChange: setGroupLens") &&
        labelsSurface.includes("settleAnchor(() => revealOrganizationLensResult") &&
        sessionsSurface.includes("settleAnchor(() => revealOrganizationLensResult"),
      "P11-14: a removed Ungrouped card restores focus outside the clipped lens rail and every group route holds its first result below sticky chrome"
    );
    check(
      labelsSurface.includes("activeGroupLens = ALL_ORGANIZATION_LENS;") &&
        sessionsSurface.includes("activeGroupLens = ALL_ORGANIZATION_LENS;") &&
        labelsSurface.includes("onJump: jumpWithinLabelLens") &&
        sessionsSurface.includes("onJump: jumpWithinSessionLens") &&
        !labelsSurface.slice(labelsSurface.indexOf("function jumpWithinLabelLens"),
          labelsSurface.indexOf("async function goToLabel")).includes("activeGroupLens =") &&
        !sessionsSurface.slice(sessionsSurface.indexOf("function jumpWithinSessionLens"),
          sessionsSurface.indexOf("async function goToSession")).includes("activeGroupLens =") &&
        labelsSurface.includes("setGroupLens, goToGroup: setGroupLens") &&
        sessionsSurface.includes("setGroupLens, goToGroup: setGroupLens") &&
        /\.organization-lens\.on \{[^}]*border-bottom-color: var\(--accent\)/s.test(primitiveCss),
      "P11-14: active-lens chips retain their lens while external item jumps reset All and group deep links remain exact"
    );
    check(
      organizationControls.includes("changeLens(UNGROUPED_ORGANIZATION_LENS);") &&
        organizationControls.indexOf("changeLens(UNGROUPED_ORGANIZATION_LENS);") >
          organizationControls.indexOf("deleteOrganizationGroup"),
      "P11-14: deleting the active group lands on Ungrouped while preserving every member"
    );
    check(
      db.includes('import { deleteNamedSession } from "../lib/organization.js";') &&
        sidepanelHost.includes('import { deleteNamedSession } from "../lib/organization.js";') &&
        db.includes("deleteNamedSession(s.id, s.modifiedAt)") &&
        sidepanelHost.includes("deleteNamedSession(s.id, s.modifiedAt)") &&
      snapshotsSurface.includes("deleteSavedItem(") &&
        sidepanelHost.includes("deleteSavedItem("),
      "P11-14: named Sessions delete with memberships and both hosts atomically delete Snapshots with Undo"
    );
  }
  
}
