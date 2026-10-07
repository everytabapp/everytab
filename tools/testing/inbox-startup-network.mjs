// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";

const TYPES = new Set(["Document", "Script", "Stylesheet", "Image", "Font", "Fetch", "XHR", "Other"]);
const time = value => Number.isFinite(value) && value >= 0;
const id = value => typeof value === "string" && value.length > 0;
const safePath = value => typeof value === "string" && value.split("/").every(part =>
  /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== "..");

/**
 * Root must filter CDP messages to the measured session before calling accept.
 * Reset before each fresh Dashboard navigation with its unique inboxTrial token.
 * Read immediately after frame completion is observed. These are CDP timestamp
 * deltas from the main request, not performance.now() or a precise frame cutoff:
 * protocol delivery and the frame-detection round trip may add observed events.
 * IDs stay private until reset; URLs are parsed and discarded during accept.
 * available means the main request was observed, not that every request succeeded.
 * Redirect chains are excluded, never represented as an ordinary file request.
 * Response and end stamps are independent offsets: native extension requests
 * can finish before the reported response stamp. Their difference is not latency.
 * @param {{extensionOrigin:string,allowedPaths:string[]}} options
 * @returns {{reset:(token:string)=>void,accept:(method:string,params:object)=>void,
 * assertNavigation:(loaderId:string,frameId:string)=>void,
 * read:()=>{available:boolean,clock:string,files:Array<{file:string,type:string,
 * requestMs:number,responseMs:number|null,endMs:number|null,failed:boolean}>}}}
 */
export function createInboxStartupNetwork({ extensionOrigin, allowedPaths }) {
  assert.ok(typeof extensionOrigin === "string" && /^chrome-extension:\/\/[a-p]{32}$/.test(extensionOrigin),
    "Startup network collector requires an exact extension origin");
  assert.ok(Array.isArray(allowedPaths) && allowedPaths.every(safePath) && allowedPaths.includes("dashboard.html"),
    "Startup network collector requires safe allowed sources and Dashboard");
  const host = extensionOrigin.slice("chrome-extension://".length);
  const allowed = new Set(allowedPaths);
  let token = null, main = null, invalidNavigation = false;
  const requests = new Map(), excluded = new Set();

  function source(raw) {
    if (typeof raw !== "string") return null;
    let url;
    try { url = new URL(raw); } catch { return null; }
    if (url.protocol !== "chrome-extension:" || url.hostname !== host ||
        url.port || url.username || url.password) return null;
    const file = url.pathname.slice(1);
    if (!safePath(file) || !allowed.has(file)) return null;
    return { file, trial: url.searchParams.getAll("inboxTrial") };
  }
  function exclude(requestId) {
    requests.delete(requestId);
    excluded.add(requestId);
    if (main?.requestId === requestId) {
      main = null;
      requests.clear();
      invalidNavigation = true;
    }
  }
  function reset(nextToken) {
    assert.ok(typeof nextToken === "string" && nextToken.length > 0, "Startup network trial token is required");
    token = nextToken;
    main = null;
    invalidNavigation = false;
    requests.clear();
    excluded.clear();
  }
  function accept(method, params) {
    if (!token || invalidNavigation || !params || typeof params !== "object" || !id(params.requestId)) return;
    const requestId = params.requestId;
    if (method === "Network.requestWillBeSent") {
      if (params.redirectResponse !== undefined) { exclude(requestId); return; }
      if (excluded.has(requestId)) return;
      // A repeated start without redirect metadata is malformed. Do not silently
      // replace its identity or let subsequent end events complete the wrong row.
      if (requests.has(requestId)) { exclude(requestId); return; }
      const location = source(params.request?.url);
      if (!location || !TYPES.has(params.type) || !time(params.timestamp) ||
          !id(params.loaderId) || !id(params.frameId)) return;
      if (!main) {
        if (params.type !== "Document" || location.file !== "dashboard.html" ||
            location.trial.length !== 1 || location.trial[0] !== token) return;
        main = { requestId, loaderId: params.loaderId, frameId: params.frameId, timestamp: params.timestamp };
      }
      if (params.loaderId !== main.loaderId || params.frameId !== main.frameId ||
          params.timestamp < main.timestamp || !Number.isFinite((params.timestamp - main.timestamp) * 1_000)) return;
      requests.set(requestId, { file: location.file, type: params.type,
        requestTime: params.timestamp, responseTime: null, endTime: null, failed: false });
      return;
    }
    if (!main || excluded.has(requestId)) return;
    const request = requests.get(requestId);
    if (!request || !time(params.timestamp) ||
        !Number.isFinite((params.timestamp - main.timestamp) * 1_000)) return;
    if (method === "Network.responseReceived") {
      const location = source(params.response?.url);
      if (params.loaderId !== main.loaderId || (params.frameId !== undefined && params.frameId !== main.frameId) ||
          params.type !== request.type || location?.file !== request.file ||
          (requestId === main.requestId && (location?.trial.length !== 1 || location.trial[0] !== token))) {
        exclude(requestId); return;
      }
      if (params.timestamp < request.requestTime || request.responseTime !== null) return;
      request.responseTime = params.timestamp;
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      if (params.timestamp < request.requestTime || request.endTime !== null) return;
      request.endTime = params.timestamp;
      request.failed = method === "Network.loadingFailed";
    }
  }
  function read() {
    return { available: main !== null, clock: "cdp-main-document-request",
      files: main ? [...requests.values()].sort((a, b) => a.requestTime - b.requestTime ||
        (a.file < b.file ? -1 : a.file > b.file ? 1 : a.type < b.type ? -1 : a.type > b.type ? 1 : 0))
        .map(entry => ({ file: entry.file, type: entry.type,
          requestMs: (entry.requestTime - main.timestamp) * 1_000,
          responseMs: entry.responseTime === null ? null : (entry.responseTime - main.timestamp) * 1_000,
          endMs: entry.endTime === null ? null : (entry.endTime - main.timestamp) * 1_000,
          failed: entry.failed })) : [] };
  }
  function assertNavigation(loaderId, frameId) {
    assert.ok(main && id(loaderId) && id(frameId) && main.loaderId === loaderId && main.frameId === frameId,
      "Startup network anchor must match the measured navigation");
  }
  return { reset, accept, read, assertNavigation };
}
