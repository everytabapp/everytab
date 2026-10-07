// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";

const COST_NAMES = new Set([
  "RunTask", "FunctionCall", "UpdateLayoutTree", "Layout", "PrePaint", "Paint",
  "EventDispatch", "ParseHTML", "EvaluateScript", "MinorGC", "MajorGC"
]);
const CHANGE_MARKERS = new Set(["inbox:root-style-change", "inbox:root-attribute-change", "inbox:body-class-change", "inbox:focus-prepared"]);
const MARKERS = new Set(["inbox:departure", "inbox:injected"]);
const MARKER_PHASES = new Set(["R", "I", "i"]);
const LIFECYCLE_TYPES = new Set(["beforeunload", "pagehide", "unload", "visibilitychange"]);
const nonnegative = value => Number.isFinite(value) && value >= 0;
const identity = value => Number.isSafeInteger(value) && value >= 0;
const rootNodeIdentity = value => Number.isSafeInteger(value) && value > 0;
const compareName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
const INVALIDATION_NAMES = new Set(["ScheduleStyleRecalculation", "StyleRecalcInvalidationTracking", "UpdateLayoutTree"]);
// Chromium core/css/style_change_reason.cc. Unknown future reasons stay private.
const STYLE_REASONS = new Set([
  "Accessibility", "ActiveStylesheetsUpdate", "Affected by :has()", "Animation", "Attribute",
  "Conditional ::backdrop", "Control", "ControlValue", "Extension declarativeContent.css",
  "DesignMode", "Dialog", "DisplayLock", "EditContext", "EnvironmentVariableChanged", "ViewTransition",
  "FlatTreeChange", "Fonts", "Frame", "Fullscreen", "@function rule change",
  "InheritedStyleChangeFromParentFrame", "Inline CSS style declaration was mutated", "Inspector",
  "@keyframes rule change", "Language", "LinkColorChange", "Media Query changed", "Navigation Query changed",
  "Node was inserted into tree", "Overscroll", "PictureSourceChange", "PlatformColorChange", "Plugin Changed",
  "Popover Visibility Change", "@position-try change", "Printing", "PropertyRegistration", "PseudoClass",
  "Related style rule", "ScrollTimeline", "SVGContainerSizeChange", "Settings", "Shadow",
  "Style attribute change", "Style rule change", "TopLayer", "UseFallback", "ViewportDefiningElement",
  "ViewportUnits", "VisuallyOrdered", "WritingModeChange", "Zoom"
]);
const sourcePath = value => typeof value === "string" && value.length <= 512 &&
  /^js\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.js$/.test(value);

