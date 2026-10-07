// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * M6 / N25 — new-tab page. Three modes (settings.newTabMode):
 *   "dashboard" (default): redirect to the full dashboard.
 *   "minimal": Horizon clock + universal search + up to ten Starred pages.
 *   "blank": a nearly-empty page on the scheme background, only a faint mark.
 * The manifest override is static (all-or-nothing), so "blank" is the closest
 * possible opt-out of the new-tab takeover.
 */
import { faviconSource } from "./favicon-source.js";
import { getSettings } from "../lib/store.js";
import { STORE_KEYS } from "../lib/types.js";
import { byStarredOrder, listStarred, renameStarred } from "../lib/starred.js";
import {
  applyDocumentLocale, formatDate, formatNumber, formatTime, formatTimeParts, msg,
  pluralCategory
} from "../lib/i18n.js";
import { dashboardHref } from "../lib/newtab-focus.js";
import { drawWelcomePhrase } from "../lib/welcome-phrases.js";
import { el, isComposingKey } from "./dom.js";
import { icon } from "./icons.js";
import { createSearchBox } from "./searchbox.js";
import { createMinimalNavigation } from "./minimal-navigation.js";
import { createFocusAccessPanel, getFocusAccessStatus } from "./focus-access.js";
import { createIntrinsicBlockMotion } from "./intrinsic-block-motion.js";
import { minimalSearchResultsRoom } from "./minimal-search-layout.js";
import { initTooltips } from "./tooltip.js";
import { initTheme } from "./theme.js";
import { expandStorageChanges } from "../lib/storage/constants.js";

initTheme();
initTooltips(); // themed tooltips, shared with the dashboard (parity)
applyDocumentLocale();
document.title = msg("newtab_title");

const app = document.getElementById("app");
const WELCOME_STATE_KEY = "tvMinimalWelcomeState";

function minimalWelcomePhrase(phrases) {
  let prior = null;
  try { prior = JSON.parse(localStorage.getItem(WELCOME_STATE_KEY) || "null"); }
  catch { /* malformed operational receipt: restart the bag */ }
  const drawn = drawWelcomePhrase(phrases, prior);
  try {
    if (drawn.state) localStorage.setItem(WELCOME_STATE_KEY, JSON.stringify(drawn.state));
    else localStorage.removeItem(WELCOME_STATE_KEY);
  } catch { /* a private/blocked localStorage does not block Minimal */ }
  return drawn.phrase;
}

// Minimal alone gets a quiet, one-shot arrival on its existing scheme orbs.
// These compositor-only animations never move content or hold up first paint.
function settleMinimalAtmosphere(enabled) {
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  if (!enabled || reduceMotion.matches) return;
  const offsets = ["translate3d(-24vw, 8vh, 0)", "translate3d(20vw, -14vh, 0)"];
  let animations = [];
  let started = false;
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    for (const animation of animations) animation.cancel();
    document.removeEventListener("visibilitychange", onVisibility);
    reduceMotion.removeEventListener("change", onMotionPreference);
    window.removeEventListener("pagehide", stop);
  };
  const start = () => {
    frame = 0;
    if (started || document.hidden || reduceMotion.matches) return;
    started = true;
    animations = [...document.querySelectorAll(".orb")].map((orb, index) =>
      orb.animate([
        { transform: offsets[index] ?? offsets[0], opacity: 1 },
        { transform: "none", opacity: 1 }
      ], { duration: 4600, easing: "cubic-bezier(.25, .1, .25, 1)", iterations: 1 })
    );
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(stop);
  };
  const onVisibility = () => {
    if (document.hidden) { if (started) stop(); }
    else if (!started) { cancelAnimationFrame(frame); frame = requestAnimationFrame(start); }
  };
  const onMotionPreference = () => { if (reduceMotion.matches) stop(); };
  document.addEventListener("visibilitychange", onVisibility);
  reduceMotion.addEventListener("change", onMotionPreference);
  window.addEventListener("pagehide", stop, { once: true });
  // A tab can mount before Chrome activates it. Its first visible frame owns
  // the one arrival; an already-started arrival never replays after a tab switch.
  onVisibility();
}

