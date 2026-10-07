// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * F4 — the one keyboard-shortcut table. The `?` overlay and the Settings list
 * both render from `SHORTCUTS` (in-page keys), so the two can never drift.
 * The browser-wide commands (N18) are read LIVE from `chrome.commands.getAll()`
 * — Chrome owns those bindings and only chrome://extensions/shortcuts can set
 * them, so we show whatever the user actually has bound (or "Not set").
 */
import { el } from "./dom.js";
import { msg } from "../lib/i18n.js";

const isMac = /Mac/i.test(navigator.platform || navigator.userAgent || "");
const MOD = isMac ? "⌘" : "Ctrl"; // in-page Undo modifier (metaKey / ctrlKey)

/** @type {{group: string, note?: string, items: {keys: string[], desc: string}[]}[]} */
export const SHORTCUTS = [
  {
    group: msg("shortcuts_group_search"),
    items: [
      { keys: ["/"], desc: msg("shortcuts_search_focus") },
      { keys: ["f"], desc: msg("shortcuts_open_filter_focus") },
      { keys: ["↑", "↓", "←", "→"], desc: msg("shortcuts_arrows_enter_list") },
      { keys: ["↑", "↓"], desc: msg("shortcuts_move_results") },
      { keys: ["Enter"], desc: msg("shortcuts_open_result") },
      { keys: ["Esc"], desc: msg("shortcuts_close_search") }
    ]
  },
  {
    group: msg("shortcuts_group_triage"),
    items: [
      { keys: [MOD, "Z"], desc: msg("shortcuts_undo") },
      { keys: ["Enter"], desc: msg("shortcuts_toggle_overview") },
      { keys: ["?"], desc: msg("shortcuts_show_reference") }
    ]
  },
  {
    group: msg("shortcuts_group_row"),
    note: msg("shortcuts_group_row_note"),
    items: [
      { keys: ["↑", "↓"], desc: msg("shortcuts_move_rows") },
      { keys: ["Enter"], desc: msg("shortcuts_open_row") },
      { keys: ["x"], desc: msg("shortcuts_select_row") },
      { keys: ["b"], desc: msg("shortcuts_star_row") },
      { keys: ["r"], desc: msg("shortcuts_restore_row") },
      { keys: ["l"], desc: msg("shortcuts_label_row") },
      { keys: ["s"], desc: msg("shortcuts_snooze_row") },
      { keys: ["d"], desc: msg("shortcuts_delete_row") },
      { keys: ["w"], desc: msg("shortcuts_close_open_row") },
      { keys: ["a"], desc: msg("shortcuts_archive_row") },
      { keys: ["i"], desc: msg("shortcuts_save_row") },
      { keys: ["t"], desc: msg("shortcuts_session_row") },
      { keys: ["z"], desc: msg("shortcuts_suspend_row") },
      { keys: ["p"], desc: msg("action_protect") }
    ]
  },
  {
    group: msg("shortcuts_group_card"),
    note: msg("shortcuts_group_card_note"),
    items: [
      { keys: ["r"], desc: msg("shortcuts_open_card") },
      { keys: ["c"], desc: msg("shortcuts_copy_card") },
      { keys: ["l"], desc: msg("shortcuts_label_card") },
      { keys: ["i"], desc: msg("shortcuts_save_card") },
      { keys: ["t"], desc: msg("shortcuts_session_card") },
      { keys: ["p"], desc: msg("action_protect") },
      { keys: ["d"], desc: msg("shortcuts_delete_card") }
    ]
  }
];

/**
 * Friendly descriptions for the browser-wide commands, keyed by manifest command
 * name. `chrome.commands.getAll()` returns each command's manifest description
 * too, but this map is the fallback and keeps the wording in the product voice.
 * The three N18 commands ship with no default key (opt-in): they read "Not set"
 * until the user binds them.
 */
export const COMMAND_LABELS = {
  "open-search-popup": msg("command_search_description"),
  "open-popup": msg("command_popup_description"),
  "open-dashboard": msg("command_dashboard_description"),
  "open-side-panel": msg("command_side_panel_description"),
  "dump-window": msg("command_save_window_description"),
  "dump-tab": msg("command_save_tab_description"),
  "snooze-tab": msg("command_snooze_tab_description"),
  "suspend-tab": msg("command_suspend_tab_description")
};

