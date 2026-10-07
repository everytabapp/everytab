// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { unwrapSuspendedUrl } from "./tabs.js";

const stripBom = (text) => String(text ?? "").replace(/^﻿/, "");

/** One list line emitted by linksToMarkdown(), or null. The URL side is
 * deliberately greedy so valid paths containing parentheses round-trip. */
function markdownLink(line) {
  const match = String(line ?? "").match(
    /^\s*[-*+]\s+\[((?:\\.|[^\]])*)\]\((https?:\/\/.*)\)\s*$/i
  );
  if (!match) return null;
  return {
    title: match[1].replace(/\\([\\[\]])/g, "$1"),
    url: match[2]
  };
}

function cleanName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function labelsFor(name, groupName) {
  const labels = [name];
  if (groupName && !/^Window\s+\d+$/i.test(groupName)) labels.push(groupName);
  return [...new Set(labels.map(cleanName).filter(Boolean))];
}

/** True only when text contains at least one EveryTab-style Markdown list link.
 * Inline prose links are deliberately not claimed by auto-detection. */
export function isEveryTabMarkdown(text) {
  return stripBom(text).split(/\r?\n/).some((line) => Boolean(markdownLink(line)));
}

/**
 * Parse EveryTab's human-readable share format into the common import shape.
 * An H1 names the import, H2 headings preserve window order, and only http(s)
 * list links become tabs. Generated Window headings stay structural; other
 * headings remain available through the Data page's labels toggle.
 * @param {string} text
 * @returns {{name: string, groups: {name: string,
 *   tabs: import("./types.js").TabRef[]}[], source: "everytab-markdown"}}
 */
export function parseEveryTabMarkdown(text) {
  const groups = [];
  let name = "";
  let sawWindowHeading = false;
  let current = { name: "", tabs: [] };
  const flush = () => {
    if (!current.tabs.length) return;
    groups.push(current);
    current = { name: "", tabs: [] };
  };

  for (const rawLine of stripBom(text).split(/\r?\n/)) {
    const h2 = rawLine.match(/^\s*##(?!#)\s+(.+?)\s*#*\s*$/);
    if (h2) {
      flush();
      sawWindowHeading = true;
      current.name = cleanName(h2[1]);
      continue;
    }
    const h1 = rawLine.match(/^\s*#(?!#)\s+(.+?)\s*#*\s*$/);
    if (h1 && !name) {
      name = cleanName(h1[1]);
      continue;
    }
    const link = markdownLink(rawLine);
    if (!link) continue;
    const url = unwrapSuspendedUrl(link.url.trim());
    if (!/^https?:/i.test(url)) continue;
    const title = cleanName(link.title) || url;
    const tab = { url, title };
    const labels = labelsFor(name, current.name);
    if (labels.length) tab.labels = labels;
    current.tabs.push(tab);
  }

  if (!sawWindowHeading && !current.name && name) current.name = name;
  flush();
  return { name: name || "Markdown import", groups, source: "everytab-markdown" };
}
