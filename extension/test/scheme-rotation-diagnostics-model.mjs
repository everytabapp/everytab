/** Deterministic tests for the copy-safe diagnostic model. */
import assert from "node:assert/strict";
import {
  SCHEME_ROTATION_DIAGNOSTIC_TRACE_LIMIT,
  buildSchemeRotationDiagnostics
} from "../js/lib/scheme-rotation-diagnostics.js";
import {
  createCustomSchemeRecord,
  createDefaultCustomSchemeDraft,
  customSchemeRef
} from "../js/lib/custom-schemes.js";

let checks = 0;
function check(condition, message) {
  checks += 1;
  assert.ok(condition, message);
}

const poolKey = "cream|tide";
const base = (overrides = {}) => ({
  settings: {
    uiScheme: "cream",
    schemeRotate: "open",
    schemeFavorites: ["cream", "tide"]
  },
  customRecords: {},
  state: { poolKey, remaining: [] },
  prepared: { from: "cream", next: "tide", poolKey },
  cache: {
    selection: "cream",
    schemeRotate: "open",
    schemeRotationPoolKey: poolKey,
    preparedTheme: { selection: "tide" }
  },
  painted: { bootSelection: "tide", currentSelection: "cream" },
  workerTrace: [],
  ...overrides
});

const report = (overrides = {}) => buildSchemeRotationDiagnostics(base(overrides));

check(report({
  settings: { uiScheme: "cream", schemeRotate: "off", schemeFavorites: [] }
}).verdict === "rotation-off", "rotation off has its own verdict");

check(report({
  settings: { uiScheme: "cream", schemeRotate: "hourly", schemeFavorites: [] }
}).verdict === "on-open-disabled", "scheduled rotation is distinct from On open");

check(report({
  settings: { uiScheme: "cream", schemeRotate: "open", schemeFavorites: ["cream"] },
  state: { poolKey: "cream", remaining: [] },
  prepared: null
}).verdict === "one-item-pool", "a one-item pool explains an invisible rotation");

check(report({
  state: { poolKey, remaining: "tide" }
}).verdict === "bag-malformed", "a malformed shuffle bag is distinguished");

const staleBag = report({
  state: { poolKey: "cream|ink", remaining: ["cream", "bogus"] }
});
check(staleBag.verdict === "bag-stale" &&
  staleBag.operational.bag.poolKeyMatches === false &&
  staleBag.operational.bag.unavailableCount === 1 &&
  staleBag.operational.bag.currentPending === true,
"a stale bag reports each bounded mismatch without returning the raw pool key");

check(report({
  prepared: { from: "cream" }
}).verdict === "reservation-malformed", "a malformed reservation is distinguished");

check(report({
  prepared: { from: "ink", next: "tide", poolKey }
}).verdict === "reservation-stale", "a stale reservation is distinguished");

const valid = report();
check(valid.verdict === "valid-reservation" &&
  valid.operational.reservation.health === "valid" &&
  valid.operational.cache.health === "valid",
"a valid prepared draw is visible independently of runtime evidence");

const missed = report({
  workerTrace: [{ event: "page-handshake-sent", source: "page" }]
});
check(missed.verdict === "worker-never-saw-handshake" &&
  missed.runtime.handshake.pageSent && !missed.runtime.handshake.workerSaw,
"a sent page handshake with no worker receipt has a direct verdict");

const expectedButMissing = report({
  expectedHandshake: true,
  workerTrace: {
    ok: true,
    protocol: 1,
    worker: { startedAt: 1_000, version: "0.8.317" },
    armed: false,
    armedUntil: 9_000,
    activeCount: 0,
    handledCount: 4,
    trace: [{ at: 1_000, event: "worker-start", version: "0.8.317" }]
  }
});
check(expectedButMissing.verdict === "worker-never-saw-handshake" &&
  expectedButMissing.runtime.handshake.expected &&
  !expectedButMissing.runtime.handshake.workerSaw,
"an externally confirmed New Tab catches a missing worker handshake without page logs");

const armedOnly = report({
  workerTrace: {
    ok: true,
    protocol: 1,
    worker: { startedAt: 1_000, version: "0.8.317" },
    armed: true,
    activeCount: 0,
    handledCount: 4,
    trace: [{ event: "worker-start", version: "0.8.317" }]
  }
});
check(armedOnly.verdict === "valid-reservation" &&
  armedOnly.runtime.handshake.expected === false,
"arming capture alone does not falsely claim that a New Tab handshake was expected");

