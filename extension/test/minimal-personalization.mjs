import { readFileSync } from "node:fs";
import { installDomFixture } from "./dom-fixture.mjs";

const checks = [];
function check(condition, name, detail = "") {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  checks.push(name);
}

const {
  drawWelcomePhrase, normalizeWelcomePhrases,
  WELCOME_PHRASE_MAX_COUNT, WELCOME_PHRASE_MAX_LENGTH
} = await import("../js/lib/welcome-phrases.js");
const { minimalSearchResultsRoom } = await import("../js/ui/minimal-search-layout.js");

check(minimalSearchResultsRoom({
  viewportHeight: 720,
  fieldBottom: 500,
  deckHeight: 134,
  expanded: true
}) === 622,
"Minimal Search projects its final anchored field position while the deck is expanding");

const longEmoji = "🙂".repeat(WELCOME_PHRASE_MAX_LENGTH + 4);
const normalized = normalizeWelcomePhrases([
  "  Welcome home  ", "", "Welcome home", "Memento mori", longEmoji, 42
]);
check(normalized.length === 3 && normalized[0] === "Welcome home" &&
  normalized[1] === "Memento mori", "welcome normalization trims, drops blanks, and deduplicates");
check([...normalized[2]].length === WELCOME_PHRASE_MAX_LENGTH && !normalized[2].includes("�"),
  "welcome normalization caps Unicode characters without splitting a surrogate pair");
check(normalizeWelcomePhrases(Array.from({ length: 120 }, (_, i) => `Line ${i}`)).length ===
  WELCOME_PHRASE_MAX_COUNT, "welcome normalization caps the library at 100 lines");

let state = null;
const sequence = [];
for (let index = 0; index < 4; index += 1) {
  const drawn = drawWelcomePhrase(["A", "B", "C"], state, () => 0);
  sequence.push(drawn.phrase);
  state = drawn.state;
}
check(new Set(sequence.slice(0, 3)).size === 3,
  "welcome shuffle shows every phrase once before repeating", sequence.join(","));
check(sequence[2] !== sequence[3], "welcome shuffle avoids a repeat across bag boundaries");
check(!JSON.stringify(state).includes("A") && !JSON.stringify(state).includes("B") &&
  !JSON.stringify(state).includes("C"), "welcome shuffle receipt stores no phrase text");
check(drawWelcomePhrase([], state).state === null,
  "an empty phrase library leaves no operational shuffle receipt");

const { normalizePortableSettings } = await import("../js/lib/portable-state-registry.js");
const portable = normalizePortableSettings({
  newTabWelcomeEnabled: false,
  newTabWelcomeTone: "accent",
  newTabWelcomePhrases: ["  Home  ", "Home", longEmoji]
});
check(portable.newTabWelcomeEnabled === false && portable.newTabWelcomePhrases.length === 2 &&
  portable.newTabWelcomePhrases[0] === "Home" && portable.newTabWelcomeTone === "accent",
"Backup, Restore, and Vault preserve visibility separately from the normalized phrase library");
check(normalizePortableSettings({ newTabWelcomeTone: "unknown" }).newTabWelcomeTone === "clock",
  "an invalid portable phrase tone falls back to the quiet clock treatment");

const fixture = installDomFixture();
const previous = new Map();
for (const key of ["chrome", "requestAnimationFrame", "cancelAnimationFrame"]) {
  previous.set(key, globalThis[key]);
}
const messages = JSON.parse(readFileSync(new URL("../_locales/en/messages.json", import.meta.url), "utf8"));
const substitute = (entry, substitutions = []) => {
  const values = Array.isArray(substitutions) ? substitutions : [substitutions];
  let value = entry?.message ?? "";
  for (const [name, placeholder] of Object.entries(entry?.placeholders ?? {})) {
    const position = Number(String(placeholder.content).slice(1)) - 1;
    value = value.replaceAll(`$${name.toUpperCase()}$`, String(values[position] ?? ""));
  }
  return value;
};
let status = { active: false, duringCount: 2, guardedCount: 2, endsAt: null };
let setupCount = 0;
let startCount = 0;
let endCount = 0;
globalThis.requestAnimationFrame = (callback) => { callback(0); return 1; };
globalThis.cancelAnimationFrame = () => {};
globalThis.chrome = {
  i18n: {
    getMessage: (key, substitutions) => key.startsWith("@@")
      ? key === "@@ui_locale" ? "en" : "ltr"
      : substitute(messages[key], substitutions)
  },
  runtime: {
    sendMessage: async ({ type }) => {
      if (type === "focus-guard-status") return { ok: true, status: structuredClone(status) };
      if (type === "focus-guard-start") {
        startCount += 1;
        status = { ...status, active: true, endsAt: Date.now() + 42 * 60_000 };
        return { ok: true, status: structuredClone(status) };
      }
      if (type === "focus-guard-end") {
        endCount += 1;
        status = { ...status, active: false, endsAt: null };
        return { ok: true, status: structuredClone(status) };
      }
      return { ok: false };
    }
  }
};

