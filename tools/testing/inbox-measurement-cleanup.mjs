// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Release an owned measurement's resources even when an earlier close fails. */

/**
 * A resolved terminateOwnedChrome call certifies that the owned browser tree is
 * stopped (or was never created). Only then may its disposable profile be removed.
 * Original failures are retained in AggregateError.errors; report its fixed
 * message rather than logging those potentially sensitive error payloads.
 *
 * @param {{sessions?:Array<{close:()=>unknown}>,client?:{close:()=>unknown}|null,
 * browser?:unknown,profile?:string|null}} resources
 * @param {{terminateOwnedChrome:(browser:unknown)=>Promise<unknown>|unknown,
 * removeProfile:(profile:string)=>Promise<unknown>|unknown}} effects
 * @returns {Promise<void>} Rejects if any cleanup failed; never emits a success receipt.
 */
export async function cleanupInboxMeasurement({ sessions = [], client, browser, profile }, {
  terminateOwnedChrome, removeProfile
}) {
  const errors = [];
  for (const session of sessions) {
    try { await session.close(); } catch (error) { errors.push(error); }
  }
  if (client) {
    try { await client.close(); } catch (error) { errors.push(error); }
  }
  let stopped = false;
  try {
    await terminateOwnedChrome(browser);
    stopped = true;
  } catch (error) { errors.push(error); }
  if (stopped && profile) {
    try { await removeProfile(profile); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Inbox measurement cleanup failed");
}
