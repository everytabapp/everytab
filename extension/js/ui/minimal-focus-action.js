// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Compact Focus action for the Minimal New Tab footer. */
import { formatRemaining } from "../lib/focus-copy.js";
import { msg } from "../lib/i18n.js";
import { el } from "./dom.js";
import { icon } from "./icons.js";
import { endFocusGuard, getFocusGuardStatus, startFocusGuard } from "./focus-strip.js";

const REFRESH_MS = 10_000;

/**
 * @param {{openSetup:() => void, element?:HTMLElement}} options
 * @returns {{element:HTMLElement,refresh:() => Promise<void>,destroy:() => void}}
 */
export function createMinimalFocusAction({ openSetup, element: initialElement }) {
  // Reuse the established shared Focus catalogue here. Unpacked Chrome can
  // briefly retain an older locale bundle when an already-installed extension
  // is reloaded; making Minimal's first paint depend on brand-new message keys
  // left long-lived profiles with only the pre-painted background.
  const readyCopy = el("span", { class: "minimal-focus-copy" }, msg("popup_focus"));
  const ready = el("span", {
    class: "minimal-focus-state is-ready is-current",
    "data-focus-state": "ready",
    "aria-hidden": "false"
  }, icon("play", 14), readyCopy);
  const activeTime = el("span", { class: "minimal-focus-copy" });
  const active = el("span", {
    class: "minimal-focus-state is-active",
    "data-focus-state": "active",
    "aria-hidden": "true"
  }, icon("stop", 14), activeTime);
  const button = initialElement?.querySelector("button") ?? el("button", {
    class: "minimal-focus-action is-hydrating", type: "button"
  });
  button.onclick = null;
  button.setAttribute("aria-label", msg("popup_focus"));
  button.replaceChildren(ready, active);
  const announcer = el("span", {
    class: "sr-only", role: "status", "aria-live": "polite"
  });
  const element = initialElement ?? el("span", { class: "minimal-focus-control" }, button);
  element.append(announcer);

  let status = null;
  let pending = false;
  let timer = 0;
  let generation = 0;
  let hydrated = false;

  const announce = (copy) => {
    announcer.textContent = "";
    requestAnimationFrame(() => { announcer.textContent = copy; });
  };

  const schedule = () => {
    clearTimeout(timer);
    if (!status?.active || status.endsAt == null) return;
    timer = setTimeout(() => { void refresh(); }, REFRESH_MS);
  };

  const render = (next) => {
    status = next ?? { active: false, duringCount: 0 };
    const isActive = Boolean(status.active);
    const readyToStart = Number(status.duringCount) > 0;
    const activeCopy = isActive
      ? status.endsAt == null
        ? msg("popup_focus")
        : formatRemaining(status.endsAt, Date.now())
      : "";
    readyCopy.textContent = msg(readyToStart ? "popup_focus" : "popup_setup_focus");
    activeTime.textContent = activeCopy;
    element.classList.toggle("is-active", isActive);
    element.classList.toggle("is-setup", !isActive && !readyToStart);
    ready.classList.toggle("is-current", !isActive);
    ready.setAttribute("aria-hidden", String(isActive));
    active.classList.toggle("is-current", isActive);
    active.setAttribute("aria-hidden", String(!isActive));
    button.setAttribute("aria-label", isActive
      ? msg("popup_end_focus")
      : msg(readyToStart ? "popup_start_focus" : "popup_setup_focus"));
    if (!hydrated) {
      hydrated = true;
      requestAnimationFrame(() => button.classList.remove("is-hydrating"));
    }
    schedule();
  };

  async function refresh() {
    const currentGeneration = ++generation;
    const next = await getFocusGuardStatus();
    if (currentGeneration !== generation) return;
    render(next);
  }

  const setPending = (next) => {
    pending = next;
    button.classList.toggle("is-pending", next);
    button.setAttribute("aria-busy", String(next));
    button.setAttribute("aria-disabled", String(next));
  };

  button.addEventListener("click", async () => {
    if (pending) return;
    if (!status) {
      setPending(true);
      try { await refresh(); }
      finally { setPending(false); }
    }
    if (!status?.active && Number(status?.duringCount) <= 0) {
      openSetup();
      return;
    }
    setPending(true);
    try {
      const result = status?.active ? await endFocusGuard() : await startFocusGuard();
      if (result?.status) {
        generation += 1;
        render(result.status);
      }
      else await refresh();
      if (!result?.ok) {
        announce(msg(status?.active ? "popup_focus_end_failed" : "popup_focus_start_failed"));
      }
    } finally {
      setPending(false);
    }
  });

  void refresh();
  return {
    element,
    refresh,
    destroy() {
      generation += 1;
      clearTimeout(timer);
    }
  };
}