try {
  const { createMinimalFocusAction } = await import("../js/ui/minimal-focus-action.js");
  const action = createMinimalFocusAction({ openSetup: () => { setupCount += 1; } });
  fixture.document.body.append(action.element);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const button = action.element.querySelector(".minimal-focus-action");
  check(button.textContent === "Focus" && button.getAttribute("aria-label") === "Start focus",
    "Minimal Focus hydrates to one play-and-Focus footer action");

  await button.dispatch("click");
  check(startCount === 1 && action.element.classList.contains("is-active") &&
    button.textContent.includes("42m") && button.getAttribute("aria-label") === "End focus",
  "Minimal Focus starts through the shared worker and morphs to stop plus time");

  await button.dispatch("click");
  check(endCount === 1 && !action.element.classList.contains("is-active") &&
    button.textContent === "Focus", "Minimal Focus stops and returns to its stable footer label");

  status = { active: true, duringCount: 2, guardedCount: 2, endsAt: null };
  await action.refresh();
  check(action.element.querySelector('[data-focus-state="active"] .minimal-focus-copy')?.textContent ===
    "Focus", "open-ended Minimal Focus uses the compact stable label instead of overflowing");

  status = { active: false, duringCount: 0, guardedCount: 0, endsAt: null };
  await action.refresh();
  check(action.element.querySelector('[data-focus-state="ready"] .minimal-focus-copy')?.textContent ===
    "Set Focus", "unconfigured Minimal Focus names the setup action before navigation");
  await button.dispatch("click");
  check(setupCount === 1 && startCount === 1,
    "Minimal Focus routes to setup instead of starting without a During Focus site");
  action.destroy();

  // Unpacked Chrome can retain the previous localized-message catalogue for
  // an already-installed profile across an extension reload. A newly added
  // message key must not become a synchronous dependency of Minimal's first
  // useful paint: long-lived profiles should still build the Focus action from
  // the established shared Focus catalogue.
  const normalLookup = globalThis.chrome.i18n.getMessage;
  globalThis.chrome.i18n.getMessage = (key, substitutions) =>
    key.startsWith("newtab_focus_") ? "" : normalLookup(key, substitutions);
  const cachedLocaleAction = createMinimalFocusAction({ openSetup: () => {} });
  fixture.document.body.append(cachedLocaleAction.element);
  await new Promise((resolve) => setTimeout(resolve, 0));
  check(cachedLocaleAction.element.querySelector(".minimal-focus-action")?.textContent === "Set Focus",
    "Minimal Focus survives a long-lived profile's stale localized-message catalogue");
  cachedLocaleAction.destroy();
  globalThis.chrome.i18n.getMessage = normalLookup;
} finally {
  fixture.restore();
  for (const [key, value] of previous) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
}