const noOp = report({
  workerTrace: [
    { event: "page-handshake-sent" },
    { event: "worker-handshake-received" },
    { event: "worker-result", outcome: "no-op", changed: false, scheme: "cream" }
  ]
});
check(noOp.verdict === "worker-no-op" && noOp.runtime.worker.outcome === "no-op",
  "a worker no-op is distinct from a missing handshake");

const success = report({
  settings: { uiScheme: "tide", schemeRotate: "open", schemeFavorites: ["cream", "tide"] },
  state: { poolKey, remaining: [] },
  prepared: { from: "tide", next: "cream", poolKey, commitToken: "private-token" },
  cache: {
    selection: "tide",
    schemeRotate: "open",
    schemeRotationPoolKey: poolKey,
    preparedTheme: { selection: "cream" }
  },
  painted: { bootSelection: "tide", currentSelection: "tide" },
  workerTrace: [
    { event: "page-handshake-sent" },
    { event: "worker-handshake-received" },
    { event: "worker-result", changed: true, before: "cream", scheme: "tide" },
    { event: "page-paint", scheme: "tide" }
  ]
});
check(success.verdict === "rotation-successful" &&
  success.runtime.transition.committed && !success.runtime.transition.reverted &&
  success.runtime.painted.currentMatchesSettings,
"a committed and still-painted scheme is a successful rotation");
check(!JSON.stringify(success).includes("private-token"),
  "reservation commit tokens never cross the report boundary");

const exactWorkerSuccess = report({
  settings: { uiScheme: "tide", schemeRotate: "open", schemeFavorites: ["cream", "tide"] },
  state: { poolKey, remaining: [] },
  prepared: { from: "tide", next: "cream", poolKey },
  cache: {
    selection: "tide",
    schemeRotate: "open",
    rotationPoolKey: poolKey,
    preparedTheme: { selection: "cream", scheme: "cream", customScheme: null }
  },
  painted: { bootSelection: "tide", currentSelection: "tide" },
  expectedHandshake: true,
  workerTrace: {
    ok: true,
    protocol: 1,
    worker: { startedAt: 1_000, version: "0.8.317" },
    armed: true,
    armedUntil: 9_000,
    activeCount: 0,
    handledCount: 5,
    trace: [
      { at: 1_000, event: "worker-start", version: "0.8.317" },
      { at: 2_000, event: "readiness-received", tabId: 42 },
      { at: 2_001, event: "task-start", tabId: 42 },
      {
        at: 2_002,
        event: "task-complete",
        tabId: 42,
        changed: true,
        scheme: { kind: "built-in", id: "tide" },
        nextScheme: { kind: "built-in", id: "cream" }
      }
    ]
  }
});
check(exactWorkerSuccess.verdict === "rotation-successful" &&
  exactWorkerSuccess.operational.cache.health === "valid" &&
  exactWorkerSuccess.runtime.trace.response.workerVersion === "0.8.317" &&
  exactWorkerSuccess.runtime.trace.events.at(-1).event === "task-complete",
"the model consumes the worker's exact response and the UI's rotationPoolKey cache shape");

const reverted = report({
  workerTrace: [
    { event: "page-handshake-sent" },
    { event: "worker-handshake-received" },
    { event: "worker-result", outcome: "changed", before: "cream", after: "tide" },
    { event: "settings-change", source: "vault", before: "tide", after: "cream" },
    { event: "page-paint", scheme: "cream" }
  ]
});
check(reverted.verdict === "rotation-reverted" &&
  reverted.runtime.transition.revertSource === "vault" &&
  reverted.evidence.includes("post-commit-vault-change") &&
  reverted.summary.includes("Vault"),
"a successful worker commit followed by a Vault setting write is called out directly");