/** Node::DebugName suffixes may contain private IDs/classes; retain only a fixed tag. */
function insertedNodeKind(value) {
  if (value === "#text") return "text";
  if (typeof value !== "string") return "other";
  const tag = /^(STYLE|LINK|HTML|BODY)(?:$| (?:id|class)=')/.exec(value)?.[1];
  return tag ? tag.toLowerCase() : "other";
}

/**
 * Validate Tracing.tracingComplete metadata separately from collected costs.
 * An omitted protocol flag is unknown, not proof that the trace lost no data.
 * @param {object} params
 * @returns {{dataLossOccurred:false|null}}
 */
export function validateInboxDepartureCompletion(params) {
  assert.ok(params !== null && typeof params === "object" && !Array.isArray(params),
    "Departure trace completion metadata is invalid");
  const present = Object.hasOwn(params, "dataLossOccurred");
  assert.ok(!present || typeof params.dataLossOccurred === "boolean",
    "Departure trace completion metadata is invalid");
  assert.ok(!params.dataLossOccurred, "Departure trace reported data loss");
  return { dataLossOccurred: present ? false : null };
}

/**
 * Collect a short native trace without retaining event args, URLs or user names.
 * The caller passes each Tracing.dataCollected value array and reads after the
 * trace completes. Retains complete X costs, fixed observation markers and,
 * when enabled, allowlisted invalidation metadata and dispatch lifecycle types.
 * Costs on other threads are excluded. Nested costs overlap, so these summaries
 * do not establish elapsed CPU time or explain unattributed browser waiting.
 * Optional attribution retains the first allowlisted owned source location only.
 * Trace stack coordinates are one-based; raw stacks and node data are discarded.
 * Invalidation timestamps show observations, not proof of a sole causal mutation.
 * Optional read-time root identities classify PropertyRegistration and exact HTML
 * insertion node IDs separately; IDs remain private and default receipts omit ownership.
 * @param {{extensionOrigin:string,sourcePaths:string[]}} [options]
 * @returns {{accept:(events:object[])=>void,read:(ownership?:{outgoingRootNodeId:number,incomingRootNodeId:number})=>{intervalMs:number,
 * events:Array<{name:string,atMs:number,durationMs:number,lifecycleType?:string}>,
 * summary:Array<{name:string,count:number,durationMs:number}>,overlapWarning:string,
 * invalidations?:Array<{name:string,atMs:number,reason:string,file:string|null,line:number|null,column:number|null,rootOwnership?:string,insertedNodeKind?:string,insertedRootOwnership?:string}>}}}
 */
export function createInboxDepartureTrace(options) {
  const costs = [];
  const invalidations = [];
  const markers = new Map();
  let invalidMarkers = false;
  let sources = null;
  if (options !== undefined) {
    assert.ok(options && typeof options.extensionOrigin === "string" && /^chrome-extension:\/\/[a-p]{32}$/.test(options.extensionOrigin) &&
      Array.isArray(options.sourcePaths) && options.sourcePaths.length > 0 &&
      options.sourcePaths.length <= 20_000 && options.sourcePaths.every(sourcePath),
    "Departure trace attribution requires an exact extension origin and safe source paths");
    sources = new Map(options.sourcePaths.map(file => [`${options.extensionOrigin}/${file}`, file]));
  }

  function sourceLocation(stack) {
    if (Array.isArray(stack)) {
      for (const frame of stack) {
        if (frame && sources.has(frame.url) && Number.isSafeInteger(frame.lineNumber) && frame.lineNumber > 0 &&
            Number.isSafeInteger(frame.columnNumber) && frame.columnNumber > 0) {
          return { file: sources.get(frame.url), line: frame.lineNumber, column: frame.columnNumber };
        }
      }
    }
    return { file: null, line: null, column: null };
  }

  function accept(events) {
    assert.ok(Array.isArray(events), "Departure trace requires an event array");
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      const { name, ph, pid, tid, ts, dur } = event;
      const validIdentity = identity(pid) && identity(tid) && nonnegative(ts);
      if (sources && INVALIDATION_NAMES.has(name) && validIdentity &&
          (name === "UpdateLayoutTree" ? ph === "X" && nonnegative(dur) && Number.isFinite(ts + dur) : ph === "I" || ph === "i")) {
        assert.ok(invalidations.length < 100_000, "Departure trace invalidation capacity exceeded");
        const data = name === "UpdateLayoutTree" ? event.args?.beginData : event.args?.data;
        const insertionKind = name === "StyleRecalcInvalidationTracking" && data?.reason === "Node was inserted into tree"
          ? insertedNodeKind(data.nodeName) : undefined;
        invalidations.push({ name, pid, tid, ts, reason: STYLE_REASONS.has(data?.reason) ? data.reason : "other",
          ...(name === "StyleRecalcInvalidationTracking" && data?.reason === "PropertyRegistration"
            ? { rootNodeId: rootNodeIdentity(data.nodeId) ? data.nodeId : null } : {}),
          ...(insertionKind !== undefined ? { insertedNodeKind: insertionKind } : {}),
          ...(insertionKind === "html" ? { insertedRootNodeId: rootNodeIdentity(data.nodeId) ? data.nodeId : null } : {}),
          ...sourceLocation(data?.stackTrace) });
      }
      if (MARKERS.has(name)) {
        if (!validIdentity || !MARKER_PHASES.has(ph) || markers.has(name)) {
          invalidMarkers = true;
        } else {
          markers.set(name, { pid, tid, ts });
        }
      } else if (CHANGE_MARKERS.has(name) && MARKER_PHASES.has(ph) && validIdentity) {
        costs.push({ name, pid, tid, ts, dur: 0 });
      } else if (COST_NAMES.has(name) && ph === "X" && validIdentity &&
          nonnegative(dur) && Number.isFinite(ts + dur)) {
        const lifecycleType = sources && name === "EventDispatch" && LIFECYCLE_TYPES.has(event.args?.data?.type)
          ? event.args.data.type : undefined;
        costs.push({ name, pid, tid, ts, dur, ...(lifecycleType !== undefined ? { lifecycleType } : {}) });
      }
    }
  }

  function read(ownership) {
    if (ownership !== undefined) {
      assert.ok(sources && ownership && typeof ownership === "object" && !Array.isArray(ownership) &&
        rootNodeIdentity(ownership.outgoingRootNodeId) && rootNodeIdentity(ownership.incomingRootNodeId) &&
        ownership.outgoingRootNodeId !== ownership.incomingRootNodeId,
      "Departure trace root ownership requires attribution and distinct positive numeric root IDs");
    }
    const start = markers.get("inbox:departure");
    const end = markers.get("inbox:injected");
    assert.ok(!invalidMarkers && start && end && start.pid === end.pid && start.tid === end.tid &&
      end.ts >= start.ts, "Departure trace requires one ordered marker pair on the same renderer thread");
    const events = [];
    for (const cost of costs) {
      if (end.ts === start.ts || cost.pid !== start.pid || cost.tid !== start.tid) continue;
      // Half-open interval: a zero-duration cost at injection is outside it.
      if (cost.ts >= end.ts || (cost.dur > 0 ? cost.ts + cost.dur <= start.ts : cost.ts < start.ts)) continue;
      const from = Math.max(cost.ts, start.ts);
      const to = Math.min(cost.ts + cost.dur, end.ts);
      events.push({ name: cost.name, atMs: (from - start.ts) / 1_000, durationMs: (to - from) / 1_000,
        ...(cost.lifecycleType !== undefined ? { lifecycleType: cost.lifecycleType } : {}) });
    }
    events.sort((a, b) => a.atMs - b.atMs || compareName(a, b) || a.durationMs - b.durationMs);
    const totals = new Map();
    for (const event of events) {
      const total = totals.get(event.name) ?? { name: event.name, count: 0, durationMs: 0 };
      total.count++;
      total.durationMs += event.durationMs;
      assert.ok(Number.isFinite(total.durationMs), "Departure trace duration total is invalid");
      totals.set(event.name, total);
    }
    return { intervalMs: (end.ts - start.ts) / 1_000, events,
      summary: [...totals.values()].sort(compareName),
      overlapWarning: "Event durations may overlap; do not sum across names.",
      ...(sources ? { invalidations: invalidations
        .filter(event => event.pid === start.pid && event.tid === start.tid && event.ts >= start.ts && event.ts < end.ts)
        .map(({ name, ts, reason, file, line, column, rootNodeId, insertedNodeKind, insertedRootNodeId }) => ({ name, atMs: (ts - start.ts) / 1_000, reason, file, line, column,
          ...(insertedNodeKind !== undefined ? { insertedNodeKind } : {}),
          ...(ownership && insertedNodeKind === "html"
            ? { insertedRootOwnership: insertedRootNodeId === null ? "unknown"
              : insertedRootNodeId === ownership.outgoingRootNodeId ? "outgoing-root"
                : insertedRootNodeId === ownership.incomingRootNodeId ? "incoming-root" : "other" } : {}),
          ...(ownership && name === "StyleRecalcInvalidationTracking" && reason === "PropertyRegistration"
            ? { rootOwnership: rootNodeId === null ? "unknown"
              : rootNodeId === ownership.outgoingRootNodeId ? "outgoing-root"
                : rootNodeId === ownership.incomingRootNodeId ? "incoming-root" : "other" } : {}) }))
        .sort((a, b) => a.atMs - b.atMs || compareName(a, b)) } : {}) };
  }
  return { accept, read };
}
