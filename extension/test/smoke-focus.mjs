export async function runSmokeFocus({ check, local }) {
  const mem = local;
  /* --- F8-1: Focus domain model + settings defaults (focus-mode.md §5.1, §5.3, §8) --- */
  {
    const { canonicalizeDomain, hostMatchesDomain, ruleIndexForDomain, resolveFocusEndTime } =
      await import("../js/lib/focus.js");
    const { DEFAULT_SETTINGS } = await import("../js/lib/types.js");
    const { getSettings } = await import("../js/lib/store.js");
  
    // defaults + stable stored values
    check(DEFAULT_SETTINGS.focusDefaultEndMode === "duration", "F8-1: default end mode is 'duration'");
    check(DEFAULT_SETTINGS.focusDefaultDurationMinutes === 60, "F8-1: default duration is 60 minutes");
    check(DEFAULT_SETTINGS.focusMorningEndMinutes === 720, "F8-1: default morning end = 12:00 (720)");
    check(DEFAULT_SETTINGS.focusDayEndMinutes === 1080, "F8-1: default day end = 18:00 (1080)");
    check(DEFAULT_SETTINGS.focusMinimizeOtherWindows === true, "F8-1: minimize-other-windows default true");
    check(Array.isArray(DEFAULT_SETTINGS.focusSiteRules) && DEFAULT_SETTINGS.focusSiteRules.length === 0,
      "F8-1: default site rules empty");
    check(DEFAULT_SETTINGS.focusExceptionStyle === "immediate", "F8-1: default exception style 'immediate'");
    check(DEFAULT_SETTINGS.focusTemporaryEndAction === "next-navigation",
      "F8-1: default temporary-end action 'next-navigation'");
  
    // an old partial settings object receives Focus defaults without losing values
    mem.settings = { uiScheme: "nord", autoArchiveDays: 3 }; // a pre-Focus install
    const migrated = await getSettings();
    check(migrated.uiScheme === "nord" && migrated.autoArchiveDays === 3,
      "F8-1: existing settings values are preserved");
    check(migrated.focusDefaultEndMode === "duration" && migrated.focusMorningEndMinutes === 720 &&
      migrated.focusExceptionStyle === "immediate" && Array.isArray(migrated.focusSiteRules) &&
      migrated.focusMinimizeOtherWindows === true,
      "F8-1: an old settings object receives Focus defaults");
    delete mem.settings; // don't leak into any later test
  
    // normalization
    const okDomain = (input, expected, name) => {
      const r = canonicalizeDomain(input);
      check(r.ok && r.domain === expected && r.displayDomain === expected, `${name} (got ${JSON.stringify(r)})`);
    };
    okDomain("Example.COM", "example.com", "F8-1: uppercase host lowercased");
    okDomain("https://example.com/path?q=1#frag", "example.com",
      "F8-1: pasted URL keeps host, drops path/query/fragment");
    okDomain("www.example.com", "example.com", "F8-1: leading www. stripped");
    okDomain("http://user:pass@example.com:8080/x", "example.com",
      "F8-1: credentials + port + path discarded");
    okDomain("example.com:8080", "example.com", "F8-1: bare host:port keeps just the host");
  
    // exact + subdomain match, no lookalikes; matches a hostname not a URL substring
    check(hostMatchesDomain("example.com", "example.com"), "F8-1: matches itself");
    check(hostMatchesDomain("video.example.com", "example.com"), "F8-1: matches a subdomain");
    check(!hostMatchesDomain("notexample.com", "example.com"), "F8-1: rejects a lookalike suffix");
    check(!hostMatchesDomain("example.com.evil.com", "example.com"), "F8-1: rejects a deeper lookalike");
  
    // HTTP(S) accepted, everything else rejected with a clear reason (never throws)
    check(canonicalizeDomain("http://example.com").ok, "F8-1: http URL accepted");
    check(canonicalizeDomain("https://example.com").ok, "F8-1: https URL accepted");
    const rejects = {
      "": "empty",
      "   ": "empty",
      "*.example.com": "wildcard",
      "chrome://settings": "scheme",
      "javascript:alert(1)": "scheme",
      "ftp://files.example.com": "scheme",
      "file:///etc/hosts": "scheme",
      "192.168.0.1": "ip",
      "http://[::1]/": "ip",
      "localhost": "localhost",
      "com": "single-label",
      "example": "single-label",
      "https://bob:secret@": "malformed",
      // F8-1r: DNS-label hardening — the URL parser accepts these; DNS does not.
      "-foo.com": "malformed",       // label begins with a hyphen
      "foo-.com": "malformed",       // label ends with a hyphen
      "a-.b.com": "malformed",       // malformed interior label
      "-.com": "malformed"           // single-char hyphen label
    };
    for (const [input, reason] of Object.entries(rejects)) {
      const r = canonicalizeDomain(input);
      check(!r.ok && r.reason === reason,
        `F8-1: rejects ${JSON.stringify(input)} as ${reason} (got ${JSON.stringify(r)})`);
    }
    // F8-1r: a label over 63 chars, and a hostname over 253 chars, are rejected.
    check(!canonicalizeDomain("a".repeat(64) + ".com").ok, "F8-1r: over-long label rejected");
    const overlongHost = Array(5).fill("a".repeat(60)).join(".") + ".com"; // 308 chars
    const overlong = canonicalizeDomain(overlongHost);
    check(!overlong.ok && overlong.reason === "malformed", "F8-1r: over-long hostname rejected");
    // Interior double hyphens stay valid so IDN/punycode labels keep working.
    check(canonicalizeDomain("ab--cd.com").ok, "F8-1r: an interior double hyphen is still valid");
    check(canonicalizeDomain("a".repeat(63) + ".com").ok, "F8-1r: a 63-char label is allowed");
  
    // IDN handled through the platform parser, stored in the safe ASCII canonical form
    const idn = canonicalizeDomain("münchen.de");
    check(idn.ok && idn.domain === "xn--mnchen-3ya.de", `F8-1: IDN punycoded (got ${JSON.stringify(idn)})`);
    check(canonicalizeDomain("xn--mnchen-3ya.de").domain === "xn--mnchen-3ya.de",
      "F8-1: punycode input stays canonical");
    check(hostMatchesDomain("shop.xn--mnchen-3ya.de", idn.domain),
      "F8-1: an IDN rule matches its subdomain in canonical form");
  
    // duplicate detection used by the settings editor
    const rules = [{ domain: "a.com" }, { domain: "b.com" }];
    check(ruleIndexForDomain(rules, "b.com") === 1, "F8-1: ruleIndexForDomain finds an existing rule");
    check(ruleIndexForDomain(rules, "c.com") === -1, "F8-1: ruleIndexForDomain returns -1 when absent");
  
    // end-time modes, deterministic under an injected `now`
    const at10 = new Date("2026-06-10T10:00:00").getTime(); // local wall-clock
    const at20 = new Date("2026-06-10T20:00:00").getTime();
    const oneHour = resolveFocusEndTime({ mode: "duration", durationMinutes: 60, now: at10 });
    check(oneHour.ok && oneHour.endsAt === at10 + 60 * 60000, "F8-1: 1 hour = now + 60 min");
    const custom90 = resolveFocusEndTime({ mode: "duration", durationMinutes: 90, now: at10 });
    check(custom90.ok && custom90.endsAt === at10 + 90 * 60000, "F8-1: custom duration honored");
    check(!resolveFocusEndTime({ mode: "duration", durationMinutes: 0, now: at10 }).ok,
      "F8-1: a zero/absent duration is invalid");
    // F8-1r: a small positive fraction would round to a zero-length run — reject it.
    check(!resolveFocusEndTime({ mode: "duration", durationMinutes: 0.4, now: at10 }).ok,
      "F8-1r: a sub-minute fractional duration is invalid");
    check(!resolveFocusEndTime({ mode: "duration", durationMinutes: 0.99, now: at10 }).ok,
      "F8-1r: a just-under-one-minute duration is invalid");
    // F8-1r: every successful timed run ends at a finite time strictly after now.
    for (const dm of [1, 1.2, 5, 60, 1440]) {
      const r = resolveFocusEndTime({ mode: "duration", durationMinutes: dm, now: at10 });
      check(r.ok && Number.isFinite(r.endsAt) && r.endsAt > at10,
        `F8-1r: duration ${dm} yields a finite endsAt > now`);
    }
    // F8-1r2: an overflowing finite duration must not yield Infinity — reject it.
    check(!resolveFocusEndTime({ mode: "duration", durationMinutes: Number.MAX_VALUE, now: at10 }).ok,
      "F8-1r2: an overflowing duration (Number.MAX_VALUE) is rejected");
    check(!resolveFocusEndTime({ mode: "duration", durationMinutes: 1e306, now: at10 }).ok,
      "F8-1r2: a huge finite duration whose ms product overflows to Infinity is rejected");
    // A merely large (but non-overflowing) finite duration stays valid + finite.
    const big = resolveFocusEndTime({ mode: "duration", durationMinutes: 1e300, now: at10 });
    check(big.ok && Number.isFinite(big.endsAt) && big.endsAt > at10,
      "F8-1r2: a large non-overflowing duration stays finite and > now");
  
    const morningBefore = resolveFocusEndTime({ mode: "morning-end", morningEndMinutes: 720, now: at10 });
    check(morningBefore.ok && new Date(morningBefore.endsAt).getHours() === 12 &&
      new Date(morningBefore.endsAt).getDate() === 10, "F8-1: morning end before boundary = today 12:00");
    const morningAfter = resolveFocusEndTime({ mode: "morning-end", morningEndMinutes: 720, now: at20 });
    check(morningAfter.ok && new Date(morningAfter.endsAt).getDate() === 11 &&
      new Date(morningAfter.endsAt).getHours() === 12, "F8-1: morning end after boundary = tomorrow 12:00");
    const dayBefore = resolveFocusEndTime({ mode: "day-end", dayEndMinutes: 1080, now: at10 });
    check(dayBefore.ok && new Date(dayBefore.endsAt).getHours() === 18 &&
      new Date(dayBefore.endsAt).getDate() === 10, "F8-1: day end before boundary = today 18:00");
    const dayAfter = resolveFocusEndTime({ mode: "day-end", dayEndMinutes: 1080, now: at20 });
    check(dayAfter.ok && new Date(dayAfter.endsAt).getDate() === 11, "F8-1: day end after boundary = tomorrow");
  
    check(resolveFocusEndTime({ mode: "manual", now: at10 }).endsAt === null,
      "F8-1: manual mode is open-ended (null end, no alarm)");
    const futureCustom = resolveFocusEndTime({ mode: "custom", customAt: at10 + 5 * 60000, now: at10 });
    check(futureCustom.ok && futureCustom.endsAt === at10 + 5 * 60000, "F8-1: a future custom date is accepted");
    check(!resolveFocusEndTime({ mode: "custom", customAt: at10 - 1000, now: at10 }).ok,
      "F8-1: a past custom date is rejected");
    check(!resolveFocusEndTime({ mode: "bogus", now: at10 }).ok, "F8-1: an unknown mode is invalid");
  
    // F8-1 introduces NO operational Focus state as a setting
    for (const k of ["focusState", "focusOpenOnce", "focusTemporaryAccess",
                     "focusBlockedAttempts", "focusReturnUrls"]) {
      check(!(k in DEFAULT_SETTINGS), `F8-1: operational key ${k} is not a setting`);
    }
  }
  
  /* --- F8-1/P11-21: still no page-content permission --- */
  {
    const fs = await import("node:fs");
    const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
    // F18 moved `tabGroups` from install-time `permissions` to `optional_permissions`
    // (requested from a user gesture); F14 adds the warning-free `sidePanel` and
    // P11-21 adds warning-free `search` for explicit default-provider handoff.
    // There is still no host/DNR/content access.
    const expectedPerms = ["tabs", "storage", "unlimitedStorage",
                           "alarms", "notifications", "contextMenus", "search", "sessions", "sidePanel"];
    check(JSON.stringify(manifest.permissions) === JSON.stringify(expectedPerms),
      "F8-1/F18: install-time permissions are the expected set (no host permissions / DNR / content scripts)");
    check(JSON.stringify(manifest.optional_permissions) === JSON.stringify(["history", "tabGroups"]),
      "F18: optional permissions are history + tabGroups");
    check(!("host_permissions" in manifest) && !("content_scripts" in manifest) &&
      !("declarative_net_request" in manifest),
      "F8-1: no host_permissions, content_scripts, or DNR");
  }
  
  /* --- F8-1: no em dash in the new Focus user-facing copy (brand rule) --- */
  {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../js/ui/settings-form.js", import.meta.url), "utf8");
    const start = src.indexOf("F8: Focus group");
    const end = src.indexOf("const groupNodes =", start);
    check(start >= 0 && end > start, "F8-1: Focus settings block located for copy lint");
    // Lint the copy, not the comments: strip block + line comments, then the
    // remaining string literals must be free of the banned em dash.
    const copy = src.slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    check(!copy.includes("—"), "F8-1: no em dash in the Focus settings copy");
  }
  
  /* ================= F8-R1: Workspace Focus retirement =================
   * focus-mode.md §9, §12.1. Focus v0.2 removed the unreliable window/session
   * "Workspace Focus" experiment. `js/lib/focus-retirement.js` is what remains: a
   * RESTORATION-ONLY compatibility drain for a legacy `focusState`. A controllable
   * window world (state/incognito/focused per window, restore, alarms, isolated
   * storage, and an ordered/deferred late-minimize model) drives the REAL retirement
   * service through the §12.1 characterizations A1-A9. The old start/switch/hide/
   * minimize/render window-session tests were removed with the feature. */
  {
    const retire = await import("../js/lib/focus-retirement.js");
    const ALARM = retire.FOCUS_ALARM;
    const baseChrome = globalThis.chrome;
    // Shrink poll/retry/quiet so the drain converges at ~zero time (never real time);
    // transitions commit by request count / read count in the mock below, not the clock.
    retire.configureFocusRetirement({ maxRequests: 3, pollsPerRequest: 3, pollIntervalMs: 0, retryMs: 1000, quietPolls: 2 });
  
    // A self-contained window world. It never MINIMIZES on its own; `minimizeRequests`
    // records any minimize the code under test issues (must stay empty — the drain only
    // restores). `commitAfter`/`commitOnRead`/`lateMinimize` model a lagging or late
    // native transition so the quiet-proof + retry paths are exercised.
    function makeWorld(winSpecs) {
      const store = {};
      const alarms = {};
      let windows = winSpecs.map((w) => ({ type: "normal", incognito: false, focused: false, state: "normal", ...w }));
      const world = {
        store, alarms, updateRequests: [], minimizeRequests: [],
        commitAfter: new Map(),      // id -> number of accepted-but-uncommitted requests before it lands
        commitOnRead: new Map(),     // id -> number of reads after which the last request commits
        requestedState: new Map(),
        lateMinimize: new Set(),     // id -> an OLDER minimize still queued ahead of a corrective request
        _pendingLateMin: new Set(),
        get windows() { return windows; },
        win: (id) => windows.find((w) => w.id === id),
        close: (id) => { windows = windows.filter((w) => w.id !== id); },
        setState: (id, s) => { const w = windows.find((x) => x.id === id); if (w) w.state = s; }
      };
      world.chrome = {
        ...baseChrome,
        storage: { local: {
          get: async (keys) => {
            if (keys == null) return { ...store };
            if (typeof keys === "string") return keys in store ? { [keys]: store[keys] } : {};
            const out = {}; for (const k of keys) if (k in store) out[k] = store[k]; return out;
          },
          set: async (obj) => { Object.assign(store, obj); },
          remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; }
        } },
        alarms: {
          create: async (name, info) => { alarms[name] = info; },
          clear: async (name) => { const had = name in alarms; delete alarms[name]; return had; }
        },
        windows: {
          getAll: async () => windows.map((w) => ({ ...w })),
          get: async (id) => {
            const w = windows.find((x) => x.id === id);
            if (!w) throw new Error("no window " + id);
            // An OLDER queued minimize lands now (after a newer corrective request acknowledged).
            if (world._pendingLateMin.has(id)) { w.state = "minimized"; world._pendingLateMin.delete(id); return { ...w }; }
            if (world.commitOnRead.has(id)) {
              const n = world.commitOnRead.get(id) - 1;
              if (n <= 0) { const to = world.requestedState.get(id); if (to) w.state = to; world.commitOnRead.delete(id); }
              else world.commitOnRead.set(id, n);
            }
            return { ...w };
          },
          update: async (id, props) => {
            const w = windows.find((x) => x.id === id);
            if (!w) throw new Error("no window " + id);
            if (props.state) {
              world.updateRequests.push({ id, state: props.state });
              if (props.state === "minimized") world.minimizeRequests.push(id);
              // A corrective (non-minimized) request while an OLDER minimize is queued does not
              // commit and does not cancel it — the minimize lands on the next read.
              if (props.state !== "minimized" && world.lateMinimize.has(id)) {
                world.lateMinimize.delete(id); world._pendingLateMin.add(id); return { ...w };
              }
              world.requestedState.set(id, props.state);
              if (world.commitOnRead.has(id)) { /* deferred to reads */ }
              else { const pending = world.commitAfter.get(id) ?? 0; if (pending > 0) world.commitAfter.set(id, pending - 1); else w.state = props.state; }
            }
            if (props.focused) { for (const x of windows) x.focused = false; w.focused = true; }
            return { ...w };
          }
        }
      };
      return world;
    }
    const useWorld = (winSpecs) => { const world = makeWorld(winSpecs); globalThis.chrome = world.chrome; return world; };
    // A legacy Workspace-Focus run as a pre-v0.2 install would still hold it.
    const legacy = (minimized, extra = {}) => ({
      id: "legacy", startedAt: 1, endsAt: null, label: "Work",
      target: { kind: "window", windowIds: [1] }, minimized, ...extra
    });
  
    /* -- the pure duration + display helpers survive for Batch 2; the retired
     *    window/session status builder (buildFocusStatus) is gone -- */
    {
      const focus = await import("../js/lib/focus.js");
      const focusCopy = await import("../js/lib/focus-copy.js");
      check(!("buildFocusStatus" in focus),
        "F8-R1: buildFocusStatus (the retired window/session run status) is gone from focus.js");
      const now = 1_000_000;
      const dflt = focus.resolveEndChoice(undefined, { focusDefaultEndMode: "duration", focusDefaultDurationMinutes: 25 }, now);
      check(dflt.ok && dflt.endsAt === now + 25 * 60000, "F8-R1: resolveEndChoice defaults kept (reused by Batch 2)");
      check(focus.resolveEndChoice({ mode: "manual" }, {}, now).endsAt === null, "F8-R1: resolveEndChoice manual stays open-ended");
      check(focusCopy.formatRemaining(now + 65 * 60000, now) === "1h 5m", "F8-R1: formatRemaining still formats 1h 5m");
      const info = focus.nextWallClockInfo(now, 0);
      check(typeof info.at === "number" && typeof info.isTomorrow === "boolean", "F8-R1: nextWallClockInfo kept");
    }
  
    /* -- A1: normal/maximized/fullscreen records restore to prior; clears when visible -- */
    {
      const w = useWorld([{ id: 1, focused: true }, { id: 2, state: "minimized" },
        { id: 3, state: "minimized" }, { id: 4, state: "minimized" }]);
      w.store.focusState = legacy([
        { windowId: 2, priorState: "normal" },
        { windowId: 3, priorState: "maximized" },
        { windowId: 4, priorState: "fullscreen" }
      ]);
      const r = await retire.drainLegacyFocus();
      check(r.complete === true, "A1: the retirement drain completes");
      check(w.win(2).state === "normal" && w.win(3).state === "maximized" && w.win(4).state === "fullscreen",
        "A1: each recorded window is restored to its prior state");
      check(!("focusState" in w.store), "A1: focusState clears only after every window is visibly non-minimized");
      check(!(ALARM in w.alarms), "A1: the legacy alarm is cleared");
      check(w.minimizeRequests.length === 0, "A1: the drain issues no minimize request");
    }
  
    /* -- A2: a pre-minimized / unrecorded window is never touched -- */
    {
      const w = useWorld([{ id: 1, focused: true }, { id: 2, state: "minimized" }, { id: 9, state: "minimized" }]);
      w.store.focusState = legacy([{ windowId: 2, priorState: "normal" }]); // window 9 is NOT recorded
      await retire.drainLegacyFocus();
      check(w.win(2).state === "normal", "A2: the recorded window restores");
      check(w.win(9).state === "minimized", "A2: an unrecorded pre-minimized window stays minimized");
      check(!w.updateRequests.some((u) => u.id === 9), "A2: no request is issued for the unrecorded window");
      check(!("focusState" in w.store), "A2: state clears");
    }
  
    /* -- A3: a user-restored recorded window is pruned without being forced back -- */
    {
      const w = useWorld([{ id: 1, focused: true }, { id: 2, state: "maximized" }]); // record: minimized-from-normal, now visible
      w.store.focusState = legacy([{ windowId: 2, priorState: "normal" }]);
      await retire.drainLegacyFocus();
      check(w.win(2).state === "maximized", "A3: a user-restored recorded window keeps the user's state (not forced to prior)");
      check(!w.updateRequests.some((u) => u.id === 2), "A3: no state request is issued for the already-visible window");
      check(!("focusState" in w.store), "A3: the resolved record is pruned and state clears");
    }
  
    /* -- A4: a closed recorded window is pruned -- */
    {
      const w = useWorld([{ id: 1, focused: true }, { id: 2, state: "minimized" }]);
      w.store.focusState = legacy([{ windowId: 2, priorState: "normal" }, { windowId: 7, priorState: "normal" }]); // 7 closed
      await retire.drainLegacyFocus();
      check(w.win(2).state === "normal", "A4: the live recorded window restores");
      check(!("focusState" in w.store), "A4: a closed recorded window is pruned and state clears");
    }
  
    /* -- A5: a visible pendingMinimize record is not cleared on one read; quiet-proof
     *       corrects a late legacy minimize before the record is dropped -- */
    {
      const w = useWorld([{ id: 1, focused: true }, { id: 2, state: "normal" }]);
      w.store.focusState = legacy([{ windowId: 2, priorState: "normal", pendingMinimize: true }]);
      w.lateMinimize.add(2); // an older accepted minimize lands right after the corrective request
      const r = await retire.drainLegacyFocus();
      check(r.complete === true && w.win(2).state === "normal",
        "A5: quiet-proof restores a late-committed legacy minimize on a visible pending record");
      check(!("focusState" in w.store), "A5: state clears only after the quiet proof completes");
    }
  
    /* -- A6: an unresolved restore retains ONLY the unresolved record under phase:ending
     *       and arms exactly one calm retry alarm; A7: recovery resumes it idempotently -- */
    {
      const w = useWorld([{ id: 1, focused: true }, { id: 2, state: "minimized" }, { id: 3, state: "minimized" }]);
      w.commitAfter.set(3, 999); // window 3's restore never confirms within the budget
      w.store.focusState = legacy([{ windowId: 2, priorState: "normal" }, { windowId: 3, priorState: "normal" }]);
      const r = await retire.drainLegacyFocus();
      check(r.complete === false, "A6: an unfinished restore keeps the run");
      check(w.win(2).state === "normal", "A6: the window that could restore did");
      check(w.store.focusState?.phase === "ending" &&
        (w.store.focusState.minimized ?? []).length === 1 &&
        w.store.focusState.minimized[0].windowId === 3,
        "A6: only the unresolved record is retained under phase:ending");
      check((w.alarms[ALARM]?.when ?? 0) > Date.now() && Object.keys(w.alarms).length === 1,
        "A6: exactly one calm retry alarm is armed");
      w.commitAfter.delete(3); // the native transition settles; the retry restore can now commit
      const r2 = await retire.drainLegacyFocus();
      check(r2.complete === true && w.win(3).state === "normal" && !("focusState" in w.store),
        "A7: a later drain resumes the restoration and completes idempotently");
    }
  
    /* -- A8: once the legacy key is absent, recovery issues zero window updates and
     *       clears a stale old alarm -- */
    {
      const w = useWorld([{ id: 1, focused: true }, { id: 2, state: "minimized" }]);
      w.alarms[ALARM] = { when: Date.now() + 99999 }; // a stale legacy alarm with NO state
      const r = await retire.drainLegacyFocus();
      check(r.complete === true, "A8: a drain with no legacy state completes");
      check(w.updateRequests.length === 0, "A8: no windows.update is issued when legacy state is absent");
      check(!(ALARM in w.alarms), "A8: a stale legacy alarm is cleared");
      check(w.win(2).state === "minimized", "A8: no window is touched");
    }
  
    /* -- A9: the legacy drain never minimizes and never creates a new run; the module
     *       exposes no start/hide/status/target API -- */
    {
      const w = useWorld([{ id: 1, focused: true }, { id: 2, state: "minimized" }, { id: 3, state: "normal" }]);
      w.store.focusState = legacy([{ windowId: 2, priorState: "normal" }]);
      await retire.drainLegacyFocus();
      check(w.minimizeRequests.length === 0, "A9: the drain never issues a minimize request");
      check(w.win(3).state === "normal", "A9: a visible window is never minimized");
      check(!("focusState" in w.store), "A9: no new run is created (focusState removed, never re-activated)");
      for (const api of ["startWindowFocus", "startSessionFocus", "hideOtherWindowsAgain",
                         "getFocusStatus", "handleFocusMessage"]) {
        check(!(api in retire), `A9: the retirement module exposes no ${api} (no start/hide/status API)`);
      }
    }
  
    /* -- onFocusWindowRemoved prunes a closed recorded window; emptying clears state -- */
    {
      const w = useWorld([{ id: 1, focused: true }, { id: 2, state: "minimized" }]);
      w.store.focusState = legacy([{ windowId: 2, priorState: "normal" }, { windowId: 3, priorState: "normal" }]);
      await retire.onFocusWindowRemoved(3);
      check((w.store.focusState.minimized ?? []).every((m) => m.windowId !== 3),
        "F8-R1: onFocusWindowRemoved prunes the closed recorded window");
      await retire.onFocusWindowRemoved(2);
      check(!("focusState" in w.store), "F8-R1: emptying the recovery ledger clears focusState");
    }
  
    /* -- full-start retirement clears legacy state WITHOUT driving windows.update -- */
    {
      const w = useWorld([{ id: 1, focused: true }, { id: 2, state: "minimized" }]);
      w.store.focusState = legacy([{ windowId: 2, priorState: "normal" }]);
      w.alarms[ALARM] = { when: Date.now() + 99999 };
      await retire.retireFocusFullStart();
      check(!("focusState" in w.store) && !(ALARM in w.alarms), "F8-R1: full-start retirement clears legacy state + alarm");
      check(w.updateRequests.length === 0, "F8-R1: full-start never drives windows.update (stale pre-restart IDs)");
      check(w.win(2).state === "minimized", "F8-R1: full-start touches no window");
    }
  
    /* -- the legacy focus-end alarm now only drives the restoration drain -- */
    {
      const w = useWorld([{ id: 1, focused: true }, { id: 2, state: "minimized" }]);
      w.store.focusState = legacy([{ windowId: 2, priorState: "normal" }]);
      check(retire.isFocusAlarm("focus-end") === true && retire.isFocusAlarm("suspend-sweep") === false,
        "F8-R1: isFocusAlarm identifies only the legacy focus-end alarm");
      await retire.handleFocusAlarm();
      check(w.win(2).state === "normal" && !("focusState" in w.store),
        "F8-R1: the focus-end alarm drains (restores) the legacy run");
    }
  
    globalThis.chrome = baseChrome; // restore the base mock for the source-contract checks below
  
    /* -- source contract: no Workspace Focus product surface remains -- */
    {
      const fs = await import("node:fs");
      const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
      const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  
      const bg = strip(read("../js/background.js"));
      check(!bg.includes("handleFocusMessage"), "F8-R1: background no longer routes Focus messages (handleFocusMessage gone)");
      for (const t of ["focus-start-window", "focus-start-session", "focus-hide-again"]) {
        check(!bg.includes(t), `F8-R1: no old '${t}' message is handled in background`);
      }
      check(bg.includes("focus-retirement.js") && !bg.includes("focus-coordinator.js"),
        "F8-R1: background imports the retirement service, not the retired coordinator");
  
      const popup = strip(read("../js/ui/popup.js"));
      const dash = strip(read("../js/ui/dashboard.js"));
      // The Workspace Focus TELLS (window/session targeting). Generic "Start focus" /
      // "End focus" are NOT banned — F8-R2's site-only run legitimately uses them.
      const bannedCopy = ["Focus this window", "Focus this session", "Switch focus here",
        "Hide other windows again", "Focused on"];
      for (const c of bannedCopy) {
        check(!popup.includes(c), `F8-R1: popup has no Workspace Focus action copy ('${c}')`);
        check(!dash.includes(c), `F8-R1: dashboard has no Workspace Focus action copy ('${c}')`);
      }
      for (const t of ["focus-start-window", "focus-start-session", "focus-hide-again", "focus-status"]) {
        check(!popup.includes(t) && !dash.includes(t), `F8-R1: no '${t}' message is sent by popup/dashboard`);
      }
      check(dash.includes("settings-focus") && dash.includes("scrollToFocusSettings"),
        "F8-R1: the dashboard #settings-focus deep link + scroll is preserved");
    }
  
    /* -- settings: five v0.2 Focus rows; the two retired fields are hidden -- */
    {
      const fs = await import("node:fs");
      const src = fs.readFileSync(new URL("../js/ui/settings-form.js", import.meta.url), "utf8");
      const start = src.indexOf("F8: Focus group");
      const end = src.indexOf("const groupNodes =", start);
      check(start >= 0 && end > start, "F8-R1: Focus settings block located");
      // Strip comments so the negative checks read the CODE, not the explanatory note.
      const code = src.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      for (const [id, title] of [["focusDuration", "Default duration"], ["morningEnds", "Morning ends at"],
        ["dayEnds", "Day ends at"], ["blockedSites", "Blocked sites"], ["focusAccess", "When you request access"]]) {
        check(code.includes(`settingsRowCopy("${id}")`),
          `F8-R1: the Focus settings group keeps the v0.2 row '${title}'`);
      }
      check(code.includes('row(durationCopy.title') && code.includes('row(morningCopy.title') &&
        code.includes('row(dayCopy.title') && code.includes('class: "setrow focus-block"') &&
        code.includes('el("div", { class: "setrow" }'),
        "F8-R1: the Focus group renders exactly the three ordinary and two specialized v0.2 rows");
      check(code.includes('settingsOptions("focusAccess")') &&
        code.includes("settingsExceptionDescription(e.currentTarget.value)"),
        "F8-R1: the access-style row uses the v0.2 immediate/pause copy");
      check(!code.includes('check("focusMinimizeOtherWindows")'),
        "F8-R1: the 'Hide other windows' row (focusMinimizeOtherWindows control) is gone");
      check(!code.includes("focusTemporaryEndAction"),
        "F8-R1: the 'When temporary access ends' control (focusTemporaryEndAction) is gone");
      // No em dash in the (new) Focus settings user-facing copy.
      check(!code.includes("—"), "F8-R1: no em dash in the v0.2 Focus settings copy");
    }
  
    /* -- the two retired settings keys survive defaults + a settings round-trip -- */
    {
      const { DEFAULT_SETTINGS } = await import("../js/lib/types.js");
      check("focusMinimizeOtherWindows" in DEFAULT_SETTINGS && "focusTemporaryEndAction" in DEFAULT_SETTINGS,
        "F8-R1: both retired keys remain in DEFAULT_SETTINGS");
      const { getSettings, saveSettings } = await import("../js/lib/store.js");
      // An install with EXPLICIT non-default retired values must not be clobbered by v0.2.
      mem.settings = { ...DEFAULT_SETTINGS, focusMinimizeOtherWindows: false, focusTemporaryEndAction: "save-close" };
      const s = await getSettings();
      check(s.focusMinimizeOtherWindows === false && s.focusTemporaryEndAction === "save-close",
        "F8-R1: stored retired values survive getSettings (never overwritten by v0.2)");
      await saveSettings({ ...s, focusSiteRules: [{ domain: "x.com", displayDomain: "x.com", scope: "focus" }] });
      const s2 = await getSettings();
      check(s2.focusMinimizeOtherWindows === false && s2.focusTemporaryEndAction === "save-close",
        "F8-R1: a save that changes other Focus settings preserves the retired values");
      delete mem.settings;
    }
  
    /* -- manifest permissions are unchanged by the retirement (no host/DNR/content) -- */
    {
      const fs = await import("node:fs");
      const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
      check(JSON.stringify(manifest.permissions) === JSON.stringify(["tabs", "storage",
        "unlimitedStorage", "alarms", "notifications", "contextMenus", "search", "sessions", "sidePanel"]),
        "F8-R1/F18/P11-21: install-time permissions are expected (Search adds no page access)");
      check(!("host_permissions" in manifest) && !("content_scripts" in manifest) &&
        !("declarative_net_request" in manifest),
        "F8-R1: still no host_permissions, content_scripts, or DNR");
    }
  }
  
  /* ================= F8-R2: distraction-site Focus guard =================
   * focus-mode.md v0.2 §5-§9. The site-only run, reactive guarding, the same-tab guard,
   * temporary access + expiry, the Return/Leave save-before-close flow, and reload
   * recovery. A self-contained TAB world (tabs with url/incognito/window/index, isolated
   * storage, alarms, windows) drives the REAL coordinator (js/lib/focus-guard.js) and the
   * pure decisions (js/lib/focus.js). Privacy boundary: no host permissions/content
   * scripts/DNR/webNavigation; the guard URL carries ONLY an opaque attempt id. */
  {
    const guard = await import("../js/lib/focus-guard.js");
    const focus = await import("../js/lib/focus.js");
    const focusCopy = await import("../js/lib/focus-copy.js");
    const actionsMod = await import("../js/lib/actions.js");
    const { DEFAULT_SETTINGS, STORE_KEYS } = await import("../js/lib/types.js");
    const baseChrome = globalThis.chrome;
    const EXT = "chrome-extension://everytab/";
    const GURL = EXT + "focus.html";
    const DURL = EXT + "dashboard.html";
    const MIN = 60000;
  
    function makeTabWorld(tabSpecs, settings, winIds) {
      const store = { settings: { ...DEFAULT_SETTINGS, ...(settings || {}) } };
      const alarms = {};
      let seq = 9000;
      let tabs = tabSpecs.map((t, i) => ({
        id: t.id, url: t.url ?? "", incognito: !!t.incognito,
        windowId: t.windowId ?? 100, index: t.index ?? i,
        active: !!t.active,
        ...(t.title ? { title: t.title } : {}), ...(t.favIconUrl ? { favIconUrl: t.favIconUrl } : {})
      }));
      // Chrome exposes window type on windows.Window, never on tabs.Tab.
      let windows = (winIds ?? [...new Set(tabs.map((t) => t.windowId))]).map((w, index) =>
        typeof w === "number" ? { id: w, type: "normal", incognito: false, focused: index === 0 }
          : { type: "normal", incognito: false, ...w });
      const clone = (t) => ({ ...t });
      const world = {
        store, alarms, notifications: {}, navlog: [], removed: [], created: [], failInboxWrite: false,
        storageSetHook: null,
        failUpdate: new Set(), // F8-R2r C2: tab ids whose chrome.tabs.update rejects
        failRemove: new Set(),
        get tabs() { return tabs; },
        tab: (id) => tabs.find((t) => t.id === id),
        setUrl: (id, url) => { const t = tabs.find((x) => x.id === id); if (t) t.url = url; },
        addWindow: (id) => { windows.push({ id, type: "normal", incognito: false }); }
      };
      world.chrome = {
        ...baseChrome,
        runtime: { ...baseChrome.runtime, id: "everytab", getURL: (p) => EXT + p },
        storage: { local: {
          get: async (keys) => {
            if (keys == null) return { ...store };
            if (typeof keys === "string") return keys in store ? { [keys]: store[keys] } : {};
            const out = {}; for (const k of keys) if (k in store) out[k] = store[k]; return out;
          },
          set: async (obj) => {
            if (world.failInboxWrite && "inbox" in obj) throw new Error("inbox write failed");
            const mode = await world.storageSetHook?.(obj);
            if (mode === "before") throw new Error("storage set failed before commit");
            Object.assign(store, obj);
            if (mode === "after") throw new Error("storage set failed after commit");
          },
          remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; }
        } },
        alarms: {
          create: async (name, info) => { alarms[name] = info; },
          clear: async (name) => { const had = name in alarms; delete alarms[name]; return had; }
        },
        tabs: {
          get: async (id) => { const t = tabs.find((x) => x.id === id); if (!t) throw new Error("no tab " + id); return clone(t); },
          query: async (q = {}) => tabs.filter((t) => {
            if (q.windowId != null && t.windowId !== q.windowId) return false;
            if (q.active != null && t.active !== q.active) return false;
            if (q.lastFocusedWindow) {
              const last = windows.find((w) => w.focused) ?? windows[0];
              if (!last || t.windowId !== last.id) return false;
            }
            if (q.windowType != null) {
              const win = windows.find((w) => w.id === t.windowId);
              if (win?.type !== q.windowType) return false;
            }
            return true;
          }).map(clone),
          update: async (id, props) => {
            const t = tabs.find((x) => x.id === id); if (!t) throw new Error("no tab " + id);
            if (world.failUpdate.has(id)) throw new Error("update refused " + id);
            if (props.url != null) { t.url = props.url; world.navlog.push({ id, url: props.url }); }
            return clone(t);
          },
          remove: async (id) => {
            if (!tabs.some((t) => t.id === id)) throw new Error("no tab " + id);
            if (world.failRemove.has(id)) throw new Error("remove refused " + id);
            tabs = tabs.filter((t) => t.id !== id); world.removed.push(id);
          },
          create: async ({ url, windowId, index }) => {
            const targetWindow = windows.find((w) => w.id === (windowId ?? 100));
            const t = { id: ++seq, url: url ?? "", incognito: !!targetWindow?.incognito,
              windowId: windowId ?? 100, index: index ?? tabs.length };
            tabs.push(t); world.created.push(clone(t)); return clone(t);
          }
        },
        windows: {
          get: async (id) => {
            const win = windows.find((w) => w.id === id);
            if (!win) throw new Error("no window " + id);
            return { ...win };
          },
          getAll: async () => windows.map((w) => ({ ...w }))
        },
        notifications: {
          create: async (id, options) => { world.notifications[id] = { ...options }; return id; },
          clear: async (id) => { const had = id in world.notifications; delete world.notifications[id]; return had; }
        }
      };
      return world;
    }
    const use = (tabSpecs, settings, winIds) => { const w = makeTabWorld(tabSpecs, settings, winIds); globalThis.chrome = w.chrome; return w; };
    const rule = (domain, scope = "focus") => ({ domain, displayDomain: domain, scope });
    const attempts = (w) => w.store.focusBlockedAttempts ?? {};
    const access = (w) => w.store.focusTemporaryAccess ?? {};
    const msg = (m, sender) => new Promise((res) => { guard.handleFocusGuardMessage(m, sender, res); });
  
    /* -- B / A.1 / A.2: pure matching, applicability, lookalikes -- */
    {
      check(focus.matchingRule([rule("example.com", "always")], "example.com", false)?.domain === "example.com",
        "F8-R2 A1: an exact host matches an always rule (no run needed)");
      check(focus.matchingRule([rule("example.com", "always")], "sub.example.com", false)?.domain === "example.com",
        "F8-R2 A1: a subdomain matches its rule");
      check(focus.matchingRule([rule("example.com", "always")], "notexample.com", false) === null,
        "F8-R2 A1: a lookalike suffix does NOT match");
      check(focus.matchingRule([rule("x.com", "focus")], "x.com", false) === null,
        "F8-R2 A2: a During Focus rule does not apply while no run is active");
      check(focus.matchingRule([rule("x.com", "focus")], "x.com", true)?.scope === "focus",
        "F8-R2 A2: a During Focus rule applies while a run is active");
      check(focus.ruleApplies(rule("a", "always"), false) === true && focus.ruleApplies(rule("a", "focus"), false) === false,
        "F8-R2 A2: ruleApplies — always is unconditional, focus needs a run");
      check(focus.isGuardableUrl("https://a.com") && !focus.isGuardableUrl("chrome://ext") &&
        !focus.isGuardableUrl("file:///x") && !focus.isGuardableUrl("data:text/html,x") &&
        !focus.isGuardableUrl(EXT + "focus.html"),
        "F8-R2 A15: only HTTP(S) URLs are guardable (internal/file/data/extension excluded)");
    }
  
    /* -- A.6 / A.5: grant-minute validation + immediate vs pause unlock -- */
    {
      check([5, 10, 15, 30].every(focus.isValidGrantMinutes) && !focus.isValidGrantMinutes(7) &&
        !focus.isValidGrantMinutes(0) && !focus.isValidGrantMinutes(60),
        "F8-R2 A6: only 5/10/15/30 minutes are valid grants");
      check(focus.accessUnlocked(1000, 1000, "immediate") === true,
        "F8-R2 A5: immediate style is always unlocked");
      check(focus.accessUnlocked(1000, 1000 + 14999, "pause") === false &&
        focus.accessUnlocked(1000, 1000 + 15000, "pause") === true,
        "F8-R2 A5: pause style unlocks only after 15s from blockedAt");
      check(focus.pauseRemainingMs(1000, 1000, "pause") === 15000 && focus.pauseRemainingMs(1000, 1000, "immediate") === 0,
        "F8-R2 A5: pause remaining is 15s at blockedAt, 0 for immediate");
      check(focusCopy.pauseCountdownText(15000) === "Continue in 15 seconds" &&
        focusCopy.pauseCountdownText(6401) === "Continue in 7 seconds" &&
        focusCopy.pauseCountdownText(1000) === "Continue in 1 second" &&
        focusCopy.pauseCountdownText(0) === "",
        "F8-R2r3 C1: countdown copy covers 15, intermediate, singular 1, and zero");
      check(focus.elapsedAccessMinutes(1000, 1000) === 1 && focus.elapsedAccessMinutes(0, 10 * MIN) === 10,
        "F8-R2 A7: elapsed access minutes are cumulative and never below 1");
    }
  
    /* -- F8-R2r3 C1: countdown reads a fixed clock, rerenders safely, and announces once -- */
    {
      const { createPauseCountdown } = await import("../js/ui/focus-page-state.js");
      let clock = 0;
      let nextTimer = 0;
      let scheduled = [];
      let label = "";
      let disabled = false;
      let announcements = 0;
      const setTimer = (fn, delay) => {
        const id = ++nextTimer;
        scheduled.push({ id, at: clock + delay, fn });
        return id;
      };
      const clearTimer = (id) => { scheduled = scheduled.filter((entry) => entry.id !== id); };
      const advanceTo = (at) => {
        clock = at;
        while (true) {
          scheduled.sort((a, b) => a.at - b.at);
          const due = scheduled.find((entry) => entry.at <= clock);
          if (!due) break;
          scheduled = scheduled.filter((entry) => entry.id !== due.id);
          due.fn();
        }
      };
      const countdown = createPauseCountdown({
        now: () => clock,
        setTimer,
        clearTimer,
        onTick: (remaining) => {
          disabled = remaining > 0;
          label = remaining > 0 ? focusCopy.pauseCountdownText(remaining) : "Need a moment on this site?";
        },
        onUnlock: () => { announcements += 1; }
      });
      countdown.start(15000);
      check(disabled && label === "Continue in 15 seconds",
        "F8-R2r3 C1: choices begin disabled at the persisted 15-second boundary");
      advanceTo(5500); // delayed callback recomputes, rather than decrementing once
      check(disabled && label === "Continue in 10 seconds",
        "F8-R2r3 C1: a delayed timer recomputes from the fixed unlock clock without drift");
      countdown.start(15000); // reactive rerender preserves the same trusted boundary
      check(disabled && label === "Continue in 10 seconds",
        "F8-R2r3 C1: rerender does not restart or extend the persisted pause");
      advanceTo(14001);
      check(disabled && label === "Continue in 1 second" && announcements === 0,
        "F8-R2r3 C1: choices stay disabled and silent through the final displayed second");
      advanceTo(15000);
      check(!disabled && label === "Need a moment on this site?" && announcements === 1,
        "F8-R2r3 C1: choices enable at the real boundary with one polite announcement");
  
      countdown.start(30000);
      countdown.start(40000); // clears the older generation before its tick can mutate this view
      advanceTo(30000);
      check(disabled && label === "Continue in 10 seconds" && announcements === 1,
        "F8-R2r3 C1: an old render timer cannot mutate a newer countdown");
      countdown.stop();
    }
  
    /* -- A.3: active / timed / overdue / open-ended status -- */
    {
      const now = 5_000_000;
      const rules = [rule("a.com", "focus"), rule("b.com", "always")];
      check(focus.siteFocusStatus({ startedAt: 1, endsAt: now + MIN }, rules, now).active === true,
        "F8-R2 A3: a future-timed run reads active");
      check(focus.siteFocusStatus({ startedAt: 1, endsAt: now - 1 }, rules, now).active === false,
        "F8-R2 A3: an overdue timed run reads inactive");
      check(focus.siteFocusStatus({ startedAt: 1, endsAt: null }, rules, now).active === true,
        "F8-R2 A3: an open-ended run reads active");
      const s = focus.siteFocusStatus({ startedAt: 1, endsAt: null }, rules, now);
      check(s.guardedCount === 2 && s.duringCount === 1 && s.alwaysCount === 1,
        "F8-R2 A3: an active run guards every rule (during + always)");
      check(focus.siteFocusStatus(null, rules, now).guardedCount === 1,
        "F8-R2 A3: with no run, only All the time rules are guarded");
    }
  
    /* -- A.4: start requires a During Focus rule; end is idempotent -- */
    {
      const w = use([{ id: 1, url: DURL }], { focusSiteRules: [rule("b.com", "always")] });
      const r = await guard.startFocus({ endChoice: { mode: "manual" } });
      check(r.ok === false && r.reason === "no-during-rules" && !("focusGuardState" in w.store),
        "F8-R2 A4: start is refused (and persists nothing) with no During Focus rule");
      const w2 = use([{ id: 1, url: DURL }], { focusSiteRules: [rule("a.com", "focus")] });
      const r2 = await guard.startFocus({ endChoice: { mode: "duration", durationMinutes: 60 } });
      check(r2.ok === true && w2.store.focusGuardState && w2.alarms["focus-guard-end"],
        "F8-R2 A4/A8: a valid start persists the run and arms the run-end alarm (distinct name)");
      check(w2.alarms["focus-guard-end"] && !("focus-end" in w2.alarms),
        "F8-R2: the run-end alarm never collides with the retired 'focus-end' alarm");
      const e = await guard.endFocus();
      check(e.ok === true && !("focusGuardState" in w2.store) && !("focus-guard-end" in w2.alarms),
        "F8-R2 A4: end clears the run + its alarm");
      const e2 = await guard.endFocus();
      check(e2.ok === true, "F8-R2 A4: end is idempotent");
    }
  
    /* -- D: reactive guard redirect; opaque-id-only URL; return-url capture -- */
    {
      const w = use([{ id: 1, url: "https://a.com", title: "A", favIconUrl: "https://a.com/f.ico", windowId: 100, index: 3 }],
        { focusSiteRules: [rule("a.com", "always")] });
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      const a = attempts(w)[1];
      check(a && a.url === "https://a.com" && a.domain === "a.com" && a.ruleScope === "always" &&
        a.reason === "initial" && a.title === "A" && a.favIconUrl === "https://a.com/f.ico" && a.windowId === 100 && a.index === 3,
        "F8-R2 D: a matching tab records a full blocked attempt (url/domain/scope/metadata)");
      check(w.tab(1).url === GURL + "#" + a.id,
        "F8-R2 D: the tab is redirected to focus.html with the opaque attempt id only");
      check(!w.navlog.at(-1).url.includes("a.com") && w.navlog.at(-1).url === GURL + "#" + a.id,
        "F8-R2 J: NO destination url/domain appears in the guard URL (opaque id only)");
    }
    {
      // a non-matching tab is not guarded, and its safe URL is remembered
      const w = use([{ id: 1, url: "https://safe.com" }], { focusSiteRules: [rule("a.com", "always")] });
      await guard.onTabUpdated(1, { url: "https://safe.com" }, w.tab(1));
      check(!attempts(w)[1] && w.store.focusReturnUrls?.[1]?.url === "https://safe.com",
        "F8-R2 D: a non-matching tab is not guarded and its safe URL is remembered");
    }
  
    /* -- A.9 / F8-R2r C1: no loop on focus.html; Back/revisit re-guards (reusing the attempt) -- */
    {
      const w = use([{ id: 1, url: "https://a.com" }], { focusSiteRules: [rule("a.com", "always")] });
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      const firstId = attempts(w)[1].id;
      const n1 = w.navlog.length;
      // Chrome fires onUpdated again for the guard page itself — must NOT re-guard (no loop).
      await guard.onTabUpdated(1, { url: w.tab(1).url }, w.tab(1));
      check(w.navlog.length === n1 && attempts(w)[1]?.id === firstId,
        "F8-R2r C1: an update for focus.html itself does not loop or churn the attempt");
      // Browser Back / revisiting the destination MUST re-guard (the old coalesce let the site
      // show). The existing attempt is reused (same opaque id), so no id churn.
      w.setUrl(1, "https://a.com");
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      check(w.tab(1).url === GURL + "#" + firstId && attempts(w)[1]?.id === firstId,
        "F8-R2r C1: Back/revisit to a still-blocked site re-guards, reusing the same attempt id");
      // A genuine duplicate update delivery while already on the guard is inert (own page).
      const n2 = w.navlog.length;
      await guard.onTabUpdated(1, { url: w.tab(1).url }, w.tab(1));
      check(w.navlog.length === n2, "F8-R2r C1: a duplicate update on the guard page does not loop");
    }
    {
      const w = use([{ id: 1, url: "https://a.com" }],
        { focusSiteRules: [rule("a.com", "always")], focusExceptionStyle: "pause" });
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      const before = { ...attempts(w)[1] };
      w.setUrl(1, "https://a.com");
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      const after = attempts(w)[1];
      check(after.id === before.id && after.blockedAt === before.blockedAt && after.reason === "initial",
        "F8-R2r2 R4: Browser Back during the pause preserves the original attempt clock");
    }
    {
      const now = Date.now();
      const w = use([{ id: 1, url: "https://a.com" }], { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusTemporaryAccess = {
        "a.com": { domain: "a.com", accessStartedAt: now - 12 * MIN, expiresAt: now - 1, grantedMinutes: 10 }
      };
      await guard.handleAccessAlarm();
      const before = { ...attempts(w)[1] };
      w.setUrl(1, "https://a.com");
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      const after = attempts(w)[1];
      check(after.id === before.id && after.blockedAt === before.blockedAt && after.reason === "expired" &&
        after.accessStartedAt === before.accessStartedAt,
        "F8-R2r2 R4: Browser Back from expiry preserves elapsed-access and Return semantics");
    }
  
    /* -- A.15: incognito + non-HTTP tabs are never guarded -- */
    {
      const w = use([{ id: 1, url: "https://a.com", incognito: true }, { id: 2, url: "chrome://settings" }],
        { focusSiteRules: [rule("a.com", "always")] });
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      await guard.onTabUpdated(2, { url: "chrome://settings" }, w.tab(2));
      check(!attempts(w)[1] && w.tab(1).url === "https://a.com", "F8-R2 A15: an incognito matching tab is never recorded or redirected");
      check(!attempts(w)[2] && w.tab(2).url === "chrome://settings", "F8-R2 A15: a chrome:// tab is never guarded");
    }
    {
      const w = use([
        { id: 1, url: "https://a.com", windowId: 100 },
        { id: 2, url: "https://a.com", windowId: 200 },
        { id: 3, url: "https://a.com", windowId: 300 },
        { id: 4, url: "https://a.com", windowId: 400, incognito: true }
      ], { focusSiteRules: [rule("a.com", "always")] }, [
        { id: 100, type: "normal" }, { id: 200, type: "popup" },
        { id: 300, type: "devtools" }, { id: 400, type: "normal", incognito: true }
      ]);
      for (const tab of [...w.tabs]) await guard.onTabUpdated(tab.id, { url: tab.url }, tab);
      check(!!attempts(w)[1] && !attempts(w)[2] && !attempts(w)[3] && !attempts(w)[4] &&
        w.tab(2).url === "https://a.com" && w.tab(3).url === "https://a.com",
        "F8-R2r2 R3: real Window.type gates normal versus popup/devtools/incognito reactive tabs");
    }
  
    /* -- D: sweep on start; end does not affect All the time guarding -- */
    {
      const w = use([{ id: 1, url: "https://a.com" }, { id: 2, url: "https://b.com" }, { id: 3, url: DURL }],
        { focusSiteRules: [rule("a.com", "focus"), rule("b.com", "always")] });
      await guard.startFocus({ endChoice: { mode: "manual" } });
      check(w.tab(1).url.startsWith(GURL) && w.tab(2).url.startsWith(GURL),
        "F8-R2 D: starting a run sweeps both the During Focus and the All the time open tabs");
      await guard.endFocus();
      // After end: a new During Focus navigation is NOT guarded; an All the time one still is.
      const w2 = use([{ id: 5, url: "https://a.com" }, { id: 6, url: "https://b.com" }],
        { focusSiteRules: [rule("a.com", "focus"), rule("b.com", "always")] });
      await guard.onTabUpdated(5, { url: "https://a.com" }, w2.tab(5));
      await guard.onTabUpdated(6, { url: "https://b.com" }, w2.tab(6));
      check(w2.tab(5).url === "https://a.com", "F8-R2 J: with no run, a During Focus site is not guarded");
      check(w2.tab(6).url.startsWith(GURL), "F8-R2 J: All the time guarding is unaffected by run end");
    }
  
    /* -- settings edit: sweep newly-applicable tabs; removing a rule stops guarding -- */
    {
      const w = use([{ id: 1, url: "https://c.com" }], { focusSiteRules: [] });
      w.store.settings.focusSiteRules = [rule("c.com", "always")];
      await guard.onRulesChanged();
      check(w.tab(1).url.startsWith(GURL), "F8-R2 J: adding an applicable rule sweeps the open tab");
      const w2 = use([{ id: 1, url: "https://c.com" }], { focusSiteRules: [] }); // rule removed
      await guard.onTabUpdated(1, { url: "https://c.com" }, w2.tab(1));
      check(w2.tab(1).url === "https://c.com", "F8-R2 J: a removed rule stops future guarding immediately");
    }
  
    /* -- E: grant access reopens destination, arms single expiry alarm, drops attempt -- */
    {
      const w = use([{ id: 1, url: "https://a.com" }], { focusSiteRules: [rule("a.com", "always")], focusExceptionStyle: "immediate" });
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      const id = attempts(w)[1].id;
      const g = await guard.grantAccess(1, id, 15);
      check(g.ok === true && w.tab(1).url === "https://a.com" && !attempts(w)[1],
        "F8-R2 E: a valid grant reopens the destination in the acted tab and clears the attempt");
      check(access(w)["a.com"]?.grantedMinutes === 15 && w.alarms["focus-guard-expiry"],
        "F8-R2 E/A8: the access record is created and the single expiry alarm is armed (distinct name)");
      const bad = await guard.grantAccess(1, id, 15); // tab has navigated to the site; no longer a guard tab
      check(bad.ok === false && bad.reason === "not-guard", "F8-R2r C10: a stale/duplicate grant from a non-guard tab is rejected");
    }
  
    /* -- A.5: pause style refuses a grant before 15s -- */
    {
      const w = use([{ id: 1, url: "https://a.com" }], { focusSiteRules: [rule("a.com", "always")], focusExceptionStyle: "pause" });
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      const id = attempts(w)[1].id;
      const g = await guard.grantAccess(1, id, 5);
      check(g.ok === false && g.reason === "locked" && attempts(w)[1],
        "F8-R2 A5: a pause-style grant is refused (locked) before the 15s unlock; the attempt stands");
      const badMin = await guard.grantAccess(1, id, 7);
      check(badMin.ok === false && badMin.reason === "invalid-minutes",
        "F8-R2 A6: an invalid minute value is rejected");
    }
  
    /* -- A.7 / A.10: cumulative accessStartedAt; a stale guard never shortens a newer grant -- */
    {
      const now = Date.now();
      const w = use([{ id: 1, url: "https://a.com" }], { focusSiteRules: [rule("a.com", "always")] });
      // a longer grant already exists (made from another tab)
      w.store.focusTemporaryAccess = { "a.com": { domain: "a.com", accessStartedAt: now - 3 * MIN, expiresAt: now + 30 * MIN, grantedMinutes: 30 } };
      // an older attempt still on the guard tries to add only 5 minutes
      w.store.focusBlockedAttempts = { 1: { id: "old", url: "https://a.com", domain: "a.com", displayDomain: "a.com", ruleScope: "always", reason: "expired", blockedAt: now, accessStartedAt: now - 3 * MIN } };
      w.setUrl(1, GURL + "#old"); // the acting tab is the guard tab (C10)
      const g = await guard.grantAccess(1, "old", 5);
      check(g.ok === true && access(w)["a.com"].expiresAt >= now + 30 * MIN,
        "F8-R2 A10: a shorter grant never shortens a longer existing grant");
      check(access(w)["a.com"].accessStartedAt === now - 3 * MIN,
        "F8-R2 A7: accessStartedAt is preserved (cumulative) across grants");
    }
    {
      const now = Date.now();
      const originalExpiry = now + 10 * MIN;
      const w = use([{ id: 1, url: GURL + "#extend" }],
        { focusSiteRules: [rule("a.com", "always")], focusExceptionStyle: "immediate" });
      w.store.focusTemporaryAccess = {
        "a.com": { domain: "a.com", accessStartedAt: now - MIN, expiresAt: originalExpiry, grantedMinutes: 10 }
      };
      w.store.focusBlockedAttempts = {
        1: { id: "extend", url: "https://a.com", domain: "a.com", displayDomain: "a.com",
          ruleScope: "always", reason: "expired", blockedAt: now, accessStartedAt: now - MIN }
      };
      w.failUpdate.add(1);
      await guard.grantAccess(1, "extend", 5);
      const once = access(w)["a.com"].expiresAt;
      await guard.grantAccess(1, "extend", 5);
      check(once === originalExpiry + 5 * MIN && access(w)["a.com"].expiresAt === once &&
        access(w)["a.com"].accessStartedAt === now - MIN,
        "F8-R2r2 R1: retrying a failed extension preserves its one exact extension and cumulative origin");
    }
  
    /* -- P11-17: one domain warning, exact Add 5 minutes, and stale-button guard -- */
    {
      const now = Date.now();
      const expiry = now + 2 * MIN - 100;
      const w = use([{ id: 1, url: "https://a.com", active: true }],
        { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusTemporaryAccess = {
        "a.com": { domain: "a.com", accessStartedAt: now - 8 * MIN,
          expiresAt: expiry, grantedMinutes: 10 }
      };
      await guard.handleAccessAlarm();
      const notificationId = Object.keys(w.notifications).find((id) => id.startsWith("focus-access-warning:"));
      const notification = w.notifications[notificationId];
      check(!!notificationId && guard.isAccessNotification(notificationId) &&
        notification?.title === "Focus access ends in 2 minutes" &&
        /Click this notification to add 5 minutes/.test(notification?.message || "") &&
        notification?.buttons?.[0]?.title === "Add 5 minutes",
        "P11-17: one domain warning names the remaining minutes and offers Add 5 minutes");
      check(access(w)["a.com"]?.warnedForExpiresAt === expiry &&
        w.alarms[guard.ACCESS_ALARM]?.when === expiry,
        "P11-17: warning state is persisted once and the same alarm advances to exact expiry");
      const extended = await guard.onAccessNotificationButton(notificationId, 0);
      const nextExpiry = access(w)["a.com"]?.expiresAt;
      check(extended.extended === true && nextExpiry === expiry + 5 * MIN &&
        access(w)["a.com"]?.accessStartedAt === now - 8 * MIN &&
        access(w)["a.com"]?.grantedMinutes === 5 && !access(w)["a.com"]?.deferredTabId &&
        !w.notifications[notificationId],
        "P11-17: the notification adds exactly five domain-wide minutes and preserves cumulative access");
      const stale = await guard.onAccessNotificationButton(notificationId, 0);
      check(stale.reason === "stale" && access(w)["a.com"]?.expiresAt === nextExpiry,
        "P11-17: a stale notification cannot extend the newer access period twice");
    }
  
    /* -- P11-17r: EveryTab surfaces can show and repeatedly extend live access -- */
    {
      const accessUi = await import("../js/ui/focus-access.js");
      check(accessUi.formatAccessRemaining(4 * MIN + 32_000, 0) === "4:32 left" &&
        accessUi.formatAccessRemaining(60 * MIN + 4 * MIN + 32_000, 0) === "1:04:32 left" &&
        accessUi.formatAccessRemaining(0, 1) === "Time ended",
        "P11-17r: temporary access uses an exact compact clock through expiry");
      const now = Date.now();
      const expiry = now + 4 * MIN;
      const w = use([{ id: 1, url: "https://a.com", active: true }],
        { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusTemporaryAccess = {
        "a.com": { domain: "a.com", accessStartedAt: now - MIN,
          expiresAt: expiry, grantedMinutes: 5 }
      };
      const before = await guard.getFocusAccessStatus();
      check(before.accesses?.length === 1 && before.accesses[0].domain === "a.com" &&
        before.accesses[0].expiresAt === expiry,
        "P11-17r: shared UI status exposes the live domain and exact access boundary");
      const once = await guard.extendFocusAccess("a.com", expiry);
      const twice = await guard.extendFocusAccess("a.com", once.expiresAt);
      check(once.ok === true && twice.ok === true && twice.expiresAt === expiry + 10 * MIN &&
        access(w)["a.com"]?.accessStartedAt === now - MIN,
        "P11-17r: the in-product action can add five minutes repeatedly while preserving cumulative access");
      const stale = await guard.extendFocusAccess("a.com", expiry);
      check(stale.ok === false && stale.reason === "stale" &&
        access(w)["a.com"]?.expiresAt === expiry + 10 * MIN,
        "P11-17r: an older rendered timer cannot replay over a newer extension");
    }
  
    /* -- P11-17s: native-notification fallback + explicit Stop access -- */
    {
      const now = Date.now();
      const expiry = now + 2 * MIN - 100;
      const w = use([{ id: 1, url: "https://a.com", active: true }],
        { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusTemporaryAccess = {
        "a.com": { domain: "a.com", accessStartedAt: now - 3 * MIN,
          expiresAt: expiry, grantedMinutes: 5 }
      };
      await guard.handleAccessAlarm();
      const notificationId = Object.keys(w.notifications).find((id) => id.startsWith("focus-access-warning:"));
      const clicked = await guard.onAccessNotificationClicked(notificationId);
      check(clicked.extended === true && access(w)["a.com"]?.expiresAt === expiry + 5 * MIN,
        "P11-17s: clicking the warning body adds five minutes when native UI hides its custom button");
    }
    {
      const now = Date.now();
      const expiry = now + 8 * MIN;
      const w = use([
        { id: 1, url: "https://a.com/write", active: true },
        { id: 2, url: "https://sub.a.com/read", active: false }
      ], { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusTemporaryAccess = {
        "a.com": { domain: "a.com", accessStartedAt: now - 3 * MIN,
          expiresAt: expiry, grantedMinutes: 10 }
      };
      const stopped = await guard.stopFocusAccess("a.com", expiry);
      check(stopped.ok === true && !access(w)["a.com"] && w.navlog.length === 2 &&
        Object.values(attempts(w)).every((a) => a.reason === "expired" && a.accessStartedAt === now - 3 * MIN),
        "P11-17s: Stop access revokes the exact grant and immediately guards every matching tab with cumulative context");
    }
  
    /* -- P11-16: shared delayed Loading feedback -- */
    {
      const { createLoadingGate, LOADING_FEEDBACK_DELAY_MS } = await import("../js/ui/loading.js");
      const events = [];
      let scheduled = null;
      let scheduledDelay = 0;
      let cancelled = false;
      const gate = createLoadingGate({
        schedule: (fn, delay) => {
          scheduled = fn;
          scheduledDelay = delay;
          return 17;
        },
        cancel: () => { cancelled = true; },
        onBusy: (busy) => events.push(`busy:${busy}`),
        onShow: () => { events.push("show"); return true; },
        onHide: () => events.push("hide")
      });
      gate.start();
      check(LOADING_FEEDBACK_DELAY_MS === 180 && scheduledDelay === 180 &&
        events.join(",") === "busy:true" && gate.visible === false,
        "P11-16: blank waits become busy immediately but do not flash Loading before 180 ms");
      scheduled();
      check(gate.visible === true && events.join(",") === "busy:true,show",
        "P11-16: a wait still pending after the threshold reveals one shared status");
      gate.stop();
      check(cancelled === false && gate.visible === false &&
        events.join(",") === "busy:true,show,hide,busy:false",
        "P11-16: settling removes the status and clears busy without delaying content");
  
      let staleShow = false;
      let staleCallback = null;
      const cancelledGate = createLoadingGate({
        schedule: (fn) => { staleCallback = fn; return 23; },
        cancel: () => {},
        onShow: () => { staleShow = true; }
      });
      cancelledGate.start();
      cancelledGate.stop();
      staleCallback();
      check(staleShow === false,
        "P11-16: a fast completion or stale delayed callback can never reopen Loading");
    }
    {
      const fs = await import("node:fs");
      const loadingSrc = fs.readFileSync(new URL("../js/ui/loading.js", import.meta.url), "utf8");
      const primitives = fs.readFileSync(new URL("../css/primitives.css", import.meta.url), "utf8");
      const sidepanel = fs.readFileSync(new URL("../js/ui/sidepanel.js", import.meta.url), "utf8");
      const dashboard = fs.readFileSync(new URL("../js/ui/dashboard.js", import.meta.url), "utf8");
      const sideCss = fs.readFileSync(new URL("../css/sidepanel.css", import.meta.url), "utf8");
      check(loadingSrc.includes('"aria-hidden": "true"') &&
        loadingSrc.includes('role: "status"') && loadingSrc.includes('"aria-live": "polite"') &&
        loadingSrc.includes('host.setAttribute("aria-busy", "true")') &&
        loadingSrc.includes("if (host.childNodes.length === 0) host.append(element)") &&
        loadingSrc.includes("element.parentNode !== host || host.childNodes.length !== 1"),
        "P11-16: the visual stages only in an empty host while its polite status stays delayed");
      check(primitives.includes("@keyframes loading-feedback-reveal") &&
        primitives.includes("will-change: opacity") &&
        primitives.includes("var(--loading-delay, var(--motion-continuity)) both") &&
        !primitives.includes("loading-feedback-sheen") &&
        !primitives.includes("clip-path: polygon") &&
        !loadingSrc.includes("loading-feedback-sheen") &&
        !loadingSrc.includes("loading-feedback-text"),
        "P11-16: Loading is one solid delayed accent label with no looping gloss or duplicate text");
      check(sidepanel.includes('showLoadingFeedback(state.host') &&
        sidepanel.includes("!state.rendered && state.host.childNodes.length === 0") &&
        dashboard.includes('showLoadingFeedback(openSec.body, { label: "Loading open tabs…" })') &&
        dashboard.includes("openSec.body.childNodes.length === 0") &&
        !dashboard.includes('label: "Loading history suggestions…"') &&
        !sideCss.includes(".panel-loading"),
        "P11-16: cold Open/panel sections share the component while cached refreshes stay visible");
      const [{ spawnSync }, { fileURLToPath }] = await Promise.all([
        import("node:child_process"), import("node:url")
      ]);
      const starvation = spawnSync(process.execPath, [
        fileURLToPath(new URL("./loading-starvation.mjs", import.meta.url))
      ], { encoding: "utf8" });
      check(starvation.status === 0 && starvation.stdout.includes("PASS: Loading feedback mounted"),
        "P11-16r: a main-thread-heavy cold render cannot starve the delayed Loading visual");
    }
  
    /* -- E/P11-17: expiry guards background matches and defers the current tab -- */
    {
      const now = Date.now();
      const w = use([
        { id: 1, url: "https://a.com/write", active: true, windowId: 100 },
        { id: 2, url: "https://sub.a.com/video", active: false, windowId: 100 },
        { id: 3, url: "https://safe.com", active: false, windowId: 100 }
      ], { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusTemporaryAccess = {
        "a.com": { domain: "a.com", accessStartedAt: now - 12 * MIN,
          expiresAt: now - 1, grantedMinutes: 10 }
      };
      await guard.handleAccessAlarm();
      const rec = access(w)["a.com"];
      const ended = Object.values(w.notifications).find((n) => n.title === "Focus access time ended");
      check(w.tab(1).url === "https://a.com/write" && rec?.deferredTabId === 1 &&
        rec?.deferredAt >= now && /Finish what you are typing/.test(ended?.message || ""),
        "P11-17: expiry never navigates over the current matching tab and announces the deferred guard");
      check(w.tab(2).url.startsWith(GURL) && attempts(w)[2]?.reason === "expired" &&
        attempts(w)[2]?.accessStartedAt === now - 12 * MIN && w.tab(3).url === "https://safe.com",
        "P11-17: matching background tabs guard immediately while unrelated tabs stay untouched");
      await guard.onTabActivated(3);
      check(w.tab(1).url === "https://a.com/write" && access(w)["a.com"]?.deferredTabId === 1,
        "P11-17: switching away preserves the deferred page state in its background tab");
      await guard.onTabActivated(1);
      check(w.tab(1).url.startsWith(GURL) && attempts(w)[1]?.reason === "expired" &&
        attempts(w)[1]?.accessStartedAt === now - 12 * MIN && !access(w)["a.com"],
        "P11-17: deliberately activating the deferred tab completes the guard with cumulative context");
    }
    {
      const now = Date.now();
      const w = use([{ id: 1, url: "https://a.com/write", active: true }],
        { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusTemporaryAccess = {
        "a.com": { domain: "a.com", accessStartedAt: now - 5 * MIN,
          expiresAt: now - 1, grantedMinutes: 5 }
      };
      await guard.handleAccessAlarm();
      w.setUrl(1, "https://sub.a.com/next");
      await guard.onTabUpdated(1, { url: "https://sub.a.com/next" }, w.tab(1));
      check(w.tab(1).url.startsWith(GURL) && attempts(w)[1]?.reason === "expired" && !access(w)["a.com"],
        "P11-17: navigating the deferred tab within the guarded domain ends its grace");
    }
    {
      const now = Date.now();
      const w = use([{ id: 1, url: "https://a.com/write", active: true }],
        { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusTemporaryAccess = {
        "a.com": { domain: "a.com", accessStartedAt: now - 5 * MIN,
          expiresAt: now - 1, grantedMinutes: 5 }
      };
      await guard.handleAccessAlarm();
      w.setUrl(1, "https://safe.com/done");
      await guard.onTabUpdated(1, { url: "https://safe.com/done" }, w.tab(1));
      check(w.tab(1).url === "https://safe.com/done" && !access(w)["a.com"] && !attempts(w)[1],
        "P11-17: leaving the guarded domain retires deferred state without redirecting the safe page");
    }
    {
      const now = Date.now();
      const w = use([{ id: 1, url: "https://a.com/write", active: true }],
        { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusTemporaryAccess = {
        "a.com": { domain: "a.com", accessStartedAt: now - 5 * MIN,
          expiresAt: now - 1, grantedMinutes: 5 }
      };
      await guard.handleAccessAlarm();
      await w.chrome.tabs.remove(1);
      await guard.onTabRemoved(1);
      check(!access(w)["a.com"] && Object.keys(w.notifications).length === 0,
        "P11-17: closing a deferred tab clears its local access record and expiry notification");
    }
    {
      const now = Date.now();
      const w = use([{ id: 1, url: "https://a.com/write", active: true }],
        { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusTemporaryAccess = {
        "a.com": { domain: "a.com", accessStartedAt: now - 5 * MIN,
          expiresAt: now - 1, grantedMinutes: 5 }
      };
      await guard.handleAccessAlarm();
      w.store.settings.focusSiteRules = [];
      await guard.onRulesChanged();
      check(!access(w)["a.com"] && w.tab(1).url === "https://a.com/write" &&
        Object.keys(w.notifications).length === 0,
        "P11-17: removing the rule retires deferred state without navigating the page");
    }
    {
      const now = Date.now();
      const w = use([{ id: 1, url: "https://a.com/write", active: true }],
        { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusTemporaryAccess = {
        "a.com": { domain: "a.com", accessStartedAt: now - 5 * MIN,
          expiresAt: now - 1, grantedMinutes: 5 }
      };
      await guard.handleAccessAlarm();
      const warningId = `focus-access-warning:${now - 1}:a.com`;
      const late = await guard.onAccessNotificationButton(warningId, 0);
      check(late.extended === true && access(w)["a.com"]?.expiresAt >= now + 5 * MIN - 50 &&
        !access(w)["a.com"]?.deferredTabId && w.tab(1).url === "https://a.com/write",
        "P11-17: clicking the still-valid warning just after expiry releases the deferred page for five minutes");
    }
  
    /* -- E: expiry re-guards non-current matching tabs (never closes), drops the record -- */
    {
      const now = Date.now();
      const w = use([{ id: 1, url: "https://a.com" }], { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusTemporaryAccess = { "a.com": { domain: "a.com", accessStartedAt: now - 12 * MIN, expiresAt: now - 1, grantedMinutes: 10 } };
      await guard.handleAccessAlarm();
      check(w.tab(1).url.startsWith(GURL) && attempts(w)[1]?.reason === "expired" && attempts(w)[1]?.accessStartedAt === now - 12 * MIN,
        "F8-R2 E: on expiry a still-matching tab is re-guarded with the cumulative accessStartedAt");
      check(!access(w)["a.com"] && w.removed.length === 0,
        "F8-R2 E: the expired access record is dropped and NO tab is closed");
      // no tab on the domain → the expired record is simply removed
      const w2 = use([{ id: 9, url: DURL }], { focusSiteRules: [rule("a.com", "always")] });
      w2.store.focusTemporaryAccess = { "a.com": { domain: "a.com", accessStartedAt: now, expiresAt: now - 1, grantedMinutes: 5 } };
      await guard.handleAccessAlarm();
      check(!access(w2)["a.com"] && w2.removed.length === 0, "F8-R2 E: with no tab on the domain, expiry just removes the record");
    }
    {
      const now = Date.now();
      const w = use([{ id: 1, url: "https://a.com" }], { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusTemporaryAccess = {
        "a.com": { domain: "a.com", accessStartedAt: now - 5 * MIN, expiresAt: now - 1, grantedMinutes: 5 }
      };
      w.failUpdate.add(1);
      await guard.handleAccessAlarm();
      const retry = access(w)["a.com"];
      check(retry?.retryAt > now && w.alarms[guard.ACCESS_ALARM]?.when === retry.retryAt && !attempts(w)[1],
        "F8-R2r2 R8: failed expiry redirect retains retry state on the one access alarm");
      w.failUpdate.delete(1);
      retry.retryAt = Date.now() - 1;
      await guard.recoverGuard();
      check(w.tab(1).url.startsWith(GURL) && !access(w)["a.com"],
        "F8-R2r2 R8/P11-17: recovery immediately reconciles an overdue retry and clears its state");
    }
    {
      const now = Date.now();
      const w = use([{ id: 1, url: "https://a.com" }], { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusTemporaryAccess = {
        "a.com": { domain: "a.com", accessStartedAt: now, expiresAt: now - 1, grantedMinutes: 5 }
      };
      w.failUpdate.add(1);
      await guard.handleAccessAlarm();
      await w.chrome.tabs.remove(1);
      access(w)["a.com"].retryAt = Date.now() - 1;
      await guard.handleAccessAlarm();
      check(!access(w)["a.com"] && !(guard.ACCESS_ALARM in w.alarms),
        "F8-R2r2 R8: expiry retry cleans normally when the tab is gone");
    }
    {
      const now = Date.now();
      const w = use([{ id: 1, url: "https://a.com" }], { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusTemporaryAccess = {
        "a.com": { domain: "a.com", accessStartedAt: now, expiresAt: now - 1, grantedMinutes: 5 }
      };
      w.failUpdate.add(1);
      await guard.handleAccessAlarm();
      w.store.settings.focusSiteRules = [];
      access(w)["a.com"].retryAt = Date.now() - 1;
      await guard.handleAccessAlarm();
      check(!access(w)["a.com"] && w.tab(1).url === "https://a.com",
        "F8-R2r2 R8: expiry retry cleans normally when the rule was removed");
    }
  
    /* -- F: safe return; Return/Leave close-without-saving writes nothing -- */
    {
      const w = use([{ id: 1, url: "https://a.com" }, { id: 2, url: DURL }], { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusReturnUrls = { 1: { url: "https://safe.com" } };
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      const id = attempts(w)[1].id;
      check(attempts(w)[1].returnUrl === "https://safe.com", "F8-R2 F: the attempt captures the validated previous safe URL");
      const r = await guard.safeReturn(1, id);
      check(r.ok === true && w.tab(1).url === "https://safe.com" && !attempts(w)[1],
        "F8-R2 F: safe return navigates to the previous safe URL and clears the attempt");
    }
    {
      const w = use([{ id: 1, url: "https://a.com" }, { id: 2, url: DURL }], { focusSiteRules: [rule("a.com", "always")] });
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      const id = attempts(w)[1].id;
      const r = await guard.returnAndClose(1, id, false);
      check(r.ok === true && r.saved === false && w.removed.includes(1),
        "F8-R2 A11: close-without-saving closes the guard tab");
      check(!("inbox" in w.store), "F8-R2 A11: close-without-saving writes NOTHING to the Inbox");
    }
    {
      const w = use([{ id: 1, url: "https://a.com" }, { id: 2, url: DURL }],
        { focusSiteRules: [rule("a.com", "focus")] });
      w.store.focusGuardState = { id: "run", startedAt: Date.now(), endsAt: null };
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      const id = attempts(w)[1].id;
      const { createGuardActionRunner } = await import("../js/ui/focus-page-actions.js");
      const button = {
        disabled: false, isConnected: true, attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        removeAttribute(k) { delete this.attrs[k]; }
      };
      let sends = 0;
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const run = createGuardActionRunner({
        send: async (message) => {
          sends += 1;
          await gate;
          return msg(message, { tab: { id: 1 } });
        },
        onFailure: () => {},
        onInvalid: () => {}
      });
      const first = run(button,
        { type: "focus-guard-return-close", attemptId: id, save: false }, "Couldn't close this tab.");
      const duplicate = await run(button,
        { type: "focus-guard-return-close", attemptId: id, save: false }, "Couldn't close this tab.");
      check(sends === 1 && duplicate.ignored && button.disabled && button.attrs["aria-busy"] === "true",
        "F8-R2r3 C3: duplicate Back-to-focus activation sends one close-without-saving message");
      release();
      const result = await first;
      check(result.ok && result.saved === false && w.removed.includes(1) && !("inbox" in w.store),
        "F8-R2r3 C3: initial Back to focus closes the tab with zero Inbox writes");
    }
    {
      const w = use([{ id: 1, url: "https://a.com" }],
        { focusSiteRules: [rule("a.com", "focus")] });
      w.store.focusGuardState = { id: "run", startedAt: Date.now(), endsAt: null };
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      const id = attempts(w)[1].id;
      const result = await msg(
        { type: "focus-guard-return-close", attemptId: id, save: false }, { tab: { id: 1 } });
      check(result.ok && w.removed.length === 0 && w.tab(1).url === `${DURL}#open` && !("inbox" in w.store),
        "F8-R2r3 C3: initial Back to focus replaces a last tab with the dashboard without saving");
    }
    {
      const w = use([{ id: 1, url: "https://a.com" }, { id: 2, url: DURL }],
        { focusSiteRules: [rule("a.com", "focus")] });
      w.store.focusGuardState = { id: "run", startedAt: Date.now(), endsAt: null };
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      const id = attempts(w)[1].id;
      w.failRemove.add(1);
      const failed = await msg(
        { type: "focus-guard-return-close", attemptId: id, save: false }, { tab: { id: 1 } });
      check(!failed.ok && failed.reason === "close-failed" && attempts(w)[1] && !("inbox" in w.store),
        "F8-R2r3 C3: initial close failure keeps the guard attempt retryable and unsaved");
      w.failRemove.delete(1);
      const retried = await msg(
        { type: "focus-guard-return-close", attemptId: id, save: false }, { tab: { id: 1 } });
      check(retried.ok && w.removed.includes(1) && !attempts(w)[1] && !("inbox" in w.store),
        "F8-R2r3 C3: retry after close failure succeeds once without an Inbox write");
    }
  
    /* -- A.12: save-and-close writes one manual Inbox item, then closes; a failed save keeps it open -- */
    {
      const w = use([{ id: 1, url: "https://a.com", title: "A site" }, { id: 2, url: DURL }], { focusSiteRules: [rule("a.com", "always")] });
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      const id = attempts(w)[1].id;
      const r = await guard.returnAndClose(1, id, true);
      const inbox = w.store.inbox ?? {};
      const items = Object.values(inbox);
      check(r.ok === true && r.saved === true && items.length === 1 && items[0].source === "manual" &&
        items[0].tabs[0].url === "https://a.com" && items[0].tabs[0].title === "A site",
        "F8-R2 A12: save-and-close writes ONE manual Inbox item with the recorded destination");
      check(w.removed.includes(1), "F8-R2 A12: the guard tab is closed only after the save succeeds");
    }
    {
      const w = use([{ id: 1, url: "https://a.com" }, { id: 2, url: DURL }], { focusSiteRules: [rule("a.com", "always")] });
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      const id = attempts(w)[1].id;
      w.failInboxWrite = true; // the Inbox write throws
      const r = await guard.returnAndClose(1, id, true);
      check(r.ok === false && r.reason === "save-failed" && !w.removed.includes(1) && attempts(w)[1],
        "F8-R2 A12: a failed save keeps the guard open and never closes the tab");
    }
  
    /* -- A.13: last tab in the window is replaced with the dashboard, not closed -- */
    {
      const w = use([{ id: 1, url: "https://a.com", windowId: 200 }], { focusSiteRules: [rule("a.com", "always")] }, [200]);
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      const id = attempts(w)[1].id;
      const r = await guard.returnAndClose(1, id, false);
      check(r.ok === true && w.removed.length === 0 && w.tab(1).url === `${DURL}#open`,
        "F8-R2 A13: the last tab in a window is replaced with the dashboard (window never disappears)");
    }
  
    /* -- A.14: sender/tab/attempt identity; message router shapes -- */
    {
      const w = use([{ id: 1, url: "https://a.com" }, { id: 2, url: DURL }], { focusSiteRules: [rule("a.com", "always")] });
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      const id = attempts(w)[1].id;
      // C10: a guard action is bound to the LIVE guard tab, not just possession of the id.
      check((await guard.grantAccess(2, id, 5)).reason === "not-guard", "F8-R2r C10: a grant from a DIFFERENT (non-guard) tab is rejected");
      check((await guard.grantAccess(1, "forged", 5)).reason === "not-guard", "F8-R2r C10: a grant with a forged attempt id (wrong hash) is rejected");
      const noTab = await msg({ type: "focus-guard-grant", attemptId: id, minutes: 5 }, {});
      check(noTab.ok === false && noTab.reason === "no-tab", "F8-R2 A14: a page action with no sender tab is rejected");
      const ctx = await msg({ type: "focus-guard-context", attemptId: id }, { tab: { id: 1 } });
      check(ctx.ok === true && ctx.context.kind === "initial" && ctx.context.displayDomain === "a.com" && ctx.context.ruleScope === "always",
        "F8-R2 F: guard-context returns the trusted context resolved by sender tab + opaque id");
      check(ctx.context.pauseUnlockAt === attempts(w)[1].blockedAt + focus.ACCESS_PAUSE_MS,
        "F8-R2r3 C1: guard context supplies the fixed persisted pause unlock boundary");
      // An unknown attempt on a genuine guard tab is a safe 'missing' state (never an open redirect).
      w.setUrl(2, GURL + "#nope");
      const missing = await msg({ type: "focus-guard-context", attemptId: "nope" }, { tab: { id: 2 } });
      check(missing.ok === true && missing.context.kind === "missing", "F8-R2 F: an unknown attempt on a guard tab resolves to a safe 'missing' state");
      const st = await msg({ type: "focus-guard-status" }, {});
      check(st.ok === true && typeof st.status.active === "boolean" && typeof st.status.guardedCount === "number",
        "F8-R2 G: the status message returns the site-only status shape");
      const badStart = await msg({ type: "focus-guard-start", endChoice: { mode: "manual" } }, {});
      check(badStart.ok === false && badStart.reason === "no-during-rules" && badStart.status,
        "F8-R2 G: a refused start returns a stable {ok:false, reason, status} shape");
    }
  
    /* -- I / A.16: reload recovery recreates a lost guard tab once; grace keeps attempts -- */
    {
      const now = Date.now();
      const w = use([{ id: 1, url: DURL, windowId: 100 }], { focusSiteRules: [rule("a.com", "always")] }, [100, 200]);
      w.store.focusBlockedAttempts = { 5: { id: "att5", url: "https://a.com", domain: "a.com", displayDomain: "a.com", ruleScope: "always", reason: "initial", blockedAt: now, windowId: 200, index: 0 } };
      w.store.focusGuardRegistry = { 5: { attemptId: "att5", windowId: 200, index: 0 } };
      await guard.markGuardGrace();  // C5: recreation only happens inside the reload grace
      await guard.recoverGuardTabs();
      const created = w.created.find((t) => t.url === GURL + "#att5" && t.windowId === 200);
      check(!!created, "F8-R2 A16: a guard tab lost to reload is recreated in its prior window");
      check(attempts(w)[created.id]?.id === "att5" && !attempts(w)[5] &&
        w.store.focusGuardRegistry[created.id]?.attemptId === "att5" && !w.store.focusGuardRegistry[5],
        "F8-R2 A16: the attempt + registry are re-keyed to the new tab id (no duplicate)");
      // A second recovery pass is idempotent (the guard is now live → not recreated again).
      const beforeN = w.created.length;
      await guard.recoverGuardTabs();
      check(w.created.length === beforeN, "F8-R2 A16: recovery is idempotent — a live guard is not recreated");
    }
    {
      const w = use([{ id: 3, url: GURL + "#a3" }, { id: 1, url: DURL }], { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusBlockedAttempts = { 3: { id: "a3", url: "https://a.com", domain: "a.com", displayDomain: "a.com", ruleScope: "always", reason: "initial", blockedAt: Date.now() } };
      w.store.focusGuardRegistry = { 3: { attemptId: "a3", windowId: 100, index: 0 } };
      await guard.markGuardGrace();
      await guard.onTabRemoved(3);
      check(attempts(w)[3], "F8-R2 A16: within the guard grace, a closed guard tab's attempt is kept for recovery");
      w.store.focusGuardGraceUntil = Date.now() - 1; // grace elapsed
      await guard.onTabRemoved(3);
      check(!attempts(w)[3] && !w.store.focusGuardRegistry[3], "F8-R2 A16: after the grace, the closed guard tab's attempt/registry are dropped");
    }
  
    /* -- guardView copy (pure, DOM-free) matches the §5.2/§5.3 contract -- */
    {
      const iv = focusCopy.guardView({ kind: "initial", displayDomain: "a.com", ruleScope: "always", runActive: false }, 0);
      check(iv.showAccess === true && iv.showReturn === false && iv.primaryAction === "safe-return",
        "F8-R2r3 C3: initial All-the-time guard keeps safe return, not the Return panel");
      const focusInitial = focusCopy.guardView({
        kind: "initial", displayDomain: "a.com", ruleScope: "focus", runActive: true
      }, 0);
      check(focusInitial.primary === "Back to focus" &&
        focusInitial.primaryAction === "close-without-saving" && !focusInitial.showReturn,
        "F8-R2r3 C3: initial During Focus guard has a distinct immediate close action");
      const ex = focusCopy.guardView({ kind: "expired", displayDomain: "a.com", runActive: true, accessStartedAt: 0 }, 10 * MIN);
      check(ex.primary === "Return to focus" && ex.primaryAction === "return-flow" &&
        ex.showReturn === true && ex.line.includes("10 minutes") && !ex.line.includes("You spent"),
        "F8-R2r3 C3: expired access keeps the Return decision panel and elapsed copy");
      const lv = focusCopy.guardView({ kind: "expired", displayDomain: "a.com", runActive: false, accessStartedAt: 0 }, MIN);
      check(lv.primary === "Leave this site", "F8-R2 F: an expired All the time guard with no run says 'Leave this site'");
      const ended = focusCopy.guardView({ kind: "ended", displayDomain: "a.com" }, 0);
      check(ended.primaryAction === "continue-to-site" && ended.showReturn === false,
        "F8-R2 D: an ended run's guard refreshes to Continue to site (no auto-reopen)");
    }
  
    /* -- A.17 / J: every Focus operational key is excluded from vault serialization -- */
    {
      const opKeys = [guard.GUARD_STATE_KEY, guard.ACCESS_KEY, guard.ATTEMPTS_KEY, guard.RETURN_URLS_KEY,
        guard.GUARD_REGISTRY_KEY, guard.GUARD_GRACE_KEY, actionsMod.FOCUS_SAVE_RECEIPTS_KEY];
      check(opKeys.every((k) => !Object.values(STORE_KEYS).includes(k)),
        "F8-R2 A17: no Focus operational key is one of the vault-synced stores");
      const fs = await import("node:fs");
      const sync = fs.readFileSync(new URL("../js/vault/sync.js", import.meta.url), "utf8");
      check(opKeys.every((k) => !sync.includes(`"${k}"`)),
        "F8-R2 A17: the vault sync module references no Focus operational key");
    }
  
    /* -- J: no old Workspace Focus surface returns; no page-content permission -- */
    {
      const fs = await import("node:fs");
      const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      const gsrc = strip(fs.readFileSync(new URL("../js/lib/focus-guard.js", import.meta.url), "utf8"));
      const bgsrc = strip(fs.readFileSync(new URL("../js/background.js", import.meta.url), "utf8"));
      check(!gsrc.includes("focusState") && !gsrc.includes("focus-coordinator") && !gsrc.includes("focus-end"),
        "F8-R2 J: the site guard never touches legacy focusState / the retired coordinator / the 'focus-end' alarm");
      check(!gsrc.includes("minimize") && !gsrc.includes("Hide other windows"),
        "F8-R2 K: no window minimize / Hide-again logic leaks into the site guard");
      check(/focusGuardTabActivated\(tabId\)/.test(bgsrc) &&
        /isAccessNotification\(id\)/.test(bgsrc) && /onAccessNotificationButton\(id, idx\)/.test(bgsrc) &&
        /onAccessNotificationClicked\(id\)/.test(bgsrc),
        "P11-17s: the worker wires deferred activation plus button and body-click notification actions");
      const accessUi = strip(fs.readFileSync(new URL("../js/ui/focus-access.js", import.meta.url), "utf8"));
      const popupUi = strip(fs.readFileSync(new URL("../js/ui/popup.js", import.meta.url), "utf8"));
      const newTabUi = strip(fs.readFileSync(new URL("../js/ui/newtab.js", import.meta.url), "utf8"));
      const stripUi = strip(fs.readFileSync(new URL("../js/ui/focus-strip.js", import.meta.url), "utf8"));
      check(gsrc.includes('case "focus-guard-extend-access"') &&
        gsrc.includes('case "focus-guard-stop-access"') &&
        accessUi.includes("export async function getFocusAccessStatus()") &&
        accessUi.includes("export function extendFocusAccess(") &&
        accessUi.includes("export function stopFocusAccess(") &&
        popupUi.includes("getFocusAccessStatus") && newTabUi.includes("getFocusAccessStatus") &&
        stripUi.includes("createFocusAccessPanel"),
        "P11-17r/s: popup, every non-blank new-tab surface, and the shared Focus band expose repeatable timer actions");
      const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
      check(JSON.stringify(manifest.permissions) === JSON.stringify(["tabs", "storage",
        "unlimitedStorage", "alarms", "notifications", "contextMenus", "search", "sessions", "sidePanel"]),
        "F8-R2 J/F18/P11-21: install-time permissions are expected (Search adds no page access)");
      check(!manifest.permissions.includes("webNavigation") && !manifest.permissions.includes("declarativeNetRequest") &&
        !("host_permissions" in manifest) && !("content_scripts" in manifest) && !("declarative_net_request" in manifest),
        "F8-R2 J: no host permissions, content scripts, DNR, or webNavigation");
      check(JSON.stringify(manifest.optional_permissions) === JSON.stringify(["history", "tabGroups"]) &&
        !("web_accessible_resources" in manifest) && !("externally_connectable" in manifest),
        "F18: optional permissions are history + tabGroups; restricted manifest fields remain unchanged");
      // No em dash in the new user-facing Focus copy.
      const guardPage = strip(fs.readFileSync(new URL("../js/ui/focus-page.js", import.meta.url), "utf8"));
      const guardHtml = fs.readFileSync(new URL("../focus.html", import.meta.url), "utf8");
      const focusSrc = strip(fs.readFileSync(new URL("../js/lib/focus.js", import.meta.url), "utf8"));
      const focusCopySrc = strip(fs.readFileSync(new URL("../js/lib/focus-copy.js", import.meta.url), "utf8"));
      const stateSrc = strip(fs.readFileSync(new URL("../js/ui/focus-page-state.js", import.meta.url), "utf8"));
      const onb = strip(fs.readFileSync(new URL("../js/lib/onboarding-copy.js", import.meta.url), "utf8"));
      check(![guardPage, guardHtml, focusSrc, focusCopySrc, stateSrc, onb].some((s) => s.includes("—")),
        "F8-R2r3: no em dash in touched Focus and popup user-facing copy");
    }
  
    /* ================= F8-R2r: launch-hardening corrections (C1-C10) ================= */
    const G = (id) => GURL + "#" + id;
    const mkAttempt = (over) => ({
      id: "att", url: "https://a.com", domain: "a.com", displayDomain: "a.com",
      ruleScope: "always", reason: "initial", blockedAt: Date.now(), ...over
    });
  
    /* -- C2: a failed initial redirect rolls back; the next event re-guards -- */
    {
      const w = use([{ id: 1, url: "https://a.com" }], { focusSiteRules: [rule("a.com", "always")] });
      w.failUpdate.add(1);
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      check(!attempts(w)[1] && !(w.store.focusGuardRegistry || {})[1],
        "F8-R2r C2: a failed initial redirect rolls back the attempt + registry (no suppression)");
      w.failUpdate.delete(1);
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      check(attempts(w)[1] && w.tab(1).url.startsWith(GURL),
        "F8-R2r C2: the next event re-guards successfully after a redirect failure");
    }
  
    /* -- C2: grant / safe-return / continue navigate-then-consume; a failed nav keeps the guard -- */
    {
      const w = use([{ id: 1, url: "https://a.com" }], { focusSiteRules: [rule("a.com", "always")], focusExceptionStyle: "immediate" });
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      const id = attempts(w)[1].id;
      w.failUpdate.add(1);
      const r1 = await guard.grantAccess(1, id, 5);
      check(r1.ok === false && r1.reason === "nav-failed" && attempts(w)[1] && access(w)["a.com"],
        "F8-R2r C2: a grant whose reopen fails keeps the attempt + access; guard stays usable");
      const exactExpiry = access(w)["a.com"].expiresAt;
      const rAgain = await guard.grantAccess(1, id, 5);
      check(rAgain.reason === "nav-failed" && access(w)["a.com"].expiresAt === exactExpiry,
        "F8-R2r2 R1: repeated navigation failure does not extend the committed grant");
      w.failUpdate.delete(1);
      const r2 = await guard.grantAccess(1, id, 5);
      check(r2.ok === true && !attempts(w)[1] && w.tab(1).url === "https://a.com" &&
        access(w)["a.com"].expiresAt === exactExpiry,
        "F8-R2r2 R1: success after retry consumes the attempt without changing expiresAt");
    }
    {
      const w = use([{ id: 1, url: "https://a.com" }, { id: 2, url: DURL }], { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusReturnUrls = { 1: { url: "https://safe.com" } };
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      const id = attempts(w)[1].id;
      w.failUpdate.add(1);
      const r1 = await guard.safeReturn(1, id);
      check(r1.ok === false && r1.reason === "nav-failed" && attempts(w)[1],
        "F8-R2r C2: a failed safe-return keeps the attempt (guard usable)");
      w.failUpdate.delete(1);
      const r2 = await guard.safeReturn(1, id);
      check(r2.ok === true && w.tab(1).url === "https://safe.com" && !attempts(w)[1],
        "F8-R2r C2: retrying safe-return navigates then consumes");
    }
    {
      const w = use([{ id: 1, url: "https://a.com" }, { id: 2, url: DURL }], { focusSiteRules: [rule("a.com", "always")] });
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      const id = attempts(w)[1].id;
      w.failUpdate.add(1);
      const r1 = await guard.continueToSite(1, id);
      check(r1.ok === false && r1.reason === "nav-failed" && attempts(w)[1],
        "F8-R2r C2: a failed continue keeps the attempt (guard usable)");
      w.failUpdate.delete(1);
      const r2 = await guard.continueToSite(1, id);
      check(r2.ok === true && w.tab(1).url === "https://a.com" && !attempts(w)[1],
        "F8-R2r C2: retrying continue navigates then consumes");
    }
  
    /* -- C3: save-and-close is idempotent per attempt (save ok, close fails, retry: one item) -- */
    {
      const w = use([{ id: 1, url: "https://a.com", title: "A" }], { focusSiteRules: [rule("a.com", "always")] }, [100]);
      await guard.onTabUpdated(1, { url: "https://a.com" }, w.tab(1));
      const id = attempts(w)[1].id;
      w.failUpdate.add(1); // last tab in window → closeOrReplace navigates to dashboard → update fails
      const r1 = await guard.returnAndClose(1, id, true);
      check(r1.ok === false && r1.reason === "close-failed", "F8-R2r C3: save succeeds but the close fails");
      const items1 = Object.values(w.store.inbox ?? {});
      check(items1.length === 1 && items1[0].id === id && items1[0].source === "manual",
        "F8-R2r C3: exactly one Inbox item is saved (id = the attempt's stable id)");
      check((w.store.counters?.tabsDumped ?? 0) === 1, "F8-R2r C3: the save counter is bumped exactly once");
      w.failUpdate.delete(1);
      const r2 = await guard.returnAndClose(1, id, true);
      check(r2.ok === true && Object.values(w.store.inbox ?? {}).length === 1 &&
        (w.store.counters?.tabsDumped ?? 0) === 1,
        "F8-R2r C3: retrying after the close failure reuses the SAME item (no duplicate item or counter)");
    }
    {
      // The seam itself is idempotent by id (covers "Inbox write visible, later step rejects").
      const w = use([{ id: 1, url: DURL }], { focusSiteRules: [] });
      const it1 = await actionsMod.saveRefToInbox({ url: "https://a.com", title: "A" }, { id: "stable-1" });
      const it2 = await actionsMod.saveRefToInbox({ url: "https://a.com", title: "A" }, { id: "stable-1" });
      check(it1.id === "stable-1" && it2.id === "stable-1" && Object.values(w.store.inbox ?? {}).length === 1 &&
        (w.store.counters?.tabsDumped ?? 0) === 1,
        "F8-R2r C3: a repeated save identity yields exactly one item, journal, and counter effect");
    }
    {
      const boundaries = [
        ["inbox", "after"], ["counters", "before"], ["counters", "after"],
        ["journal", "before"], ["journal", "after"]
      ];
      for (const [key, mode] of boundaries) {
        const id = `partial-${key}-${mode}`;
        const w = use([{ id: 1, url: DURL }], { focusSiteRules: [] });
        let injected = false;
        w.storageSetHook = (obj) => {
          if (!injected && key in obj) { injected = true; return mode; }
          return undefined;
        };
        let rejected = false;
        try {
          await actionsMod.saveRefToInbox({ url: "https://a.com", title: "A" }, { id });
        } catch { rejected = true; }
        w.storageSetHook = null;
        const reloadedActions = await import(`../js/lib/actions.js?retry=${id}`);
        await reloadedActions.saveRefToInbox({ url: "https://a.com", title: "A" }, { id });
        const liveItems = Object.values(w.store.inbox ?? {}).filter((item) => !item.deletedAt && item.id === id);
        const journalEntries = (w.store.journal ?? []).filter((entry) =>
          entry.dels?.some((del) => del.store === STORE_KEYS.inbox && del.id === id));
        check(rejected && liveItems.length === 1 && (w.store.counters?.tabsDumped ?? 0) === 1 &&
          journalEntries.length === 1 && w.store.focusSaveReceipts?.[id]?.complete === true,
          `F8-R2r2 R2: retry converges after ${mode}-commit failure at ${key}`);
      }
    }
  
    /* -- C4: stale cleanup never deletes a live newer grant -- */
    {
      const now = Date.now();
      const w = use([{ id: 1, url: G("g1") }, { id: 2, url: "https://a.com" }], { focusSiteRules: [rule("a.com", "always")] }, [100]);
      w.store.focusTemporaryAccess = { "a.com": { domain: "a.com", accessStartedAt: now, expiresAt: now + 20 * MIN, grantedMinutes: 20 } };
      w.store.focusBlockedAttempts = { 1: mkAttempt({ id: "g1", url: "https://a.com" }) };
      w.setUrl(2, "about:blank"); // the destination tab is momentarily NOT on the domain
      const r = await guard.returnAndClose(1, "g1", false); // an OLD guard closes
      check(r.ok === true && access(w)["a.com"]?.expiresAt === now + 20 * MIN,
        "F8-R2r C4: closing an old guard does not delete a live newer grant");
    }
    {
      const now = Date.now();
      const w = use([{ id: 5, url: G("g5") }, { id: 6, url: "about:blank" }], { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusTemporaryAccess = { "a.com": { domain: "a.com", accessStartedAt: now, expiresAt: now + 10 * MIN, grantedMinutes: 10 } };
      w.store.focusBlockedAttempts = { 5: mkAttempt({ id: "g5", url: "https://a.com" }) };
      await guard.onTabRemoved(5); // an OLD tab-removed event, no tab currently on the domain
      check(access(w)["a.com"]?.expiresAt === now + 10 * MIN,
        "F8-R2r C4: an old onRemoved event does not delete a live newer grant");
    }
  
    /* -- C5: full-restart rebind by opaque id (new tab id); generic recovery never prunes it -- */
    {
      const w = use([{ id: 1, url: DURL }, { id: 77, url: G("r1"), windowId: 100 }], { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusBlockedAttempts = { 5: mkAttempt({ id: "r1", url: "https://a.com", windowId: 100, index: 0 }) };
      w.store.focusGuardRegistry = { 5: { attemptId: "r1", windowId: 100, index: 0 } };
      await guard.recoverGuard(); // ordinary worker-spin recovery (no grace, no claim)
      check(attempts(w)[77]?.id === "r1" && !attempts(w)[5],
        "F8-R2r C5: a full-restart guard rebinds to its new tab id by opaque attempt id");
      check(w.store.focusGuardRegistry[77]?.attemptId === "r1" && !w.store.focusGuardRegistry[5],
        "F8-R2r C5: the registry is re-keyed with no duplicate; generic recovery never pruned it");
    }
  
    /* -- C5: within reload grace, recovery keeps a recreatable guard, then recreates it -- */
    {
      const w = use([{ id: 1, url: DURL }], { focusSiteRules: [rule("a.com", "always")] }, [100]);
      w.store.focusBlockedAttempts = { 9: mkAttempt({ id: "r9", url: "https://a.com", windowId: 100, index: 0 }) };
      w.store.focusGuardRegistry = { 9: { attemptId: "r9", windowId: 100, index: 0 } };
      await guard.markGuardGrace();
      await guard.recoverGuard(); // must NOT prune the reload-closed guard attempt
      check(attempts(w)[9]?.id === "r9", "F8-R2r C5: within reload grace, recovery does not prune a recreatable guard");
      await guard.recoverGuardTabs();
      check(w.created.some((t) => t.url === G("r9") && t.windowId === 100),
        "F8-R2r C5: the reload-closed guard is recreated inside the grace");
    }
  
    /* -- C5: a removed rule / ended run / incognito window are never recreated -- */
    {
      const w = use([{ id: 1, url: DURL }], { focusSiteRules: [] }, [100]); // rule removed
      w.store.focusBlockedAttempts = { 9: mkAttempt({ id: "r9", url: "https://a.com", windowId: 100 }) };
      w.store.focusGuardRegistry = { 9: { attemptId: "r9", windowId: 100, index: 0 } };
      await guard.markGuardGrace();
      await guard.recoverGuardTabs();
      check(w.created.length === 0 && !attempts(w)[9], "F8-R2r C5: a guard whose rule was removed is dropped, not recreated");
    }
    {
      const w = use([{ id: 1, url: DURL }], { focusSiteRules: [rule("a.com", "focus")] }, [100]); // focus rule, no run
      w.store.focusBlockedAttempts = { 9: mkAttempt({ id: "r9", url: "https://a.com", ruleScope: "focus", windowId: 100 }) };
      w.store.focusGuardRegistry = { 9: { attemptId: "r9", windowId: 100, index: 0 } };
      await guard.markGuardGrace();
      await guard.recoverGuardTabs();
      check(w.created.length === 0, "F8-R2r C5: a During-Focus guard is not recreated when no run is active");
    }
    {
      const w = use([{ id: 1, url: DURL, windowId: 100 }], { focusSiteRules: [rule("a.com", "always")] }, [{ id: 300, incognito: true }]);
      w.store.focusBlockedAttempts = { 9: mkAttempt({ id: "r9", url: "https://a.com", windowId: 300 }) };
      w.store.focusGuardRegistry = { 9: { attemptId: "r9", windowId: 300, index: 0 } };
      await guard.markGuardGrace();
      await guard.recoverGuardTabs();
      check(w.created.length === 0 && !attempts(w)[9], "F8-R2r C5: a guard is never recreated into an incognito window");
    }
    {
      // C5 arbitration: an UNCLAIMED worker-spin recovery runs and prunes a genuinely orphaned
      // attempt (dead tab, no live guard, no grace). Run this BEFORE the claim below.
      const w = use([{ id: 1, url: DURL }], { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusBlockedAttempts = { 55: mkAttempt({ id: "o55", url: "https://a.com" }) }; // tab 55 is gone
      guard.scheduleGuardWorkerRecovery(0);
      await new Promise((r) => setTimeout(r, 8));
      check(!attempts(w)[55], "F8-R2r C5: an unclaimed worker-spin recovery prunes a genuinely orphaned attempt");
    }
    {
      // C5 arbitration: once a reload/startup claim has fired, the deferred worker recovery
      // YIELDS, so it can never prune a record reload/full-start recovery could still rebind.
      const w = use([{ id: 1, url: DURL }], { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusBlockedAttempts = { 66: mkAttempt({ id: "o66", url: "https://a.com" }) };
      guard.claimGuardLifecycle();
      guard.scheduleGuardWorkerRecovery(0);
      await new Promise((r) => setTimeout(r, 8));
      check(attempts(w)[66]?.id === "o66", "F8-R2r C5: after a lifecycle claim, the deferred worker recovery yields (no prune)");
    }
    {
      const w = use([{ id: 7, url: G("life"), windowId: 100 }],
        { focusSiteRules: [rule("a.com", "always")] }, [100]);
      w.store.focusBlockedAttempts = { 7: mkAttempt({ id: "life", windowId: 100, index: 0 }) };
      w.store.focusGuardRegistry = { 7: { attemptId: "life", windowId: 100, index: 0 } };
      let releaseGrace;
      const graceGate = new Promise((resolve) => { releaseGrace = resolve; });
      w.storageSetHook = async (obj) => {
        if (guard.GUARD_GRACE_KEY in obj) await graceGate;
        return undefined;
      };
      guard.claimGuardLifecycle();
      const graceWrite = guard.markGuardGrace();
      await w.chrome.tabs.remove(7);
      const removal = guard.onTabRemoved(7);
      await removal;
      check(attempts(w)[7]?.id === "life",
        "F8-R2r2 R7: synchronous lifecycle claim protects onRemoved before grace storage resolves");
      releaseGrace(); await graceWrite;
      w.storageSetHook = null;
      await guard.recoverGuardTabs();
      const recreated = w.created.find((tab) => tab.url === G("life"));
      check(!!recreated && attempts(w)[recreated.id]?.id === "life",
        "F8-R2r2 R7: delayed persisted grace still recovers the claimed guard");
      w.store.focusGuardGraceUntil = Date.now() - 1;
      await w.chrome.tabs.remove(recreated.id);
      await guard.onTabRemoved(recreated.id);
      check(!attempts(w)[recreated.id],
        "F8-R2r2 R7: a genuine later close is cleaned after transient claim and grace expire");
    }
  
    /* -- C6: context + grant use the CURRENT applicable rule, not the stale captured scope -- */
    {
      const w = use([{ id: 1, url: G("s1") }], { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusBlockedAttempts = { 1: mkAttempt({ id: "s1", url: "https://a.com", ruleScope: "focus" }) }; // stale scope
      const ctx = await guard.guardContext(1, "s1");
      check(ctx.ruleScope === "always" && ctx.kind === "initial",
        "F8-R2r C6: context reports the CURRENT rule scope (always), not the stale captured focus");
    }
    {
      // Overlapping parent(always)/child(focus): the applicable rule (parent always) is shown.
      const w = use([{ id: 1, url: "https://sub.example.com" }],
        { focusSiteRules: [rule("example.com", "always"), rule("sub.example.com", "focus")] });
      await guard.onTabUpdated(1, { url: "https://sub.example.com" }, w.tab(1));
      const id = attempts(w)[1].id;
      const ctx = await guard.guardContext(1, id);
      check(ctx.ruleScope === "always" && ctx.displayDomain === "example.com",
        "F8-R2r C6: overlapping parent(always)/child(focus) resolves to the applicable always rule");
    }
    {
      const w = use([{ id: 1, url: G("g1") }], { focusSiteRules: [] }); // rule removed just before Grant
      w.store.focusBlockedAttempts = { 1: mkAttempt({ id: "g1", url: "https://a.com" }) };
      const g = await guard.grantAccess(1, "g1", 5);
      check(g.ok === true && g.notBlocked === true && !access(w)["a.com"] && w.tab(1).url === "https://a.com",
        "F8-R2r C6: granting a no-longer-blocked site opens it with NO stale access record");
    }
    {
      const w = use([{ id: 1, url: G("g2") }], { focusSiteRules: [rule("a.com", "focus")] }); // run ended
      w.store.focusBlockedAttempts = { 1: mkAttempt({ id: "g2", url: "https://a.com", ruleScope: "focus" }) };
      const g = await guard.grantAccess(1, "g2", 5);
      check(g.ok === true && g.notBlocked === true && !access(w)["a.com"],
        "F8-R2r C6: granting after the run ended opens the site, no stale grant");
    }
  
    /* -- R5: real stable-identity focus helper over a connected-element DOM shim -- */
    {
      const { markGuardFocus, captureGuardFocus, restoreGuardFocus } =
        await import("../js/ui/focus-page-state.js");
      const frames = [];
      const doc = { activeElement: null, body: null, hasFocus: () => true };
      const node = (parent = null) => ({
        parent, children: [], dataset: {}, isConnected: true,
        contains(other) {
          for (let n = other; n; n = n.parent) if (n === this) return true;
          return false;
        },
        focus() { doc.activeElement = this; }
      });
      doc.body = node(); doc.activeElement = doc.body;
      const surface = node(doc.body);
      const settingsLink = node(doc.body);
      const makeControl = (identity) => {
        const control = markGuardFocus(node(surface), identity);
        surface.children.push(control);
        return control;
      };
      const detach = (control) => {
        control.isConnected = false;
        surface.children = surface.children.filter((c) => c !== control);
        if (doc.activeElement === control) doc.activeElement = doc.body;
      };
      const flush = () => { while (frames.length) frames.shift()(); };
      const restore = (snapshot, primary, controls, opts = {}) => restoreGuardFocus({
        document: doc, snapshot, primary,
        findIdentity: (identity) => controls.find((c) => c.dataset.guardFocusId === identity) ?? null,
        requestFrame: (fn) => frames.push(fn), ...opts
      });
  
      let old = makeControl("grant:10"); old.focus();
      let snap = captureGuardFocus(doc, [surface]);
      detach(old);
      let primary = makeControl("primary");
      let ten = makeControl("grant:10");
      restore(snap, primary, [primary, ten]); flush();
      check(doc.activeElement === ten && ten.isConnected,
        "F8-R2r2 R5: refresh restores the equivalent 10-minute control");
  
      snap = captureGuardFocus(doc, [surface]);
      detach(ten);
      const primary2 = makeControl("primary");
      restore(snap, primary2, [primary2]); flush();
      check(doc.activeElement === primary2 && doc.activeElement.isConnected,
        "F8-R2r2 R5: a removed duration control falls back to the connected primary");
  
      snap = captureGuardFocus(doc, [surface]);
      detach(primary2);
      const primary3 = makeControl("primary");
      restore(snap, primary3, [primary3]); flush();
      check(doc.activeElement === primary3,
        "F8-R2r2 R5: primary focus restores to the equivalent replacement primary");
  
      const panelChoice = makeControl("return:save"); panelChoice.focus();
      snap = captureGuardFocus(doc, [surface]);
      detach(panelChoice);
      const primary4 = makeControl("primary");
      restore(snap, primary4, [primary4], { forcePrimary: true }); flush();
      check(doc.activeElement === primary4 && doc.activeElement.isConnected,
        "F8-R2r2 R5: an invalidated Return panel closes onto the new primary");
  
      old = makeControl("grant:10"); old.focus();
      snap = captureGuardFocus(doc, [surface]);
      detach(old);
      const primary5 = makeControl("primary");
      const ten2 = makeControl("grant:10");
      restore(snap, primary5, [primary5, ten2]);
      settingsLink.focus();
      flush();
      check(doc.activeElement === settingsLink && doc.activeElement.isConnected,
        "F8-R2r2 R5: deliberate movement to Settings cancels late focus restoration");
    }
  
    /* -- C8: the popup honors the saved duration; pending guard suppresses a double send -- */
    {
      check(focusCopy.blockedSitesSummary([]) === "No blocked sites yet",
        "F8-R2r3 C2: inactive popup preserves the empty blocked-sites copy");
      check(focusCopy.blockedSitesSummary([rule("a.com", "focus"), rule("b.com", "focus")]) ===
        "Blocked sites: 2 during Focus",
        "F8-R2r3 C2: inactive popup naturally omits a zero All-the-time count");
      check(focusCopy.blockedSitesSummary([rule("a.com", "always"), rule("b.com", "always"),
        rule("c.com", "always")]) === "Blocked sites: 3 all the time",
        "F8-R2r3 C2: inactive popup naturally omits a zero During-Focus count");
      check(focusCopy.blockedSitesSummary([rule("a.com", "focus"), rule("b.com", "always")]) ===
        "Blocked sites: 1 during Focus · 1 all the time",
        "F8-R2r3 C2: inactive popup uses the exact explicit two-category summary");
      const i25 = focusCopy.focusPopupDurationInfo({ focusDefaultEndMode: "duration", focusDefaultDurationMinutes: 25 });
      check(i25.minutes === 25 && i25.customDefault === true && i25.label === "25 minutes",
        "F8-R2r C8: a saved 25-minute duration is shown + sent as 25 (not one hour)");
      const i60 = focusCopy.focusPopupDurationInfo({ focusDefaultEndMode: "duration", focusDefaultDurationMinutes: 60 });
      check(i60.minutes === 60 && i60.customDefault === false && i60.label === "1 hour",
        "F8-R2r C8: a saved 60-minute duration keeps the natural '1 hour' copy");
      const iManual = focusCopy.focusPopupDurationInfo({ focusDefaultEndMode: "manual", focusDefaultDurationMinutes: 25 });
      check(iManual.customDefault === false, "F8-R2r C8: a non-duration default does not force a duration option");
      // Duplicate-activation guard (real shared helper).
      const { withPending } = await import("../js/ui/pending.js");
      const btn = { dataset: {}, disabled: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
      let calls = 0;
      let release;
      const gate = new Promise((r) => { release = r; });
      const p1 = withPending(btn, async () => { calls += 1; await gate; });
      check(btn.disabled === true && btn.attrs["aria-busy"] === "true", "F8-R2r C8: a pending action disables the control + sets aria-busy");
      await withPending(btn, async () => { calls += 1; }); // second activation while pending
      check(calls === 1, "F8-R2r C8: a duplicate activation while pending is ignored (one send)");
      release(); await p1;
      check(btn.disabled === false && !("aria-busy" in btn.attrs), "F8-R2r C8: the control is restored after the action settles");
      const fs = await import("node:fs");
      const pop = fs.readFileSync(new URL("../js/ui/popup.js", import.meta.url), "utf8");
      check(/withPending\(e\.currentTarget/.test(pop) && /focusPopupDurationInfo/.test(pop) &&
        /value: "default"/.test(pop),
        "F8-R2r C8: the popup wires the pending guard on Start/End and the saved-duration option");
      check(/blockedSitesSummary\(settings\.focusSiteRules/.test(pop) &&
        /popupGuardedSites\(status\.guardedCount\)/.test(pop),
        "F8-R2r3 C2: popup uses explicit inactive helper and keeps active N-sites-guarded copy");
    }
  
    /* -- C9: the permanent Focus explanation keeps the honest live-state boundary -- */
    {
      const { createGuardActionRunner, guardFailureText } =
        await import("../js/ui/focus-page-actions.js");
      const control = () => ({
        dataset: {}, disabled: false, isConnected: true, attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        removeAttribute(k) { delete this.attrs[k]; }
      });
      const runCase = async (response, fallback = "Fallback") => {
        const btn = control();
        let failure = ""; let invalid = 0;
        const run = createGuardActionRunner({
          send: async () => response,
          onFailure: (res, copy) => { failure = guardFailureText(res, copy); },
          onInvalid: () => { invalid += 1; }
        });
        await run(btn, { type: "x" }, fallback);
        return { btn, failure, invalid };
      };
      const closeFailed = await runCase({ ok: false, reason: "close-failed", saved: true });
      check(/was saved to the Inbox/.test(closeFailed.failure) && closeFailed.btn.disabled === false,
        "F8-R2r2 R6: close-failed truthfully says the page was saved and restores the control");
      const saveFailed = await runCase({ ok: false, reason: "save-failed" });
      check(/Could not save/.test(saveFailed.failure) && /still open/.test(saveFailed.failure),
        "F8-R2r2 R6: save-failed says the page was not saved and remains open");
      const unavailable = await runCase({ ok: false, reason: "unavailable" });
      check(/temporarily unavailable/.test(unavailable.failure) && unavailable.invalid === 0,
        "F8-R2r2 R6: transient unavailability stays on the guard as a retryable failure");
  
      const btn = control();
      let calls = 0; let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const run = createGuardActionRunner({
        send: async () => { calls += 1; await gate; return { ok: true }; },
        onFailure: () => {}, onInvalid: () => {}
      });
      const first = run(btn, { type: "x" }, "Fallback");
      const duplicate = await run(btn, { type: "x" }, "Fallback");
      check(btn.disabled && btn.attrs["aria-busy"] === "true" && calls === 1 && duplicate.ignored,
        "F8-R2r2 R6: a pending guard action is aria-busy and suppresses duplicate activation");
      release(); await first;
      check(btn.disabled && btn.attrs["aria-busy"] === "true" && calls === 1,
        "F8-R2r2 R6: a successful unload path remains inert after one send");
    }
  
    {
      const onb = await import("../js/lib/onboarding-copy.js");
      const fp = onb.HELP_TOPICS.find((p) => p.id === "focus");
      const text = JSON.stringify(fp);
      check(/cannot preserve text typed into the page/.test(text) && /current page stays open/.test(text),
        "F8-R2r C9: Help explains expiry safety without promising live page-state recovery");
    }
  
    /* -- C10: guard actions/context require a live normal focus.html sender (wrong page/hash/tab/incognito) -- */
    {
      const w = use([
        { id: 1, url: G("k1") },                 // a genuine guard tab
        { id: 2, url: DURL },                    // dashboard page
        { id: 3, url: G("k1"), incognito: true } // incognito guard-looking tab
      ], { focusSiteRules: [rule("a.com", "always")] });
      w.store.focusBlockedAttempts = { 1: mkAttempt({ id: "k1", url: "https://a.com" }) };
      // wrong extension PAGE (dashboard) cannot rebind/read someone's attempt
      check((await guard.guardContext(2, "k1")).kind === "not-guard",
        "F8-R2r C10: a non-guard (dashboard) page is rejected as not-guard");
      // wrong hash on a real guard tab
      w.setUrl(2, G("other"));
      check((await guard.guardContext(2, "k1")).kind === "not-guard",
        "F8-R2r C10: a guard tab whose hash is a DIFFERENT attempt id cannot act on this one");
      // incognito guard-looking tab is rejected
      check((await guard.grantAccess(3, "k1", 5)).reason === "not-guard",
        "F8-R2r C10: an incognito tab is never a valid guard sender");
      // the genuine guard tab works
      const ctx = await guard.guardContext(1, "k1");
      check(ctx.kind === "initial" && ctx.ruleScope === "always",
        "F8-R2r C10: the real guard tab resolves its own attempt");
      check((await guard.returnAndClose(2, "k1", false)).reason === "not-guard",
        "F8-R2r C10: return-close from a non-guard tab is rejected");
    }
    {
      const w = use([
        { id: 1, url: G("normal"), windowId: 100 },
        { id: 2, url: G("popup"), windowId: 200 },
        { id: 3, url: G("tools"), windowId: 300 }
      ], { focusSiteRules: [rule("a.com", "always")] }, [
        { id: 100, type: "normal" }, { id: 200, type: "popup" }, { id: 300, type: "devtools" }
      ]);
      w.store.focusBlockedAttempts = {
        1: mkAttempt({ id: "normal" }), 2: mkAttempt({ id: "popup" }), 3: mkAttempt({ id: "tools" })
      };
      check((await guard.guardContext(1, "normal")).kind === "initial" &&
        (await guard.guardContext(2, "popup")).kind === "not-guard" &&
        (await guard.guardContext(3, "tools")).kind === "not-guard",
        "F8-R2r2 R3: one-tab sender validation consults windows.Window.type");
      await guard.recoverGuard();
      check(attempts(w)[1]?.id === "normal" && !attempts(w)[2] && !attempts(w)[3],
        "F8-R2r2 R3: recovery keeps only live normal-window guard attempts");
    }
  
    globalThis.chrome = baseChrome; // restore the shared mock for any trailing work
  }
  
}