const exactVaultReversion = report({
  expectedHandshake: true,
  workerTrace: {
    ok: true,
    protocol: 1,
    worker: { startedAt: 1_000, version: "0.8.317" },
    armed: true,
    activeCount: 0,
    handledCount: 6,
    trace: [
      { event: "worker-start", version: "0.8.317" },
      { event: "readiness-received", tabId: 43 },
      {
        event: "task-complete",
        tabId: 43,
        changed: true,
        scheme: { kind: "built-in", id: "tide" },
        nextScheme: { kind: "built-in", id: "cream" }
      },
      {
        event: "storage-change",
        settings: {
          old: { uiScheme: { kind: "built-in", id: "tide" }, schemeRotate: "open" },
          new: { uiScheme: { kind: "built-in", id: "cream" }, schemeRotate: "open" }
        },
        settingsModifiedAt: { old: 123, new: 456 },
        preparedInChange: false,
        vaultMeta: {
          old: { lastSyncAt: 100, ok: true, pulled: 0, pushed: 1, conflicts: 0 },
          new: { lastSyncAt: 200, ok: true, pulled: 1, pushed: 1, conflicts: 0 }
        }
      }
    ]
  }
});
const exactStorage = exactVaultReversion.runtime.trace.events.at(-1);
check(exactVaultReversion.verdict === "rotation-reverted" &&
  exactVaultReversion.runtime.transition.revertSource === "vault" &&
  exactStorage.vaultMetaChanged === true &&
  exactStorage.settingsModifiedAt.new === 456 &&
  exactStorage.vaultMeta.new.pulled === 1,
"the exact storage-change shape identifies a post-commit Vault reversion");

const splitVaultReversion = report({
  expectedHandshake: true,
  workerTrace: {
    ok: true,
    protocol: 1,
    worker: { startedAt: 1_000, version: "0.8.317" },
    armed: true,
    activeCount: 0,
    handledCount: 7,
    trace: [
      { event: "readiness-received", tabId: 44 },
      {
        event: "task-complete",
        tabId: 44,
        changed: true,
        scheme: { kind: "built-in", id: "tide" },
        nextScheme: { kind: "built-in", id: "cream" }
      },
      {
        event: "storage-change",
        settings: {
          old: { uiScheme: { kind: "built-in", id: "tide" }, schemeRotate: "open" },
          new: { uiScheme: { kind: "built-in", id: "cream" }, schemeRotate: "open" }
        },
        preparedInChange: false
      },
      {
        event: "storage-change",
        preparedInChange: false,
        vaultMeta: {
          old: { lastSyncAt: 100, ok: true, pulled: 0, pushed: 1, conflicts: 0 },
          new: { lastSyncAt: 200, ok: true, pulled: 1, pushed: 1, conflicts: 0 }
        }
      }
    ]
  }
});
check(splitVaultReversion.verdict === "rotation-reverted" &&
  splitVaultReversion.runtime.transition.revertSource === "vault" &&
  splitVaultReversion.evidence.includes("post-commit-vault-change") &&
  splitVaultReversion.runtime.trace.events.at(-1).vaultPullObserved === true,
"a later Vault metadata event attributes a Settings-first sync reversion to the pull");

const uuid = "11111111-1111-4111-8111-111111111111";
const privateName = "Private Aurora Work Profile";
const customDraft = createDefaultCustomSchemeDraft(privateName);
const customRecord = createCustomSchemeRecord(customDraft.value, {
  id: uuid,
  deviceId: "private-device-name",
  createdAt: 1,
  modifiedAt: 2,
  schemaVersion: 1
}).value;
const custom = customSchemeRef(uuid);
const customPoolKey = `cream|${custom}`;
const privacyReport = buildSchemeRotationDiagnostics({
  settings: { uiScheme: custom, schemeRotate: "open", schemeFavorites: ["cream", custom] },
  customRecords: {
    [uuid]: customRecord,
    "private-malformed-key": { name: "Never print this malformed name" }
  },
  state: { poolKey: customPoolKey, remaining: ["cream"] },
  prepared: { from: custom, next: "cream", poolKey: customPoolKey },
  cache: {
    scheme: "custom",
    customScheme: uuid,
    selection: custom,
    schemeRotate: "open",
    schemeRotationPoolKey: customPoolKey,
    preparedTheme: { scheme: "cream", selection: "cream" }
  },
  painted: { bootSelection: custom, currentSelection: custom },
  workerTrace: [
    {
      event: "settings-change",
      source: "unknown-source-that-must-not-print",
      before: custom,
      after: "cream",
      error: `${privateName} failed at https://private.example/`
    },
    { event: "private-event-name", outcome: "private-outcome", scheme: custom }
  ]
});
const copied = JSON.stringify(privacyReport);
check(privacyReport.rotation.current.kind === "custom" &&
  privacyReport.rotation.pool.customCount === 1 &&
  privacyReport.customSchemes.liveCount === 1 &&
  privacyReport.customSchemes.invalidCount === 1,
"custom schemes remain useful as counts and kinds");
check(!copied.includes(uuid) && !copied.includes(privateName) &&
  !copied.includes("private-device-name") && !copied.includes("private.example") &&
  !copied.includes("private-event-name") && !copied.includes("unknown-source-that-must-not-print") &&
  !copied.includes(customPoolKey),
"copy-safe output masks custom identities and drops arbitrary source text");

