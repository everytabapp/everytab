#!/usr/bin/env node
// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Bounded probe: can this machine's Chrome drive an ordinary page target?
 *
 * Hosted macOS runners start Chrome and its extension service worker, but a
 * page target has stopped answering its first DevTools command (Page.enable)
 * there, so every page-driving browser suite would wait out its timeout. CI
 * runs this probe first and executes those suites only when a page answers;
 * otherwise it reports the lane as not executed instead of hanging.
 *
 *   CHROME_BIN=<chrome> node tools/probe-chrome-page-target.mjs
 *
 * Each candidate launch adds switches to the switches the browser suites use
 * and gets 20 s. One line per candidate names the last step reached. The
 * baseline decides the result: `pages=ready` or `pages=unavailable` is printed
 * and, under GitHub Actions, appended to $GITHUB_OUTPUT. The extra candidates
 * are diagnostics only and never change what the suites run. Exit status is 0
 * for either verdict and 1 only when the probe itself cannot run.
 */
import { appendFileSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHROME_FIXTURE_ARGS, spawnOwnedChrome, terminateOwnedChrome } from "../extension/test/chrome-test-process.mjs";

const CANDIDATE_MS = 20_000;
const BASE_ARGS = ["--headless=new", "--disable-gpu", "--no-first-run",
  "--disable-background-networking", "--disable-component-update", "--disable-default-apps",
  ...(process.env.EVERYTAB_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [])];
/** Diagnostic variants. Only `baseline` decides whether page suites run. */
export const CANDIDATES = [
  { name: "baseline", args: [] },
  { name: "software-angle", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  { name: "in-process-gpu", args: ["--in-process-gpu"] },
  { name: "no-gpu-compositing", args: ["--disable-gpu-compositing", "--disable-gpu-rasterization"] },
  { name: "unthrottled", args: ["--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding", "--disable-background-timer-throttling"] },
  { name: "headed", args: [], headed: true }
];

function cdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("socket error")), { once: true });
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`${request.method} ${message.error.message}`));
    else request.resolve(message.result);
  });
  return {
    async send(method, params = {}, sessionId) {
      await ready;
      const id = nextId++;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return result;
    },
    close() { socket.close(); }
  };
}

function endpoint(chrome) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    chrome.stderr.setEncoding("utf8");
    chrome.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    chrome.once("exit", (code) => reject(new Error(`Chrome exited with code ${code}`)));
  });
}

/** Run one candidate; resolves with the steps reached and their elapsed times. */
async function probe(chromeBin, candidate) {
  const profile = await mkdtemp(path.join(tmpdir(), "everytab-page-probe-"));
  const args = [...CHROME_FIXTURE_ARGS, ...BASE_ARGS.filter((arg) => !(candidate.headed && arg === "--headless=new")),
    ...candidate.args, "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"];
  const chrome = spawnOwnedChrome(chromeBin, args, { stdio: ["ignore", "ignore", "pipe"] });
  const started = performance.now();
  const steps = [];
  let client;
  let timer;
  const mark = (step) => steps.push(`${step} ${Math.round(performance.now() - started)}ms`);
  const run = (async () => {
    client = cdp(await endpoint(chrome));
    mark("endpoint");
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    mark("target");
    await client.send("Page.enable", {}, sessionId);
    mark("Page.enable");
    const value = await client.send("Runtime.evaluate", { expression: "6 * 7", returnByValue: true }, sessionId);
    if (value.result?.value !== 42) throw new Error("Runtime.evaluate returned an unexpected value");
    mark("Runtime.evaluate");
    await client.send("Page.navigate", { url: "data:text/html,<p>probe</p>" }, sessionId);
    mark("Page.navigate");
    return true;
  })();
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(false), CANDIDATE_MS); });
  let ok = false;
  let failure = "";
  try { ok = await Promise.race([run, deadline]); }
  catch (error) { failure = String(error?.message ?? error).split("\n")[0].slice(0, 120); }
  finally {
    clearTimeout(timer);
    client?.close();
    await terminateOwnedChrome(chrome);
    await rm(profile, { recursive: true, force: true });
  }
  run.catch(() => {});
  return { ok, steps, failure: ok ? "" : failure || `no answer within ${CANDIDATE_MS / 1000}s` };
}

export async function main() {
  const chromeBin = process.env.CHROME_BIN;
  if (!chromeBin || !existsSync(chromeBin)) throw new Error("Set CHROME_BIN to a Chrome binary");
  const results = [];
  for (const candidate of CANDIDATES) {
    const result = await probe(chromeBin, candidate);
    results.push({ name: candidate.name, ...result });
    console.log(`probe ${candidate.name}: ${result.ok ? "page answered" : `stopped (${result.failure})`}; ` +
      `${result.steps.join(", ") || "no step completed"}`);
  }
  const verdict = results[0].ok ? "ready" : "unavailable";
  console.log(`pages=${verdict}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `pages=${verdict}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; },
    (error) => { console.error(`FAIL page-target probe: ${error.message}`); process.exitCode = 1; });
}
