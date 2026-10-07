// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * suspend-page.js — drives the custom tab suspension page.
 * Reads original URL/title/favicon from query params; navigates back on any interaction.
 */
import { faviconSource } from "./favicon-source.js";
import { initTheme } from "./theme.js";
import { icon } from "./icons.js";
import { applyDocumentLocale, applyUiLanguage, msg } from "../lib/i18n.js";
import { getSettings } from "../lib/store.js";

// One Settings read installs the chosen interface language before the page
// writes its first text; theme.js already loads the store module graph here.
await applyUiLanguage((await getSettings()).uiLanguage);
applyDocumentLocale();
initTheme();

const params = new URLSearchParams(location.search);
const originalUrl = params.get("originalUrl") || "";
const title = params.get("title") || originalUrl || msg("suspend_page_default_title");
const favIconUrl = faviconSource({
  favIconUrl: params.get("favIconUrl") || "", url: originalUrl
});

// A restored/recovered extension page may have outlived the registry entry that
// protects it across the next reload. Reassert its own identity immediately;
// the worker validates sender.tab and the page URL before persisting anything.
try {
  chrome.runtime.sendMessage({ type: "adopt-suspended-page" }).catch(() => {});
} catch { /* extension context changed again; the recovery passes still retry */ }

// F12: the EveryTab ET mark stands in for the old sleep emoji.
document.getElementById("mark-wrap")?.append(icon("mark", 40));

// Tab-strip title: a plain "· suspended" suffix instead of the 💤 prefix.
document.title = msg("suspend_page_document_title", [title]);

document.getElementById("title").textContent = title;
document.getElementById("url").textContent = originalUrl;
document.getElementById("brand").textContent = msg("suspend_page_brand");
document.getElementById("wake-btn").textContent = msg("suspend_page_wake");
document.getElementById("hint").textContent = msg("suspend_page_hint");

if (favIconUrl) {
  const img = document.createElement("img");
  img.src = favIconUrl;
  img.className = "favicon";
  img.alt = ""; // decorative — the title text beside it is the accessible name
  img.onerror = () => img.remove();
  document.getElementById("favicon-wrap").appendChild(img);
}

// Keep the site's favicon in the TAB STRIP (user feedback: favicons are how you
// find a tab). Navigating to suspend.html would otherwise drop it. Extension
// pages can set their own via <link rel=icon>. Best effort: try to grey it out
// as a "resting" cue, but fall back to the full-color icon when the image is
// cross-origin (canvas taint) — being recognizable matters more than the tint.
function setTabFavicon(href) {
  let link = document.querySelector("link[rel~='icon']");
  if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.appendChild(link); }
  link.href = href;
}
if (favIconUrl) {
  setTabFavicon(favIconUrl);
  const probe = new Image();
  probe.crossOrigin = "anonymous"; // required to read the pixels back; no CORS → onerror
  probe.onload = () => {
    try {
      const s = probe.naturalWidth || 32;
      const cv = document.createElement("canvas");
      cv.width = s; cv.height = s;
      const c2 = cv.getContext("2d");
      c2.drawImage(probe, 0, 0, s, s);
      c2.globalCompositeOperation = "saturation"; // keep luminance + hue, drop saturation
      c2.fillStyle = "hsl(0,0%,50%)";
      c2.fillRect(0, 0, s, s);
      setTabFavicon(cv.toDataURL("image/png")); // throws if the canvas is tainted
    } catch { /* keep the full-color favicon */ }
  };
  probe.onerror = () => { /* no CORS / load failed → keep the full-color favicon */ };
  probe.src = favIconUrl;
}

let wakeStarted = false;
async function wake(e) {
  // Don't double-fire if the button itself is clicked (it bubbles to body too)
  e?.stopPropagation?.();
  if (!originalUrl || wakeStarted) return;
  wakeStarted = true;
  try {
    // Let the worker remove the recovery record before it navigates this tab.
    // Direct navigation remains the fallback if MV3 is unavailable.
    const result = await chrome.runtime.sendMessage({ type: "wake-suspended-page" });
    if (result?.ok) return;
  } catch { /* fall through to direct navigation */ }
  location.href = originalUrl;
}

document.getElementById("wake-btn").addEventListener("click", wake);

// Click anywhere else on the body also wakes
document.body.addEventListener("click", (e) => {
  if (e.target !== document.getElementById("wake-btn")) wake(e);
});

document.addEventListener("keydown", (e) => {
  // Browser Reload is a deliberate request to visit the resting tab again.
  // Keep ordinary typing out of this path and prevent a reload of suspend.html.
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey &&
      e.key?.toLowerCase() === "r") {
    e.preventDefault();
    void wake(e);
    return;
  }
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    void wake(e);
  }
});