const uuidB = "22222222-2222-4222-8222-222222222222";
const customB = customSchemeRef(uuidB);
const customRecordB = { ...structuredClone(customRecord), id: uuidB, modifiedAt: 3 };
const twoCustomRecords = { [uuid]: customRecord, [uuidB]: customRecordB };
const twoCustomPoolKey = `${customB}|${custom}`;
const exactCustomReservation = buildSchemeRotationDiagnostics({
  settings: {
    uiScheme: custom,
    schemeRotate: "open",
    schemeFavorites: [custom, customB]
  },
  customRecords: twoCustomRecords,
  state: { poolKey: twoCustomPoolKey, remaining: [] },
  prepared: { from: custom, next: customB, poolKey: twoCustomPoolKey },
  cache: {
    selection: custom,
    schemeRotate: "open",
    rotationPoolKey: twoCustomPoolKey,
    preparedTheme: { selection: customB }
  },
  painted: custom,
  workerTrace: []
});
check(exactCustomReservation.verdict === "valid-reservation" &&
  exactCustomReservation.operational.reservation.nextDiffers === true &&
  exactCustomReservation.operational.cache.health === "valid",
"two distinct custom references remain distinct for reservation and cache comparisons");

const threeSchemePoolKey = `cream|${customB}|${custom}`;
const customMismatch = buildSchemeRotationDiagnostics({
  settings: {
    uiScheme: custom,
    schemeRotate: "open",
    schemeFavorites: ["cream", custom, customB]
  },
  customRecords: twoCustomRecords,
  state: { poolKey: threeSchemePoolKey, remaining: [] },
  prepared: { from: customB, next: "cream", poolKey: threeSchemePoolKey },
  cache: {
    selection: customB,
    schemeRotate: "open",
    rotationPoolKey: threeSchemePoolKey,
    preparedTheme: { selection: "cream" }
  },
  painted: customB,
  workerTrace: []
});
check(customMismatch.verdict === "reservation-stale" &&
  customMismatch.operational.reservation.fromMatchesCurrent === false &&
  customMismatch.operational.cache.currentMatches === false &&
  customMismatch.runtime.painted.currentMatchesSettings === false,
"custom A and custom B mismatches stay visible internally across reservation, cache, and paint");

const customVaultReversion = buildSchemeRotationDiagnostics({
  settings: {
    uiScheme: customB,
    schemeRotate: "open",
    schemeFavorites: ["cream", custom, customB]
  },
  customRecords: twoCustomRecords,
  state: { poolKey: threeSchemePoolKey, remaining: [] },
  prepared: { from: customB, next: "cream", poolKey: threeSchemePoolKey },
  cache: {
    selection: customB,
    schemeRotate: "open",
    rotationPoolKey: threeSchemePoolKey,
    preparedTheme: { selection: "cream" }
  },
  painted: customB,
  workerTrace: [
    { event: "worker-result", changed: true, before: "cream", scheme: custom },
    { event: "settings-change", source: "vault", before: custom, after: customB }
  ]
});
const copiedCustomReversion = JSON.stringify(customVaultReversion);
check(customVaultReversion.verdict === "rotation-reverted" &&
  customVaultReversion.runtime.transition.revertSource === "vault" &&
  !copiedCustomReversion.includes(uuid) && !copiedCustomReversion.includes(uuidB),
"a custom A to custom B Vault reversion is detected before both identities are masked");

