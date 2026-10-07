// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Locale-backed compact relative age shared by Search and saved-list rows. */
import { formatNumber, msg } from "./i18n.js";

export function compactRelativeAge(timestamp, now = Date.now()) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return msg("age_just_now");
  const seconds = Math.max(0, Math.floor((now - value) / 1000));
  if (seconds < 60) return msg("age_just_now");
  if (seconds < 3600) return msg("age_minutes", [formatNumber(Math.floor(seconds / 60))]);
  if (seconds < 86400) return msg("age_hours", [formatNumber(Math.floor(seconds / 3600))]);
  return msg("age_days", [formatNumber(Math.floor(seconds / 86400))]);
}
