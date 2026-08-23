/**
 * N2 — synchronous pre-paint boot. Loaded as the FIRST <head> tag on every
 * extension page as a CLASSIC external script (MV3's CSP forbids inline scripts,
 * so this must be a separate file), which makes it run before the stylesheet and
 * before first paint. It:
 * Applies the cached theme (data-scheme / data-mode + a solid background and
 * color-scheme) so the pre-CSS frame is themed instead of white.
 *
 * D4-3a: it also resolves the Dashboard's navigation mode before first paint, so
 * a remembered icon rail never paints expanded and then jumps. The two width
 * numbers below are the same measured boundaries js/lib/nav-mode.js exports;
 * this file is a classic script and cannot import them.
 *
 * Caches it reads (localStorage, all written by js/ui/theme.js apply()):
 *   tvTheme       {scheme, mode, gradient, uiCheckboxShape,
 *                  uiCornerStyle, uiRowInfo, uiActionLabels,
 *                  uiSidebarCollapsed, customProperties?}
 *   tvBg          the computed --bg-solid color for the current scheme × mode
 *
 * Everything is best-effort: any failure (corrupt cache, private mode) is
 * swallowed so the normal module boot still runs.
 */
(function () {
  try {
    var root = document.documentElement;

    var t = JSON.parse(localStorage.getItem("tvTheme") || "null");
    if (t) {
      var canUsePrepared = location.pathname.endsWith("/newtab.html");
      var painted = canUsePrepared && t.schemeRotate === "open" && t.preparedTheme
        ? t.preparedTheme : t;
      // The module theme engine treats this as the completed synchronous paint
      // boundary. It must not reread the shared cache after another context has
      // had a chance to replace its prepared draw.
      globalThis.__everyTabBootThemeSelection = painted.selection || painted.scheme;
      // Permanent pre-paint aliases preserve removed/renamed beta palettes
      // without a first-frame flash before the module normalizer runs.
      if (painted.scheme === "everforest") painted.scheme = "matcha";
      if (painted.scheme === "catppuccin" || painted.scheme === "rosepine") painted.scheme = "dracula";
      if (typeof painted.scheme === "string") root.setAttribute("data-scheme", painted.scheme);
      if (painted.scheme === "custom" && painted.customProperties) {
        var customProperties = [
          "--bg-solid", "--surface", "--surface-2", "--border", "--ink", "--ink-2", "--ink-3",
          "--accent", "--accent-ink", "--accent-strong", "--accent-strong-ink",
          "--ok", "--warn", "--danger", "--bg-grad"
        ];
        customProperties.forEach(function (property) {
          if (typeof painted.customProperties[property] === "string") {
            root.style.setProperty(property, painted.customProperties[property]);
          }
        });
        if (typeof painted.customScheme === "string") {
          root.setAttribute("data-custom-scheme", painted.customScheme);
        }
      }
      if (painted.mode === "light" || painted.mode === "dark") {
        root.setAttribute("data-mode", painted.mode);
        root.style.colorScheme = painted.mode; // themes even the UA's very first frame
      }
      root.setAttribute("data-gradient", t.gradient ? "true" : "false");
      var appearance = {
        uiCheckboxShape: "checkbox-shape",
        uiCornerStyle: "corner-style",
        uiRowInfo: "row-info",
        uiActionLabels: "action-labels"
      };
      Object.keys(appearance).forEach(function (key) {
        if (typeof t[key] === "string") root.setAttribute("data-" + appearance[key], t[key]);
      });
    }

    // D4-3a pre-paint navigation mode. Mirrors js/lib/nav-mode.js exactly:
    // header at or below 620px, rail at or below 900px or when the user
    // collapsed it, otherwise the full labelled sidebar.
    var collapsed = Boolean(t && t.uiSidebarCollapsed === true);
    root.setAttribute("data-sidebar", collapsed ? "collapsed" : "expanded");
    var w = window.innerWidth || 0;
    root.setAttribute("data-nav", w <= 620 ? "header" : (w <= 900 || collapsed) ? "rail" : "expanded");

    var bg = painted && painted.bg ? painted.bg : localStorage.getItem("tvBg");
    if (bg) root.style.backgroundColor = bg;

    // E3-4r3: start the Dashboard's critical path from the first classic head
    // script, before stylesheets and module evaluation. `newtab-entry.js` still
    // checks the authoritative Settings value; a stale local cache can only
    // cause harmless unused reads. The direct dashboard always opts in.
    var isNewTab = location.pathname.endsWith("/newtab.html");
    var isDashboard = location.pathname.endsWith("/dashboard.html");
    var prewarmDashboard = isDashboard || (isNewTab && (!t || t.newTabMode === "dashboard"));
    if (prewarmDashboard) {
      // Let Chrome fetch/compile the 0.6 MB Dashboard module graph while CSS and
      // Settings load instead of discovering it only after newtab-entry awaits.
      var preload = document.createElement("link");
      preload.rel = "modulepreload";
      preload.href = chrome.runtime.getURL("js/ui/dashboard.js");
      document.head.appendChild(preload);

      // Only the New Tab entry consumes this early live-window snapshot.
      // Direct dashboard.html starts Open from dashboard.js, so creating the
      // promise here would issue a second populated query with no consumer.
      if (isNewTab) {
        var earlyWindows = chrome.windows.getAll({ populate: true }).catch(function () { return null; });
        globalThis.__everyTabEarlyOpenWindows = earlyWindows;
      }
    }

  } catch (e) {
    /* fall through to the normal module boot */
  }
})();
