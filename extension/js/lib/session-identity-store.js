// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Storage-facing companion to the pure Session identity projection module. */
import { readStoreMap } from "./store.js";
import {
  SESSION_IDENTITY_INDEX_KEY, isSessionIdentityIndex
} from "./session-identity-index.js";

/**
 * Read only the compact Open identity projection through the active storage
 * authority. A missing pre-index profile returns an empty list rather than
 * opening automatic Snapshot recovery data.
 */
export async function readSessionIdentities() {
  const index = await readStoreMap(SESSION_IDENTITY_INDEX_KEY);
  if (!isSessionIdentityIndex(index)) return [];
  return Object.values(index.sessionsById).map((session) => ({ ...session }));
}
