// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * P11-17r: shared temporary-access countdown and repeatable extension control.
 *
 * State remains worker-owned. Surfaces read one trusted status message and send one
 * stale-safe command containing the exact boundary they rendered. The panel is a flat
 * status band, not a chip/card, and its second-level countdown is never an aria-live
 * region. Only deliberate Add 5 minute results are announced.
 */
import { el, coalesce } from "./dom.js";
import { withPending } from "./pending.js";
import { formatNumber, msg } from "../lib/i18n.js";

async function sendGuard(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** Read the live temporary-access rows without exposing message plumbing to hosts. */
export async function getFocusAccessStatus() {
  const result = await sendGuard({ type: "focus-guard-status" });
  return { accesses: result?.status?.accesses ?? [] };
}

/** Repeatedly callable, stale-safe five-minute extension for one rendered boundary. */
export function extendFocusAccess(domain, expectedExpiresAt) {
  return sendGuard({
    type: "focus-guard-extend-access",
    domain,
    expectedExpiresAt
  });
}

/** End a rendered domain grant now; the worker owns revocation and re-guarding. */
export function stopFocusAccess(domain, expectedExpiresAt) {
  return sendGuard({
    type: "focus-guard-stop-access",
    domain,
    expectedExpiresAt
  });
}

/** Calm exact countdown for a temporary-access boundary. */
export function formatAccessRemaining(expiresAt, now = Date.now()) {
  const seconds = Math.max(0, Math.ceil((Number(expiresAt) - Number(now)) / 1000));
  if (!Number.isFinite(seconds) || seconds <= 0) return msg("focus_access_time_ended");
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const clock = h > 0
    ? `${formatNumber(h, { useGrouping: false })}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${formatNumber(m, { useGrouping: false })}:${String(s).padStart(2, "0")}`;
  return msg("focus_access_time_left", [clock]);
}

/**
 * @param {object} [ctx]
 * @param {string} [ctx.className] host-only placement hook
 * @param {() => void} [ctx.onMeasure] host geometry changed
 * @param {(text:string) => void} [ctx.onNotice] visible failure fallback
 * @param {() => void} [ctx.onEmptied] restore focus when Stop removes the final row
 * @returns {{element:HTMLElement, render:(accesses:any[])=>void, refresh:()=>Promise<unknown>, destroy:()=>void}}
 */
export function createFocusAccessPanel({
  className = "", onMeasure = () => {}, onNotice, onEmptied = () => {}
} = {}) {
  const rows = el("div", { class: "focus-access-rows" });
  const live = el("div", { class: "sr-only", role: "status", "aria-live": "polite" });
  const element = el("div", {
    class: `focus-access hidden${className ? ` ${className}` : ""}`,
    "aria-label": msg("focus_access_panel_aria")
  }, el("span", { class: "focus-access-head" }, msg("focus_access_heading")), rows, live);
  let timer = 0;
  let current = [];

  function announce(text) {
    live.textContent = "";
    requestAnimationFrame(() => { live.textContent = text; });
  }

  function tick() {
    const now = Date.now();
    for (const node of rows.querySelectorAll(".focus-access-time")) {
      node.textContent = formatAccessRemaining(Number(node.dataset.expiresAt), now);
    }
  }

  function render(accesses = current) {
    clearInterval(timer);
    current = Array.isArray(accesses) ? accesses.filter((a) => a?.domain) : [];
    const focusedDomain = element.contains(document.activeElement)
      ? document.activeElement?.dataset?.domain : "";
    const focusedAction = document.activeElement?.classList?.contains("focus-access-stop")
      ? "stop" : "add";
    if (current.length === 0) {
      rows.replaceChildren();
      element.classList.add("hidden");
      onMeasure();
      return;
    }
    element.classList.remove("hidden");
    rows.replaceChildren(...current.map((access) => {
      const time = el("span", {
        class: "focus-access-time",
        "data-expires-at": access.expiresAt
      }, formatAccessRemaining(access.expiresAt));
      const stop = el("button", {
        class: "focus-access-stop",
        type: "button",
        "data-domain": access.domain,
        "aria-label": msg("focus_access_stop_aria", [access.displayDomain || access.domain]),
        onclick: (event) => withPending(event.currentTarget, async () => {
          const rowIndex = current.findIndex((row) => row.domain === access.domain);
          const result = await stopFocusAccess(access.domain, access.expiresAt);
          if (result?.ok) {
            const updated = current.filter((row) => row.domain !== access.domain);
            render(updated);
            announce(msg("focus_access_stopped", [access.displayDomain || access.domain]));
            if (updated.length > 0) {
              const nextIndex = Math.min(Math.max(0, rowIndex), updated.length - 1);
              rows.querySelectorAll(".focus-access-stop")[nextIndex]?.focus();
            } else {
              onEmptied();
            }
            if (result.failedCount > 0) {
              const text = result.failedCount === 1
                ? msg("focus_access_guard_next_one")
                : msg("focus_access_guard_next_other", [formatNumber(result.failedCount)]);
              if (onNotice) onNotice(text); else announce(text);
            }
            return;
          }
          await refresh();
          if (result?.reason !== "stale") {
            const text = msg("focus_access_stop_failed");
            if (onNotice) onNotice(text); else announce(text);
          }
        })
      }, msg("action_stop"));
      const add = el("button", {
        class: "focus-access-add",
        type: "button",
        "data-domain": access.domain,
        "aria-label": msg("focus_access_add_aria", [access.displayDomain || access.domain]),
        onclick: (event) => withPending(event.currentTarget, async () => {
          const result = await extendFocusAccess(access.domain, access.expiresAt);
          if (result?.ok) {
            const updated = current.map((row) => row.domain === access.domain
              ? { ...row, expiresAt: result.expiresAt, expired: false, deferred: false }
              : row);
            render(updated);
            announce(msg("focus_access_added", [access.displayDomain || access.domain]));
            return;
          }
          await refresh();
          if (result?.reason !== "stale") {
            const text = msg("focus_access_extend_failed");
            if (onNotice) onNotice(text); else announce(text);
          }
        })
      }, msg("focus_access_add_five"));
      return el("div", { class: "focus-access-row" },
        el("span", { class: "focus-access-domain", title: access.displayDomain || access.domain },
          access.displayDomain || access.domain),
        time,
        el("span", { class: "focus-access-actions" }, stop, add));
    }));
    tick();
    timer = setInterval(tick, 1000);
    if (focusedDomain) {
      rows.querySelector(`.focus-access-${focusedAction}[data-domain="${CSS.escape(focusedDomain)}"]`)?.focus();
    }
    onMeasure();
  }

  const refresh = coalesce(async () => {
    const status = await getFocusAccessStatus();
    render(status.accesses);
  });
  const destroy = () => clearInterval(timer);
  return { element, render, refresh, destroy };
}
