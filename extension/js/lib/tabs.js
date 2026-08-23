/**
 * Shared tab-URL helpers. EVERY place that reads a tab's URL goes through
 * here — covers asleep/discarded tabs and legacy suspender extensions.
 */

/**
 * Unwrap URLs rewritten by suspender extensions (The Great Suspender forks,
 * Tab Suspender, etc.): chrome-extension://<id>/suspended.html#...&uri=https://real
 * @param {string} url
 * @returns {string}
 */
export function unwrapSuspendedUrl(url) {
  if (!url.startsWith("chrome-extension://")) return url;
  const m = url.match(/[#?&](?:uri|url)=(.+)$/);
  if (!m) return url;
  let target = m[1];
  if (/^https?%3A/i.test(target)) {
    // Encoded target: the encoded URL contains no literal "&" (they are "%26"),
    // so a literal "&" can only begin a trailing suspender param — e.g.
    // "…&icon=data:image/png;base64,…". Cut there before decoding so the favicon
    // (or any other packed metadata) never lands inside the real URL.
    target = target.split("&")[0];
    try {
      target = decodeURIComponent(target);
    } catch {
      /* keep as-is */
    }
  } else {
    // Unencoded target may legitimately contain "&" (a real query string), so
    // only strip a trailing data-URI icon/favicon blob, which a page URL never
    // carries — some suspenders pack "…&icon=data:image/…base64,…" after the uri.
    target = target.replace(/&(?:icon|favicon|favIconUrl)=data:.*$/i, "");
  }
  return /^https?:/.test(target) ? target : url;
}

/**
 * Real URL of a tab: discarded/unloaded tabs can have empty `url` with the
 * target in `pendingUrl`; suspender URLs get unwrapped.
 * @param {chrome.tabs.Tab} t
 */
export function urlOf(t) {
  return unwrapSuspendedUrl(t.url || t.pendingUrl || "");
}

/** Is this a saveable web page (after unwrapping)? @param {chrome.tabs.Tab} t */
export function isHttpTab(t) {
  return /^https?:/.test(urlOf(t));
}

/**
 * If the tab is parked on OUR suspend.html page, resolve the original tab it
 * represents. Our page is deliberately NOT unwrapped by unwrapSuspendedUrl()
 * (post-M3: the param is `originalUrl=`, not `url=`, so the page keeps its
 * suspend exemption) — but auto-archive must see through it: a suspended tab
 * is an idle http tab and should be archivable under its real URL.
 * @param {chrome.tabs.Tab} t
 * @returns {import("./types.js").TabRef | null} null if not our suspend page
 */
export function ownSuspendedRef(t) {
  const raw = t.url || t.pendingUrl || "";
  if (!raw.startsWith(chrome.runtime.getURL("suspend.html"))) return null;
  try {
    const params = new URL(raw).searchParams;
    const url = params.get("originalUrl") || "";
    if (!/^https?:/.test(url)) return null;
    return {
      url,
      title: params.get("title") || url,
      favIconUrl: params.get("favIconUrl") || undefined,
      pinned: t.pinned
    };
  } catch {
    return null;
  }
}

/**
 * F13 — the organize-time shape of a live tab: id + positional/recency metadata
 * plus its canonical URL/title, so a suspended tab reports its underlying page
 * and therefore sorts and gathers next to its awake siblings. DOM-free; the pure
 * planners in `organize.js` consume this shape.
 * @param {chrome.tabs.Tab} t @returns {import("./organize.js").OrganizeTab}
 */
export function organizeTabOf(t) {
  const ref = canonicalRef(t);
  return {
    id: t.id,
    url: ref?.url ?? urlOf(t),
    title: ref?.title ?? t.title ?? "",
    pinned: !!t.pinned,
    index: t.index,
    lastAccessed: t.lastAccessed,
    active: !!t.active
  };
}

/** @param {chrome.tabs.Tab} t @returns {import("./types.js").TabRef} */
export function toRef(t) {
  return {
    url: urlOf(t),
    title: t.title || urlOf(t) || "untitled",
    favIconUrl: t.favIconUrl,
    pinned: t.pinned
  };
}

/**
 * Is this tab parked on OUR suspend page? (Distinct from foreign suspenders,
 * which `urlOf` already unwraps.) The single predicate every feature uses to
 * decide "this is a suspended tab of ours".
 * @param {chrome.tabs.Tab} t
 */
export function isOwnSuspendPage(t) {
  return (t.url || t.pendingUrl || "").startsWith(chrome.runtime.getURL("suspend.html"));
}

/**
 * The canonical TabRef a tab represents: the underlying page if it's on our
 * suspend page, else the plain http(s) ref, else null (nothing saveable).
 * THE source of truth for "what page is this" across search, dedup, dumps,
 * sessions — so a suspended tab is never dropped or shown as `suspend.html?…`.
 * (Formerly `archive.js`'s private `archiveRef`.)
 * @param {chrome.tabs.Tab} t @returns {import("./types.js").TabRef | null}
 */
export function canonicalRef(t) {
  return ownSuspendedRef(t) ?? (isHttpTab(t) ? toRef(t) : null);
}

/**
 * Canonical URL of a tab: the underlying URL if suspended, else `urlOf`.
 * @param {chrome.tabs.Tab} t
 */
export function canonicalUrlOf(t) {
  return ownSuspendedRef(t)?.url ?? urlOf(t);
}

/**
 * Does this tab represent a saveable page (real http(s) or one of ours
 * suspended)? **Incognito tabs are never saveable** — EveryTab must never write
 * an incognito URL to storage/the vault, so excluding them here centrally keeps
 * them out of snapshots, sessions, dumps, and dedup (every capture path gates on
 * this). Display/search paths that read `canonicalRef` directly guard incognito
 * separately.
 */
export function isSaveableTab(t) {
  return saveableTabRef(t) !== null;
}

/**
 * Capture a live tab for persistence. Unlike `canonicalRef`, this adapter keeps
 * the tab's provenance long enough to enforce the incognito boundary before a
 * plain TabRef can reach Starred, Labels, Sessions, Snoozes, or the Vault.
 * Read-only presentation code may still use `canonicalRef` directly.
 * @param {chrome.tabs.Tab} t
 * @returns {import("./types.js").TabRef|null}
 */
export function saveableTabRef(t) {
  if (!t || t.incognito) return null;
  return canonicalRef(t);
}

/**
 * Whitelist match (case-insensitive): a pattern equals or suffix-matches the
 * hostname ("github.com" matches "gist.github.com"), or is a substring of the
 * full URL. Shared by the auto-save "Keep these tabs open" list (archive.js) and
 * the "Never suspend these" list (suspend.js, F9). Lives here (the lowest-level tab
 * module) so both can use it without an import cycle.
 * @param {string} url @param {string[]} [patterns]
 */
export function matchesWhitelist(url, patterns) {
  if (!patterns || patterns.length === 0) return false;
  const u = String(url || "").toLowerCase();
  let host = "";
  try {
    host = new URL(u).hostname;
  } catch {
    /* non-parsable URL: substring match still applies */
  }
  return patterns.some((raw) => {
    const p = String(raw).trim().toLowerCase();
    if (!p) return false;
    return host === p || host.endsWith("." + p) || u.includes(p);
  });
}
