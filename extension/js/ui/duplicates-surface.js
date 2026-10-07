// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { findDuplicateGroupsFromTabs } from "../lib/dedup.js";
import {
  normalizeDuplicateDomainRules, normalizeDuplicateHostname
} from "../lib/duplicate-domain-rules.js";
import { msg as localeMessage, formatNumber } from "../lib/i18n.js";
import { canonicalUrlOf } from "../lib/tabs.js";
import { createDisplayTabReads } from "./display-tab-reads.js";
import { el, coalesceLatest } from "./dom.js";
import { icon } from "./icons.js";
import { createAnchoredPanel, createTabList, fromDuplicateGroups } from "./tablist.js";
import { shellSectionCountTitle } from "./shell-copy.js";

/** Mirrors the survivor order in findDuplicateGroups. Resolved per call so the
 * module can load before Chrome's message catalogue is available. */
export const duplicateKeepRule = () => localeMessage("duplicate_keep_rule");

export const duplicateAddressLabel = () => localeMessage("duplicate_same_address");

/** Only explain Chrome's title lag when the visible row titles actually differ. */
export function duplicateTitleNote(group) {
  return group?.data?.chromeTitlesDiffer ? localeMessage("duplicate_title_note") : null;
}

/** Exact hostname represented by a duplicate card. */
export function duplicateGroupHostname(group) {
  return normalizeDuplicateHostname(
    group?.data?.canonicalUrl ?? group?.data?.key ?? group?.refs?.[0]?.url ?? ""
  );
}

/** Return a normalized rule list with one exact-host choice replaced. */
export function withDuplicateRule(rules, hostname, mode) {
  return normalizeDuplicateDomainRules([
    ...normalizeDuplicateDomainRules(rules).filter((rule) => rule.hostname !== hostname),
    { hostname, mode }
  ]);
}

/** Present the canonical identity as quiet, truncation-safe context. */
export function duplicateIdentityBanner(group, onRule = null) {
  const address = String(group?.data?.canonicalUrl ?? group?.data?.key ?? "");
  const note = duplicateTitleNote(group);
  const hostname = duplicateGroupHostname(group);
  return el("div", { class: "dup-identity" },
    el("span", { class: "dup-identity-label" }, duplicateAddressLabel()),
    el("span", { class: "dup-identity-url", title: address }, address),
    note ? el("span", { class: "dup-title-note" }, note) : null,
    typeof onRule === "function" && hostname
      ? el("button", {
        class: "dup-rule-trigger quiet",
        type: "button",
        onclick: (event) => onRule(group, event.currentTarget)
      }, localeMessage("duplicate_not_same_page"))
      : null);
}

function ruleModeLabel(mode) {
  if (mode === "include-fragment") return localeMessage("duplicate_rule_fragment");
  if (mode === "skip") return localeMessage("duplicate_rule_skip");
  return localeMessage("duplicate_rule_standard");
}

function hostnameOfTab(tab) {
  return normalizeDuplicateHostname(canonicalUrlOf(tab));
}

function samplesForHostname(tabs, hostname) {
  return [...new Set((tabs ?? [])
    .filter((tab) => hostnameOfTab(tab) === hostname)
    .map((tab) => String(canonicalUrlOf(tab)))
    .filter(Boolean))].slice(0, 2);
}

function remainingExtraCopies(tabs, rules, hostname) {
  return findDuplicateGroupsFromTabs(tabs, rules)
    .filter((group) => normalizeDuplicateHostname(group.key) === hostname)
    .reduce((count, group) => count + group.close.length, 0);
}

