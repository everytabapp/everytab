// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Shared failure diagnostics for worker, domain and UI owners.
 * Only fixed operation labels and error classifications may reach a log sink.
 * Messages, stacks, causes, record identities and arbitrary properties stay private.
 */
const SAFE_ERROR_NAMES = new Set([
  "AbortError", "ConstraintError", "DataCloneError", "DataError", "Error",
  "InvalidStateError", "NetworkError", "NotAllowedError", "NotFoundError",
  "NotReadableError", "OperationError", "QuotaExceededError", "ReadOnlyError",
  "SecurityError", "SnoozeWakeIncompleteError", "TimeoutError",
  "TransactionInactiveError", "TypeError"
]);
const SAFE_ERROR_CODES = new Set([
  "storage-authority-not-initialized",
  // Vault protocol failure families; see js/vault/failure-codes.js.
  "vault-update-required", "vault-placeholder-file", "vault-damaged-backup",
  "vault-foreign-manifest-unreadable", "vault-conflict-copy"
]);

// Keep these labels literal: a character/length check also accepts private titles.
// Adding a diagnostic requires choosing a label here, not passing user content.
const SAFE_OPERATIONS = new Set([
  "Close-the-day recovery",
  "Data render",
  "Focus access extension",
  "Focus access notification click",
  "Focus activation",
  "Focus browser-start recovery",
  "Focus guard alarm",
  "Focus guard recovery",
  "Focus navigation",
  "Focus reload recovery",
  "Focus tab cleanup",
  "Focus tab recovery",
  "Inbox automation indicators",
  "Inbox expiry settings sweep",
  "interface language install",
  "Inbox expiry sweep",
  "Inbox schedule repair",
  "Label choices read",
  "Label group assignment",
  "Label save",
  "New Tab creation tracking",
  "New Tab lifecycle cleanup",
  "New Tab scheme rotation",
  "New Tab singleton reconciliation",
  "Open automation indicators",
  "Scheme rotation",
  "Session group assignment",
  "Session identity index backfill",
  "Session window cleanup",
  "Side Panel refresh",
  "Snooze save",
  "Snooze delivery",
  "Vault render",
  "Vault timeout status save",
  "archive-expiry-notification",
  "archive-notification",
  "automatic Inbox sweep",
  "automatic Snapshot",
  "automatic Snapshot schedule repair",
  "automatic Snapshot startup capture",
  "automatic archive sweep",
  "automatic suspend sweep",
  "automatic suspension schedule repair",
  "automation protection read",
  "automation protection update",
  "badge refresh",
  "browser startup",
  "command notification",
  "context menu installation",
  "delayed Focus tab recovery",
  "device identity setup",
  "duplicate grace close",
  "duplicate grace scheduling",
  "extension installation",
  "final suspended-tab recovery pass",
  "first-install Dashboard",
  "focus-access-expiry-notification",
  "focus-access-warning",
  "interrupted Snooze delivery recovery",
  "interrupted Undo recovery",
  "introduction progress save",
  "maximum-open-tabs Auto-save",
  "maximum-open-tabs scheduling",
  "merge-newer-schema",
  "missing Session notification",
  "notification Undo",
  "notification cleanup",
  "onboarding Vault connection",
  "onboarding Vault status",
  "onboarding choice save",
  "onboarding completion save",
  "overdue Snooze sweep",
  "pending live-close recovery",
  "prompt recovery notification",
  "recovery notification",
  "recovery start notification",
  "retained suspended close cleanup",
  "runtime message",
  "scheme rotation schedule repair",
  "session-group-assignment",
  "snooze-notification",
  "storage-authority-initialization",
  "storage-authority-prewarm",
  "storage-authority-prewarm-reporting",
  "suspended close cleanup",
  "suspended close cleanup retry",
  "suspended metadata repair",
  "suspended metadata repair scheduling",
  "suspended-close-retry",
  "suspended-recovery-notification",
  "suspended-recovery-scheduled",
  "suspended-tab navigation cleanup",
  "suspended-tab recovery",
  "suspended-tab recovery cycle",
  "suspended-tab recovery pass",
  "tab activity browser-start reset",
  "tab activity cleanup",
  "tab activity focus transition",
  "tab activity initialization",
  "tab activity transition",
  "tab activity window cleanup",
  "tab protection removal",
  "tab protections read",
  "tab-group-restore",
  "temporary automation protection browser-start reset",
  "temporary automation protection cleanup",
  "temporary protection removal",
  "unused Library favicon cleanup"
]);

function readableStringProperty(value, property) {
  try {
    const candidate = value?.[property];
    return typeof candidate === "string" ? candidate : null;
  } catch {
    return null;
  }
}

/** Classify an unknown thrown value without coercing it or reading its payload. */
export function classifyFailure(error) {
  const code = readableStringProperty(error, "code");
  if (SAFE_ERROR_CODES.has(code)) return `code:${code}`;
  const name = readableStringProperty(error, "name");
  return SAFE_ERROR_NAMES.has(name) ? `name:${name}` : "name:UnknownError";
}

/** Emit one string. Diagnostic failures must never interrupt recovery or UI work.
 * @param {string} operation A fixed label from this module's allowlist.
 * @param {unknown} error The failure to classify, never forwarded to the sink.
 * @param {(message: string) => void} [sink] Optional owner-provided console sink.
 */
export function reportFailure(operation, error, sink) {
  const label = SAFE_OPERATIONS.has(operation) ? operation : "operation";
  try {
    const write = sink ?? console.warn;
    write(`EveryTab: ${label} failed [${classifyFailure(error)}]`);
  } catch {
    // Logging is best effort. Do not recursively log a broken logger.
  }
}
