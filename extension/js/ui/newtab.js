/**
 * M6 / N25 — new-tab page. Three modes (settings.newTabMode):
 *   "dashboard" (default): redirect to the full dashboard.
 *   "minimal": Horizon clock + universal search + up to five Starred pages.
 *   "blank": a nearly-empty page on the scheme background, only a faint mark.
 * The manifest override is static (all-or-nothing), so "blank" is the closest
 * possible opt-out of the new-tab takeover.
 */
import { getSettings } from "../lib/store.js";
import { STORE_KEYS } from "../lib/types.js";
import { listStarred } from "../lib/starred.js";
import {
  applyDocumentLocale, formatDate, formatNumber, formatTime, msg, pluralCategory
} from "../lib/i18n.js";
import { dashboardHref } from "../lib/newtab-focus.js";
import { el } from "./dom.js";
import { icon } from "./icons.js";
import { createSearchBox } from "./searchbox.js";
import { createFocusAccessPanel, getFocusAccessStatus } from "./focus-access.js";
import { initTooltips } from "./tooltip.js";
import { initTheme } from "./theme.js";

initTheme();
initTooltips(); // themed tooltips, shared with the dashboard (parity)
applyDocumentLocale();
document.title = msg("newtab_title");

const app = document.getElementById("app");

const settings = globalThis.__everyTabNewTabSettings ?? await getSettings();
if (settings.newTabMode === "blank") {
  // N25: render nothing but a faint mark in the corner, on the scheme
  // background. No clock, no search, no focus grab — the quietest new tab we
  // can offer while the manifest override is still in force.
  document.body.classList.add("blank");
  app.append(el("div", { class: "blank-mark", "aria-hidden": "true" }, icon("mark", 30)));
} else {
  document.body.classList.add("minimal-horizon");
  const clock = el("div", { class: "clock" });
  const date = el("div", { class: "date" });
  const clockBlock = el("div", { class: "minimal-clock" }, clock, date);
  const tick = () => {
    const now = new Date();
    clock.textContent = formatTime(now, { hour: "2-digit", minute: "2-digit" });
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
  const search = createSearchBox({
    placeholder: msg("newtab_search_placeholder"),
    historyPlaceholder: msg("newtab_search_history_placeholder"),
    enterFallback: true,
    webSearchDisposition: "CURRENT_TAB",
    navigate: (url) => location.assign(url)
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
  const starredIcon = (item) => {
    if (!item.favIconUrl) {
      return el("span", { class: "minimal-fav minimal-fav-fallback", "aria-hidden": "true" },
        String(item.title || item.url || "★").trim().slice(0, 1).toLocaleUpperCase());
    }
    const image = el("img", { class: "minimal-fav", src: item.favIconUrl, alt: "" });
    image.addEventListener("error", () => image.replaceWith(
      el("span", { class: "minimal-fav minimal-fav-fallback", "aria-hidden": "true" },
        String(item.title || item.url || "★").trim().slice(0, 1).toLocaleUpperCase())
    ));
    return image;
  };
  const renderStarred = async (initial = null) => {
    const items = initial ?? await listStarred();
    const visible = items.slice(0, 5);
    const launcherLabel = pluralCategory(visible.length) === "one"
      ? msg("newtab_starred_launcher_one")
      : msg("newtab_starred_launcher_many", [formatNumber(visible.length)]);
    starredLauncher.setAttribute("aria-label", launcherLabel);
    starredLauncher.replaceChildren(...visible.map((item) => el("button", {
      class: "minimal-launch",
      type: "button",
      title: item.title || item.url,
      onclick: () => chrome.runtime.sendMessage({ type: "activate-starred", url: item.url })
    }, starredIcon(item), el("span", { class: "minimal-launch-name" }, item.title || item.url))));
  };
  const footer = el(
    "div",
    { class: "links" },
    el(
      "a",
      { href: dashboardHref() },
      msg("nav_dashboard")
    ),
    el("button", { onclick: () => chrome.runtime.openOptionsPage() }, msg("nav_settings"))
  );
  const deck = el("section", { class: "minimal-deck" },
    search,
    focusAccessPanel.element,
    starredLauncher,
    footer
  );
  app.append(clockBlock, deck);
  // Clock, Search, Focus, and navigation are the useful Minimal surface. Starred
  // is a small saved-data enhancement and must not hold that surface behind a
  // cold or Vault-pressured storage read.
  void renderStarred().catch(() => {});
  // Paint from the same worker-owned record as popup/dashboard. Blank mode stays blank.
  void getFocusAccessStatus().then(({ accesses }) => focusAccessPanel.render(accesses));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.focusTemporaryAccess) focusAccessPanel.refresh();
    if (area === "local" && changes[STORE_KEYS.starred]) void renderStarred();
  });
  // The fixed footer must remain clickable under short windows and browser
  // zoom. Measure its real position after localized clock/date copy has laid
  // out, then cap only this Search instance to the space that actually remains.
  const searchField = search.querySelector(".search-field");
  const fitSearchResults = () => {
    if (!searchField) return;
    const available = document.documentElement.clientHeight -
      searchField.getBoundingClientRect().bottom - 24;
    search.style.setProperty("--search-results-max-h", `${Math.max(0, Math.floor(available))}px`);
  };
  requestAnimationFrame(fitSearchResults);
  window.addEventListener("resize", fitSearchResults);
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
