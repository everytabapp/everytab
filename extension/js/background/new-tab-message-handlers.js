// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

const MESSAGE = Object.freeze({
  diagnosticsArm: "scheme-rotation-diagnostics-arm",
  diagnosticsReport: "scheme-rotation-diagnostics",
  diagnosticsPaint: "scheme-rotation-diagnostics-page-paint",
  rotationReady: "scheme-rotation-new-tab-ready",
  mounted: "everytab-new-tab-mounted"
});

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const isId = (value) => Number.isInteger(value) && value >= 0;
const hasSenderTab = (_message, sender) => isRecord(sender.tab) && isId(sender.tab.id);
const acceptsMessage = () => true;

const handler = (type, mode, validate, handle, failure) => ({
  type,
  mode,
  validate,
  handle,
  failure
});

/**
 * Describe the five messages exchanged by a mounted New Tab page and the
 * worker. Chrome response-channel mechanics remain owned by the shared message
 * registry; this module owns only New Tab validation and domain routing.
 *
 * @param {{
 *   diagnostics: {
 *     arm: (activeCount: number, handledCount: number) => unknown,
 *     report: (activeCount: number, handledCount: number) => unknown,
 *     record: (event: string, details: Record<string, unknown>) => unknown,
 *     safeScheme: (value: unknown) => unknown
 *   },
 *   rotation: {
 *     counts: () => {active: number, handled: number},
 *     run: (tabId: number) => unknown
 *   },
 *   retireMounted: (tab: Record<string, unknown>) => unknown
 * }} domains
 * @returns {Array<{
 *   type: string,
 *   mode: "sync"|"async",
 *   validate: Function,
 *   handle: Function,
 *   failure: unknown
 * }>}
 */
export function createNewTabMessageHandlers({ diagnostics, rotation, retireMounted }) {
  const rotationCounts = () => {
    const { active, handled } = rotation.counts();
    return { active, handled };
  };

  return [
    handler(MESSAGE.diagnosticsArm, "sync", acceptsMessage, () => {
      const { active, handled } = rotationCounts();
      return diagnostics.arm(active, handled);
    }, { ok: false }),
    handler(MESSAGE.diagnosticsReport, "sync", acceptsMessage, () => {
      const { active, handled } = rotationCounts();
      return diagnostics.report(active, handled);
    }, { ok: false }),
    handler(MESSAGE.diagnosticsPaint, "sync", acceptsMessage, (message, sender) => ({
      ok: true,
      recorded: diagnostics.record("page-paint", {
        tabId: isId(sender.tab?.id) ? sender.tab.id : null,
        source: "page",
        before: diagnostics.safeScheme(message.bootSelection),
        after: diagnostics.safeScheme(message.finalSelection)
      })
    }), { ok: false, recorded: false }),
    handler(MESSAGE.rotationReady, "async", hasSenderTab, (_message, sender) => {
      diagnostics.record("readiness-received", { tabId: sender.tab.id });
      return rotation.run(sender.tab.id);
    }, { ok: false, reason: "rotation-failed" }),
    handler(MESSAGE.mounted, "async", hasSenderTab,
      (_message, sender) => retireMounted(sender.tab),
      { ok: false, reason: "unavailable" })
  ];
}