const settings = globalThis.__everyTabNewTabSettings ?? await getSettings();
if (settings.newTabMode === "blank") {
  // N25: render nothing but a faint mark in the corner, on the scheme
  // background. No clock, no search, no focus grab — the quietest new tab we
  // can offer while the manifest override is still in force.
  document.body.classList.add("blank");
  app.append(el("div", { class: "blank-mark", "aria-hidden": "true" }, icon("mark", 30)));
} else {
  document.body.classList.add("minimal-horizon");
  // Keep the numerals as the clock's direct text node. This preserves the
  // optical-centering correction for the display face; the separately styled
  // day period remains out of flow and the complete value is exposed by the
  // timer's accessible label.
  const clockTime = document.createTextNode("");
  const clockPeriod = el("span", { class: "clock-period", "aria-hidden": "true" });
  const clock = el("div", { class: "clock", role: "timer" }, clockTime, clockPeriod);
  const date = el("div", { class: "date" });
  const welcomeCopy = settings.newTabWelcomeEnabled
    ? minimalWelcomePhrase(settings.newTabWelcomePhrases)
    : "";
  const welcome = welcomeCopy
    ? el("p", {
        class: "minimal-welcome",
        title: welcomeCopy,
        "data-tone": settings.newTabWelcomeTone === "accent" ? "accent" : "clock"
      }, welcomeCopy)
    : null;
  const clockBlock = el("div", { class: "minimal-clock" }, clock, welcome, date);
  const tick = () => {
    const now = new Date();
    const timeOptions = { hour: "2-digit", minute: "2-digit" };
    const formattedTime = formatTime(now, timeOptions);
    const parts = formatTimeParts(now, timeOptions);
    const periodIndex = parts.findIndex(({ type }) => type === "dayPeriod");
    const firstNumberIndex = parts.findIndex(({ type }) => type === "hour");
    const period = periodIndex >= 0 ? parts[periodIndex].value : "";
    clockTime.data = parts
      .filter(({ type }) => type !== "dayPeriod")
      .map(({ value }) => value)
      .join("")
      .trim();
    clockPeriod.textContent = period;
    clock.toggleAttribute("data-has-period", Boolean(period));
    clock.dataset.periodPosition = periodIndex >= 0 && periodIndex < firstNumberIndex
      ? "before"
      : "after";
    clock.setAttribute("aria-label", formattedTime);
    date.textContent = formatDate(now, {
      weekday: "long",
      month: "long",
      day: "numeric"
    });
  };
  tick();
  setInterval(tick, 10_000);

  // F2 — two focus models. Both get the URL-or-web-search Enter fallback (so a
  // new tab can always navigate); they differ only in whether we grab focus.
  //   "omnibox" (default): leave focus in Chrome's address bar; "/" or a click
  //                        enters our search. A page can't focus the omnibox, so
  //                        "type straight into the address bar" just works by us
  //                        NOT stealing focus.
  //   "search":            autofocus our box; type-as-you-go.
  let minimalNavigation = null;
  const search = createSearchBox({
    placeholder: msg("newtab_search_placeholder"),
    historyPlaceholder: msg("newtab_search_history_placeholder"),
    enterFallback: true,
    webSearchDisposition: "CURRENT_TAB",
    navigate: (url) => location.assign(url),
    preloadEmptySuggestions: true,
    exitToList: () => minimalNavigation?.focusFirst(),
    escapeToList: () => minimalNavigation?.focusBoundary()
  });
  const searchInput = search.querySelector("input");
  const focusAccessPanel = createFocusAccessPanel({
    className: "newtab-focus-access",
    onEmptied: () => searchInput?.focus()
  });
  const starredLauncher = el("div", {
    class: "minimal-launcher",
    role: "group",
    "aria-label": msg("nav_starred")
  });
  let mutateDeck = (change) => change();
  const starredIcon = (item) => {
    const source = faviconSource(item);
    if (!source) {
      return el("span", { class: "minimal-fav minimal-fav-fallback", "aria-hidden": "true" },
        String(item.title || item.url || "★").trim().slice(0, 1).toLocaleUpperCase());
    }
    const image = el("img", { class: "minimal-fav", src: source, alt: "" });
    image.addEventListener("error", () => image.replaceWith(
      el("span", { class: "minimal-fav minimal-fav-fallback", "aria-hidden": "true" },
        String(item.title || item.url || "★").trim().slice(0, 1).toLocaleUpperCase())
    ));
    return image;
  };
  const focusStarredLaunch = (id) => {
    const item = [...starredLauncher.querySelectorAll(".minimal-launch-item")]
      .find((node) => node.dataset.starId === id);
    item?.querySelector(".minimal-launch")?.focus();
  };
  const startStarredRename = (item, wrapper) => {
    if (wrapper.querySelector(".minimal-launch-rename-input")) return;
    const name = item.title || item.url;
    const input = el("input", {
      class: "minimal-launch-rename-input",
      type: "text",
      value: name,
      "aria-label": `${msg("action_rename")} ${name}`
    });
    let finished = false;
    const finish = async (commit, restoreFocus) => {
      if (finished) return;
      finished = true;
      const next = input.value;
      if (!commit) {
        input.remove();
        wrapper.classList.remove("renaming");
        if (restoreFocus) wrapper.querySelector(".minimal-launch")?.focus();
        return;
      }
      await renameStarred(item.id, next).catch(() => false);
      await renderStarred();
      if (restoreFocus) focusStarredLaunch(item.id);
    };
    input.addEventListener("keydown", (event) => {
      if (isComposingKey(event)) return;
      if (event.key === "Enter") {
        event.preventDefault();
        void finish(true, true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        void finish(false, true);
      }
    });
    input.addEventListener("blur", () => { void finish(true, false); });
    wrapper.classList.add("renaming");
    wrapper.append(input);
    input.focus();
    input.select();
  };
  const starredLauncherItem = (item) => {
    const name = item.title || item.url;
    const wrapper = el("div", {
      class: "minimal-launch-item",
      "data-star-id": item.id
    });
    const launch = el("button", {
      class: "minimal-launch",
      type: "button",
      title: name,
      onclick: () => chrome.runtime.sendMessage({ type: "activate-starred", url: item.url }),
      onkeydown: (event) => {
        if (event.key !== "F2") return;
        event.preventDefault();
        startStarredRename(item, wrapper);
      }
    }, starredIcon(item), el("span", { class: "minimal-launch-name" }, name));
    const rename = el("button", {
      class: "minimal-launch-rename",
      type: "button",
      title: `${msg("action_rename")} ${name}`,
      "aria-label": `${msg("action_rename")} ${name}`,
      onclick: (event) => {
        event.stopPropagation();
        startStarredRename(item, wrapper);
      }
    }, icon("rename", 13));
    wrapper.append(launch, rename);
    return wrapper;
  };
  const renderStarred = async (initial = null) => {
    const items = initial ?? await listStarred();
    const visible = items.slice(0, 10);
    const launcherLabel = pluralCategory(visible.length) === "one"
      ? msg("newtab_starred_launcher_one")
      : msg("newtab_starred_launcher_many", [formatNumber(visible.length)]);
    mutateDeck(() => {
      starredLauncher.setAttribute("aria-label", launcherLabel);
      starredLauncher.replaceChildren(...visible.map(starredLauncherItem));
    });
  };
  // Render the real Focus control with the footer. Its optional behavior owner
  // adopts this same DOM after loading, so keyboard focus and geometry survive.
  let focusActivationQueued = false;
  const initialFocusButton = el("button", {
    class: "minimal-focus-action is-hydrating", type: "button",
    "aria-label": msg("popup_focus"),
    onclick: async () => {
      if (focusActivationQueued) return;
      focusActivationQueued = true;
      const action = await focusActionReady;
      if (action) initialFocusButton.click();
      else location.assign(dashboardHref("settings-focus"));
    }
  }, el("span", { class: "minimal-focus-state is-ready is-current" },
    icon("play", 14), el("span", { class: "minimal-focus-copy" }, msg("popup_focus"))));
  const initialFocusControl = el("span", { class: "minimal-focus-control" }, initialFocusButton);
  const focusActionHost = el("span", { class: "minimal-focus-action-host" }, initialFocusControl);
  let focusAction = null;
  const footer = el(
    "div",
    { class: "links" },
    el(
      "a",
      { href: dashboardHref() },
      msg("nav_dashboard")
    ),
    el("button", { onclick: () => chrome.runtime.openOptionsPage() }, msg("nav_settings")),
    focusActionHost
  );
  const deck = el("section", { class: "minimal-deck" },
    search,
    focusAccessPanel.element,
    starredLauncher,
    footer
  );
  const prefetchedStarred = globalThis.__everyTabNewTabStarred;
  if (prefetchedStarred?.items) {
    void renderStarred(prefetchedStarred.items.sort(byStarredOrder));
  }
  app.append(clockBlock, deck);
  settleMinimalAtmosphere(settings.uiGradient);
  const hydrationMotion = createIntrinsicBlockMotion(deck, {
    shouldAnimate: () => !deck.classList.contains("is-search-expanded")
  });
  mutateDeck = hydrationMotion.mutate;
  minimalNavigation = createMinimalNavigation(deck, searchInput);
  const focusActionReady = import("./minimal-focus-action.js").then(({ createMinimalFocusAction }) => {
    focusAction = createMinimalFocusAction({
      openSetup: () => location.assign(dashboardHref("settings-focus")),
      element: initialFocusControl
    });
    return focusAction;
  }).catch(() => {
    // Focus is an enhancement to Minimal, never a first-paint dependency.
    // Keep the visible fallback useful if a stale unpacked module cannot load.
    initialFocusButton.classList.remove("is-hydrating");
    initialFocusButton.onclick = () => location.assign(dashboardHref("settings-focus"));
    return null;
  });
  // Clock, Search, Focus, and navigation are the useful Minimal surface. Starred
  // is a small saved-data enhancement and must not hold that surface behind a
  // cold or Vault-pressured storage read.
  if (!prefetchedStarred?.items) {
    if (prefetchedStarred?.ready) {
      void prefetchedStarred.ready.then((items) => {
        if (items) return renderStarred(items.sort(byStarredOrder));
      }).catch(() => {});
    } else {
      void renderStarred().catch(() => {});
    }
  }
  // Paint from the same worker-owned record as popup/dashboard. Blank mode stays blank.
  void getFocusAccessStatus().then(({ accesses }) => {
    mutateDeck(() => focusAccessPanel.render(accesses));
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    changes = expandStorageChanges(changes);
    if (area === "local" && changes.focusTemporaryAccess) focusAccessPanel.refresh();
    if (area === "local" && changes[STORE_KEYS.starred]) void renderStarred();
    if (area === "local" && (changes.focusGuardState || changes.settings)) {
      if (focusAction) void focusAction.refresh();
    }
  });
  window.addEventListener("pagehide", () => {
    focusAction?.destroy();
    minimalNavigation?.destroy();
    hydrationMotion.destroy();
  }, { once: true });
  // The fixed footer must remain clickable under short windows and browser
  // zoom. Measure its real position after localized clock/date copy has laid
  // out, then cap only this Search instance to the space that actually remains.
  const searchField = search.querySelector(".search-field");
  const fitSearchResults = () => {
    if (!searchField) return;
    const fieldBox = searchField.getBoundingClientRect();
    const deckBox = deck.getBoundingClientRect();
    const available = minimalSearchResultsRoom({
      viewportHeight: document.documentElement.clientHeight,
      fieldBottom: fieldBox.bottom,
      deckHeight: deckBox.height,
      expanded: deck.classList.contains("is-search-expanded")
    });
    search.style.setProperty("--search-results-max-h", `${Math.max(0, Math.floor(available))}px`);
  };
  const syncSearchExpansion = () => {
    const expanded = search.contains(document.activeElement);
    if (expanded === deck.classList.contains("is-search-expanded")) return;
    const applyExpansion = () => deck.classList.toggle("is-search-expanded", expanded);
    hydrationMotion.handoff(applyExpansion, { force: true, motionClass: "is-search-morphing" });
    fitSearchResults();
  };
  const settleSearchExpansion = () => requestAnimationFrame(syncSearchExpansion);
  const dismissSearchFromPage = (event) => {
    if (search.contains(event.target)) return;
    search.dismissSearch({ blur: true });
    syncSearchExpansion();
  };
  search.addEventListener("focusin", syncSearchExpansion);
  search.addEventListener("focusout", settleSearchExpansion);
  document.addEventListener("pointerdown", dismissSearchFromPage);
  deck.addEventListener("transitionend", (event) => {
    if (event.target === deck && event.propertyName === "block-size") fitSearchResults();
  });
  requestAnimationFrame(fitSearchResults);
  window.addEventListener("resize", fitSearchResults);
  window.addEventListener("pagehide", () => {
    document.removeEventListener("pointerdown", dismissSearchFromPage);
  }, { once: true });
  if (settings.newTabFocus === "search") {
    requestAnimationFrame(() => searchInput?.focus());
  }
  // "/" focuses search from anywhere (parity with the dashboard) — the way into
  // search in omnibox mode; a no-op while already typing in the box.
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !typing) {
      e.preventDefault();
      searchInput?.focus();
      searchInput?.select();
    }
  });
}
