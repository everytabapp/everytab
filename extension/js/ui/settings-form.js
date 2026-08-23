/**
 * M6 — shared settings form. Mounted by both the dashboard Settings page and
 * the standalone options page, so there is exactly one source of truth for
 * what the settings UI contains.
 */
import { getSettings, listItems, patchSettings } from "../lib/store.js";
import { DEFAULT_SETTINGS, STORE_KEYS } from "../lib/types.js";
import {
  availableSchemeIds, customSchemeCatalogue
} from "../lib/custom-schemes.js";
import { canonicalizeDomain, ruleIndexForDomain } from "../lib/focus.js";
import { hasTabGroupsPermission, ensureTabGroupsPermission } from "../lib/tab-groups.js";
import {
  hasHistoryAccess, requestHistoryAccess, removeHistoryAccess, onHistoryAccessChanged
} from "../lib/history-access.js";
import { el } from "./dom.js";
import { historyAccessCopy } from "./history-access-copy.js";
import { SCHEMES, SCHEME_LABELS, SCHEME_ACCENTS, SCHEME_GROUPS } from "./theme.js";
import { renderShortcutList, renderBrowserCommands } from "./shortcuts.js";
import { createCustomSchemeSettings } from "./custom-schemes-settings.js";
import { createAutomationThresholdControls } from "./automation-threshold-controls.js";
import {
  settingsExceptionDescription, settingsFavoriteAria,
  settingsFavoritesHelp, settingsFavoritesSummary, settingsGroupTitle, settingsInvalidSite,
  settingsOptions, settingsRowCopy, settingsSchemeGroupLabel, settingsStatic
} from "./settings-copy.js";

/**
 * Mount the shared Settings form once and expose a focused-value refresh that
 * never replaces the mounted controls.
 * @param {HTMLElement} container
 * @param {{listenStorage?: boolean}} [options]
 * @returns {Promise<{refresh: () => Promise<void>}>}
 */
