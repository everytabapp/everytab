import { spawn, spawnSync } from "node:child_process";

/**
 * Switches every automated Chrome fixture passes, on every platform.
 * --use-mock-keychain: from Chrome 155 on macOS, a disposable profile's first
 * network navigation waits for login Keychain access. Hosted runners and
 * non-interactive shells never answer, so Page.navigate (and later commands)
 * hang until the suite times out. Chrome for Testing 150 did not wait. Linux
 * and Windows ignore the switch. Fixtures never store real credentials.
 * --blink-settings: declare the desktop fine, hover-capable pointer EveryTab
 * targets. Headless Chrome on a hosted Linux runner detects no pointing device
 * and matches (hover: none), which switches pointer-reveal CSS to its touch
 * fallback. CDP media emulation cannot override hover or pointer.
 * Values: HoverType 2 = hover, PointerType 4 = fine.
 */
export const CHROME_FIXTURE_ARGS = Object.freeze([
  "--use-mock-keychain",
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4"
]);

const owned = new Set();
let hooksInstalled = false;

/** True after a dumped DOM fixture has published its explicit terminal receipt. */
export function hasDomTestReceipt(output) {
  return /<pre id="result"[^>]*data-status="(?:pass|fail)"/.test(output);
}

function isRunning(child) {
  return Boolean(child) && child.exitCode == null && child.signalCode == null;
}

function isTreeRunning(child) {
  if (!child?.pid) return false;
  if (process.platform === "win32") return isRunning(child);
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return isRunning(child);
    throw error;
  }
}

function signalTree(child, signal) {
  if (!isTreeRunning(child)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {
      stdio: "ignore",
      windowsHide: true
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code === "EPERM" && isRunning(child)) {
      child.kill(signal);
      return;
    }
    if (!["ESRCH", "EPERM"].includes(error?.code)) throw error;
  }
}

function emergencyCleanup() {
  for (const child of owned) {
    try { signalTree(child, "SIGKILL"); } catch {}
  }
}

function installEmergencyHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.once("exit", emergencyCleanup);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      emergencyCleanup();
      process.kill(process.pid, signal);
    });
  }
}

function waitForTreeExit(child, timeoutMs) {
  if (!isTreeRunning(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const inspect = () => {
      if (!isTreeRunning(child)) resolve(true);
      else if (Date.now() >= deadline) resolve(false);
      else setTimeout(inspect, 20);
    };
    inspect();
  });
}

/** Spawn one browser fixture in its own process group so its complete tree is owned. */
export function spawnOwnedChrome(command, args, options = {}) {
  installEmergencyHooks();
  const child = spawn(command, args, {
    ...options,
    detached: process.platform !== "win32"
  });
  owned.add(child);
  return child;
}

/** End an owned browser tree, escalating after a short graceful shutdown window. */
export async function terminateOwnedChrome(child, { graceMs = 1_500, forceMs = 1_500 } = {}) {
  if (!child) return;
  if (isTreeRunning(child)) {
    signalTree(child, "SIGTERM");
    if (!await waitForTreeExit(child, graceMs)) {
      signalTree(child, "SIGKILL");
      if (!await waitForTreeExit(child, forceMs)) {
        throw new Error(`Owned Chrome process tree ${child.pid} did not exit`);
      }
    }
  }
  owned.delete(child);
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy?.();
  child.unref();
}

/** Run a short Chrome fixture and capture output without leaking its process tree on timeout. */
export async function runOwnedChrome(command, args, {
  timeoutMs,
  maxBuffer = 4 * 1024 * 1024,
  completeWhen = null
} = {}) {
  const child = spawnOwnedChrome(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let abort;
  const aborted = new Promise((resolve, reject) => { abort = reject; });
  let finishFromOutput;
  let outputFinished = false;
  const outputCompleted = typeof completeWhen === "function"
    ? new Promise((resolve) => { finishFromOutput = resolve; })
    : null;
  const collect = (chunks, kind) => (chunk) => {
    const bytes = Buffer.byteLength(chunk);
    if (kind === "stdout") stdoutBytes += bytes;
    else stderrBytes += bytes;
    if (Math.max(stdoutBytes, stderrBytes) > maxBuffer) {
      abort(new Error(`Owned Chrome ${kind} exceeded ${maxBuffer} bytes`));
      return;
    }
    chunks.push(chunk);
    if (kind === "stdout" && finishFromOutput && !outputFinished) {
      const output = Buffer.concat(stdout).toString("utf8");
      if (completeWhen(output)) {
        outputFinished = true;
        finishFromOutput({ code: null, signal: null, completedFromOutput: true });
      }
    }
  };
  child.stdout.on("data", collect(stdout, "stdout"));
  child.stderr.on("data", collect(stderr, "stderr"));
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => abort(new Error(`Owned Chrome timed out after ${timeoutMs}ms`)), timeoutMs)
    : null;
  try {
    const result = await Promise.race([completed, aborted, ...(outputCompleted ? [outputCompleted] : [])]);
    if (result.code != null && result.code !== 0) {
      throw new Error(`Owned Chrome exited with ${result.signal ?? `code ${result.code}`}`);
    }
    return { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
  } catch (error) {
    const capturedStdout = Buffer.concat(stdout).toString("utf8");
    const capturedStderr = Buffer.concat(stderr).toString("utf8");
    // Some macOS Chrome builds emit --dump-dom output but keep the browser
    // process alive. Accept a complete fixture receipt even if it arrived in
    // the same event-loop turn as the watchdog; the finally block still owns
    // and terminates the complete browser tree.
    if (typeof completeWhen === "function" && completeWhen(capturedStdout)) {
      return { stdout: capturedStdout, stderr: capturedStderr };
    }
    error.stdout = capturedStdout;
    error.stderr = capturedStderr;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    await terminateOwnedChrome(child);
  }
}
