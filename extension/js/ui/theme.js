/**
 * M6 — theme engine. Applies data-scheme / data-mode on <html> and the
 * .gradient class on <body> from settings, live-updates on settings changes,
 * and follows the OS for uiMode "system". Import from every UI surface.
 */
import {
  getSettings, mutateStores, patchSettings, settingsFromStored
} from "../lib/store.js";
import { STORE_KEYS } from "../lib/types.js";
import {
  SCHEMES, SCHEME_LABELS, SCHEME_ACCENTS, SCHEME_GROUPS, normalizeScheme
} from "../lib/schemes.js";
import {
  maybeRotateSchemeOnOpen, prepareNextSchemeOnOpen, rotationPool,
  SCHEME_ROTATION_PREPARED_KEY
} from "../lib/scheme-rotation.js";
import {
  CUSTOM_SCHEME_CSS_PROPERTIES,
  CUSTOM_SCHEME_NOTICE_KEY,
  resolveCustomSchemeMode,
  resolveSchemeSelection,
  runtimeCustomSchemeCssProperties
} from "../lib/custom-schemes.js";

export { SCHEMES, SCHEME_LABELS, SCHEME_ACCENTS, SCHEME_GROUPS } from "../lib/schemes.js";

const media = window.matchMedia("(prefers-color-scheme: dark)");
const CACHE_KEY = "tvTheme";
const RESERVATION_LOCK = "everytab-theme-reservation";
let applyGeneration = 0;
let ownedOpenCommitToken = null;
let awaitingWorkerOpenRotation = false;
const NEW_TAB_ROTATION_MESSAGE = "scheme-rotation-new-tab-ready";
const NEW_TAB_ROTATION_DIAGNOSTIC_PAINT_MESSAGE = "scheme-rotation-diagnostics-page-paint";
const APPEARANCE_DATA = {
  uiCheckboxShape: "checkboxShape",
  uiCornerStyle: "cornerStyle",
  uiRowInfo: "rowInfo",
  uiActionLabels: "actionLabels"
};
const readThemeCache = () => {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); }
  catch { return null; }
};
const rotationPoolKey = (settings, customRecords) =>
  rotationPool(settings.schemeFavorites, customRecords).join("|");

function cacheSnapshotIsOlder(next, current) {
  if (!current) return false;
  const nextSettings = Number(next?.settingsModifiedAt) || 0;
  const currentSettings = Number(current?.settingsModifiedAt) || 0;
  if (nextSettings !== currentSettings) return nextSettings < currentSettings;
  const nextCustom = Number(next?.customModifiedAt) || 0;
  const currentCustom = Number(current?.customModifiedAt) || 0;
  if (nextCustom !== currentCustom) return nextCustom < currentCustom;
  // Preparing a draw does not change ordinary Settings. At the same revision,
  // an older in-flight paint with no reservation must not erase a newer one.
  return current.selection === next.selection &&
    Boolean(current.preparedTheme) && !next.preparedTheme;
}

/* scheme-rotation-page-paint:test-seam:start */
function schemeRotationDiagnosticSelection(value, builtInSchemes = SCHEMES) {
  const canonical = {
    everforest: "matcha",
    catppuccin: "dracula",
    rosepine: "dracula"
  }[value] ?? value;
  if (builtInSchemes.includes(canonical)) return { kind: "built-in", id: canonical };
  if (value === "custom" ||
      (typeof value === "string" && value.startsWith("custom:"))) {
    return { kind: "custom" };
  }
  return { kind: value == null || value === "" ? "none" : "unknown" };
}
/* scheme-rotation-page-paint:test-seam:end */

async function reportNewTabDiagnosticPaint(capture) {
  if (!capture || !Number.isFinite(capture.armedUntil) || Date.now() > capture.armedUntil) return;
  const root = document.documentElement;
  const finalSelection = root.dataset.scheme === "custom"
    ? "custom"
    : root.dataset.scheme || null;
  try {
    await chrome.runtime.sendMessage({
      type: NEW_TAB_ROTATION_DIAGNOSTIC_PAINT_MESSAGE,
      bootSelection: schemeRotationDiagnosticSelection(
        globalThis.__everyTabBootThemeSelection ?? null
      ),
      finalSelection: schemeRotationDiagnosticSelection(finalSelection)
    });
  } catch { /* the bounded diagnostic is optional and never affects theming */ }
}

function clearCustomProperties(target) {
  for (const property of CUSTOM_SCHEME_CSS_PROPERTIES) target.style.removeProperty(property);
  delete target.dataset.customScheme;
}

