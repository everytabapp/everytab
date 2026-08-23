import { requestHistoryAccess } from "../lib/history-access.js";
import { el } from "./dom.js";
import { historyAccessCopy } from "./history-access-copy.js";

/**
 * Inline permission preflight. The Chrome prompt is triggered only by Allow.
 * @param {{onGranted:()=>void|Promise<void>, onDismiss?:()=>void, purpose?:string}} options
 */
export function createHistoryAccessDisclosure({ onGranted, onDismiss, purpose = historyAccessCopy.purpose() }) {
  const status = el("span", { class: "history-access-status", role: "status", "aria-live": "polite" });
  const allow = el("button", { type: "button", class: "mini2" }, historyAccessCopy.allow());
  const dismiss = el("button", { type: "button", class: "linklike" }, historyAccessCopy.notNow());
  const element = el("div", { class: "history-access-disclosure" },
    el("p", { class: "history-access-purpose" }, purpose),
    el("p", {}, historyAccessCopy.details()),
    el("p", { class: "history-access-trust" }, historyAccessCopy.trust()),
    el("div", { class: "history-access-actions" }, allow, dismiss, status));

  allow.addEventListener("click", async () => {
    allow.disabled = true;
    const granted = await requestHistoryAccess();
    if (granted) await onGranted();
    else {
      allow.disabled = false;
      status.textContent = historyAccessCopy.denied();
    }
  });
  dismiss.addEventListener("click", () => onDismiss?.());
  return element;
}
