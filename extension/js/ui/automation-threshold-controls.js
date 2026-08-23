/**
 * Shared controls for EveryTab's eight automatic-behaviour thresholds.
 *
 * Settings and first-run onboarding deliberately consume the same inputs,
 * value mappings, persistence callback, and refresh contract. The two surfaces
 * own their presentation, but there is only one behavioral implementation.
 */
import { el } from "./dom.js";
import {
  createSlider, SUSPEND_STOPS, AUTO_DUMP_MINUTES,
  suspendPatch, autoDumpPatch
} from "./slider.js";
import { settingsDurationLabel, settingsRowCopy, settingsStatic } from "./settings-copy.js";

/**
 * @param {{
 *   readSettings: () => Partial<import("../lib/types.js").Settings>,
 *   update: (patch: Partial<import("../lib/types.js").Settings>) => Promise<unknown>|unknown,
 *   registerSync?: (sync: () => void) => void
 * }} options
 */
export function createAutomationThresholdControls({ readSettings, update, registerSync = () => {} }) {
  const localSyncers = [];
  const ownSync = (sync) => {
    localSyncers.push(sync);
    registerSync(sync);
  };
  const number = (key, min, max) => {
    const input = el("input", {
      type: "number", min, max, style: "width:82px",
      "aria-label": settingsRowCopy(({ autoSaveMaxTabs: "maxTabsOpen", inboxExpiryDays: "inboxExpiry",
        suspendMinTabs: "suspendMinTabs", suspendMaxTabs: "suspendMaxTabs",
        snapshotEveryMinutes: "snapshotEvery", snapshotKeep: "snapshotsKeep" })[key]).title,
      onchange: (event) => void update({ [key]: Number(event.currentTarget.value) })
    });
    const sync = () => {
      if (document.activeElement !== input) input.value = String(readSettings()[key] ?? 0);
    };
    sync();
    ownSync(sync);
    return input;
  };

  const suspendSlider = createSlider({
    stops: SUSPEND_STOPS,
    value: readSettings().suspendEnabled ? readSettings().suspendAfterMinutes : 0,
    format: (minutes) => settingsDurationLabel(minutes),
    ariaLabel: settingsRowCopy("suspendAfter").title,
    ticks: [settingsStatic.durationOffShort(), settingsStatic.oneHourShort(), settingsStatic.twoHoursShort()],
    onChange: (minutes) => void update(suspendPatch(minutes))
  });
  const syncSuspend = () => {
    const settings = readSettings();
    if (document.activeElement !== suspendSlider.node.querySelector("input")) {
      suspendSlider.set(settings.suspendEnabled ? settings.suspendAfterMinutes : 0);
    }
  };
  ownSync(syncSuspend);

  const autoSaveSlider = createSlider({
    stops: AUTO_DUMP_MINUTES,
    value: readSettings().autoArchiveEnabled ? readSettings().autoDumpAfterMinutes : 0,
    format: (minutes) => settingsDurationLabel(minutes, "auto"),
    ariaLabel: settingsRowCopy("autoSaveAfter").title,
    ticks: [settingsStatic.durationOffShort(), settingsStatic.oneDayShort(),
      settingsStatic.sevenDaysShort(), settingsStatic.thirtyOneDaysShort()],
    onChange: (minutes) => void update(autoDumpPatch(minutes))
  });
  const syncAutoSave = () => {
    const settings = readSettings();
    if (document.activeElement !== autoSaveSlider.node.querySelector("input")) {
      autoSaveSlider.set(settings.autoArchiveEnabled ? settings.autoDumpAfterMinutes : 0);
    }
  };
  ownSync(syncAutoSave);

  return Object.freeze({
    autoSaveAfter: autoSaveSlider.node,
    maxTabsOpen: number("autoSaveMaxTabs", 0, 999),
    inboxExpiry: number("inboxExpiryDays", 0, 3650),
    suspendAfter: suspendSlider.node,
    suspendMinTabs: number("suspendMinTabs", 0, 999),
    suspendMaxTabs: number("suspendMaxTabs", 0, 999),
    snapshotEvery: number("snapshotEveryMinutes", 5, 240),
    snapshotsKeep: number("snapshotKeep", 0, 10000),
    sync() { for (const sync of localSyncers) sync(); }
  });
}