function applyCustomProperties(target, properties) {
  clearCustomProperties(target);
  for (const property of CUSTOM_SCHEME_CSS_PROPERTIES) {
    if (typeof properties?.[property] === "string") {
      target.style.setProperty(property, properties[property]);
    }
  }
}

/**
 * Resolve the already-reserved next draw to concrete pre-paint attributes.
 * A detached probe reads that scheme's CSS variables without changing today's
 * page or producing a visible transition.
 */
function preparedThemeFor(settings, nextScheme, customRecords) {
  if (!nextScheme) return null;
  const resolved = resolveSchemeSelection(nextScheme, customRecords);
  const mode = resolveCustomSchemeMode(settings.uiMode, resolved, media.matches);
  if (resolved.kind === "custom") {
    const projected = runtimeCustomSchemeCssProperties(resolved.record, mode);
    if (!projected.ok) return null;
    return {
      scheme: "custom",
      selection: resolved.selection,
      customScheme: resolved.record.id,
      customProperties: projected.value,
      mode,
      bg: projected.value["--bg-solid"]
    };
  }
  const scheme = resolved.id;
  const probe = document.createElement("span");
  probe.dataset.scheme = scheme;
  probe.dataset.mode = mode;
  probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none";
  document.documentElement.append(probe);
  const bg = getComputedStyle(probe).getPropertyValue("--bg-solid").trim();
  probe.remove();
  return { scheme, selection: scheme, mode, bg };
}

/** Attach the next fully-resolved theme to the synchronous local cache. */
function cachePreparedTheme(cache, settings, preparedTheme, poolKey) {
  return {
    ...cache,
    schemeRotate: settings.schemeRotate,
    schemeRotationPoolKey: poolKey,
    preparedTheme
  };
}

function applyAppearanceData(root, source) {
  for (const [setting, dataKey] of Object.entries(APPEARANCE_DATA)) {
    if (typeof source?.[setting] === "string") root.dataset[dataKey] = source[setting];
  }
  // D4-3a: the remembered wide-layout navigation choice. Kept separate from the
  // effective `data-nav` mode, which the Dashboard shell derives from this plus
  // the live viewport, so a forced rail/header state never rewrites the choice.
  if (typeof source?.uiSidebarCollapsed === "boolean") {
    root.dataset.sidebar = source.uiSidebarCollapsed ? "collapsed" : "expanded";
  }
}

/**
 * Let at most one live EveryTab document reserve the next On-open scheme.
 * Storage changes are broadcast to every extension page, so queueing the same
 * transaction from each listener turns one click into N store-lock waits.
 * `ifAvailable` makes the other contexts skip instead of forming a queue.
 */
async function prepareNextSchemeOnce() {
  if (!navigator.locks?.request) return prepareNextSchemeOnOpen();
  return navigator.locks.request(
    RESERVATION_LOCK,
    { mode: "exclusive", ifAvailable: true },
    (lock) => lock === null ? undefined : prepareNextSchemeOnOpen()
  );
}

/**
 * Paint the last-known theme synchronously from localStorage for a host or test
 * harness that did not run the classic boot script. Production HTML runs
 * boot.js before CSS; initTheme deliberately does not reread this shared cache
 * after that pre-paint boundary. The async `apply()` reconciles the real value.
 */
function applyCached() {
  try {
    const c = readThemeCache();
    if (!c) return;
    const root = document.documentElement;
    const canUsePrepared = location.pathname.endsWith("/newtab.html") ||
      document.documentElement.dataset.newTabHost === "true";
    const painted = canUsePrepared && c.schemeRotate === "open" && c.preparedTheme
      ? c.preparedTheme : c;
    if (painted.scheme === "custom" && painted.customProperties) {
      root.dataset.scheme = "custom";
      root.dataset.customScheme = painted.customScheme ?? "";
      applyCustomProperties(root, painted.customProperties);
    } else {
      clearCustomProperties(root);
      root.dataset.scheme = normalizeScheme(painted.scheme);
    }
    if (painted.mode === "light" || painted.mode === "dark") root.dataset.mode = painted.mode;
    root.dataset.gradient = c.gradient ? "true" : "false";
    applyAppearanceData(root, c);
    document.body.classList.toggle("gradient", Boolean(c.gradient));
  } catch { /* corrupt cache → fall back to the HTML defaults */ }
}