/** Owns the complete Duplicates scan, presentation, and close actions. */
export function createDuplicatesSurface({ getBody, setHeading, msg, showNotice = () => {} }) {
  const render = coalesceLatest(renderInner);
  const ruleSlot = el("span", { class: "dup-rule-slot", hidden: true });
  const rulePanel = createAnchoredPanel(ruleSlot, {
    copy: (name) => name === "duplicate-rules"
      ? {
        title: localeMessage("duplicate_matching_rules"),
        description: localeMessage("duplicate_matching_rules_description"),
        icon: "duplicates"
      }
      : {
        title: localeMessage("duplicate_rule_title"),
        description: localeMessage("duplicate_rule_description"),
        icon: "duplicates"
      }
  });

  async function saveRule(hostname, mode) {
    try {
      const result = await msg({ type: "set-duplicate-domain-rule", hostname, mode });
      if (result?.ok === false) throw new Error("rule update failed");
      rulePanel.close();
      await render();
      return true;
    } catch {
      showNotice(localeMessage("duplicate_rule_failed"));
      return false;
    }
  }

  function ruleEditor(hostname, currentMode, tabs, rules) {
    let mode = currentMode ?? "standard";
    const choices = el("div", {
      class: "dup-rule-choices",
      role: "group",
      "aria-label": localeMessage("duplicate_rule_question", [hostname])
    });
    const preview = el("p", { class: "palette-help dup-rule-preview" });
    const feedback = el("p", { class: "dup-rule-feedback", hidden: true },
      localeMessage("duplicate_rule_failed"));
    const choiceCopy = [
      ["standard", "duplicate_rule_standard", "duplicate_rule_standard_detail"],
      ["include-fragment", "duplicate_rule_fragment", "duplicate_rule_fragment_detail"],
      ["skip", "duplicate_rule_skip", "duplicate_rule_skip_detail"]
    ];
    const buttons = choiceCopy.map(([value, labelKey, detailKey]) => el("button", {
      class: "dup-rule-choice",
      type: "button",
      "data-rule-mode": value,
      "aria-pressed": String(mode === value),
      onclick: () => {
        mode = value;
        for (const button of buttons) {
          button.setAttribute("aria-pressed", String(button.dataset.ruleMode === mode));
        }
        updatePreview();
      }
    }, el("strong", {}, localeMessage(labelKey)),
    el("span", {}, localeMessage(detailKey))));
    choices.append(...buttons);

    function updatePreview() {
      const candidate = withDuplicateRule(rules, hostname, mode);
      preview.textContent = localeMessage("duplicate_rule_preview", [
        formatNumber(remainingExtraCopies(tabs, candidate, hostname))
      ]);
    }
    updatePreview();

    const samples = samplesForHostname(tabs, hostname);
    return el("div", { class: "palette-form dup-rule-editor" },
      el("p", { class: "dup-rule-domain" },
        localeMessage("duplicate_rule_question", [hostname])),
      choices,
      samples.length
        ? el("div", { class: "dup-rule-samples" },
          el("span", { class: "palette-field-label" }, localeMessage("duplicate_rule_samples")),
          ...samples.map((url) => el("code", { title: url }, url)))
        : null,
      preview,
      feedback,
      el("div", { class: "dup-rule-form-actions" },
        el("button", {
          class: "quiet", type: "button", onclick: () => rulePanel.close({ restore: true })
        }, localeMessage("duplicate_rule_cancel")),
        el("button", {
          class: "primary", type: "button", onclick: async (event) => {
            event.currentTarget.disabled = true;
            feedback.hidden = true;
            if (!await saveRule(hostname, mode)) {
              event.currentTarget.disabled = false;
              feedback.hidden = false;
            }
          }
        }, localeMessage("duplicate_rule_save"))));
  }

  function openRuleEditor(hostname, anchor, tabs, rules) {
    const current = normalizeDuplicateDomainRules(rules)
      .find((rule) => rule.hostname === hostname)?.mode ?? "standard";
    rulePanel.anchor(anchor);
    rulePanel.toggle(() => ruleEditor(hostname, current, tabs, rules),
      `duplicate-rule:${hostname}`);
  }

  function rulesPanel(tabs, rules) {
    const normalized = normalizeDuplicateDomainRules(rules);
    const root = el("div", { class: "palette-form dup-rules-manager" });
    if (!normalized.length) {
      root.append(el("p", { class: "palette-help" }, localeMessage("duplicate_rules_empty")));
      return root;
    }
    root.append(el("div", { class: "dup-rule-list" }, ...normalized.map((rule) => {
      const row = el("div", { class: "dup-rule-row" },
        el("div", { class: "dup-rule-row-copy" },
          el("strong", {}, rule.hostname),
          el("span", {}, ruleModeLabel(rule.mode))),
        el("div", { class: "dup-rule-row-actions" }));
      const actions = row.querySelector(".dup-rule-row-actions");
      actions.append(
        el("button", {
          class: "quiet", type: "button", onclick: () => {
            root.replaceChildren(ruleEditor(rule.hostname, rule.mode, tabs, rules));
          }
        }, localeMessage("duplicate_rule_change")),
        el("button", {
          class: "quiet", type: "button", onclick: async (event) => {
            event.currentTarget.disabled = true;
            if (!await saveRule(rule.hostname, "standard")) event.currentTarget.disabled = false;
          }
        }, localeMessage("duplicate_rule_remove"))
      );
      return row;
    })));
    return root;
  }

  async function renderInner(reads = createDisplayTabReads()) {
    const [groups, tabs, rules, windows] = await Promise.all([
      reads.groups(), reads.tabs(), reads.rules(),
      chrome.windows.getAll({ windowTypes: ["normal"] })
    ]);
    const total = groups.reduce((count, group) => count + group.close.length, 0);
    setHeading(shellSectionCountTitle("duplicates", total));
    const windowNumber = new Map(windows.map((window, index) => [window.id, index + 1]));
    const listGroups = fromDuplicateGroups(groups);

    const matchingRules = el("button", {
      class: "quiet", type: "button",
      onclick: (event) => {
        rulePanel.anchor(event.currentTarget);
        rulePanel.toggle(() => rulesPanel(tabs, rules), "duplicate-rules");
      }
    }, localeMessage("duplicate_matching_rules"));

    getBody().replaceChildren(createTabList({
      section: "duplicates",
      foldable: true,
      groups: listGroups,
      selectable: "none",
      onChange: () => render(),
      empty: localeMessage("duplicate_empty"),
      toolbar: el("div", { class: "dup-toolbar" },
        el("div", { class: "dup-toolbar-copy" },
          el("strong", {}, total === 0
            ? localeMessage("duplicate_all_unique")
            : localeMessage("duplicate_summary", [
              total === 1
                ? localeMessage("duplicate_extra_copies_one", [formatNumber(total)])
                : localeMessage("duplicate_extra_copies_other", [formatNumber(total)]),
              listGroups.length === 1
                ? localeMessage("duplicate_pages_one", [formatNumber(listGroups.length)])
                : localeMessage("duplicate_pages_other", [formatNumber(listGroups.length)])
            ])),
          el("span", {}, duplicateKeepRule())),
        el("div", { class: "dup-toolbar-acts" },
          matchingRules,
          el("button", {
            class: "quiet", title: localeMessage("duplicate_rescan_title"), onclick: () => render()
          },
          el("span", { class: "action-icon" }, icon("refresh", 14)),
          el("span", {}, localeMessage("duplicate_rescan"))),
          total > 0
            ? el("button", {
              class: "danger",
              title: localeMessage("duplicate_close_all_title"),
              onclick: async () => {
                await msg({ type: "close-duplicates" });
                await render();
              }
            }, total === 1
              ? localeMessage("duplicate_close_all_one", [formatNumber(total)])
              : localeMessage("duplicate_close_all_other", [formatNumber(total)]))
            : null),
        ruleSlot),
      rowOpen: (ctx) => msg({
        type: "focus-tab", tabId: ctx.live.id, windowId: ctx.live.windowId
      }),
      groupBanner: (group) => duplicateIdentityBanner(group, (selected, anchor) =>
        openRuleEditor(duplicateGroupHostname(selected), anchor, tabs, rules)),
      rowMeta: (_ref, group, index) => {
        const tab = group.live[index];
        const role = tab.id === group.data.keepId
          ? localeMessage("duplicate_role_kept")
          : tab.pinned ? localeMessage("duplicate_role_pinned") : localeMessage("duplicate_role_extra");
        return localeMessage("duplicate_row_meta", [formatNumber((tab.index ?? 0) + 1), role]);
      },
      rowBadges: (ctx) => {
        const windowLabel = windowNumber.get(ctx.live.windowId) ?? "?";
        const isKeep = ctx.live.id === ctx.group.data.keepId;
        return [
          isKeep
            ? el("span", { class: "dup-role", title: duplicateKeepRule() }, localeMessage("duplicate_badge_keep"))
            : null,
          el("span", { class: "dup-window", title: localeMessage("duplicate_window_title", [String(windowLabel)]) },
            localeMessage("duplicate_window_badge", [String(windowLabel)]))
        ].filter(Boolean);
      },
      rowActions: [
        {
          id: "switch", label: localeMessage("duplicate_action_switch"), icon: "switch", key: "r", hidden: true,
          run: (ctx) => msg({
            type: "focus-tab", tabId: ctx.live.id, windowId: ctx.live.windowId
          })
        },
        {
          id: "close", label: localeMessage("duplicate_action_close"), glyph: "×", danger: true, key: "d",
          when: (ctx) => ctx.group.data.closeIds.has(ctx.live.id),
          run: async (ctx) => {
            await msg({ type: "close-duplicates", tabId: ctx.live.id });
            await render();
          }
        }
      ],
      groupActions: [{
        id: "close-extras", label: localeMessage("duplicate_action_close_extras"), danger: true, key: "d",
        run: async (ctx) => {
          await msg({ type: "close-duplicates", key: ctx.group.data.key });
          await render();
        }
      }]
    }));
  }

  return { render };
}
