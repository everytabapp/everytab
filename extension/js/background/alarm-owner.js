// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "../lib/failure-diagnostic.js";
import { isGuardAlarm } from "../lib/focus-guard.js";
import { SCHEME_ROTATION_ALARM } from "../lib/scheme-rotation.js";
import { SNAPSHOT_ALARM } from "../lib/snapshot-schedule.js";
import { SNOOZE_ALARM_PREFIX } from "../lib/snooze.js";
import { SUSPEND_CLOSE_CLEANUP_ALARM } from "../lib/suspend.js";

export const SUSPEND_ALARM = "suspend-sweep";
export const ARCHIVE_ALARM = "archive-sweep";
export const RECOVERY_ALARM = "suspend-recovery";
export const SUSPEND_METADATA_REPAIR_ALARM = "suspend-metadata-repair";
export const DEDUP_GRACE_PREFIX = "dedup-grace:";

async function runAlarm(name, work) {
  try {
    await work();
  } catch (error) {
    reportFailure(name, error);
  }
}

/**
 * Install the worker's single alarm dispatcher. Each domain owns its product
 * operation; this boundary owns alarm identity, MV3 task lifetime, and failure
 * containment.
 *
 * @param {{
 *   snapshots: { take: () => Promise<unknown> },
 *   assets: { collect: () => Promise<unknown> },
 *   suspension: {
 *     sweep: () => Promise<unknown>,
 *     finishRecovery: () => Promise<unknown>,
 *     repairRecoveryMetadata: () => Promise<unknown>,
 *     retryCloseCleanups: () => Promise<unknown>
 *   },
 *   focus: {
 *     endGuard: () => Promise<unknown>,
 *     expireAccess: () => Promise<unknown>
 *   },
 *   archive: { sweep: () => Promise<unknown>, expireInbox: () => Promise<unknown> },
 *   rotation: { rotate: () => Promise<unknown> },
 *   snooze: { ready: Promise<unknown>, fire: (id: string, options: object) => Promise<unknown> },
 *   duplicates: {
 *     ready: Promise<unknown>,
 *     readSettings: () => Promise<object>,
 *     close: (options: object) => Promise<unknown>,
 *     refreshBadge: () => unknown
 *   }
 * }} domains
 */
export function installAlarmOwner({
  snapshots,
  assets,
  suspension,
  focus,
  archive,
  rotation,
  snooze,
  duplicates
}) {
  chrome.alarms.onAlarm.addListener(async ({ name }) => {
    if (name === SNAPSHOT_ALARM) {
      await runAlarm("automatic Snapshot", snapshots.take);
      return;
    }

    if (name === SUSPEND_ALARM) {
      await runAlarm("automatic suspend sweep", suspension.sweep);
      return;
    }

    if (isGuardAlarm(name)) {
      await runAlarm("Focus guard alarm", () => (
        name === "focus-guard-end" ? focus.endGuard() : focus.expireAccess()
      ));
      return;
    }

    if (name === RECOVERY_ALARM) {
      await runAlarm("final suspended-tab recovery pass", suspension.finishRecovery);
      return;
    }

    if (name === SUSPEND_METADATA_REPAIR_ALARM) {
      await runAlarm("suspended metadata repair", suspension.repairRecoveryMetadata);
      return;
    }

    if (name === SUSPEND_CLOSE_CLEANUP_ALARM) {
      await runAlarm("suspended close cleanup retry", suspension.retryCloseCleanups);
      return;
    }

    if (name === ARCHIVE_ALARM) {
      await Promise.all([
        runAlarm("automatic archive sweep", () => Promise.all([
          archive.sweep(), archive.expireInbox()
        ])),
        runAlarm("unused Library favicon cleanup", assets.collect)
      ]);
      return;
    }

    if (name === SCHEME_ROTATION_ALARM) {
      await runAlarm("Scheme rotation", rotation.rotate);
      return;
    }

    if (name.startsWith(SNOOZE_ALARM_PREFIX)) {
      await runAlarm("Snooze delivery", async () => {
        await snooze.ready;
        await snooze.fire(name.slice(SNOOZE_ALARM_PREFIX.length), { manual: false });
      });
      return;
    }

    if (name.startsWith(DEDUP_GRACE_PREFIX)) {
      await runAlarm("duplicate grace close", async () => {
        const settings = await duplicates.readSettings();
        if (!settings.dedupAutoClose) return;
        await duplicates.ready;
        await duplicates.close({
          tabId: Number(name.slice(DEDUP_GRACE_PREFIX.length)),
          auto: true
        });
        duplicates.refreshBadge();
      });
    }
  });
}
