import { msg } from "../lib/i18n.js";

const INVALID_REASONS = new Set(["invalid", "missing", "not-guard", "no-tab"]);

export function guardFailureText(response, fallback) {
  if (response?.reason === "close-failed" && response.saved) {
    return msg("focus_error_saved_close_failed");
  }
  if (response?.reason === "save-failed") {
    return msg("focus_error_save_tab_open");
  }
  if (response?.reason === "unavailable") {
    return msg("focus_error_unavailable");
  }
  return fallback;
}

/**
 * One pending guard-page action across the whole surface. The initiating control stays
 * disabled and aria-busy until a failure settles; success/invalid-context paths are expected
 * to unload into the destination or safe EveryTab fallback and remain inert meanwhile.
 */
export function createGuardActionRunner({ send, onFailure, onInvalid }) {
  let pending = false;
  return async function run(control, message, failCopy) {
    if (pending) return { ok: false, reason: "duplicate", ignored: true };
    pending = true;
    control.disabled = true;
    control.setAttribute("aria-busy", "true");
    let leaving = false;
    try {
      let response;
      try { response = await send(message); }
      catch { response = { ok: false, reason: "unavailable" }; }
      if (response?.ok) {
        leaving = true;
        return response;
      }
      if (INVALID_REASONS.has(response?.reason)) {
        leaving = true;
        onInvalid(response);
        return response;
      }
      onFailure(response ?? { ok: false, reason: "unavailable" }, failCopy);
      return response;
    } finally {
      if (!leaving) {
        pending = false;
        if (control.isConnected !== false) {
          control.disabled = false;
          control.removeAttribute("aria-busy");
        }
      }
    }
  };
}
