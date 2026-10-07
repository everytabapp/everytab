// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Pure builders for the non-authoritative, human-readable Vault views. */
import { hydrateEmbeddedFavicons } from "../lib/storage/assets.js";
import {
  requireSupportedEntity,
  requireSupportedFamily,
  requireSupportedValue
} from "../lib/storage/record-format.js";

export const READABLE_LIBRARY_KIND = "vault-v2-readable-library";

function sortedValues(records = {}) {
  return Object.values(records).sort((left, right) =>
    String(left?.name ?? left?.title ?? left?.id ?? "").localeCompare(
      String(right?.name ?? right?.title ?? right?.id ?? "")
    ) || String(left?.id ?? "").localeCompare(String(right?.id ?? ""))
  );
}

function oneLine(value, fallback = "Untitled") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function markdownText(value, fallback) {
  return oneLine(value, fallback).replace(/([\\\[\]*_`])/g, "\\$1");
}

function markdownLink(tab) {
  const title = markdownText(tab?.title || tab?.url, "Untitled tab");
  if (typeof tab?.url !== "string" || !tab.url) return title;
  try {
    const url = encodeURI(tab.url).replace(/</g, "%3C").replace(/>/g, "%3E");
    return `[${title}](<${url}>)`;
  } catch {
    return title;
  }
}

function noun(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function tabsInItem(item) {
  return Array.isArray(item?.tabs) ? item.tabs.length : 0;
}

function tabsInSession(session) {
  return Array.isArray(session?.windows)
    ? session.windows.reduce((total, window) => total + (window?.length ?? 0), 0)
    : 0;
}

function labelsIn(families) {
  const labels = new Set();
  const add = (values) => {
    for (const label of values ?? []) {
      if (typeof label === "string" && label) labels.add(label);
    }
  };
  const visitTab = (tab) => add(tab?.labels);
  for (const family of ["inbox", "archive"]) {
    for (const item of sortedValues(families[family])) {
      add(item?.labels);
      (item?.tabs ?? []).forEach(visitTab);
    }
  }
  for (const session of sortedValues(families.sessions)) {
    add(session?.labels);
    (session?.windows ?? []).forEach((window) => window.forEach(visitTab));
  }
  const labelMeta = families.labelMeta?.current?.value;
  if (labelMeta && typeof labelMeta === "object") add(Object.keys(labelMeta));
  return [...labels].sort((left, right) => left.localeCompare(right));
}

function groupedMembers(kind, members, families) {
  const known = new Map(members.map((member) => [member.key, member.label]));
  const rawGroups = sortedValues(families.organizationGroups)
    .filter((group) => group?.organizationKind === kind && group?.name);
  const canonicalByName = new Map();
  const canonicalById = new Map();
  for (const group of rawGroups) {
    const normalized = oneLine(group.name).toLocaleLowerCase();
    const canonical = canonicalByName.get(normalized) ?? group;
    canonicalByName.set(normalized, canonical);
    canonicalById.set(group.id, canonical);
  }
  const memberKeysByGroup = new Map(
    [...canonicalByName.values()].map((group) => [group.id, new Set()])
  );
  const groupedKeys = new Set();
  for (const edge of sortedValues(families.organizationMemberships)) {
    if (edge?.organizationKind !== kind || !known.has(edge.memberKey)) continue;
    const group = canonicalById.get(edge.groupId);
    if (!group) continue;
    memberKeysByGroup.get(group.id)?.add(edge.memberKey);
    groupedKeys.add(edge.memberKey);
  }
  const groups = [...canonicalByName.values()]
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .map((group) => ({
      name: group.name,
      members: [...(memberKeysByGroup.get(group.id) ?? [])]
        .map((key) => known.get(key))
        .sort((left, right) => left.localeCompare(right))
    }));
  return {
    groups,
    ungrouped: members
      .filter(({ key }) => !groupedKeys.has(key))
      .map(({ label }) => label)
      .sort((left, right) => left.localeCompare(right))
  };
}

/** Build a self-contained live-data projection from one exact Library checkpoint. */
export function buildReadableLibrary(checkpoint, {
  vaultId,
  inputHash,
  generatedAt
}) {
  // Validate the complete checkpoint before deriving a view. Tombstones are
  // intentionally omitted below, but an unknown tombstone still signals that
  // this client cannot safely interpret the source checkpoint.
  for (const entity of checkpoint?.entities ?? []) requireSupportedEntity(entity);
  const assets = new Map((checkpoint?.assets ?? []).map((asset) => [asset.digest, asset]));
  const families = {};
  const live = (checkpoint?.entities ?? [])
    .filter((entity) => entity?.lifecycle === "live")
    .sort((left, right) => left.family.localeCompare(right.family) || left.id.localeCompare(right.id));
  for (const entity of live) {
    (families[entity.family] ??= {})[entity.id] =
      hydrateEmbeddedFavicons(entity.value, assets);
  }
  return {
    app: "everytab",
    kind: READABLE_LIBRARY_KIND,
    formatVersion: 1,
    vaultId,
    inputHash,
    generatedAt,
    libraryContentHash: checkpoint.contentHash,
    summary: {
      records: live.length,
      families: Object.fromEntries(
        Object.entries(families).map(([family, records]) => [family, Object.keys(records).length])
      )
    },
    families
  };
}

/** Build the concise browsing view from the readable live-data projection. */
export function buildReadableIndex(readable) {
  const families = readable?.families ?? {};
  // The readable projection is a public input boundary too. Validate every
  // family, including empty ones, and every value before selecting index rows.
  for (const [family, records] of Object.entries(families)) {
    requireSupportedFamily(family);
    for (const value of Object.values(records ?? {})) requireSupportedValue(value);
  }
  const inbox = sortedValues(families.inbox);
  const archive = sortedValues(families.archive);
  const sessions = sortedValues(families.sessions).filter((session) => session?.auto !== true);
  const snoozes = sortedValues(families.snoozes);
  const starred = sortedValues(families.starred)
    .sort((left, right) => (left.position ?? Infinity) - (right.position ?? Infinity));
  const collections = sortedValues(families.collections);
  const labels = labelsIn(families);
  const labelGroups = groupedMembers(
    "label", labels.map((label) => ({ key: label, label })), families
  );
  const sessionGroups = groupedMembers(
    "session", sessions.map((session) => ({ key: session.id, label: session.name })), families
  );
  const inboxTabs = inbox.reduce((total, item) => total + tabsInItem(item), 0);
  const archiveTabs = archive.reduce((total, item) => total + tabsInItem(item), 0);
  const sessionTabs = sessions.reduce((total, session) => total + tabsInSession(session), 0);
  const generatedDay = new Date(readable.generatedAt).toISOString().slice(0, 10);
  const lines = [
    "# EveryTab Vault",
    "",
    `<!-- EveryTab readable view ${readable.inputHash} -->`,
    "",
    `_Generated ${generatedDay}. Rebuilt after saved data changes. Do not edit._`,
    "",
    "## Overview",
    "",
    `- Inbox: ${noun(inbox.length, "item")}, ${noun(inboxTabs, "tab")}`,
    `- Archive: ${noun(archive.length, "item")}, ${noun(archiveTabs, "tab")}`,
    `- Sessions: ${noun(sessions.length, "session")}, ${noun(sessionTabs, "tab")}`,
    `- Snoozed: ${noun(snoozes.length, "item")}`,
    `- Starred: ${noun(starred.length, "page")}`,
    `- Labels: ${noun(labels.length, "label")}`,
    ""
  ];

  const appendGroups = (title, projection) => {
    lines.push(`## ${title} (${projection.groups.length})`, "");
    for (const group of projection.groups) {
      lines.push(`### ${markdownText(group.name, "Untitled group")} (${group.members.length})`, "");
      for (const member of group.members) lines.push(`- ${markdownText(member, "Untitled")}`);
      lines.push("");
    }
    if (projection.ungrouped.length > 0) {
      lines.push(`### Ungrouped (${projection.ungrouped.length})`, "");
      for (const member of projection.ungrouped) lines.push(`- ${markdownText(member, "Untitled")}`);
      lines.push("");
    }
  };

  appendGroups("Label groups", labelGroups);
  appendGroups("Session groups", sessionGroups);

  lines.push(`## Sessions (${sessions.length})`, "");
  for (const session of sessions) {
    const windows = session.windows?.length ?? 0;
    const tabs = tabsInSession(session);
    lines.push(
      `### ${markdownText(session.name, "Untitled Session")} · ${noun(windows, "window")}, ${noun(tabs, "tab")}`,
      ""
    );
    for (const window of session.windows ?? []) {
      for (const tab of window) lines.push(`- ${markdownLink(tab)}`);
    }
    lines.push("");
  }

  if (collections.length > 0) {
    lines.push(`## Collections (${collections.length})`, "");
    for (const collection of collections) {
      lines.push(
        `### ${markdownText(collection.name, "Untitled Collection")} (${noun(tabsInItem(collection), "tab")})`,
        ""
      );
      for (const tab of collection.tabs ?? []) lines.push(`- ${markdownLink(tab)}`);
      lines.push("");
    }
  }

  if (starred.length > 0) {
    lines.push(`## Starred (${starred.length})`, "");
    for (const tab of starred) lines.push(`- ${markdownLink(tab)}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
