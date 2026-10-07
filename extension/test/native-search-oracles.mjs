/** Independent, exact fixture expectations shared by browser and portable checks. */
export const QUERY = "zebrafixture";
export function expectedSearchRows(edited = false, complete = false) {
  return [
    { type: "inbox", title: `${QUERY} ${edited ? "revised" : "initial"} inbox`, url: "https://fixture.invalid/page/0" },
    ...(complete ? [{ type: "session", title: `${QUERY} secondary`, url: "https://fixture.invalid/secondary" }] : [])
  ];
}
export function assertSearchResults(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((row, index) =>
    ["type", "title", "url"].some(key => row?.[key] !== expected[index][key]))) {
    throw new Error("Search results differ from exact fixture expectations");
  }
}
export function domRowsMatch(actual, expected) {
  return actual.length === expected.length && actual.every((row, index) =>
    row.title === expected[index].title && row.type === expected[index].type && row.role === "option");
}

/** Distinguish Search snapshot caching from the underlying Store map cache. */
export function assertPhaseCache(phase, calls) {
  if (!["first", "warm-immediate", "warm-expired", "after-edit"].includes(phase)) {
    throw new Error("Unknown Search measurement phase");
  }
  const count = (label, family) => calls.filter(call => call.label === label &&
    (family === undefined || call.family === family)).length;
  const warm = phase.startsWith("warm");
  if (count("primarySnapshotBuild") !== (warm ? 0 : 1) ||
      (warm ? count("libraryFamilyRead", "inbox") !== 0 : count("libraryFamilyRead", "inbox") === 0) ||
      (phase === "warm-immediate" ? count("libraryFamilyRead", "sessions") !== 0
        : count("libraryFamilyRead", "sessions") === 0)) {
    const error = new Error("Search snapshot or family cache phase mismatch");
    error.code = "cache-phase";
    throw error;
  }
}

/** A missing rendering opportunity is a fixture failure, never an unbounded wait. */
export function observeFrame(read, {
  request = callback => requestAnimationFrame(callback),
  cancel = handle => cancelAnimationFrame(handle),
  startTimer = callback => setTimeout(callback, 2_000),
  stopTimer = handle => clearTimeout(handle)
} = {}) {
  return new Promise((resolve, reject) => {
    const timer = startTimer(() => {
      cancel(frame);
      const error = new Error("Rendering opportunity did not arrive");
      error.code = "frame-timeout";
      reject(error);
    });
    const frame = request(() => {
      stopTimer(timer);
      try { resolve(read()); } catch (error) { reject(error); }
    });
  });
}

export function assertWarmCadence(phase, elapsedMs) {
  if ((phase === "warm-immediate" && !(Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < 1_000)) ||
      (phase === "warm-expired" && !(Number.isFinite(elapsedMs) && elapsedMs >= 1_000))) {
    const error = new Error("Warm query cadence missed its intended cache interval");
    error.code = "warm-cadence";
    throw error;
  }
}
