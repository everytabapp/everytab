// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Own the short live-browser prefetch window before Dashboard finishes loading. */
export function createNewTabOpenPrefetch({ load, publish }) {
  let cycle = null;
  let dirty = false;

  async function loadNewestQuietGeneration() {
    let result = null;
    do {
      dirty = false;
      try {
        result = await load();
      } catch {
        result = null;
      }
    } while (dirty);
    return result;
  }

  return {
    request() {
      dirty = true;
      if (cycle) return cycle;

      // Every caller observes one promise that resolves only after an in-flight
      // generation and, when needed, one coalesced trailing generation settle.
      // A stale intermediate result is never exposed to the Dashboard.
      cycle = loadNewestQuietGeneration().finally(() => { cycle = null; });
      publish(cycle);
      return cycle;
    }
  };
}
