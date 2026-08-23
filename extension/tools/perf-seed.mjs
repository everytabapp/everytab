/**
 * E3-0 — deterministic perf-dataset seeder (e3-performance-pass.md §2/§3.1).
 *
 * Generates, per tier, a standard EveryTab JSON export file that is loaded
 * through the EXISTING Data-page import ("Import JSON") — no new write path,
 * so the E2-0 §5.4 guardrail is untouched (the import path `importJson` is a
 * sanctioned writer). Also generates a bookmarks-HTML file whose per-window
 * folders can be "Open all (N)"-ed to reach the tier's open-tab counts
 * (open tabs can't be seeded through storage).
 *
 * Run from `extension/`:
 *     node tools/perf-seed.mjs t2            # writes ./everytab-perf-t2.json + …-open-tabs.html
 *     node tools/perf-seed.mjs t3 /tmp/seed  # optional output directory
 *
 * Determinism: one seeded PRNG (mulberry32) drives everything; timestamps are
 * fixed offsets from a constant base date; ids are sequential. Running the
 * script twice produces byte-identical files, so measurement passes are
 * comparable across sessions and machines.
 *
 * NOTE (§7 protocol): snooze dueAt values are set FAR FUTURE (2030+) on
 * purpose — near-past due times would make the background sweep fire hundreds
 * of snoozes on the first worker start after import, polluting the profile.
 *
 * `test/perf.mjs` imports `buildTierData` / `buildOpenTabs` directly, so the
 * micro-bench and the browser seed share one fixture definition.
 */

import { SCHEMA_VERSION, STORE_KEYS } from "../js/lib/types.js";

/* ---------------- tiers (e3-performance-pass.md §2) ---------------- */

export const TIERS = {
  t1: { openTabs: 40, openWindows: 2, inboxTabs: 150, archiveTabs: 1000, sessions: 10, labels: 20, snoozes: 10 },
  t2: { openTabs: 150, openWindows: 6, inboxTabs: 1500, archiveTabs: 10000, sessions: 40, labels: 120, snoozes: 60 },
  t3: { openTabs: 400, openWindows: 12, inboxTabs: 5000, archiveTabs: 40000, sessions: 150, labels: 400, snoozes: 200 }
};

/* ---------------- deterministic PRNG ---------------- */

/** mulberry32 — tiny, seedable, good enough for fixture skew. @param {number} seed */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- realistic-ish URL / title / label pools ---------------- */

// Head domains carry most of the traffic (domain-skewed distribution: ~60% of
// tabs land on these), mirroring a real browsing profile.
const HEAD_DOMAINS = [
  "github.com", "docs.google.com", "youtube.com", "stackoverflow.com",
  "mail.google.com", "en.wikipedia.org", "news.ycombinator.com", "reddit.com",
  "twitter.com", "linkedin.com", "notion.so", "figma.com"
];
const MID_DOMAINS = [
  "developer.mozilla.org", "medium.com", "nytimes.com", "amazon.com",
  "chatgpt.com", "claude.ai", "calendar.google.com", "drive.google.com",
  "slack.com", "web.whatsapp.com", "maps.google.com", "netflix.com",
  "spotify.com", "bbc.com", "theguardian.com", "arxiv.org"
];

const TITLE_WORDS = [
  "guide", "review", "notes", "draft", "plan", "spec", "issue", "thread",
  "release", "budget", "recipe", "travel", "photos", "meeting", "design",
  "report", "howto", "setup", "api", "docs", "tutorial", "changelog",
  "roadmap", "invoice", "summary", "analysis", "checklist", "ideas"
];

const LABEL_SEEDS = [
  "work", "research", "read-later", "recipes", "travel", "finance", "home",
  "project-x", "shopping", "learning", "music", "health", "news", "tools",
  "inspiration", "family", "urgent", "reference", "video", "archive-2025"
];

/* ---------------- generators ---------------- */

function makeGen(rnd) {
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));

  /** Domain-skewed pick: 60% head, 25% mid, 15% long tail. */
  const domain = () => {
    const r = rnd();
    if (r < 0.6) return pick(HEAD_DOMAINS);
    if (r < 0.85) return pick(MID_DOMAINS);
    return `site${int(1, 400)}.example.com`;
  };

  const url = () => {
    const d = domain();
    const depth = int(1, 3);
    const segs = [];
    for (let i = 0; i < depth; i++) segs.push(`${pick(TITLE_WORDS)}-${int(1, 9999)}`);
    // A recognizable slice of GitHub URLs are PR pages so the built-in
    // "GitHub PRs" smart view matches a realistic subset at every tier.
    if (d === "github.com" && rnd() < 0.4) return `https://github.com/org${int(1, 40)}/repo${int(1, 200)}/pull/${int(1, 5000)}`;
    if (d === "youtube.com" && rnd() < 0.7) return `https://youtube.com/watch?v=v${int(10000, 99999)}`;
    return `https://${d}/${segs.join("/")}`;
  };

  const title = () => {
    const n = int(2, 6);
    const words = [];
    for (let i = 0; i < n; i++) words.push(pick(TITLE_WORDS));
    return words.join(" ");
  };

  return { pick, int, domain, url, title };
}

