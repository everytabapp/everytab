// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Shared, document-local presentation for automation awareness.
 * Policy data is projected before it reaches this module; this file owns only
 * copy, the inline trigger, one explanation surface, and one coarse timer.
 */
import { el } from "./dom.js";
import { formatNumber, msg } from "../lib/i18n.js";
import { settingsDurationLabel } from "./settings-copy.js";
import { createAnchoredPanel } from "./tablist.js";
import { icon } from "./icons.js";
import { currentProtection } from "./automation-protection.js";

const MINUTE_MS = 60_000;

const longDuration = (ms) => settingsDurationLabel(
  Math.max(1, Math.floor(Number(ms) / MINUTE_MS)), "auto"
);
function shortDuration(ms) {
  const minutes = Math.max(1, Math.floor(ms / MINUTE_MS));
  const unit = minutes % 1440 === 0 ? "day" : minutes % 60 === 0 ? "hour" : "minute";
  const value = minutes / (unit === "day" ? 1440 : unit === "hour" ? 60 : 1);
  return formatNumber(value, { style: "unit", unit, unitDisplay: "narrow" });
}

function projectedNow(view, now) {
  if (view?.protection) view = { ...view, protection: currentProtection(view.protection, now) };
  if (view?.display !== "timed" || !Number.isFinite(view.awayAt)) return view;
  const awayMs = Math.max(0, now - view.awayAt);
  return {
    ...view,
    awayMs,
    state: awayMs >= view.afterMs ? "due" : "running",
    progress: Math.max(0, Math.min(1, awayMs / view.afterMs))
  };
}

function copyFor(view, now) {
  const protection = view.protection;
  if (protection?.kind === "expired" ||
      (protection?.expiresAt && protection.expiresAt <= now)) {
    return { status: msg("protection_expired"), detail: msg("protection_expired_detail"), caveat: "" };
  }
  const copy = policyCopyFor(view, now);
  if (!protection?.protected || view.reason === "automation-protected") return copy;
  return {
    ...copy, status: msg("awareness_state_protected", [copy.status]),
    shortStatus: msg("awareness_state_protected", [copy.shortStatus ?? copy.status]),
    detail: `${copy.detail} ${msg("awareness_protected_detail")}`
  };
}

function policyCopyFor(view, now) {
  if (view.kind === "inbox") {
    if (view.display === "unknown") return {
      status: msg("awareness_inbox_date_unknown"),
      detail: msg("awareness_inbox_date_unknown_detail"),
      caveat: ""
    };
    const after = longDuration(view.afterMs);
    return {
      status: msg("awareness_inbox_rule", [after]),
      shortStatus: msg("awareness_inbox_rule", [shortDuration(view.afterMs)]),
      detail: msg("awareness_inbox_detail", [after]),
      caveat: msg("awareness_timing_caveat")
    };
  }

  const current = projectedNow(view, now);
  const action = current.action;
  if (current.display === "timed") {
    const after = longDuration(current.afterMs);
    const status = msg(action === "suspend"
      ? "awareness_suspend_after"
      : "awareness_autosave_after", [after]);
    const detail = current.state === "due"
      ? msg(action === "suspend" ? "awareness_suspend_due" : "awareness_autosave_due", [after])
      : msg(action === "suspend" ? "awareness_suspend_running" : "awareness_autosave_running",
        [longDuration(current.awayMs), after]);
    const shortStatus = msg(action === "suspend"
      ? "awareness_suspend_after" : "awareness_autosave_after", [shortDuration(current.afterMs)]);
    return { status, shortStatus, detail, caveat: msg("awareness_timing_caveat") };
  }
  if (current.state === "active") return {
    status: msg("awareness_active"), detail: msg("awareness_active_detail"), caveat: ""
  };
  if (current.state === "unknown") return {
    status: msg("awareness_time_unknown"), detail: msg("awareness_time_unknown_detail"), caveat: ""
  };
  if (current.state === "minimum-count") return {
    status: msg("awareness_suspend_minimum", [String(current.limit ?? 0)]),
    detail: msg("awareness_suspend_minimum_detail", [String(current.limit ?? 0)]), caveat: ""
  };
  if (current.state === "count") {
    const awake = current.action === "awake-cap";
    return {
      status: msg(awake ? "awareness_awake_cap" : "awareness_open_cap"),
      detail: msg(awake ? "awareness_awake_cap_detail" : "awareness_open_cap_detail",
        [String(current.limit ?? 0)]), caveat: ""
    };
  }
  const reasons = {
    pinned: ["awareness_pinned", "awareness_pinned_detail"],
    audible: ["awareness_audible", "awareness_audible_detail"],
    grouped: ["awareness_grouped", "awareness_grouped_detail"],
    "automation-protected": ["awareness_protected", "awareness_protected_detail"]
  };
  const [statusKey, detailKey] = reasons[current.reason] ??
    ["awareness_unsupported", "awareness_unsupported_detail"];
  return {
    status: msg(statusKey),
    detail: msg(detailKey),
    caveat: ""
  };
}