export async function mountSettingsForm(container, { listenStorage = true } = {}) {
  let [settings, customRecords] = await Promise.all([
    getSettings(), listItems(STORE_KEYS.customSchemes)
  ]);
  const saved = el("div", { class: "saved" });

  /**
   * Each control registers a fn that re-applies its value from `settings`.
   * This is what makes the form a live reflection of the single stored value:
   * when scheme/mode change elsewhere (the sidebar quick-theme picker, another
   * tab), the storage listener below refreshes `settings` and every control —
   * so the form never shows a stale selection, and a later save from here can't
   * clobber a change made from another surface.
   * @type {Array<() => void>}
   */
  const syncers = [];

  /** @param {Partial<import("../lib/types.js").Settings>} patch */
  const update = async (patch) => {
    // Publish the local choice synchronously for dependent controls whose
    // handlers intentionally do not await persistence.
    settings = { ...settings, ...patch };
    await patchSettings(patch);
    // Re-read the committed merge instead of retaining a whole-form snapshot.
    // Hidden retired keys and concurrent writes from other surfaces therefore
    // survive an unrelated Settings edit byte-for-byte.
    settings = await getSettings();
    saved.textContent = settingsStatic.saved();
    setTimeout(() => (saved.textContent = ""), 1500);
  };

  const row = (title, desc, ...controls) =>
    el(
      "div",
      { class: "setrow" },
      el("span", { class: "tw" }, el("div", { class: "t" }, title), el("div", { class: "d" }, desc)),
      ...controls
    );

  /* F48: a multi-line list needs the full width of the column, so it stacks
     under its label instead of competing with it for a shared row. Squeezed
     into the control slot beside the text, a textarea wrapped one word per
     line and was unusable. */
  const stackedRow = (title, desc, ...controls) =>
    el(
      "div",
      { class: "setrow setrow-stacked" },
      el("span", { class: "tw" }, el("div", { class: "t" }, title), el("div", { class: "d" }, desc)),
      ...controls
    );

  const check = (key) => {
    const input = el("input", { type: "checkbox" });
    input.checked = Boolean(settings[key]);
    input.addEventListener("change", () => update({ [key]: input.checked }));
    syncers.push(() => {
      if (document.activeElement !== input) input.checked = Boolean(settings[key]);
    });
    return input;
  };

  const select = (key, options) => {
    const entries = Array.isArray(options) ? options : Object.entries(options);
    const sel = el(
      "select",
      { onchange: (e) => update({ [key]: e.currentTarget.value }) },
      ...entries.map(([v, label]) => el("option", { value: v }, label))
    );
    sel.value = String(settings[key] ?? "");
    syncers.push(() => {
      const v = String(settings[key] ?? "");
      if (sel.value !== v) sel.value = v;
    });
    return sel;
  };

  // A newline-separated URL-pattern list bound to a settings key (used by both
  // "Keep these tabs open" and F9's "Never suspend these").
  const patternList = (key) => {
    const ta = el("textarea", {
      rows: 3,
      placeholder: settingsStatic.patternsPlaceholder(),
      onchange: (e) =>
        update({ [key]: e.currentTarget.value.split("\n").map((l) => l.trim()).filter(Boolean) })
    });
    ta.value = (settings[key] ?? []).join("\n");
    syncers.push(() => {
      if (document.activeElement !== ta) ta.value = (settings[key] ?? []).join("\n");
    });
    return ta;
  };
  const whitelist = patternList("archiveWhitelist");
  const suspendWhitelist = patternList("suspendWhitelist");

  const automation = createAutomationThresholdControls({
    readSettings: () => settings,
    update,
    registerSync: (sync) => syncers.push(sync)
  });

  // F18 — "Preserve tab groups": a preference (default ON) functionally gated on
  // the optional `tabGroups` permission. Enabling it requests the permission from
  // this click (a user gesture); if denied, the row keeps the preference on and
  // shows the "permission needed" state (the history-permission pattern). A
  // separate "Allow" button re-requests after a denial.
  const preserveGroupsRow = () => {
    const copy = settingsRowCopy("preserveGroups");
    const cb = el("input", { type: "checkbox" });
    cb.checked = settings.preserveTabGroups !== false; // correct first paint (default ON)
    const allow = el("button", { class: "mini", type: "button", hidden: "" }, settingsStatic.allowGroupAccess());
    const note = el("div", { class: "d perm-note", hidden: "" });
    let hasPerm = false;

    const refresh = () => {
      const want = settings.preserveTabGroups !== false;
      if (document.activeElement !== cb) cb.checked = want;
      const needsPerm = want && !hasPerm;
      note.hidden = !needsPerm;
      allow.hidden = !needsPerm;
      note.textContent = needsPerm ? settingsStatic.groupPermissionNote() : "";
    };
    const syncPerm = async () => { hasPerm = await hasTabGroupsPermission(); refresh(); };

    cb.addEventListener("change", async () => {
      if (cb.checked) hasPerm = await ensureTabGroupsPermission();
      await update({ preserveTabGroups: cb.checked });
      refresh();
    });
    allow.addEventListener("click", async () => { hasPerm = await ensureTabGroupsPermission(); refresh(); });
    syncers.push(refresh);
    void syncPerm();

    return el("div", { class: "setrow" },
      el("span", { class: "tw" },
        el("div", { class: "t" }, copy.title),
        el("div", { class: "d" }, copy.description),
        note, allow),
      cb);
  };

  const historyAccessRow = () => {
    const copy = settingsRowCopy("history");
    let enabled = false;
    let pending = false;
    const state = el("span", { class: "permission-state" });
    const feedback = el("div", { class: "d perm-note", role: "status", "aria-live": "polite" });
    const action = el("button", { type: "button", class: "mini" });
    const render = () => {
      state.textContent = enabled ? settingsStatic.historyOn() : settingsStatic.historyOff();
      action.textContent = enabled ? settingsStatic.historyTurnOff() : settingsStatic.historyAllow();
      action.disabled = pending;
    };
    const refreshPermission = async () => {
      enabled = await hasHistoryAccess();
      render();
    };
    action.addEventListener("click", async () => {
      if (pending) return;
      pending = true;
      render();
      feedback.textContent = "";
      if (enabled) {
        const removed = await removeHistoryAccess();
        enabled = await hasHistoryAccess();
        feedback.textContent = removed
          ? settingsStatic.historyRemoved()
          : settingsStatic.historyRemoveFailed();
      } else {
        const granted = await requestHistoryAccess();
        enabled = await hasHistoryAccess();
        feedback.textContent = enabled
          ? settingsStatic.historyEnabled()
          : granted
            ? settingsStatic.historyEnableFailed()
            : settingsStatic.historyDenied();
      }
      pending = false;
      render();
    });
    onHistoryAccessChanged((next) => {
      enabled = next;
      render();
    });
    syncers.push(() => { void refreshPermission(); });
    void refreshPermission();
    return el("div", { class: "setrow history-permission-row" },
      el("span", { class: "tw" },
        el("div", { class: "permission-title-line" },
          el("div", { class: "t" }, copy.title),
          el("span", { class: "permission-state-wrap" }, state)),
        el("div", { class: "d" }, historyAccessCopy.details()),
        el("div", { class: "d history-access-trust" }, historyAccessCopy.trust()),
        feedback),
      action);
  };

  // Each h3 group becomes its own <section> so the settings can carry a filter
  // box + a jump nav (the page has grown; this makes anything quick to find).
  const groups = [];
  const group = (groupId, ...contents) => {
    const title = settingsGroupTitle(groupId);
    const gid = `setg-${groupId}`;
    const node = el("section", { class: "settings-group", id: gid }, el("h3", {}, title), ...contents);
    groups.push({ id: gid, title, node });
    return node;
  };

  const keyboardGroup = group("keyboard",
    el("p", { class: "settings-hint" }, settingsStatic.keyboardHint()),
    renderShortcutList());

  // ---- F8: Focus group (run defaults + blocked-site rules) ----
  // F8-1 stores settings only; no tab/window is redirected, minimized, or closed
  // here. Built as a function so the group() call lands between New tab and
  // Auto-save in both the jump nav (call order) and the rendered order.
  const buildFocusGroup = () => {
    // "Default duration" maps two stored fields (focusDefaultEndMode +
    // focusDefaultDurationMinutes) onto one select. "1 hour" and "Custom
    // duration" both store end mode "duration"; the minutes value distinguishes
    // them, and the number input reveals only for the custom choice.
    let showCustomDuration =
      settings.focusDefaultEndMode === "duration" &&
      Number(settings.focusDefaultDurationMinutes) !== 60;

    const durationSelect = el("select", { "aria-label": settingsRowCopy("focusDuration").title },
      ...settingsOptions("focusDuration").map(([value, label]) => el("option", { value }, label)));
    const durationMinutes = el("input", {
      type: "number", min: 1, max: 1440, style: "width:76px",
      "aria-label": settingsStatic.customDurationAria()
    });

    const durationValue = () => {
      const mode = settings.focusDefaultEndMode;
      if (mode === "morning-end" || mode === "day-end" || mode === "manual") return mode;
      return showCustomDuration ? "custom" : "1h";
    };
    const refreshDuration = () => {
      durationSelect.value = durationValue();
      durationMinutes.value = String(Number(settings.focusDefaultDurationMinutes) || 60);
      durationMinutes.style.display = durationSelect.value === "custom" ? "" : "none";
    };
    durationSelect.addEventListener("change", () => {
      const v = durationSelect.value;
      if (v === "1h") {
        showCustomDuration = false;
        update({ focusDefaultEndMode: "duration", focusDefaultDurationMinutes: 60 });
      } else if (v === "custom") {
        showCustomDuration = true;
        update({
          focusDefaultEndMode: "duration",
          focusDefaultDurationMinutes: Number(settings.focusDefaultDurationMinutes) || 60
        });
      } else {
        update({ focusDefaultEndMode: v });
      }
      refreshDuration();
    });
    durationMinutes.addEventListener("change", () => {
      const mins = Math.max(1, Math.min(1440, Math.round(Number(durationMinutes.value) || 60)));
      if (mins !== 60) showCustomDuration = true;
      update({ focusDefaultEndMode: "duration", focusDefaultDurationMinutes: mins });
      refreshDuration();
    });
    syncers.push(() => {
      if (document.activeElement === durationSelect || document.activeElement === durationMinutes) return;
      showCustomDuration =
        settings.focusDefaultEndMode === "duration" &&
        Number(settings.focusDefaultDurationMinutes) !== 60;
      refreshDuration();
    });
    refreshDuration();

    // Native time input backed by minutes since local midnight.
    const timeField = (key, label) => {
      const toHHMM = (mins) => {
        const m = Math.max(0, Math.min(1439, Number(mins) || 0));
        return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      };
      const input = el("input", { type: "time", "aria-label": label });
      input.value = toHHMM(settings[key]);
      input.addEventListener("change", () => {
        const [h, m] = input.value.split(":").map(Number);
        if (!input.value || !Number.isFinite(h) || !Number.isFinite(m)) {
          input.value = toHHMM(settings[key]); // reject a cleared field, keep prior value
          return;
        }
        update({ [key]: h * 60 + m });
      });
      syncers.push(() => {
        if (document.activeElement !== input) input.value = toHHMM(settings[key]);
      });
      return input;
    };

    // Blocked sites — an inline list editor (never a textarea or alert).
    const siteInput = el("input", {
      type: "text", class: "focus-site-input", placeholder: settingsStatic.addSitePlaceholder(),
      "aria-label": settingsStatic.addSiteAria()
    });
    const addBtn = el("button", { type: "button", class: "focus-site-add-btn" }, settingsStatic.addSite());
    const notice = el("div", { class: "focus-site-notice", role: "alert", "aria-live": "assertive" });
    const list = el("div", { class: "focus-site-list" });

    const rowFor = (domain) => list.querySelector(`[data-domain="${domain}"]`);

    // `listDirty` defers a re-render requested while focus is inside the list, so
    // a focused control is never yanked out from under the user mid-event; the
    // deferred render is flushed by the focusout handler when focus leaves.
    let listDirty = false;
    // Resync the rendered list to current settings, but never synchronously while
    // focus is inside it (that would destroy the focused control mid-event) —
    // defer to the focusout path instead.
    const reconcileOrDefer = () => {
      if (list.contains(document.activeElement)) { listDirty = true; return; }
      renderSites();
    };

    // All row mutations locate their rule by canonical `domain`, never by the
    // rendered array index — so a change or removal always hits the intended rule
    // even if the list shifted underneath it. A stale action on a rule removed
    // elsewhere is a data no-op that reconciles the view (deferred if the stale
    // control is still focused) and never touches another rule.
    const changeScope = (domain, scopeValue) => {
      const rules = settings.focusSiteRules ?? [];
      if (ruleIndexForDomain(rules, domain) < 0) { reconcileOrDefer(); return; } // gone: no-op
      update({ focusSiteRules: rules.map((r) => (r.domain === domain ? { ...r, scope: scopeValue } : r)) });
    };
    const removeSite = (domain) => {
      notice.textContent = "";
      const rules = settings.focusSiteRules ?? [];
      const idx = ruleIndexForDomain(rules, domain);
      if (idx < 0) { reconcileOrDefer(); return; } // already gone: no-op, no sync render
      // Restore focus only when the removal came from inside the removed row (e.g.
      // keyboard-activating its Remove button); a removal that did not originate
      // in the row must not steal focus. Prefer the next remaining row's Remove
      // button, else the previous row's, else the Add-site input when empty.
      const removedRow = rowFor(domain);
      const restoreFocus = removedRow ? removedRow.contains(document.activeElement) : false;
      const nextDomain = rules[idx + 1]?.domain ?? rules[idx - 1]?.domain ?? null;
      update({ focusSiteRules: rules.filter((r) => r.domain !== domain) }).then(() => {
        renderSites();
        if (!restoreFocus) return;
        if (nextDomain) rowFor(nextDomain)?.querySelector(".focus-site-remove")?.focus();
        else siteInput.focus();
      });
    };

    const renderSites = () => {
      listDirty = false;
      list.replaceChildren();
      const rules = settings.focusSiteRules ?? [];
      if (rules.length === 0) {
        list.append(el("div", { class: "focus-site-empty" }, settingsStatic.noBlockedSites()));
        return;
      }
      for (const rule of rules) {
        const scope = el("select", {
          class: "focus-site-scope", "aria-label": settingsStatic.siteScopeAria(rule.displayDomain),
          onchange: (e) => changeScope(rule.domain, e.currentTarget.value)
        }, ...settingsOptions("focusScope").map(([value, label]) => el("option", { value }, label)));
        scope.value = rule.scope;
        const remove = el("button", {
          type: "button", class: "focus-site-remove mini",
          "aria-label": settingsStatic.removeSiteAria(rule.displayDomain),
          onclick: () => removeSite(rule.domain)
        }, settingsStatic.remove());
        // displayDomain is user data — appended as a text node, never innerHTML.
        list.append(el("div", { class: "focus-site-row", "data-domain": rule.domain },
          el("span", { class: "focus-site-domain" }, rule.displayDomain),
          scope, remove));
      }
    };

    const addSite = () => {
      const result = canonicalizeDomain(siteInput.value);
      if (!result.ok) {
        notice.textContent = settingsInvalidSite(result.reason);
        return;
      }
      const rules = settings.focusSiteRules ?? [];
      if (ruleIndexForDomain(rules, result.domain) >= 0) {
        notice.textContent = settingsStatic.siteDuplicate(result.displayDomain);
        const existing = rowFor(result.domain);
        existing?.scrollIntoView({ block: "nearest" });
        existing?.querySelector(".focus-site-scope")?.focus();
        return;
      }
      siteInput.value = "";
      notice.textContent = "";
      update({
        focusSiteRules: [...rules, { domain: result.domain, displayDomain: result.displayDomain, scope: "focus" }]
      }).then(renderSites);
    };
    addBtn.addEventListener("click", addSite);
    siteInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addSite(); }
    });
    // A cross-tab settings change reconciles the list, deferring while focus is
    // inside it so a focused control is never yanked out from under the user.
    syncers.push(reconcileOrDefer);
    list.addEventListener("focusout", () => {
      // focusout fires before focus settles; defer so activeElement is updated,
      // then flush only once focus has genuinely left the list.
      setTimeout(() => {
        if (listDirty && !list.contains(document.activeElement)) renderSites();
      }, 0);
    });
    renderSites();

    // "When you request access" — behavior-first copy, dynamic description (F8-R1 v0.2).
    const excDesc = el("div", { class: "d" });
    const excSelect = el("select", {
      "aria-label": settingsStatic.focusAccessAria(),
      onchange: (e) => {
        update({ focusExceptionStyle: e.currentTarget.value });
        excDesc.textContent = settingsExceptionDescription(e.currentTarget.value);
      }
    }, ...settingsOptions("focusAccess").map(([value, label]) => el("option", { value }, label)));
    excSelect.value = settings.focusExceptionStyle;
    excDesc.textContent = settingsExceptionDescription(settings.focusExceptionStyle);
    syncers.push(() => {
      if (document.activeElement !== excSelect) excSelect.value = settings.focusExceptionStyle;
      excDesc.textContent = settingsExceptionDescription(settings.focusExceptionStyle);
    });

    // F8-R1: the retired "Hide other windows when Focus starts" and "When temporary
    // access ends" rows are gone. Their stored keys (focusMinimizeOtherWindows,
    // focusTemporaryEndAction) are preserved untouched in settings for back-compat.

    const durationCopy = settingsRowCopy("focusDuration");
    const morningCopy = settingsRowCopy("morningEnds");
    const dayCopy = settingsRowCopy("dayEnds");
    const blockedCopy = settingsRowCopy("blockedSites");
    const accessCopy = settingsRowCopy("focusAccess");
    return group("focus",
      el("p", { class: "settings-hint" },
        settingsStatic.focusHint()),
      row(durationCopy.title, durationCopy.description, durationSelect, durationMinutes),
      row(morningCopy.title, morningCopy.description,
        timeField("focusMorningEndMinutes", morningCopy.title)),
      row(dayCopy.title, dayCopy.description,
        timeField("focusDayEndMinutes", dayCopy.title)),
      el("div", { class: "setrow focus-block" },
        el("span", { class: "tw" },
          el("div", { class: "t" }, blockedCopy.title),
          el("div", { class: "d" }, blockedCopy.description)),
        el("div", { class: "focus-site-add" }, siteInput, addBtn),
        notice,
        list),
      el("div", { class: "setrow" },
        el("span", { class: "tw" }, el("div", { class: "t" }, accessCopy.title), excDesc),
        excSelect));
  };

  const schemeSelect = el("select", {
    onchange: (event) => update({ uiScheme: event.currentTarget.value })
  });
  const renderSchemeSelect = () => {
    if (document.activeElement === schemeSelect) return;
    const yours = customSchemeCatalogue(customRecords);
    schemeSelect.replaceChildren(
      ...SCHEME_GROUPS.map((group) => el("optgroup", {
        label: settingsSchemeGroupLabel(group.defaultMode, group.tone)
      },
        ...group.ids.map((scheme) =>
          el("option", { value: scheme }, SCHEME_LABELS[scheme] ?? scheme)))),
      ...(yours.length ? [el("optgroup", { label: settingsStatic.yours() },
        ...yours.map(({ id, label }) => el("option", { value: id }, label)))] : [])
    );
    schemeSelect.value = String(settings.uiScheme ?? DEFAULT_SETTINGS.uiScheme);
    if (!schemeSelect.value) schemeSelect.value = DEFAULT_SETTINGS.uiScheme;
  };
  renderSchemeSelect();
  syncers.push(renderSchemeSelect);

  // D3: stars progressively constrain rotation. Empty intentionally means
  // every scheme, so there is no redundant "rotation pool" setting.
  // Open on every mount for discovery. It remains collapsible because 21
  // choices are useful during setup but need not occupy permanent space.
  const favoritesDetails = el("details", { class: "scheme-favorites", open: "" });
  const favoritesSummary = el("summary");
  const favoritesHelp = el("p", { class: "settings-hint" },
    settingsFavoritesHelp(0, settings.schemeRotate));
  const favoritesGrid = el("div", { class: "scheme-favorites-grid" });
  const renderFavorites = () => {
    const favorites = new Set(Array.isArray(settings.schemeFavorites) ? settings.schemeFavorites : []);
    const yours = customSchemeCatalogue(customRecords);
    const ids = availableSchemeIds(customRecords);
    const customById = new Map(yours.map((entry) => [entry.id, entry]));
    favoritesSummary.textContent = settingsFavoritesSummary(favorites.size, ids.length);
    favoritesHelp.textContent = settingsFavoritesHelp(favorites.size, settings.schemeRotate);
    const favoriteButton = (scheme) => {
      const on = favorites.has(scheme);
      const custom = customById.get(scheme);
      const label = custom?.label ?? SCHEME_LABELS[scheme] ?? scheme;
      const accent = custom?.accent ?? SCHEME_ACCENTS[scheme];
      return el("button", {
        type: "button",
        class: `scheme-favorite${on ? " on" : ""}`,
        title: label,
        "aria-pressed": String(on),
        "aria-label": settingsFavoriteAria(on, label),
        onclick: async () => {
          const next = new Set(Array.isArray(settings.schemeFavorites) ? settings.schemeFavorites : []);
          if (next.has(scheme)) next.delete(scheme); else next.add(scheme);
          await update({ schemeFavorites: ids.filter((id) => next.has(id)) });
          renderFavorites();
        }
      },
      el("span", { class: "scheme-star", "aria-hidden": "true" }, on ? "★" : "☆"),
      el("span", { class: "scheme-swatch", style: `background:${accent}` }),
      el("span", { class: "scheme-favorite-label" }, label));
    };
    favoritesGrid.replaceChildren(
      ...SCHEME_GROUPS.map((group) => el("section", {
        class: "scheme-category", "aria-label": settingsSchemeGroupLabel(group.defaultMode, group.tone),
        "data-default-mode": group.defaultMode, "data-tone": group.tone
      },
      el("div", { class: "scheme-category-label" }, settingsSchemeGroupLabel(group.defaultMode, group.tone)),
      el("div", { class: "scheme-category-options" },
        ...group.ids.filter((id) => ids.includes(id)).map(favoriteButton)))),
      ...(yours.length ? [el("section", {
        class: "scheme-category scheme-category-yours", "aria-label": settingsStatic.yours()
      },
      el("div", { class: "scheme-category-label" }, settingsStatic.yours()),
      el("div", { class: "scheme-category-options" },
        ...yours.map(({ id }) => favoriteButton(id))))] : [])
    );
  };
  favoritesDetails.append(favoritesSummary, favoritesHelp, favoritesGrid);
  renderFavorites();
  syncers.push(renderFavorites);

  const customSchemeSettings = createCustomSchemeSettings({
    records: customRecords,
    selectedScheme: () => settings.uiScheme,
    applyScheme: (selection) => update({ uiScheme: selection }),
    onChanged: () => refresh()
  });

  const localizedRow = (id, ...controls) => {
    const copy = settingsRowCopy(id, id === "colorScheme" ? [SCHEMES.length] : []);
    return row(copy.title, copy.description, ...controls);
  };
  const localizedStackedRow = (id, ...controls) => {
    const copy = settingsRowCopy(id);
    return stackedRow(copy.title, copy.description, ...controls);
  };

  const groupNodes = [
    group("appearance",
      localizedRow("colorScheme", schemeSelect),
      localizedRow("mode", select("uiMode", settingsOptions("mode"))),
      localizedRow("rotation", select("schemeRotate", settingsOptions("rotation"))),
      favoritesDetails,
      customSchemeSettings.element,
      localizedRow("backgroundGradient", check("uiGradient")),
      localizedRow("sectionDescriptions", check("uiSectionIntros")),
      localizedRow("checkboxShape", select("uiCheckboxShape", settingsOptions("checkbox"))),
      localizedRow("cornerStyle", select("uiCornerStyle", settingsOptions("corners"))),
      localizedRow("rowInformation", select("uiRowInfo", settingsOptions("rowInfo"))),
      localizedRow("rowActionLabels", select("uiActionLabels", settingsOptions("actionLabels")))),

    group("newtab",
      localizedRow("newTabPage", select("newTabMode", settingsOptions("newTabMode"))),
      localizedRow("newTabFocus", select("newTabFocus", settingsOptions("newTabFocus"))),
      localizedRow("oneNewTab", check("oneNewTabPerWindow"))),

    buildFocusGroup(),

    group("autosave",
      localizedRow("autoSaveAfter", automation.autoSaveAfter),
      localizedRow("maxTabsOpen", automation.maxTabsOpen),
      localizedStackedRow("keepTabsOpen", whitelist),
      localizedRow("inboxExpiry", automation.inboxExpiry)),

    group("suspension",
      localizedRow("suspendAfter", automation.suspendAfter),
      localizedRow("suspendMinTabs", automation.suspendMinTabs),
      localizedRow("suspendMaxTabs", automation.suspendMaxTabs),
      localizedStackedRow("neverSuspend", suspendWhitelist),
      localizedRow("suspendPage", check("suspendLazyReload"))),

    group("sessions",
      preserveGroupsRow(),
      localizedRow("snapshotEvery", automation.snapshotEvery),
      localizedRow("snapshotsKeep", automation.snapshotsKeep)),

    group("duplicates",
      localizedRow("autoCloseDuplicates", check("dedupAutoClose"))),

    group("privacy",
      historyAccessRow()),

    group("intro",
      localizedRow("replayIntro",
        el("button", { onclick: async () => {
          const { replayOnboarding } = await import("./onboarding.js");
          await replayOnboarding();
        } }, settingsStatic.replayIntro())),
      localizedRow("openHelp",
        el("button", { type: "button", onclick: async () => {
          const { openHelp } = await import("./onboarding.js");
          openHelp();
        } }, settingsStatic.openHelp()))),

    keyboardGroup
  ];

  // Filter box + jump nav.
  const filterInput = el("input", {
    type: "search", class: "settings-filter",
    placeholder: settingsStatic.filterPlaceholder(), "aria-label": settingsStatic.filterAria()
  });
  const nav = el("div", { class: "settings-nav" });
  const navChips = new Map();
  for (const g of groups) {
    const chip = el("button", {
      type: "button", class: "settings-nav-chip",
      title: settingsStatic.jumpTo(g.title),
      // D4-4: instant, like every other programmatic jump in the product. A JS
      // `behavior: "smooth"` argument beats the global reduced-motion CSS rule,
      // so this was the one piece of motion that ignored the user's preference.
      onclick: () => document.getElementById(g.id)?.scrollIntoView({ behavior: "auto", block: "start" })
    }, g.title);
    navChips.set(g, chip);
    nav.append(chip);
  }
  const noMatch = el("p", { class: "settings-hint", style: "display:none" }, settingsStatic.noMatch());

  function applyFilter() {
    const q = filterInput.value.trim().toLowerCase();
    let anyGroup = false;
    for (const g of groups) {
      const rows = [...g.node.querySelectorAll(".setrow, .custom-schemes")];
      const titleMatch = g.title.toLowerCase().includes(q);
      let anyRow = false;
      for (const r of rows) {
        const show = !q || titleMatch || r.textContent.toLowerCase().includes(q);
        r.style.display = show ? "" : "none";
        if (show) anyRow = true;
      }
      // A group with no rows (e.g. the shortcuts list) shows when its text matches.
      const visible = !q || titleMatch || anyRow || (rows.length === 0 && g.node.textContent.toLowerCase().includes(q));
      g.node.style.display = visible ? "" : "none";
      navChips.get(g).hidden = !visible;
      if (visible) anyGroup = true;
    }
    nav.hidden = !anyGroup;
    noMatch.style.display = anyGroup ? "none" : "";
  }
  filterInput.addEventListener("input", applyFilter);

  const toolbar = el("div", { class: "settings-toolbar section-local-sticky" }, filterInput, nav);
  container.append(
    toolbar,
    ...groupNodes,
    noMatch,
    saved
  );
  // The chip row can gain lines at narrow widths. Publish its actual height so
  // a jump scrolls the group heading fully below this local sticky strip.
  const measureToolbar = () => {
    document.documentElement.style.setProperty("--settings-toolbar-h", `${toolbar.getBoundingClientRect().height}px`);
  };
  measureToolbar();
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(measureToolbar).observe(toolbar);

  // N18: the live browser-command bindings live under Keyboard shortcuts (async).
  renderBrowserCommands().then((node) => keyboardGroup.append(node));

  // Single source of truth: when the stored settings change from anywhere
  // (the sidebar quick-theme picker, another open tab), pull the fresh value
  // and re-apply every control. Our own saves re-enter here harmlessly — the
  // values already match, so the syncers are a no-op.
  let refreshTail = Promise.resolve();
  function refresh() {
    // A local write and its storage.onChanged delivery can request the same
    // refresh together. Serialize them so a later pass cannot replace the row
    // a completed action just focused or announced.
    refreshTail = refreshTail.then(async () => {
      [settings, customRecords] = await Promise.all([
        getSettings(), listItems(STORE_KEYS.customSchemes)
      ]);
      for (const sync of syncers) sync();
      customSchemeSettings.refresh(customRecords);
    });
    return refreshTail;
  }
  if (listenStorage) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || (!changes.settings && !changes[STORE_KEYS.customSchemes])) return;
      void refresh();
    });
  }
  return { refresh };
}