/**
 * Build the label name pool for a tier: the 20 seeds, then `topic-N` fillers.
 * @param {number} count
 */
export function buildLabelPool(count) {
  const out = [...LABEL_SEEDS.slice(0, Math.min(count, LABEL_SEEDS.length))];
  for (let i = out.length; i < count; i++) out.push(`topic-${i + 1}`);
  return out;
}

// Fixed time base: 2026-07-01T00:00:00Z. All record timestamps are
// deterministic offsets BEFORE this base (so listItems' modifiedAt sort is
// realistic); snooze dueAt values sit far future (see the header note).
const BASE = Date.UTC(2026, 6, 1);
const DAY = 86_400_000;
const FUTURE = Date.UTC(2030, 0, 1);

/**
 * Deterministic full export payload for a tier — the exact shape
 * `buildJsonExport` writes and the Data page's "Import JSON" reads.
 * @param {keyof typeof TIERS} tier
 * @returns {{payload: object, stats: object}}
 */
export function buildTierData(tier) {
  const cfg = TIERS[tier];
  if (!cfg) throw new Error(`unknown tier "${tier}" (use t1|t2|t3)`);
  const rnd = mulberry32(0xe3_0000 + tier.charCodeAt(1));
  const g = makeGen(rnd);
  const labels = buildLabelPool(cfg.labels);
  let seq = 0;
  const id = () => `et-perf-${tier}-${(++seq).toString(36).padStart(6, "0")}`;

  // Zipf-ish label pick: rank-weighted so a few labels dominate (like real
  // usage) while `assignAll` below still guarantees every label ≥ 1 tab.
  const labelPick = () => labels[Math.floor(labels.length * Math.pow(rnd(), 2.2))];

  const meta = (ageDays) => {
    const created = BASE - Math.floor(ageDays * DAY);
    return {
      id: id(),
      deviceId: "et-perf-seeder",
      createdAt: created,
      modifiedAt: created + g.int(0, 6) * 3_600_000,
      schemaVersion: SCHEMA_VERSION
    };
  };

  const tabRef = (withLabel) => {
    const t = { url: g.url(), title: g.title() };
    if (rnd() < 0.3) t.favIconUrl = `https://${g.domain()}/favicon.ico`;
    if (withLabel) t.labels = [labelPick(), ...(rnd() < 0.15 ? [labelPick()] : [])];
    return t;
  };

  /** Bundle-mixing item builder: ~70% single tabs, rest window bundles. */
  const buildItems = (tabBudget, archived) => {
    const map = {};
    let tabs = 0;
    let queue = 0; // labels owed to `assignAll`
    while (tabs < tabBudget) {
      const isBundle = rnd() < 0.3 && tabBudget - tabs > 3;
      const n = isBundle ? Math.min(g.int(4, 12), tabBudget - tabs) : 1;
      const m = meta(g.int(0, 90) + rnd());
      const refs = [];
      for (let i = 0; i < n; i++) refs.push(tabRef(rnd() < (archived ? 0.2 : 0.3)));
      const item = {
        ...m,
        kind: n > 1 ? "window" : "tab",
        tabs: refs,
        source: g.pick(["dump", "manual", "auto-archive", "dump", "snooze"]),
        labels: rnd() < 0.1 ? [labelPick()] : [] // legacy item-grain labels too
      };
      if (archived) item.archivedAt = m.modifiedAt;
      if (rnd() < 0.03) item.deletedAt = m.modifiedAt + 1; // a few tombstones — real maps have them
      map[item.id] = item;
      tabs += n;
      queue += n;
    }
    return map;
  };

  const inbox = buildItems(cfg.inboxTabs, false);
  const archive = buildItems(cfg.archiveTabs, true);

  // Sessions: ~1/5 auto snapshots, the rest named; 1–3 windows × 4–14 tabs.
  const sessions = {};
  for (let s = 0; s < cfg.sessions; s++) {
    const auto = s % 5 === 4;
    const m = meta(g.int(0, 120) + rnd());
    const windows = [];
    const wn = g.int(1, 3);
    for (let w = 0; w < wn; w++) {
      const row = [];
      const tn = g.int(4, 14);
      for (let t = 0; t < tn; t++) row.push(tabRef(!auto && rnd() < 0.15));
      windows.push(row);
    }
    const sess = { ...m, name: auto ? `Snapshot ${s}` : `${g.pick(TITLE_WORDS)} session ${s + 1}`, auto, windows, labels: [] };
    sessions[sess.id] = sess;
  }

  // Snoozes: mostly single-tab; ~1/5 window snoozes; a few recurring.
  const snoozes = {};
  for (let s = 0; s < cfg.snoozes; s++) {
    const m = meta(g.int(0, 30) + rnd());
    const due = FUTURE + g.int(0, 365) * DAY; // far future — never fires during a measurement pass
    const isWindow = s % 5 === 0;
    const sn = isWindow
      ? { ...m, url: "", title: `Window (${g.int(2, 6)} tabs)`, dueAt: due, tabs: Array.from({ length: g.int(2, 6) }, () => tabRef(false)) }
      : { ...m, ...tabRef(false), dueAt: due };
    if (s % 7 === 0) sn.recurrence = "weekly";
    snoozes[sn.id] = sn;
  }

  // Guarantee every label in the pool is carried by ≥ 1 live inbox tab, so the
  // Labels page really renders `cfg.labels` cards at this tier.
  const liveInbox = Object.values(inbox).filter((i) => !i.deletedAt);
  labels.forEach((label, i) => {
    const item = liveInbox[i % liveInbox.length];
    const ref = item.tabs[i % item.tabs.length];
    ref.labels = [...new Set([...(ref.labels ?? []), label])];
  });

  const payload = {
    app: "tabvault",
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date(BASE).toISOString(), // fixed — determinism over honesty here
    settings: {},
    data: {
      [STORE_KEYS.inbox]: inbox,
      [STORE_KEYS.archive]: archive,
      [STORE_KEYS.sessions]: sessions,
      [STORE_KEYS.collections]: {},
      [STORE_KEYS.snoozes]: snoozes,
      [STORE_KEYS.smartviews]: {}
    }
  };
  const count = (m) => Object.keys(m).length;
  const tabCount = (m) => Object.values(m).reduce((n, i) => n + (i.tabs?.length ?? 0), 0);
  const stats = {
    tier,
    inboxItems: count(inbox), inboxTabs: tabCount(inbox),
    archiveItems: count(archive), archiveTabs: tabCount(archive),
    sessions: count(sessions), snoozes: count(snoozes), labels: labels.length
  };
  return { payload, stats };
}