/** Open Chrome's own shortcuts page — the only surface that can bind commands. */
export function openShortcutsPage() {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
}

function keyEls(keys) {
  const out = [];
  keys.forEach((k, i) => {
    if (i) out.push(el("span", { class: "kbd-plus" }, "+"));
    out.push(el("kbd", {}, k));
  });
  return out;
}

/**
 * Render the shortcut list — shared by the overlay and the Settings page so
 * there is exactly one source of truth.
 * @returns {HTMLElement}
 */
export function renderShortcutList() {
  const wrap = el("div", { class: "shortcuts-list" });
  for (const g of SHORTCUTS) {
    wrap.append(
      el(
        "div",
        { class: "shortcuts-group" },
        el("h4", {}, g.group),
        g.note ? el("p", { class: "shortcuts-note" }, g.note) : null,
        ...g.items.map((it) =>
          el(
            "div",
            { class: "shortcut-row" },
            el("span", { class: "shortcut-keys" }, ...keyEls(it.keys)),
            el("span", { class: "shortcut-desc" }, it.desc)
          )
        )
      )
    );
  }
  return wrap;
}

/**
 * N18 — the live "Anywhere in Chrome" group. Reads every command's current
 * binding from `chrome.commands.getAll()` (Chrome owns these, so this is the
 * only truth), shows "Not set" for the opt-in ones, and offers a "Change in
 * Chrome" button that opens chrome://extensions/shortcuts (the only place they
 * can be bound or rebound). Async because getAll() is; callers append the
 * returned node when it resolves.
 * @returns {Promise<HTMLElement>}
 */
export async function renderBrowserCommands() {
  let commands = [];
  try {
    commands = (await chrome.commands.getAll()) || [];
  } catch { /* not an extension page / API absent — degrade to the button only */ }
  // Keep a stable, meaningful order regardless of what getAll returns.
  const ORDER = ["open-search-popup", "open-popup", "open-dashboard", "open-side-panel", "dump-window", "dump-tab", "snooze-tab", "suspend-tab"];
  const byName = new Map(commands.map((c) => [c.name, c]));
  const names = [...ORDER.filter((n) => byName.has(n)), ...commands.map((c) => c.name).filter((n) => !ORDER.includes(n))];

  const rows = names.map((name) => {
    const c = byName.get(name) || {};
    const desc = COMMAND_LABELS[name] || c.description || name;
    const keys = c.shortcut
      ? el("span", { class: "shortcut-keys" }, el("kbd", {}, c.shortcut))
      : el("span", { class: "shortcut-unset" }, msg("shortcuts_not_set"));
    return el("div", { class: "shortcut-row" }, keys, el("span", { class: "shortcut-desc" }, desc));
  });

  return el(
    "div",
    { class: "shortcuts-group" },
    el("h4", {}, msg("shortcuts_anywhere_heading")),
    el("p", { class: "shortcuts-note" },
      msg("shortcuts_anywhere_note")),
    ...rows,
    el("button", { class: "mini2", style: "margin-top:8px",
      onclick: openShortcutsPage }, msg("shortcuts_change_in_chrome"))
  );
}

let overlayEl = null;

/** Open the themed `?` overlay. Idempotent; Esc / click-outside / × closes it. */
export function openShortcutsOverlay() {
  if (overlayEl) return;
  function close() {
    document.removeEventListener("keydown", onKey, true);
    overlayEl?.remove();
    overlayEl = null;
  }
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  }
  const card = el(
    "div",
    { class: "shortcuts-card", role: "dialog", "aria-modal": "true", "aria-label": msg("shortcuts_dialog_title") },
    el(
      "div",
      { class: "shortcuts-head" },
      el("h3", {}, msg("shortcuts_dialog_title")),
      el("button", { class: "shortcuts-close", type: "button", "aria-label": msg("action_close"), onclick: close }, "×")
    ),
    renderShortcutList()
  );
  // N18: append the live browser-command bindings once getAll() resolves.
  renderBrowserCommands().then((node) => card.append(node));
  overlayEl = el(
    "div",
    { class: "shortcuts-overlay", onclick: (e) => { if (e.target === overlayEl) close(); } },
    card
  );
  document.body.append(overlayEl);
  card.querySelector(".shortcuts-close")?.focus();
  document.addEventListener("keydown", onKey, true);
}
