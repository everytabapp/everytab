// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Localized disclosure copy for the optional browser History permission. */
import { msg } from "../lib/i18n.js";

export const historyAccessCopy = Object.freeze({
  details: () => msg("history_access_copy"),
  trust: () => msg("history_access_trust"),
  purpose: () => msg("history_access_purpose"),
  allow: () => msg("history_access_allow"),
  notNow: () => msg("history_access_not_now"),
  denied: () => msg("history_access_denied")
});