async function apply() {
  const generation = ++applyGeneration;
  // One physical read keeps Settings, its revision, custom schemes, and the
  // prepared draw from different commits from being mixed into one cache.
  const snapshot = await chrome.storage.local.get([
    "settings", "settingsModifiedAt", STORE_KEYS.customSchemes,
    SCHEME_ROTATION_PREPARED_KEY
  ]);
  const s = settingsFromStored(snapshot.settings ?? {});
  const customRecords = snapshot[STORE_KEYS.customSchemes] ?? {};
  const storedPrepared = snapshot[SCHEME_ROTATION_PREPARED_KEY] ?? null;
  const settingsModifiedAt = Number(snapshot.settingsModifiedAt) || 0;
  // Multiple picker clicks and storage broadcasts can overlap. Only the most
  // recently requested reconciliation may touch the DOM or synchronous cache;
  // otherwise a slower read for an older choice can visibly undo the last click.
  if (generation !== applyGeneration) return;
  const root = document.documentElement;
  const resolved = resolveSchemeSelection(s.uiScheme, customRecords);
  const mode = resolveCustomSchemeMode(s.uiMode, resolved, media.matches);
  const scheme = resolved.kind === "custom" ? "custom" : resolved.id;
  if (resolved.kind === "custom") {
    const projected = runtimeCustomSchemeCssProperties(resolved.record, mode);
    if (projected.ok) {
      applyCustomProperties(root, projected.value);
      root.dataset.customScheme = resolved.record.id;
    }
  } else {
    clearCustomProperties(root);
  }
  root.dataset.scheme = scheme;
  root.dataset.mode = mode;
  root.dataset.gradient = s.uiGradient ? "true" : "false";
  applyAppearanceData(root, s);
  document.body.classList.toggle("gradient", Boolean(s.uiGradient));
  // Keep the synchronous paint caches fresh (js/boot.js reads these before CSS so
  // the pre-paint frame is themed, not white).
  const bg = getComputedStyle(root).getPropertyValue("--bg-solid").trim();
  if (bg) root.style.backgroundColor = bg;
  root.style.colorScheme = mode;
  try {
    const poolKey = rotationPoolKey(s, customRecords);
    const storedNext = s.schemeRotate === "open" &&
      storedPrepared?.from === resolved.selection &&
      storedPrepared?.poolKey === poolKey
      ? storedPrepared.next : null;
    // Always rebuild the synchronous pre-paint cache from the authoritative
    // reservation. This closes the race between our own settings write and the
    // storage listener, where a late generic apply() could otherwise erase the
    // prepared next draw and make On open look inert until after first paint.
    const prepared = preparedThemeFor(s, storedNext, customRecords);
    const currentProperties = resolved.kind === "custom"
      ? runtimeCustomSchemeCssProperties(resolved.record, mode).value
      : null;
    const selectedCustomModifiedAt = resolved.kind === "custom"
      ? Number(resolved.record?.modifiedAt) || 0 : 0;
    const cache = cachePreparedTheme({
      scheme, selection: resolved.selection, mode,
      ...(resolved.kind === "custom" ? {
        customScheme: resolved.record.id,
        customProperties: currentProperties
      } : {}),
      gradient: Boolean(s.uiGradient),
      newTabMode: s.newTabMode,
      newTabFocus: s.newTabFocus,
      uiSidebarCollapsed: s.uiSidebarCollapsed === true,
      settingsModifiedAt,
      customModifiedAt: selectedCustomModifiedAt,
      ...Object.fromEntries(Object.keys(APPEARANCE_DATA).map((key) => [key, s[key]]))
    }, s, prepared, poolKey);
    // Several live EveryTab pages reconcile the same storage broadcast. A
    // slower page that started on the previous commit must not replace the
    // shared pre-paint cache after a newer page has already written it.
    if (!cacheSnapshotIsOlder(cache, readThemeCache())) {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
      if (bg) localStorage.setItem("tvBg", bg);
    }
  } catch { /* private mode / quota — non-fatal */ }
  if (resolved.missingCustomRef) {
    try {
      await mutateStores([CUSTOM_SCHEME_NOTICE_KEY], () => ({
        [CUSTOM_SCHEME_NOTICE_KEY]: {
          at: Date.now(),
          missing: resolved.missingCustomRef,
          message: "A missing custom color scheme was replaced with Cream."
        }
      }));
      await patchSettings({ uiScheme: "cream" });
    } catch { /* safe visual fallback already painted */ }
  }
}

