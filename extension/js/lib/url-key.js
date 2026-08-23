/**
 * Lightweight URL identity shared by storage projections and duplicate/search
 * features. Keep this module dependency-free: Session index construction runs
 * inside store.js and must not pull the journal/counter/store graph back into
 * itself.
 *
 * @param {string} url
 * @param {{ignoreQuery?: boolean}} [opts]
 */
export function normalizeUrl(url, opts = {}) {
  try {
    const u = new URL(url);
    u.hash = "";
    if (opts.ignoreQuery) u.search = "";
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return url;
  }
}