const maskedWorkerCustomReversion = buildSchemeRotationDiagnostics({
  settings: {
    uiScheme: customB,
    schemeRotate: "open",
    schemeFavorites: ["cream", custom, customB]
  },
  customRecords: twoCustomRecords,
  state: { poolKey: threeSchemePoolKey, remaining: [] },
  prepared: { from: customB, next: "cream", poolKey: threeSchemePoolKey },
  cache: {
    selection: customB,
    schemeRotate: "open",
    rotationPoolKey: threeSchemePoolKey,
    preparedTheme: { selection: "cream" }
  },
  // Production runs this model in Settings, so its own boot paint is not the
  // temporary New Tab's pre-paint identity.
  painted: { bootSelection: customB, currentSelection: customB },
  expectedHandshake: true,
  expectedTabId: 901,
  expectedCommitSelection: custom,
  workerTrace: {
    ok: true,
    protocol: 1,
    worker: { startedAt: 1_000, version: "0.8.317" },
    armed: true,
    activeCount: 0,
    handledCount: 1,
    trace: [
      { event: "readiness-received", tabId: 901 },
      {
        event: "task-complete",
        tabId: 901,
        changed: true,
        scheme: { kind: "custom" },
        nextScheme: { kind: "built-in", id: "cream" }
      },
      {
        event: "storage-change",
        settings: {
          old: { uiScheme: { kind: "custom" }, schemeRotate: "open" },
          new: { uiScheme: { kind: "custom" }, schemeRotate: "open" }
        },
        preparedInChange: false
      },
      {
        event: "storage-change",
        preparedInChange: false,
        vaultMeta: {
          old: { lastSyncAt: 100, ok: true, pulled: 0, pushed: 0, conflicts: 0 },
          new: { lastSyncAt: 200, ok: true, pulled: 1, pushed: 0, conflicts: 0 }
        }
      }
    ]
  }
});
const copiedMaskedCustom = JSON.stringify(maskedWorkerCustomReversion);
check(maskedWorkerCustomReversion.verdict === "rotation-reverted" &&
  maskedWorkerCustomReversion.runtime.transition.revertSource === "vault" &&
  !copiedMaskedCustom.includes(uuid) && !copiedMaskedCustom.includes(uuidB),
"a private preflight reservation recovers custom A/B comparison from a masked worker response");

const expectedTabId = 864_209_753;
const otherTabId = 864_209_754;
const concurrentTabs = report({
  settings: { uiScheme: "tide", schemeRotate: "open", schemeFavorites: ["cream", "tide"] },
  state: { poolKey, remaining: [] },
  prepared: { from: "tide", next: "cream", poolKey },
  cache: {
    selection: "tide",
    schemeRotate: "open",
    rotationPoolKey: poolKey,
    preparedTheme: { selection: "cream" }
  },
  painted: { bootSelection: "tide", currentSelection: "tide" },
  expectedHandshake: true,
  expectedTabId,
  workerTrace: {
    ok: true,
    protocol: 1,
    worker: { startedAt: 1_000, version: "0.8.317" },
    armed: true,
    activeCount: 0,
    handledCount: 2,
    trace: [
      { event: "worker-start", version: "0.8.317" },
      { event: "readiness-received", tabId: otherTabId },
      {
        event: "task-complete",
        tabId: otherTabId,
        changed: true,
        scheme: { kind: "built-in", id: "ink" }
      },
      { event: "readiness-received", tabId: expectedTabId },
      { event: "task-start", tabId: expectedTabId },
      {
        event: "task-complete",
        tabId: expectedTabId,
        changed: true,
        scheme: { kind: "built-in", id: "tide" }
      },
      { event: "page-paint", tabId: otherTabId, scheme: "ink" }
    ]
  }
});
const copiedConcurrent = JSON.stringify(concurrentTabs);
check(concurrentTabs.verdict === "rotation-successful" &&
  concurrentTabs.runtime.worker.changedTo.id === "tide" &&
  concurrentTabs.runtime.trace.ignoredTabEventCount === 3 &&
  concurrentTabs.runtime.trace.events.every((event) => !("tabId" in event)) &&
  !copiedConcurrent.includes(String(expectedTabId)) &&
  !copiedConcurrent.includes(String(otherTabId)),
"the expected New Tab ignores concurrent lifecycle events without serializing either tab id");

const onlyOtherTab = report({
  expectedHandshake: true,
  expectedTabId,
  workerTrace: [
    { event: "readiness-received", tabId: otherTabId },
    {
      event: "task-complete",
      tabId: otherTabId,
      changed: true,
      scheme: { kind: "built-in", id: "tide" }
    }
  ]
});
check(onlyOtherTab.verdict === "worker-never-saw-handshake" &&
  onlyOtherTab.runtime.trace.ignoredTabEventCount === 2,
"another New Tab cannot satisfy the expected tab's missing-handshake check");

