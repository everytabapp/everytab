// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "../lib/failure-diagnostic.js";
import { expandStorageChanges } from "../lib/storage/constants.js";
import { snapshotCadenceChanged } from "../lib/snapshot-schedule.js";

/**
 * Install the worker's single Settings-change policy. The owner expands storage
 * revision pulses, chooses the maintenance required by each logical change,
 * and contains repairs that already have named failure handling.
 *
 * @param {{
 *   recordStorageChange: (changes: object, area: string) => unknown,
 *   ensureSnapshotAlarm: () => Promise<unknown>,
 *   ensureArchiveAlarm: () => unknown,
 *   ensureSchemeRotationAlarm: () => unknown,
 *   refreshBadge: () => unknown,
 *   scheduleAutoSaveCapSweep: () => unknown,
 *   sweepInboxExpiry: () => Promise<unknown>,
 *   focusRulesChanged: () => unknown,
 *   uiLanguageChanged: () => unknown
 * }} effects
 */
export function installSettingsChangeOwner({
  recordStorageChange,
  ensureSnapshotAlarm,
  ensureArchiveAlarm,
  ensureSchemeRotationAlarm,
  refreshBadge,
  scheduleAutoSaveCapSweep,
  sweepInboxExpiry,
  focusRulesChanged,
  uiLanguageChanged
}) {
  chrome.storage.onChanged.addListener((physicalChanges, area) => {
    const changes = expandStorageChanges(physicalChanges);
    recordStorageChange(changes, area);
    if (area !== "local" || !changes.settings) return;

    if (snapshotCadenceChanged(changes.settings)) {
      void ensureSnapshotAlarm().catch((error) => {
        reportFailure("automatic Snapshot schedule repair", error);
      });
    }
    ensureArchiveAlarm();
    ensureSchemeRotationAlarm();
    refreshBadge();

    const hasSettingsValues = Object.hasOwn(changes.settings, "oldValue") ||
      Object.hasOwn(changes.settings, "newValue");
    const oldAutoSaveCap = Number(changes.settings.oldValue?.autoSaveMaxTabs) || 0;
    const newAutoSaveCap = Number(changes.settings.newValue?.autoSaveMaxTabs) || 0;
    if (!hasSettingsValues || oldAutoSaveCap !== newAutoSaveCap) {
      scheduleAutoSaveCapSweep();
    }

    const oldInboxExpiry = Number(changes.settings.oldValue?.inboxExpiryDays) || 0;
    const newInboxExpiry = Number(changes.settings.newValue?.inboxExpiryDays) || 0;
    if (!hasSettingsValues || oldInboxExpiry !== newInboxExpiry) {
      void sweepInboxExpiry().catch((error) => {
        reportFailure("Inbox expiry settings sweep", error);
      });
    }

    // Focus settings do not schedule runs. A blocked-site rule or scope change
    // only sweeps newly applicable open tabs; removal stops future guarding.
    void focusRulesChanged();

    // Notification text follows the chosen interface language. Only a language
    // change (or a value-free pulse) re-reads Settings and reinstalls it.
    const oldLanguage = changes.settings.oldValue?.uiLanguage;
    const newLanguage = changes.settings.newValue?.uiLanguage;
    if (!hasSettingsValues || oldLanguage !== newLanguage) void uiLanguageChanged();
  });
}
