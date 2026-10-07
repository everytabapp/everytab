// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { findDuplicateGroupsFromTabs } from "../lib/dedup.js";
import { readDuplicateDomainRules } from "../lib/duplicate-domain-rules.js";

/** Tabs that the Open page actually presents: ordinary, non-private windows. */
export function ordinaryWindowTabs(windows) {
  return (windows ?? [])
    .filter((window) => (!window.type || window.type === "normal") && !window.incognito)
    .flatMap((window) => window.tabs ?? [])
    .filter((tab) => !tab.incognito);
}

/**
 * One display batch's lazy tab snapshot and duplicate projection. Create a new
 * instance for every batch or explicit rescan; never use it to validate actions.
 * A failed read stays failed for this batch instead of mixing two snapshots.
 */
export function createDisplayTabReads(options = {}) {
  const {
    groupTabs = findDuplicateGroupsFromTabs,
    queryWindows = () => chrome.windows.getAll({ populate: true }),
    readRules = readDuplicateDomainRules
  } = options ?? {};
  const queryTabs = options?.queryTabs ?? (() =>
    Promise.resolve().then(queryWindows).then(ordinaryWindowTabs));
  let tabsRead;
  let rulesRead;
  let groupsRead;
  const tabs = () => tabsRead ??= Promise.resolve().then(queryTabs);
  const rules = () => rulesRead ??= Promise.resolve().then(readRules);
  const groups = () => groupsRead ??= Promise.all([tabs(), rules()])
    .then(([snapshot, domainRules]) => groupTabs(snapshot, domainRules));
  return { tabs, rules, groups };
}
