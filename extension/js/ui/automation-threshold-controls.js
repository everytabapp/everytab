// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

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
import { SNAPSHOT_KEEP_MAX, SNAPSHOT_KEEP_MIN, effectiveSnapshotKeep } from "../lib/types.js";

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
  const number = (key, min, max, normalize = (value) => value) => {
    const input = el("input", {
      type: "number", min, max, style: "width:82px",
      "aria-label": settingsRowCopy(({ autoSaveMaxTabs: "maxTabsOpen", inboxExpiryDays: "inboxExpiry",
        suspendMinTabs: "suspendMinTabs", suspendMaxTabs: "suspendMaxTabs",
        snapshotEveryMinutes: "snapshotEvery", snapshotKeep: "snapshotsKeep" })[key]).title,
      onchange: (event) => void update({ [key]: normalize(Number(event.currentTarget.value)) })
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
    ticks: [settingsStatic.durationOffShort(), settingsDurationLabel(SUSPEND_STOPS.at(-1))],
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
    // Typed values outside the bounds are saved as the effective retention,
    // the same value the Recovery database and getSettings apply.
    snapshotsKeep: number("snapshotKeep", SNAPSHOT_KEEP_MIN, SNAPSHOT_KEEP_MAX, effectiveSnapshotKeep),
    sync() { for (const sync of localSyncers) sync(); }
  });
}
