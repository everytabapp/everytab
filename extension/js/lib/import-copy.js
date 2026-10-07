// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { IMPORT_FORMAT_IDS } from "./import-formats.js";
import { formatNumber, msg, pluralCategory } from "./i18n.js";

const FORMAT_MESSAGE_KEYS = Object.freeze({
  "everytab-markdown": "import_format_everytab_markdown",
  onetab: "import_format_onetab",
  "session-buddy": "import_format_session_buddy",
  "tab-session-manager": "import_format_tab_session_manager",
  toby: "import_format_toby",
  "raindrop-csv": "import_format_raindrop_csv",
  "bookmarks-html": "import_format_bookmarks_html"
});

/** Resolve a stable parser id into presentation copy. */
export function importFormatLabel(id) {
  return msg(FORMAT_MESSAGE_KEYS[id] ?? "import_format_generic");
}

/** Return localized picker options without coupling the parser to one language. */
export function importFormatOptions() {
  return IMPORT_FORMAT_IDS.map((id) => ({ id, label: importFormatLabel(id) }));
}

/** Localized Activity copy for a committed import. */
export function importJournalDescription(count, source) {
  const key = pluralCategory(count) === "one" ? "import_journal_one" : "import_journal_other";
  return msg(key, [formatNumber(count), importFormatLabel(source)]);
}

export function importDefaultSessionName() {
  return msg("import_default_session");
}