const newtabSource = readFileSync(new URL("../js/ui/newtab.js", import.meta.url), "utf8");
const searchboxSource = readFileSync(new URL("../js/ui/searchbox.js", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../js/ui/settings-form.js", import.meta.url), "utf8");
const cssSource = readFileSync(new URL("../css/newtab.css", import.meta.url), "utf8");
check(newtabSource.includes('class: "minimal-welcome"') &&
  newtabSource.includes("settings.newTabWelcomeEnabled") &&
  newtabSource.includes('"data-tone": settings.newTabWelcomeTone') &&
  newtabSource.includes('clock, welcome, date') &&
  !readFileSync(new URL("../js/ui/dashboard.js", import.meta.url), "utf8").includes("minimal-welcome"),
"the all-caps inscription is mounted between time and date on Minimal only and obeys its tone setting");
check(!newtabSource.includes('import { createMinimalFocusAction }') &&
  newtabSource.indexOf("app.append(clockBlock, deck)") <
    newtabSource.indexOf('import("./minimal-focus-action.js")') &&
  newtabSource.includes("Focus is an enhancement to Minimal"),
"Minimal paints its core surface before resolving the optional Focus enhancement");
check(settingsSource.includes('localizedRow("welcomePhrasesEnabled", check("newTabWelcomeEnabled"))') &&
  settingsSource.includes('localizedRow("welcomeTone", select("newTabWelcomeTone"') &&
  settingsSource.includes('localizedStackedRow("welcomePhrases", welcomePhrases)') &&
  settingsSource.includes("normalizeWelcomePhrases"),
"Settings can hide or recolor the clock inscription without erasing its bounded newline phrase library");
check(cssSource.includes('.minimal-welcome[data-tone="clock"]') &&
  cssSource.includes('.minimal-welcome[data-tone="accent"]') &&
  cssSource.includes("text-transform: uppercase") && cssSource.includes("letter-spacing: .095em"),
"Minimal uses the selected all-caps inscription with distinct quiet-clock and full-accent tones");
check(newtabSource.includes("formatTimeParts") &&
  newtabSource.includes('class: "clock-period"') &&
  newtabSource.includes('role: "timer"') &&
  newtabSource.includes('clock.setAttribute("aria-label", formattedTime)') &&
  newtabSource.includes('clock.dataset.periodPosition') &&
  cssSource.includes('.clock[data-has-period]') &&
  cssSource.includes('font-size: .12em') &&
  cssSource.includes('inset-inline-start: calc(50% + 10.75em)'),
"Minimal preserves locale time while keeping a subordinate day period inside the responsive clock boundary");
check(newtabSource.includes("items.slice(0, 10)") &&
  cssSource.includes("grid-template-columns: repeat(5, minmax(0, 1fr))") &&
  !cssSource.includes(".minimal-launch:nth-child"),
"Minimal exposes ten Starred launchers in two stable five-item rows");
check(!newtabSource.includes("emptyArrowExit: true") &&
  newtabSource.includes("exitToList: () => minimalNavigation?.focusFirst()") &&
  newtabSource.includes("createMinimalNavigation(deck, searchInput)"),
"empty Minimal Search keeps Down in its Recent tabs before the deck navigation path");
check(newtabSource.includes("minimalNavigation?.focusBoundary()") &&
  cssSource.includes("padding: 28px 18px clamp(72px, 9.5vh, 144px)"),
"Minimal Escape owns a neutral arrow boundary and the resting deck leaves the clock room to breathe");
check(newtabSource.includes("renameStarred") &&
  newtabSource.includes('class: "minimal-launch-item"') &&
  newtabSource.includes('class: "minimal-launch-rename"') &&
  newtabSource.includes('class: "minimal-launch-rename-input"') &&
  cssSource.includes(".minimal-launch-item:hover .minimal-launch-rename") &&
  cssSource.includes(".minimal-launch-item:focus-within .minimal-launch-rename"),
"Minimal Starred exposes a top-right hover and keyboard rename without reserving a title lane");
check(cssSource.includes(".minimal-focus-action::before") &&
  cssSource.includes(".minimal-focus-control.is-active .minimal-focus-action::before") &&
  cssSource.includes("inline-size: 96px") &&
  cssSource.includes("justify-content: center"),
"the centered reduced footer action retains the Dashboard-style accent fill transition");
check(newtabSource.includes('deck.classList.toggle("is-search-expanded", expanded)') &&
  newtabSource.includes('search.addEventListener("focusin", syncSearchExpansion)') &&
  newtabSource.includes('search.addEventListener("focusout", settleSearchExpansion)') &&
  newtabSource.includes('search.dismissSearch({ blur: true })'),
"Minimal Search expands on focus and returns to its launcher when focus leaves or the page is clicked");
check(cssSource.includes("interpolate-size: allow-keywords") &&
  cssSource.includes(".minimal-deck.is-search-expanded") &&
  cssSource.includes("inline-size: min(920px, calc(100vw - 80px))") &&
  cssSource.includes("--minimal-search-expanded-block: min(clamp(560px, 76vh, 720px), calc(100vh - 84px))") &&
  cssSource.includes("block-size: min(calc(var(--minimal-search-expanded-block) - 88px)") &&
  cssSource.includes("var(--motion-continuity) var(--ease-out)"),
"Minimal Search direction A opens upward with shared continuity and reserves one bounded result viewport");
check(newtabSource.includes("createIntrinsicBlockMotion") &&
  newtabSource.includes("mutateDeck(() => {") &&
  newtabSource.includes("mutateDeck(() => focusAccessPanel.render(accesses))") &&
  newtabSource.includes('hydrationMotion.handoff(applyExpansion, { force: true, motionClass: "is-search-morphing" })') &&
  cssSource.includes(".minimal-deck.is-hydrating-layout") &&
  cssSource.includes("cubic-bezier(.35, 0, .25, 1)"),
"cold Starred and Focus hydration retarget one gentle intrinsic-size motion instead of jumping the deck");
check(newtabSource.includes("preloadEmptySuggestions: true") &&
  searchboxSource.includes("box.prepareEmptySuggestions = prepareEmptySuggestions") &&
  searchboxSource.includes("if (!domainNamesCache || !labelCountsCache || !recentResultsCache)") &&
  searchboxSource.includes("fillDomains(domainNamesCache)") &&
  searchboxSource.includes("fillLabels(labelCountsCache)") &&
  searchboxSource.includes("fillRecents(recentResultsCache)"),
"Minimal prepares its complete empty Search model before focus and paints cached suggestions synchronously");
check(!searchboxSource.includes('class: "search-shortcut"') &&
  !cssSource.includes(".search-shortcut") &&
  newtabSource.includes('e.key === "/"'),
"the slash shortcut remains functional without adding a visual keycap to Search");

console.log(`PASS ${checks.length}: ${checks.join(" | ")}`);
