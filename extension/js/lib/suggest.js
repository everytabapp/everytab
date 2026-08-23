/**
 * M6 onboarding — smart-view suggestions from browsing history.
 * Runs ONLY after the user grants the optional `history` permission via the
 * onboarding button (or later from the dashboard). The scan is local; nothing
 * leaves the machine.
 *
 * O1 quality filter: skip noise sources (webmail message URLs, photo viewers,
 * search-result pages, AI chats, and any non-http(s) URL such as our own
 * chrome-extension://…/suspend.html pages), and score each host by the number of
 * DISTINCT pages the user has (fragment-only variants collapse) — the "many tabs
 * of one site" signal (youtube, amazon, github, retail…), not raw visit churn.
 */
import { STORE_KEYS } from "./types.js";
import { listItems } from "./store.js";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function prettyName(host) {
  const base = host.split(".")[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Hosts that are apps/feeds, never a useful "many tabs" smart view. */
const BLOCK_HOSTS = [
  // webmail
  "mail.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com",
  "mail.yahoo.com", "mail.proton.me",
  // photo viewers
  "photos.google.com", "photos.apple.com",
  // AI chats
  "chat.openai.com", "chatgpt.com", "gemini.google.com", "bard.google.com", "claude.ai",
  "copilot.microsoft.com", "perplexity.ai", "poe.com", "grok.com"
];

/** Search engines — their result pages (/search or a `q` param) are noise. */
const SEARCH_HOST_RE = /(^|\.)(google|bing|duckduckgo|ecosia|startpage|baidu|yandex)\.[a-z.]+$/i;

/** @param {URL} u @returns {boolean} true if this history entry is noise to skip. */
function isNoiseUrl(u) {
  if (!/^https?:$/.test(u.protocol)) return true; // chrome-extension://, chrome://, file://…
  const host = u.hostname.replace(/^www\./, "");
  if (BLOCK_HOSTS.some((b) => host === b || host.endsWith("." + b))) return true;
  if (SEARCH_HOST_RE.test(host) && (u.pathname === "/search" || u.searchParams.has("q"))) return true;
  return false;
}

/**
 * Propose up to `maxSuggestions` domain smart views from the last `days` of
 * history. A host qualifies when it has at least `minVisits` DISTINCT pages
 * (fragment-only variants of one page collapse). Domains already covered by an
 * existing view (name or pattern) are skipped.
 * @param {{days?: number, maxSuggestions?: number, minVisits?: number}} [opts]
 * @returns {Promise<{name: string, field: "domain", pattern: string, scope: "all", count: number}[]>}
 */
export async function suggestSmartViews(opts = {}) {
  const { days = 30, maxSuggestions = 10, minVisits = 3 } = opts;
  if (!chrome.history) return [];

  let items;
  try {
    items = await chrome.history.search({
      text: "",
      startTime: Date.now() - days * 86_400_000,
      maxResults: 5000
    });
  } catch {
    return []; // permission missing or revoked
  }

  /** @type {Map<string, Set<string>>} host → set of distinct page keys (variant-collapsed) */
  const pages = new Map();
  for (const h of items) {
    let u;
    try {
      u = new URL(h.url);
    } catch {
      continue; // non-URL entries
    }
    if (isNoiseUrl(u)) continue;
    const host = u.hostname.replace(/^www\./, "");
    if (!host) continue;
    // Same host + path (+ query) collapses; the fragment is dropped, so a page
    // deep-linked by #hash (webmail threads, SPA routes) counts once, not many.
    const key = host + u.pathname + u.search;
    let set = pages.get(host);
    if (!set) { set = new Set(); pages.set(host, set); }
    set.add(key);
  }

  /** @type {import("./types.js").SmartView[]} */
  const existing = await listItems(STORE_KEYS.smartviews);
  const existingNames = new Set(existing.map((v) => v.name.toLowerCase()));
  const covered = (host) =>
    existing.some((v) => {
      try {
        const re = new RegExp(v.pattern, "i");
        return v.field === "domain" ? re.test(host) : re.test(`https://${host}/`);
      } catch {
        return false;
      }
    });

  const proposals = [];
  const scored = [...pages.entries()]
    .map(([host, set]) => [host, set.size])
    .sort((a, b) => b[1] - a[1]);
  for (const [host, count] of scored) {
    if (proposals.length >= maxSuggestions || count < minVisits) break;
    if (covered(host)) continue;
    let name = prettyName(host);
    if (existingNames.has(name.toLowerCase())) name = host;
    proposals.push({ name, field: "domain", pattern: `${escapeRe(host)}$`, scope: "all", count });
    existingNames.add(name.toLowerCase());
  }
  return proposals;
}