const concurrentCustomRotation = buildSchemeRotationDiagnostics({
  settings: {
    uiScheme: customB,
    schemeRotate: "open",
    schemeFavorites: ["cream", custom, customB]
  },
  customRecords: twoCustomRecords,
  state: { poolKey: threeSchemePoolKey, remaining: [] },
  prepared: { from: customB, next: "cream", poolKey: threeSchemePoolKey },
  cache: {
    selection: customB,
    schemeRotate: "open",
    rotationPoolKey: threeSchemePoolKey,
    preparedTheme: { selection: "cream" }
  },
  painted: { bootSelection: customB, currentSelection: customB },
  expectedCommitSelection: custom,
  expectedHandshake: true,
  expectedTabId: 10,
  workerTrace: [
    { event: "readiness-received", tabId: 10 },
    { event: "task-complete", tabId: 10, changed: true, scheme: { kind: "custom" } },
    {
      event: "storage-change",
      preparedInChange: true,
      settings: {
        old: { uiScheme: { kind: "custom" }, schemeRotate: "open" },
        new: { uiScheme: { kind: "custom" }, schemeRotate: "open" }
      }
    },
    { event: "readiness-received", tabId: 11 },
    { event: "task-complete", tabId: 11, changed: true, scheme: { kind: "custom" } }
  ]
});
check(concurrentCustomRotation.verdict === "rotation-successful" &&
  concurrentCustomRotation.runtime.transition.reverted === false &&
  concurrentCustomRotation.runtime.trace.ignoredTabEventCount === 2,
"a second custom New Tab rotation is not misreported as a reversion of the expected tab");

const matureCustomRecords = {};
for (let index = 1; index <= 129; index += 1) {
  const id = `${index.toString(16).padStart(8, "0")}-1111-4111-8111-${index
    .toString(16).padStart(12, "0")}`;
  matureCustomRecords[id] = {
    ...structuredClone(customRecord),
    id,
    modifiedAt: index
  };
}
const matureId = Object.keys(matureCustomRecords).at(-1);
const matureSelection = customSchemeRef(matureId);
const maturePoolKey = `cream|${matureSelection}`;
const mature = buildSchemeRotationDiagnostics({
  settings: {
    uiScheme: matureSelection,
    schemeRotate: "open",
    schemeFavorites: ["cream", matureSelection]
  },
  customRecords: matureCustomRecords,
  state: { poolKey: maturePoolKey, remaining: ["cream"] },
  prepared: { from: matureSelection, next: "cream", poolKey: maturePoolKey },
  cache: {
    selection: matureSelection,
    schemeRotate: "open",
    rotationPoolKey: maturePoolKey,
    preparedTheme: { selection: "cream" }
  },
  painted: matureSelection,
  workerTrace: []
});
check(mature.rotation.current.kind === "custom" &&
  mature.rotation.missingCustomSelection === false &&
  mature.rotation.pool.size === 2 && mature.rotation.pool.customCount === 1 &&
  mature.customSchemes.liveCount === 129 &&
  !JSON.stringify(mature).includes(matureId),
"a mature custom map uses the full runtime catalogue while emitting only counts and kinds");

const longTrace = Array.from({ length: SCHEME_ROTATION_DIAGNOSTIC_TRACE_LIMIT + 8 }, () => ({
  event: "page-paint",
  scheme: "cream",
  error: "private text"
}));
const bounded = report({ workerTrace: longTrace });
check(bounded.runtime.trace.retainedCount === SCHEME_ROTATION_DIAGNOSTIC_TRACE_LIMIT &&
  bounded.runtime.trace.droppedCount === 8 &&
  bounded.runtime.trace.events.length === SCHEME_ROTATION_DIAGNOSTIC_TRACE_LIMIT &&
  !JSON.stringify(bounded).includes("private text"),
"trace output is bounded and strips arbitrary diagnostic text");

check(assert.deepEqual(report(), report()) === undefined,
  "the same explicit snapshot produces a stable report");

console.log(`\nAll ${checks} scheme-rotation diagnostic checks passed`);