/**
 * @param {{openSettings:(group:"suspension"|"autosave"|"protection")=>void,
 *   now?:()=>number, schedule?:typeof setTimeout, cancel?:typeof clearTimeout}} options
 */
export function createAutomationAwareness(options) {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  const views = new WeakMap();
  const rowNodes = new Map();
  const inboxNodes = new Map();
  const continuityTokens = new WeakMap();
  let rowRevealSnapshot = null;
  const slot = el("div", { hidden: true });
  document.body.append(slot);
  let source = null;
  let details = null;
  let refreshTimer = 0;
  let closed = false;
  const picker = createAnchoredPanel(slot, {
    copy: () => ({
      title: copyFor(views.get(source), now()).status,
      description: "",
      icon: views.get(source)?.kind === "inbox" ? "archive" : "settings"
    })
  });

  function visible(node) {
    return node.isConnected && node.getClientRects().length > 0;
  }

  function paint(node) {
    const base = views.get(node);
    if (!base) return;
    const view = projectedNow(base, now());
    views.set(node, view);
    const copy = copyFor(view, now());
    node.setAttribute("aria-label", copy.status);
    node.querySelector(".automation-awareness-copy").textContent = copy.shortStatus ?? copy.status;
    node.style.setProperty("--automation-awareness-progress",
      `${Math.round((view.progress ?? 0) * 100)}%`);
    node.classList.toggle("has-meter", view.display === "timed");
    const expired = view.protection?.kind === "expired" ||
      Boolean(view.protection?.expiresAt && view.protection.expiresAt <= now());
    node.classList.toggle("is-protected", Boolean(view.protection?.protected && !expired));
    node.classList.toggle("is-expired", expired);
    const shield = node.querySelector(".automation-awareness-shield");
    if (shield) shield.hidden = !view.protection?.protected || expired;
    if (source === node && details?.isConnected) {
      // The timer updates copy in place, never a focused picker control.
      details.querySelector(".automation-awareness-detail").textContent = copy.detail;
      const heading = details.closest(".action-popover")?.querySelector("[id^='action-popover-title-']");
      if (heading) heading.textContent = copy.status;
    }
  }

  function openDetails(node) {
    if (closed || !visible(node)) return;
    if (source !== node) picker.close();
    source = node;
    paint(node);
    picker.anchor(node);
    picker.toggle(() => {
      const view = views.get(node);
      const copy = copyFor(view, now());
      details = el("div", { class: "palette-form" },
        el("p", { class: "palette-help automation-awareness-detail" }, copy.detail),
        copy.caveat ? el("p", { class: "palette-help" }, copy.caveat) : null,
        view.settingsGroup ? el("button", {
          type: "button", class: "mini2 automation-awareness-manage",
          "data-awareness-settings": view.settingsGroup,
          onclick: () => {
            picker.close();
            options.openSettings(view.settingsGroup);
          }
        }, msg(view.settingsGroup === "protection" ? "protection_manage" :
          view.settingsGroup === "suspension" ? "awareness_manage_suspension" : "awareness_manage_autosave")) : null);
      return details;
    }, "automation");
    scheduleRefresh();
  }

  function bind(node, view) {
    views.set(node, view);
    paint(node);
    node.addEventListener("click", (event) => {
      event.preventDefault();
      openDetails(node);
    });
    return node;
  }

  function revealed(node) {
    if (!node.isConnected || typeof getComputedStyle !== "function" ||
        Number.parseFloat(getComputedStyle(node).opacity) < .5) return false;
    // Match the CSS reveal owners, not residual opacity during a fade-out.
    // Otherwise a refresh after pointer leave restarts the control at opacity 1.
    if (node.classList.contains("automation-awareness-inbox")) {
      const item = node.closest(".item");
      return Boolean(item && (item.matches(":hover") || item.matches(":focus-within") ||
        item.classList.contains("palette-source")));
    }
    const row = node.closest(".trow");
    return node.matches(":focus-visible") || node.classList.contains("is-protected") ||
      node.classList.contains("is-expired") || Boolean(row &&
        (row.matches(":hover") || row.matches(":focus-within") || row.classList.contains("kbd-reveal")));
  }

  /**
   * Build one Open or Inbox list synchronously. Sample every connected cached
   * trigger before list construction paints or reparents any of them;
   * alternating those writes with computed-style reads forces a style recalc
   * of the whole page for each remaining trigger, which is quadratic in the
   * list size (1.2 s per Inbox filter keystroke at 400 saved tabs). Nested
   * builds share the outer snapshot. It never survives this build, even when
   * construction throws, so later renders observe current reveal state.
   * @template T
   * @param {()=>T} build synchronous list construction
   * @returns {T}
   */
  function withRowRender(build) {
    if (rowRevealSnapshot) return build();
    const snapshot = new WeakMap();
    for (const cache of [rowNodes, inboxNodes]) {
      for (const node of cache.values()) snapshot.set(node, revealed(node));
    }
    rowRevealSnapshot = snapshot;
    try { return build(); }
    finally { rowRevealSnapshot = null; }
  }

  function preserveRevealAcrossMount(node, wasRevealed = revealed(node)) {
    const token = {};
    continuityTokens.set(node, token);
    node.classList.add("is-remounting");
    node.classList.toggle("is-rejoining", wasRevealed);
    const frame = typeof requestAnimationFrame === "function" && document.hidden !== true
      ? requestAnimationFrame
      : (callback) => schedule(callback, 16);
    // Reparenting can move a previously hidden control under a stationary
    // pointer. Suppress only its transition during the mount handoff; CSS still
    // decides visibility. Previously revealed controls also keep their existing
    // bridge until the new row owns pointer/focus state again.
    frame(() => frame(() => {
      if (continuityTokens.get(node) !== token) return;
      continuityTokens.delete(node);
      node.classList.remove("is-rejoining", "is-remounting");
    }));
  }

  function cached(cache, identity, view, create) {
    if (identity == null) return bind(create(), view);
    const key = String(identity);
    let node = cache.get(key);
    if (!node) {
      node = bind(create(), view);
      cache.set(key, node);
    } else {
      preserveRevealAcrossMount(node, rowRevealSnapshot
        ? rowRevealSnapshot.get(node) ?? false
        : undefined);
      views.set(node, view);
      paint(node);
    }
    return node;
  }

  function row(view, identity = null) {
    if (!view || view.display === "none") {
      if (identity != null) rowNodes.delete(String(identity));
      return null;
    }
    return cached(rowNodes, identity, { ...view, kind: "open" }, () => el("button", {
      type: "button", class: "automation-awareness automation-awareness-row",
      tabindex: "-1",
      "data-info": "automation", "aria-expanded": "false", "aria-haspopup": "dialog"
    },
    el("span", { class: "automation-awareness-shield", "aria-hidden": "true", hidden: true }, icon("shield", 13)),
    el("span", { class: "automation-awareness-copy" }),
    el("span", { class: "automation-awareness-meter", "aria-hidden": "true" },
      el("span", { class: "automation-awareness-meter-fill" }))));
  }

  function inbox(view, identity = null) {
    if (!view || view.display === "age-only") {
      if (identity != null) inboxNodes.delete(String(identity));
      return null;
    }
    return cached(inboxNodes, identity, { ...view, kind: "inbox" }, () => el("button", {
      type: "button", class: "automation-awareness automation-awareness-inbox",
      tabindex: "-1",
      "data-info": "automation", "aria-expanded": "false", "aria-haspopup": "dialog"
    }, el("span", { class: "automation-awareness-copy" })));
  }

  function clearRefresh() {
    if (refreshTimer) cancel(refreshTimer);
    refreshTimer = 0;
  }

  function scheduleRefresh() {
    clearRefresh();
    if (closed || document.visibilityState === "hidden") return;
    const timed = [...document.querySelectorAll(".automation-awareness-row")]
      .filter((node) => visible(node) && (views.get(node)?.display === "timed" ||
        views.get(node)?.protection?.expiresAt > now()));
    const badges = [...document.querySelectorAll(".automation-protection-badge[data-expires-at]")];
    if (!timed.length && !badges.length) return;
    refreshTimer = schedule(() => {
      for (const node of timed) if (visible(node)) paint(node);
      for (const badge of badges) if (Number(badge.dataset.expiresAt) <= now()) badge.remove();
      scheduleRefresh();
    }, Math.max(250, MINUTE_MS - (now() % MINUTE_MS) + 16));
  }

  function sync() {
    if (closed) return;
    if (source && !visible(source)) picker.close();
    for (const cache of [rowNodes, inboxNodes]) {
      for (const [key, node] of cache) if (!node.isConnected) cache.delete(key);
    }
    scheduleRefresh();
  }

  function onVisibility() {
    if (document.visibilityState === "hidden") picker.close();
    sync();
  }
  document.addEventListener("visibilitychange", onVisibility);

  function close() {
    closed = true;
    picker.close();
    clearRefresh();
    rowNodes.clear();
    inboxNodes.clear();
    slot.remove();
    document.removeEventListener("visibilitychange", onVisibility);
  }

  return { row, inbox, withRowRender, sync, close };
}