/** Call once per page. Keeps the page themed for its whole life. */
export function initTheme() {
  // boot.js already painted before CSS. Re-reading the origin-wide cache here
  // can apply a different reservation if another live EveryTab page updated it
  // during module loading. Harnesses without the classic boot still use the
  // synchronous fallback.
  if (!globalThis.__everyTabBootThemeSelection) applyCached();
  // New Tab owns the one visible On-open draw. Every utility surface merely
  // reserves and caches the next draw, so Popup, side panel, Dashboard,
  // Settings, the editor, and suspended pages never change the selected scheme.
  // The manifest URL is New Tab's
  // immutable identity; the data marker remains useful to Dashboard code but
  // is deliberately not required for rotation after async entry boot.
  const isNewTabOverride = location.pathname.endsWith("/newtab.html") ||
    document.documentElement.dataset.newTabHost === "true";
  const canRotateOnOpen = isNewTabOverride;
  void (async () => {
    if (canRotateOnOpen) {
      if (isNewTabOverride && chrome.runtime?.sendMessage) {
        awaitingWorkerOpenRotation = true;
        let workerOwned = false;
        let diagnosticsCapture = null;
        try {
          const response = await chrome.runtime.sendMessage({ type: NEW_TAB_ROTATION_MESSAGE });
          workerOwned = response?.ok === true;
          diagnosticsCapture = response?.diagnosticsCapture ?? null;
        } catch { /* a cold/restarting worker falls back to the page-owned path */ }
        if (workerOwned) {
          awaitingWorkerOpenRotation = false;
          await apply();
          await reportNewTabDiagnosticPaint(diagnosticsCapture);
          return;
        }
        awaitingWorkerOpenRotation = false;
        ownedOpenCommitToken = crypto.randomUUID();
        await maybeRotateSchemeOnOpen(Math.random, ownedOpenCommitToken);
        await apply();
        await reportNewTabDiagnosticPaint(diagnosticsCapture);
        return;
      }
      ownedOpenCommitToken = crypto.randomUUID();
      await maybeRotateSchemeOnOpen(Math.random, ownedOpenCommitToken);
      // The page that owns the draw also owns its visible completion. A storage
      // broadcast keeps other contexts synchronized but is not a reliable
      // completion signal for the writer itself.
      await apply();
      return;
    }
    await prepareNextSchemeOnce();
    await apply();
  })();
  media.addEventListener("change", () => apply());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings || changes[STORE_KEYS.customSchemes]) {
      const rotationCommitPrepared = SCHEME_ROTATION_PREPARED_KEY in changes;
      const ownsRotationCommit = rotationCommitPrepared &&
        changes[SCHEME_ROTATION_PREPARED_KEY]?.newValue?.commitToken === ownedOpenCommitToken;
      // The opening page applies its own transaction directly above. Skip only
      // that exact broadcast; all other EveryTab contexts still repaint once.
      if (ownsRotationCommit) return;
      // A real New Tab is waiting for the worker-owned, tab-id-deduplicated
      // transaction. Its final apply() reads the authoritative commit once, so
      // an earlier broadcast must not create a duplicate opening repaint.
      if (awaitingWorkerOpenRotation && rotationCommitPrepared) return;
      // Paint the authoritative selection before doing any reservation write.
      // The store lock is shared by every EveryTab context, so coupling paint to
      // `prepareNextSchemeOnOpen()` made a perfectly saved picker choice look
      // inert whenever another page briefly owned that lock. The follow-up waits
      // for this first paint as well, which guarantees its prepared cache is the
      // final write even if the reservation itself resolves first.
      const livePaint = apply();
      void livePaint.catch(() => {});
      const settingChange = changes.settings;
      const before = settingChange?.oldValue ?? {};
      const after = settingChange?.newValue ?? {};
      const rotationInputsChanged = Boolean(changes[STORE_KEYS.customSchemes]) ||
        before.uiScheme !== after.uiScheme ||
        before.schemeRotate !== after.schemeRotate ||
        JSON.stringify(before.schemeFavorites ?? []) !== JSON.stringify(after.schemeFavorites ?? []);
      // An On-open rotation commit already carries its successor reservation in
      // the same atomic write. Re-reserving from every listener is both
      // redundant and the source of the cross-context loading/selection stall.
      if (rotationInputsChanged && !rotationCommitPrepared) {
        void Promise.all([
          livePaint.catch(() => null),
          prepareNextSchemeOnce()
        ]).then(([, nextScheme]) => nextScheme === undefined ? null : apply()).catch(() => {});
      }
    }
  });
}
