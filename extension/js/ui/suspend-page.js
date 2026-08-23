/**
 * suspend-page.js — drives the custom tab suspension page.
 * Reads original URL/title/favicon from query params; navigates back on any interaction.
 */
import { initTheme } from "./theme.js";
import { icon } from "./icons.js";

initTheme();

const params = new URLSearchParams(location.search);
const originalUrl = params.get("originalUrl") || "";
const title = params.get("title") || originalUrl || "Suspended tab";
const favIconUrl = params.get("favIconUrl") || "";

// F12: the EveryTab ET mark stands in for the old sleep emoji.
document.getElementById("mark-wrap")?.append(icon("mark", 40));

// Tab-strip title: a plain "· suspended" suffix instead of the 💤 prefix.
document.title = `${title} · suspended`;

document.getElementById("title").textContent = title;
document.getElementById("url").textContent = originalUrl;

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

function wake(e) {
  // Don't double-fire if the button itself is clicked (it bubbles to body too)
  e?.stopPropagation?.();
  if (originalUrl) location.href = originalUrl;
}

document.getElementById("wake-btn").addEventListener("click", wake);

// Click anywhere else on the body also wakes
document.body.addEventListener("click", (e) => {
  if (e.target !== document.getElementById("wake-btn")) wake(e);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    if (originalUrl) location.href = originalUrl;
  }
});
