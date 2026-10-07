// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Exclusive sample attribution for an owned installed Inbox document. */
import assert from "node:assert/strict";

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nonnegative = value => Number.isFinite(value) && value >= 0;
const nodeId = value => Number.isSafeInteger(value) && value >= 0;

function ownedHost(origin) {
  assert.ok(typeof origin === "string", "CPU profile requires an extension origin");
  let parsed;
  try { parsed = new URL(origin); } catch {}
  assert.ok(parsed?.protocol === "chrome-extension:" && /^[a-p]{32}$/.test(parsed.hostname) &&
    !parsed.username && !parsed.password && !parsed.port &&
    ["", "/"].includes(parsed.pathname) && !parsed.search && !parsed.hash,
  "CPU profile requires an exact extension origin");
  return parsed.hostname;
}

function ownedPath(source, host) {
  let parsed;
  try { parsed = new URL(source); } catch { return null; }
  if (parsed.protocol !== "chrome-extension:" || parsed.hostname !== host ||
      parsed.username || parsed.password || parsed.port || !parsed.pathname.startsWith("/js/")) return null;
  const parts = parsed.pathname.slice(1).split("/");
  if (parts.some(part => !/^[A-Za-z0-9._-]+$/.test(part) || part === "." || part === "..")) return null;
  return parts.join("/");
}

/**
 * CDP deltas are microseconds between sample timestamps; the first starts at
 * profile.startTime. Charge each delta only to its sampled top node, never its
 * ancestors. This is a sampling estimate, not elapsed time for each function.
 * A final boundary discrepancy may be one sample interval, capped at the larger
 * of 1ms or 1% of the duration. Preserve those samples without normalizing them;
 * unattributedMs is only the nonnegative uncovered duration. Larger overshoots
 * are rejected. Outside URLs, query strings and function names never leave here.
 * @param {{nodes:Array<{id:number,callFrame:{functionName:string,url:string,
 * lineNumber:number,columnNumber:number},children?:number[]}>,startTime:number,
 * endTime:number,samples:number[],timeDeltas:number[]}} profile
 * @param {string} extensionOrigin Exact chrome-extension:// origin.
 * @param {{includeLocations?:boolean}} [options] Include safe one-based source coordinates.
 * @returns {{durationMs:number,sampledMs:number,unattributedMs:number,sampleCount:number,
 * files:Array<{path:string,sampledMs:number,samples:number}>,
 * locations?:Array<{path:string,line:number,column:number,sampledMs:number,samples:number}>,
 * categories:{idleMs:number,otherMs:number}}}
 */
export function summarizeInboxCpuProfile(profile, extensionOrigin, { includeLocations = false } = {}) {
  const host = ownedHost(extensionOrigin);
  assert.ok(record(profile) && Array.isArray(profile.nodes) && profile.nodes.length > 0,
    "CPU profile nodes are missing");
  assert.ok(nonnegative(profile.startTime) && nonnegative(profile.endTime) &&
    profile.endTime >= profile.startTime, "CPU profile timestamps are invalid");
  assert.ok(Array.isArray(profile.samples) && Array.isArray(profile.timeDeltas) &&
    profile.samples.length === profile.timeDeltas.length, "CPU profile sample arrays must match");
  const nodes = new Map();
  for (const node of profile.nodes) {
    assert.ok(record(node) && nodeId(node.id) && !nodes.has(node.id), "CPU profile node IDs must be unique");
    const frame = node.callFrame;
    assert.ok(record(frame) && typeof frame.functionName === "string" && typeof frame.url === "string" &&
      [frame.lineNumber, frame.columnNumber].every(value => Number.isSafeInteger(value) && value >= -1),
    "CPU profile call frame is invalid");
    assert.ok(node.children === undefined || (Array.isArray(node.children) &&
      node.children.every(nodeId) && new Set(node.children).size === node.children.length),
    "CPU profile child IDs are invalid");
    nodes.set(node.id, node);
  }
  for (const node of nodes.values()) {
    assert.ok((node.children ?? []).every(id => nodes.has(id) && id !== node.id),
      "CPU profile child reference is invalid");
  }

  const files = new Map();
  const locations = new Map();
  let total = 0, largestDelta = 0, idle = 0, other = 0;
  for (let index = 0; index < profile.samples.length; index++) {
    const id = profile.samples[index], delta = profile.timeDeltas[index];
    assert.ok(nodeId(id) && nodes.has(id), "CPU profile sample references an unknown node");
    assert.ok(nonnegative(delta), "CPU profile sample delta is invalid");
    total += delta;
    largestDelta = Math.max(largestDelta, delta);
    const frame = nodes.get(id).callFrame;
    if (frame.functionName === "(idle)") { idle += delta; continue; }
    const file = ownedPath(frame.url, host);
    if (!file) { other += delta; continue; }
    const bucket = files.get(file) ?? { path: file, microseconds: 0, samples: 0 };
    bucket.microseconds += delta;
    bucket.samples++;
    files.set(file, bucket);
    if (includeLocations && frame.lineNumber >= 0 && frame.columnNumber >= 0) {
      const key = `${file}:${frame.lineNumber}:${frame.columnNumber}`;
      const site = locations.get(key) ?? { path: file, line: frame.lineNumber + 1,
        column: frame.columnNumber + 1, microseconds: 0, samples: 0 };
      site.microseconds += delta;
      site.samples++;
      locations.set(key, site);
    }
  }
  const duration = profile.endTime - profile.startTime;
  const tolerance = duration === 0 ? 0 : Math.min(largestDelta, Math.max(1_000, duration * 0.01));
  assert.ok(Number.isFinite(total) && total <= duration + tolerance,
    "CPU profile sampled time exceeds its duration");
  return {
    durationMs: duration / 1_000, sampledMs: total / 1_000,
    unattributedMs: Math.max(0, duration - total) / 1_000, sampleCount: profile.samples.length,
    files: [...files.values()].sort((a, b) => b.microseconds - a.microseconds ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map(({ path, microseconds, samples }) => ({ path, sampledMs: microseconds / 1_000, samples })),
    ...(includeLocations ? { locations: [...locations.values()]
      .sort((a, b) => b.microseconds - a.microseconds || a.path.localeCompare(b.path) ||
        a.line - b.line || a.column - b.column)
      .map(({ microseconds, ...site }) => ({ ...site, sampledMs: microseconds / 1_000 })) } : {}),
    categories: { idleMs: idle / 1_000, otherMs: other / 1_000 }
  };
}
