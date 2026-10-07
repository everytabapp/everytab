// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "../lib/failure-diagnostic.js";
/** One protection picker shared by the popup and live-tab row actions. */
import { el } from "./dom.js";
import { msg, formatNumber } from "../lib/i18n.js";
import { formatRemaining } from "../lib/focus-copy.js";
import { canonicalUrlOf } from "../lib/tabs.js";
import {
  readProtectionStatus, setProtection, setProtections, removeProtection
} from "../lib/automation-protection.js";

/** Resolve an expiring display layer without hiding a permanent rule below it. */
export function currentProtection(status, now = Date.now()) {
  while (status?.protected && status.expiresAt != null && status.expiresAt <= now && status.afterExpiry) {
    status = status.afterExpiry;
  }
  return status;
}

export function protectionStatusText(status, now = Date.now()) {
  status = currentProtection(status, now);
  if (status?.kind === "expired") return msg("protection_expired");
  if (!status?.protected) return "";
  if (status.expiresAt) return msg("protection_time_left", [formatRemaining(status.expiresAt, now)]);
  return msg(status.kind === "site" ? "protection_website_protected" : "protection_protected");
}

export function buildProtectionPanel(target, { close, onChanged = () => {}, openSettings },
  service = {
    read: readProtectionStatus, set: setProtection, setMany: setProtections,
    remove: removeProtection, queryWindow: (windowId) => chrome.tabs.query({ windowId })
  }) {
  const windowTarget = typeof target === "object";
  const tabId = windowTarget ? null : target;
  const panel = el("div", { class: "palette-form protection-options", "aria-busy": "true" },
    el("p", { class: "palette-help", role: "status" }, msg("protection_loading")));
  let status;
  let targets = [];
  let pending = false;
  const feedback = el("p", { class: "palette-help", role: "alert", hidden: true });
  const change = async (scope, duration) => {
    if (pending) return;
    pending = true;
    panel.setAttribute("aria-busy", "true");
    for (const button of panel.querySelectorAll("button")) button.disabled = true;
    try {
      feedback.hidden = true;
      const result = scope === "remove" ? await service.remove(tabId, status)
        : windowTarget ? await service.setMany(targets, scope, duration)
          : await service.set(tabId, scope, duration, { url: status.url, hostname: status.hostname });
      if (result?.ok === false) throw new Error("Protection change rejected");
      const next = windowTarget ? result : await service.read(tabId);
      close({ restore: true });
      await onChanged(next);
    } catch (error) {
      reportFailure("automation protection update", error);
      feedback.textContent = msg("protection_failed");
      feedback.hidden = false;
    } finally {
      pending = false;
      panel.setAttribute("aria-busy", "false");
      for (const button of panel.querySelectorAll("button")) button.disabled = false;
    }
  };
  const scopeRow = (scope, title, detail) => el("div", {
    class: "protection-scope", role: "group", "aria-label": title
  }, el("div", { class: "protection-scope-copy" }, el("strong", {}, title),
    el("p", { class: `palette-help${scope === "page" && !windowTarget ? " protection-page-address" : ""}`, title: detail }, detail)),
  el("div", { class: "protection-durations" }, ...["day", "always"].map((duration) => {
    const label = msg(duration === "day" ? "protection_duration_day" :
      scope === "tab" ? "protection_duration_tab" : "protection_duration_always");
    return el("button", {
      type: "button", class: "protection-choice", "data-scope": scope, "data-duration": duration,
      "aria-label": `${title}: ${label}`, onclick: () => change(scope, duration)
    }, label);
  })));
  const readTarget = async () => {
    if (!windowTarget) return service.read(tabId);
    const tabs = target.tabs ?? await service.queryWindow(target.windowId);
    targets = tabs.flatMap((tab) => {
      if (!Number.isInteger(tab.id) || tab.incognito) return [];
      try {
        const url = new URL(canonicalUrlOf(tab));
        return /^https?:$/.test(url.protocol)
          ? [{ tabId: tab.id, url: url.href, hostname: url.hostname.toLowerCase() }] : [];
      } catch { return []; }
    });
    return { protected: false, kind: "none" };
  };
  void readTarget().then((value) => {
    status = value;
    const summary = protectionStatusText(status);
    const detail = status.protected
      ? status.kind === "tab" ? msg("protection_tab_detail")
        : ["site", "temporary-site"].includes(status.kind) ? msg("protection_site_detail", [status.siteHostname ?? status.hostname])
          : status.kind === "rule" ? msg("protection_rule_detail", [status.rule ?? ""])
            : msg("protection_page_detail")
      : "";
    panel.replaceChildren(...[
      status.protected && summary ? el("div", { class: "protection-current", role: "status" },
        el("strong", {}, msg("protection_current")),
        el("p", { class: "palette-help" }, summary),
        detail ? el("p", { class: "palette-help" }, detail) : null) :
        summary ? el("p", { class: "palette-help", role: "status" }, summary) : null,
      windowTarget ? el("p", { class: "palette-help" },
        msg(targets.length ? (target.tabs ? "protection_selected_scope" : "protection_window_scope")
          : "protection_window_empty", [formatNumber(targets.length)])) : null,
      status.hostname || targets.length ? el("div", { class: "protection-scope-list" },
        scopeRow("tab", msg(windowTarget ? "protection_scope_tabs" : "protection_scope_tab"),
          msg("protection_tab_scope_detail")),
        scopeRow("site", msg(windowTarget ? "protection_scope_domains" : "protection_scope_domain"),
          windowTarget ? msg("protection_domain_count", [formatNumber(new Set(targets.map((item) => item.hostname)).size)])
            : msg("protection_site_detail", [status.hostname])),
        scopeRow("page", msg(windowTarget ? "protection_scope_pages" : "protection_scope_page"),
          windowTarget ? msg("protection_page_count", [formatNumber(new Set(targets.map((item) => item.url)).size)])
            : status.url)) : null,
      status.protected && status.kind !== "rule"
        ? el("button", { type: "button", class: "quiet", onclick: () => change("remove") },
          msg(["site", "temporary-site"].includes(status.kind) ? "protection_remove_site" : "protection_remove")) : null,
      el("button", { type: "button", class: "quiet", onclick: () => {
        close(); openSettings();
      } }, msg("protection_manage")), feedback
    ].filter(Boolean));
    panel.setAttribute("aria-busy", "false");
    const popover = panel.closest(".action-popover");
    if (popover?.querySelector(".action-popover-close") === document.activeElement) {
      panel.querySelector("button")?.focus({ preventScroll: true });
    }
  }).catch((error) => {
    reportFailure("automation protection read", error);
    panel.replaceChildren(el("p", { class: "palette-help", role: "alert" }, msg("protection_failed")));
    panel.setAttribute("aria-busy", "false");
  });
  return panel;
}
