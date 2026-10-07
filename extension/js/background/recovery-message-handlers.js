// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

const isNonEmptyText = (value) => typeof value === "string" && value.trim().length > 0;
const isTextList = (value) => Array.isArray(value) &&
  value.every((entry) => typeof entry === "string" && entry.trim().length > 0);
const noPayload = () => true;
const handler = (type, validate, handle, failure) => ({
  type,
  mode: "async",
  validate,
  handle,
  failure
});

/**
 * Describe the complete Data-page recovery message family. The recently
 * closed and automatic Snapshot domains retain their own storage and browser
 * effects; this module owns public message identity, validation bounds, and
 * safe failure shapes.
 *
 * @param {{
 *   recentlyClosed: {
 *     inspect: () => Promise<unknown>,
 *     recover: (sessionIds: string[]) => Promise<unknown>
 *   },
 *   snapshots: {
 *     inspect: () => Promise<unknown>,
 *     review: (snapshotId: string) => Promise<unknown>,
 *     recover: (snapshotId: string, pickKeys: string[]) => Promise<unknown>
 *   }
 * }} domains
 */
export function createRecoveryMessageHandlers({ recentlyClosed, snapshots }) {
  return [
    handler(
      "inspect-recently-closed-suspended",
      noPayload,
      recentlyClosed.inspect,
      { ok: false, candidates: [] }
    ),
    handler(
      "recover-recently-closed-suspended",
      (message) => isTextList(message.sessionIds) && message.sessionIds.length <= 25,
      (message) => recentlyClosed.recover(message.sessionIds),
      { ok: false, requested: 0, restored: 0, failed: 0, unavailable: 0 }
    ),
    handler(
      "inspect-snapshot-recovery",
      noPayload,
      snapshots.inspect,
      { ok: false, snapshots: [] }
    ),
    handler(
      "review-snapshot-recovery",
      (message) => isNonEmptyText(message.snapshotId),
      (message) => snapshots.review(message.snapshotId),
      { ok: false, reason: "review-failed", snapshot: null, candidates: [] }
    ),
    handler(
      "recover-snapshot-missing-tabs",
      (message) => isNonEmptyText(message.snapshotId) && isTextList(message.pickKeys) &&
        message.pickKeys.length > 0 && message.pickKeys.length <= 1000,
      (message) => snapshots.recover(message.snapshotId, message.pickKeys),
      { ok: false, requested: 0, restored: 0, windows: 0, unavailable: 0, failed: 0 }
    )
  ];
}
