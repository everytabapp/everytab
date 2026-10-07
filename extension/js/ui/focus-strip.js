// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * F14-2b — the shared site-guard Focus strip.
 *
 * F8-R2: one compact strip while a site-guard run is active: mark, "Focus is on",
 * remaining time, guarded-site count, End focus. It never names a window/session
 * and never adds Focus actions to Open tabs or Sessions. Runs come from
 * device-local `focusGuardState`; one polite announcement on a start/stop
 * transition (never a live countdown). Shared so the dashboard and (later) the
 * side panel render the identical strip; surface-specific geometry
 * (`onMeasure` = the dashboard's `measureHero`) and the search input to hand
 * focus back to are injected via `ctx`. DOM composition + `chrome.runtime`
 * messaging only; owns no persisted state.
 */
import { el, coalesce } from "./dom.js";
import { formatRemaining } from "../lib/focus-copy.js";
import { formatNumber, msg } from "../lib/i18n.js";
import { createFocusAccessPanel } from "./focus-access.js";

async function sendGuard(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** Read the shared site-guard status without exposing message plumbing to callers. */
export async function getFocusGuardStatus() {
  const result = await sendGuard({ type: "focus-guard-status" });
  return result?.status ?? { active: false, guardedCount: 0, duringCount: 0, alwaysCount: 0 };
}

/** Start Focus with the saved default or an explicit validated one-run choice. */
export function startFocusGuard(endChoice) {
  return sendGuard({ type: "focus-guard-start", ...(endChoice ? { endChoice } : {}) });
}

/** End the active Focus run from any shared surface. */
export function endFocusGuard() {
  return sendGuard({ type: "focus-guard-end" });
}

/**
 * @param {object} ctx
 * @param {() => (HTMLElement|null|undefined)} ctx.getSearchInput focus returns here
 *   when the strip is about to lose it (on End / on going inactive)
 * @param {() => void} ctx.onMeasure called after each render — the strip changes
 *   the sticky-hero height (dashboard passes `measureHero`)
 * @param {() => (HTMLElement|null|undefined)} [ctx.getLayoutFollower] page content below the strip
 * @param {() => void} [ctx.openBlockedSites] F48: jump to the Blocked sites
 *   editor. Injected because the router is the host's, not the strip's.
 * @returns {{ element: HTMLElement, strip: HTMLElement, announcer: HTMLElement, refresh: () => void }}
 *   F44: the strip reports state and owns no action, so it needs no toast sink.
 */
export function createFocusStrip(ctx) {
  const { getSearchInput, onMeasure, openBlockedSites, getLayoutFollower = () => null } = ctx;
  const strip = el("div", { class: "focus-strip hidden" });
  const layoutInner = el("div", { class: "focus-strip-layout-inner" }, strip);
  const element = el("div", { class: "focus-strip-layout" }, layoutInner);
  const announcer = el("div", { class: "sr-only", role: "status", "aria-live": "polite" });
  const restoreAfterAccess = () => {
    const guarded = strip.querySelector(".fs-counts-link");
    if (guarded) guarded.focus(); else getSearchInput()?.focus();
  };
  const accessPanel = createFocusAccessPanel({ onMeasure, onEmptied: restoreAfterAccess });
  let focusStripTimer = 0;
  let layoutAnimations = [];
  let finishLayout = null;
  let layoutTarget = 0;
  let layoutOpen = false;
  const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
  let focusWasActive = false;

  function announce(text) {
    announcer.textContent = "";
    requestAnimationFrame(() => { announcer.textContent = text; });
  }

  function transitionLayout(open, onSettled = () => {}) {
    const targetHeight = open ? layoutInner.getBoundingClientRect().height : 0;
    if (layoutOpen === open && Math.abs(layoutTarget - targetHeight) <= 0.5) {
      if (!finishLayout) onSettled();
      onMeasure();
      return;
    }
    const follower = getLayoutFollower();
    const beforeTop = follower?.getBoundingClientRect().top;
    const presentation = getComputedStyle(layoutInner);
    const fromOpacity = presentation.opacity;
    const fromClip = presentation.clipPath;
    const wasOpen = layoutOpen;
    const wasMoving = Boolean(finishLayout);
    for (const animation of layoutAnimations) animation.cancel();
    layoutAnimations = [];
    finishLayout = null;
    layoutOpen = open;
    layoutTarget = targetHeight;
    const root = document.documentElement;
    root.classList.add("focus-layout-transition");
    element.classList.toggle("is-open", open);
    // Publish the final height once. Every sticky offset now reads the same
    // settled geometry; only the native-size presentation moves between frames.
    root.style.setProperty("--focus-layout-h", `${targetHeight}px`);
    element.style.overflow = "visible";
    onMeasure();
    const delta = follower && Number.isFinite(beforeTop)
      ? beforeTop - follower.getBoundingClientRect().top : 0;
    const finish = () => {
      if (finishLayout !== finish) return;
      finishLayout = null;
      for (const animation of layoutAnimations) animation.cancel();
      layoutAnimations = [];
      element.style.removeProperty("overflow");
      root.classList.remove("focus-layout-transition");
      onSettled();
      onMeasure();
    };
    finishLayout = finish;
    if (reduced?.matches || typeof layoutInner.animate !== "function" ||
        !element.isConnected || document.visibilityState === "hidden") {
      finish();
      return;
    }
    const style = getComputedStyle(element);
    const token = open ? "--motion-continuity" : "--motion-reveal";
    const configured = Number.parseFloat(style.getPropertyValue(token));
    const duration = Number.isFinite(configured) && configured >= 0 ? configured : open ? 180 : 140;
    const easing = style.getPropertyValue("--ease-out").trim() || "cubic-bezier(.2,.8,.2,1)";
    // Opening/closing clips one complete band, including its material. A data
    // refresh with the same target never restarts this effect or its follower.
    const visual = layoutInner.animate([
      { opacity: wasMoving ? fromOpacity : wasOpen ? 1 : 0,
        clipPath: wasMoving ? fromClip : wasOpen ? "inset(0 0 0% 0)" : "inset(0 0 100% 0)" },
      { opacity: open ? 1 : 0, clipPath: open ? "inset(0 0 0% 0)" : "inset(0 0 100% 0)" }
    ], { duration, easing });
    layoutAnimations.push(visual);
    if (follower && Math.abs(delta) > 0.5) {
      layoutAnimations.push(follower.animate([
        { transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }
      ], { duration, easing }));
    }
    Promise.allSettled(layoutAnimations.map((animation) => animation.finished)).then(finish);
  }

  const settleMotion = () => finishLayout?.();
  const onMotionPreference = () => { if (reduced?.matches) settleMotion(); };
  reduced?.addEventListener?.("change", onMotionPreference);
  window.addEventListener("wheel", settleMotion, { passive: true });
  window.addEventListener("touchmove", settleMotion, { passive: true });
  window.addEventListener("pagehide", () => {
    settleMotion();
    clearInterval(focusStripTimer);
    accessPanel.destroy();
    reduced?.removeEventListener?.("change", onMotionPreference);
    window.removeEventListener("wheel", settleMotion);
    window.removeEventListener("touchmove", settleMotion);
  }, { once: true });

  function beginExit() {
    strip.classList.add("focus-exit");
    strip.inert = true;
  }

  /** Rebuild the strip from the current site-guard status. Coalesced; never steals focus. */
  async function render() {
    const status = await getFocusGuardStatus();
    clearInterval(focusStripTimer);
    const focusedAccessDomain = strip.contains(document.activeElement)
      ? document.activeElement?.dataset?.domain : "";
    const focusedAccessAction = document.activeElement?.classList?.contains("focus-access-stop")
      ? "stop" : "add";
    const previouslyHadFocus = strip.contains(document.activeElement);
    accessPanel.render(status.accesses ?? []);
    // Keep focus on the equivalent strip action when the ready/active state
    // replaces it. Hand it to Search only when this surface hides the strip.
    const hadFocus = previouslyHadFocus || strip.contains(document.activeElement);
    if (!status.active && (status.accesses?.length ?? 0) === 0) {
      if (hadFocus) getSearchInput()?.focus({ preventScroll: true });
      beginExit();
      if (focusWasActive) announce(msg("focus_status_ended"));
      focusWasActive = false;
      transitionLayout(false, () => {
        strip.replaceChildren();
        strip.classList.remove("access-only", "focus-exit");
        strip.classList.add("hidden");
      });
      return;
    }
    strip.inert = false;
    strip.classList.remove("hidden", "focus-exit");
    strip.classList.toggle("access-only", !status.active);
    if (!status.active) {
      strip.classList.remove("focus-exit");
      strip.replaceChildren(accessPanel.element);
      if (focusWasActive) announce(msg("focus_status_ended"));
      focusWasActive = false;
      if (focusedAccessDomain) {
        strip.querySelector(`.focus-access-${focusedAccessAction}[data-domain="${CSS.escape(focusedAccessDomain)}"]`)?.focus();
      }
      transitionLayout(true);
      onMeasure();
      return;
    }
    const remain = el("span", { class: "fs-time" },
      status.endsAt != null ? formatRemaining(status.endsAt, Date.now()) : msg("focus_until_end"));
    /* F48: the guarded count is the one fact in this band you might want to act
     * on, so it is a real control that jumps to the Blocked sites editor. It
     * carries no button chrome — underlining on hover is what says "clickable",
     * the same language "More stats" uses. */
    const guardedText = status.guardedCount === 1
      ? msg("focus_guarded_one")
      : msg("focus_guarded_other", [formatNumber(status.guardedCount)]);
    const guarded = openBlockedSites
      ? el("button", { class: "fs-counts fs-counts-link", type: "button",
          title: msg("focus_guarded_settings_title"),
          "aria-label": msg("focus_guarded_settings_aria", [guardedText]),
          onclick: () => openBlockedSites() }, guardedText)
      : el("span", { class: "fs-counts" }, guardedText);
    /* F44: the band is status only. Ending a run belongs to the one accented
     * Focus control on the top-right utility line, which is visible on every
     * route and width; carrying a second End here made the same action exist
     * twice on one screen. */
    const content = el("div", { class: "focus-strip-content" },
      el("span", { class: "fs-dot", "aria-hidden": "true" }),
      el("span", { class: "fs-name" }, msg("focus_guard_heading_on")),
      remain,
      guarded,
      accessPanel.element
    );
    strip.replaceChildren(content);
    /* F48r: an ACTIVE re-render must not throw focus at the search box. It used
     * to, from the days when this band owned the End button and that button was
     * replaced on every render; now the band's only control is the guarded
     * count, and clicking it was landing the user in Search with its
     * suggestions open. Put focus back where it was. Handing focus to Search
     * remains correct only in the inactive branch above, where the strip and
     * everything in it disappears. */
    if (hadFocus) {
      const equivalent = focusedAccessDomain
        ? strip.querySelector(`.focus-access-${focusedAccessAction}[data-domain="${CSS.escape(focusedAccessDomain)}"]`)
        : strip.querySelector(".fs-counts-link");
      equivalent?.focus();
    }
    if (!focusWasActive) announce(msg("focus_status_on"));
    focusWasActive = true;
    // Calm minute-granular countdown; never a live region (the announcer is separate).
    if (status.endsAt != null) {
      focusStripTimer = setInterval(() => {
        const t = formatRemaining(status.endsAt, Date.now());
        if (t !== remain.textContent) remain.textContent = t;
      }, 1000);
    }
    transitionLayout(true);
    onMeasure();
  }

  const refresh = coalesce(render);
  return { element, strip, announcer, refresh };
}
