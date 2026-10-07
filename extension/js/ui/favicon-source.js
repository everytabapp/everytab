// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Display icons without contacting a saved or imported favicon's server. */
export function cachedFaviconUrl(pageUrl) {
  if (typeof pageUrl !== "string" ||
      typeof globalThis.chrome?.runtime?.getURL !== "function") return "";
  try {
    if (!["http:", "https:"].includes(new URL(pageUrl).protocol)) return "";
    const cacheUrl = new URL(chrome.runtime.getURL("/_favicon/"));
    cacheUrl.searchParams.set("pageUrl", pageUrl);
    cacheUrl.searchParams.set("size", "32");
    return cacheUrl.href;
  } catch { return ""; }
}

/** Stored favicon bytes stay unchanged; only the display source is restricted. */
export function faviconSource(ref = {}) {
  const captured = ref.favIconUrl;
  // SVGs used as images cannot run scripts or load external resources.
  if (typeof captured === "string" &&
      /^data:image\/(?:png|jpeg|gif|webp|avif|x-icon|vnd\.microsoft\.icon|svg\+xml)(?:;|,)/i.test(captured)) {
    return captured;
  }
  try {
    const local = new URL(chrome.runtime.getURL("/"));
    const icon = new URL(captured);
    if (icon.protocol === local.protocol && icon.host === local.host) return icon.href;
  } catch { /* remote or malformed captured sources use the local cache */ }
  return cachedFaviconUrl(ref.url);
}
