// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { createWindowGroupArrival } from './window-group-arrival.js';

/** One brief cue when a page's initially pending information becomes usable. */
export function createStartupArrival() {
  const arrived = new Set();
  const groupArrival = createWindowGroupArrival();
  const counts = new Map();
  const pendingCounts = new Set();
  const summaries = new WeakMap();
  const active = new Set();
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  const finish = () => {
    for (const stop of [...active]) stop();
  };
  const onMotionChange = () => { if (reduced?.matches) finish(); };
  reduced?.addEventListener?.('change', onMotionChange);
  const syncReelVisibility = () => {
    document.documentElement.dataset.startupReelsPaused =
      document.visibilityState === 'hidden' ? 'true' : 'false';
  };
  syncReelVisibility();
  document.addEventListener?.('visibilitychange', syncReelVisibility);

  function motion(node, token) {
    if (!node?.isConnected || reduced?.matches || typeof node.animate !== 'function' ||
        document.visibilityState === 'hidden' || node.contains(document.activeElement)) return null;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return null;
    const duration = parseFloat(style.getPropertyValue(token));
    if (!Number.isFinite(duration) || duration <= 0) return null;
    return { duration, easing: style.getPropertyValue('--ease-out').trim() || 'ease-out' };
  }

  function play(node, frames, options, cleanup = () => {}, elapsed = 0) {
    const animation = node.animate(frames, options);
    if (elapsed) animation.currentTime = elapsed;
    const stop = () => {
      if (!active.delete(stop)) return;
      animation.cancel();
      cleanup();
    };
    active.add(stop);
    animation.finished.then(stop, stop);
    return stop;
  }

  function reveal(node, key, { distance = 4, token = '--motion-reveal' } = {}) {
    if (arrived.has(key)) return;
    arrived.add(key);
    const options = motion(node, token);
    if (!options) return;
    play(node, [
      { opacity: 0, transform: `translateY(${distance}px)` },
      { opacity: 1, transform: 'translateY(0)' }
    ], options);
  }

  function revealGroups(node, key, replace) {
    groupArrival.reveal(node, key, replace);
  }

  function pendingCount(className = 'n') {
    const node = document.createElement('span');
    node.className = `${className} startup-count`;
    node.dataset.startupPending = 'true';
    node.setAttribute('aria-hidden', 'true');
    // The CSS reel is decorative and has an empty accessible alternative. The
    // DOM carries no numeric value until its source has actually resolved.
    pendingCounts.add(node);
    return node;
  }

  function settleCount(node, text, key) {
    const pending = node.dataset.startupPending === 'true';
    const reelTransform = pending && node.isConnected && !reduced?.matches
      ? getComputedStyle(node, '::before').transform : '';
    const reelOffset = reelTransform?.match(/^matrix\([^,]+,[^,]+,[^,]+,[^,]+,[^,]+,\s*([\d.-]+)\)$/)?.[1] ?? '0';
    pendingCounts.delete(node);
    let value = node.querySelector('.startup-count-value');
    if (!value) {
      value = document.createElement('span');
      value.className = 'startup-count-value';
      node.replaceChildren(value);
    }
    value.textContent = String(text);
    node.classList.add('startup-count');
    delete node.dataset.startupPending;
    node.removeAttribute('aria-hidden');
    const previous = counts.get(key);
    if (counts.has(key) && (!previous || previous.node === node)) return;
    const options = motion(node, '--motion-continuity');
    const now = performance.now();
    const elapsed = previous ? now - previous.start : 0;
    previous?.stop();
    counts.set(key, null);
    if (!options || (previous && elapsed >= previous.duration)) return;
    // Saved branch hydration can replace a count while it is arriving. Continue
    // that same deadline on its replacement; storage refreshes never replay it.
    if (previous) options.duration = previous.duration;
    node.dataset.startupRolling = 'true';
    node.style.setProperty('--startup-reel-offset', `${reelOffset}px`);
    node.style.setProperty('--startup-count-elapsed', `${-elapsed}ms`);
    const stop = play(value, [
      { opacity: 0, transform: 'translateY(100%)' },
      { opacity: 1, transform: 'translateY(0)' }
    ], options, () => {
      delete node.dataset.startupRolling;
      node.style.removeProperty('--startup-reel-offset');
      node.style.removeProperty('--startup-count-elapsed');
    }, elapsed);
    counts.set(key, { node, start: previous?.start ?? now, duration: options.duration, stop });
  }

  function pendingSummary(parts, className) {
    const node = document.createElement('span');
    node.className = className;
    node.setAttribute('aria-hidden', 'true');
    const slots = [], words = [];
    for (const [index, text] of parts.entries()) {
      const word = document.createElement('span');
      word.textContent = text;
      words.push(word);
      node.append(word);
      if (index < parts.length - 1) {
        const slot = pendingCount('startup-summary-number');
        slots.push(slot);
        node.append(slot);
      }
    }
    summaries.set(node, { slots, words });
    return node;
  }

  function settleSummary(node, text, key) {
    const summary = summaries.get(node);
    // Keep localized wording and grouped digits exactly as supplied by the
    // surface. A future nonnumeric count format remains a complete static label.
    const matches = [...text.matchAll(/\p{Decimal_Number}+(?:[.,'’\u066B\u066C\u00A0\u202F]\p{Decimal_Number}+)*/gu)];
    node.removeAttribute('aria-hidden');
    if (!summary || matches.length !== summary.slots.length) {
      for (const slot of summary?.slots ?? []) pendingCounts.delete(slot);
      summaries.delete(node);
      node.textContent = text;
      return;
    }
    let offset = 0;
    for (const [index, match] of matches.entries()) {
      summary.words[index].textContent = text.slice(offset, match.index);
      settleCount(summary.slots[index], match[0], `${key}:${index}`);
      offset = match.index + match[0].length;
    }
    summary.words.at(-1).textContent = text.slice(offset);
  }

  return {
    pendingCount, settleCount, pendingSummary, settleSummary, reveal, revealGroups,
    destroy() {
      groupArrival.destroy();
      finish();
      for (const node of pendingCounts) node.dataset.startupStopped = 'true';
      pendingCounts.clear();
      document.removeEventListener?.('visibilitychange', syncReelVisibility);
      reduced?.removeEventListener?.('change', onMotionChange);
    }
  };
}