/**
 * Deterministic open-tab fixture for a tier — chrome.tabs.query({})-shaped
 * objects (used by `test/perf.mjs` mocks) grouped into windows.
 * @param {keyof typeof TIERS} tier
 */
export function buildOpenTabs(tier) {
  const cfg = TIERS[tier];
  if (!cfg) throw new Error(`unknown tier "${tier}"`);
  const rnd = mulberry32(0x0e30 + tier.charCodeAt(1));
  const g = makeGen(rnd);
  const tabs = [];
  const perWin = Math.ceil(cfg.openTabs / cfg.openWindows);
  for (let i = 0; i < cfg.openTabs; i++) {
    tabs.push({
      id: 1000 + i,
      windowId: 1 + Math.floor(i / perWin),
      index: i % perWin,
      url: g.url(),
      title: g.title(),
      pinned: false,
      incognito: false
    });
  }
  return tabs;
}

/** Bookmarks-HTML (NETSCAPE format) with one folder per window — "Open all"-able. */
export function buildOpenTabsHtml(tier) {
  const tabs = buildOpenTabs(tier);
  const wins = new Map();
  for (const t of tabs) {
    if (!wins.has(t.windowId)) wins.set(t.windowId, []);
    wins.get(t.windowId).push(t);
  }
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    "<META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">",
    `<TITLE>EveryTab perf ${tier} open tabs</TITLE>`,
    `<H1>EveryTab perf ${tier} open tabs</H1>`,
    "<DL><p>"
  ];
  for (const [winId, list] of wins) {
    lines.push(`  <DT><H3>Perf ${tier} window ${winId} (${list.length} tabs)</H3>`);
    lines.push("  <DL><p>");
    for (const t of list) lines.push(`    <DT><A HREF="${esc(t.url)}">${esc(t.title)}</A>`);
    lines.push("  </DL><p>");
  }
  lines.push("</DL><p>");
  return lines.join("\n");
}

/* ---------------- CLI ---------------- */

const isMain = import.meta.url === new URL(`file://${process.argv[1]}`.replace(/\\/g, "/")).href ||
  process.argv[1]?.endsWith("perf-seed.mjs");

if (isMain && typeof process !== "undefined") {
  const [, , tierArg, outDir = "."] = process.argv;
  const tier = (tierArg ?? "").toLowerCase();
  if (!TIERS[tier]) {
    console.error("usage: node tools/perf-seed.mjs <t1|t2|t3> [outDir]");
    process.exit(1);
  }
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { payload, stats } = buildTierData(tier);
  const jsonPath = path.join(outDir, `everytab-perf-${tier}.json`);
  const htmlPath = path.join(outDir, `everytab-perf-${tier}-open-tabs.html`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(payload)); // compact — T3 is large
  fs.writeFileSync(htmlPath, buildOpenTabsHtml(tier));
  console.log(`wrote ${jsonPath} (${(fs.statSync(jsonPath).size / 1e6).toFixed(1)} MB)`);
  console.log(`wrote ${htmlPath}`);
  console.table([stats]);
  console.log("Load: dashboard → Data → Import JSON → pick the .json file.");
  console.log("Open tabs: import the .html into Chrome bookmarks, then right-click each folder → Open all (in new window).");
}
