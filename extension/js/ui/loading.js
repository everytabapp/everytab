/**
 * Shared Loading feedback for a genuinely blank wait (P11-16).
 *
 * The delay prevents fast local reads from flashing a transient status. Callers
 * keep useful existing content instead of mounting this component during a
 * background refresh. The pure gate is exported so timing/cancellation stays
 * directly testable without a browser DOM.
 */
import { el } from "./dom.js";

export const LOADING_FEEDBACK_DELAY_MS = 180;

/**
 * @param {{
 *   delayMs?: number,
 *   schedule?: (fn: () => void, delay: number) => unknown,
 *   cancel?: (handle: unknown) => void,
 *   onBusy?: (busy: boolean) => void,
 *   onShow?: () => boolean|void,
 *   onHide?: () => void
 * }} options
 */
export function createLoadingGate({
  delayMs = LOADING_FEEDBACK_DELAY_MS,
  schedule = (fn, delay) => setTimeout(fn, delay),
  cancel = (handle) => clearTimeout(handle),
  onBusy = () => {},
  onShow = () => true,
  onHide = () => {}
} = {}) {
  let timer = null;
  let started = false;
  let stopped = false;
  let visible = false;

  return {
    start() {
      if (started || stopped) return;
      started = true;
      onBusy(true);
      timer = schedule(() => {
        timer = null;
        if (stopped) return;
        visible = onShow() !== false;
      }, delayMs);
    },
    stop() {
      if (!started || stopped) return;
      stopped = true;
      if (timer !== null) cancel(timer);
      timer = null;
      if (visible) onHide();
      visible = false;
      onBusy(false);
    },
    get visible() { return visible; }
  };
}

const activeByHost = new WeakMap();

/**
 * Mark `host` busy immediately and stage the shared visual feedback when it is
 * genuinely empty. CSS owns the delayed reveal: unlike a JS timer, its opacity
 * animation can finish on the compositor while a large synchronous list render
 * occupies the main thread. The polite announcement remains JS-delayed so a
 * fast local read is never spoken. A newer controller for the same host owns
 * `aria-busy`, so an older async completion cannot clear the current operation.
 *
 * @param {HTMLElement} host
 * @param {{label?: string, delayMs?: number}} [options]
 * @returns {{element: HTMLElement, stop: () => void}}
 */
export function showLoadingFeedback(host, {
  label = "Loading…",
  delayMs = LOADING_FEEDBACK_DELAY_MS
} = {}) {
  activeByHost.get(host)?.stop();
  const safeDelayMs = Number.isFinite(delayMs) ? Math.max(0, delayMs) : LOADING_FEEDBACK_DELAY_MS;

  const element = el("div", {
    class: "loading-feedback",
    style: `--loading-delay: ${safeDelayMs}ms`,
    "aria-hidden": "true"
  }, label);
  const announcer = el("span", {
    class: "sr-only",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true"
  }, label);

  let controller;
  const gate = createLoadingGate({
    delayMs: safeDelayMs,
    onBusy: (busy) => {
      if (activeByHost.get(host) !== controller) return;
      if (busy) host.setAttribute("aria-busy", "true");
      else host.removeAttribute("aria-busy");
    },
    onShow: () => {
      if (element.parentNode !== host || host.childNodes.length !== 1) return false;
      host.append(announcer);
      return true;
    },
    onHide: () => announcer.remove()
  });

  controller = {
    element,
    stop() {
      gate.stop();
      announcer.remove();
      element.remove();
      if (activeByHost.get(host) === controller) activeByHost.delete(host);
    }
  };
  activeByHost.set(host, controller);
  if (host.childNodes.length === 0) host.append(element);
  gate.start();
  return controller;
}
