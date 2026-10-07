// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Visual arrival for the composed Open-window list.
 * @param {{navigationType?: string}} [options]
 */
export function createWindowGroupArrival({
  navigationType = globalThis.performance?.getEntriesByType?.('navigation')?.[0]?.type
} = {}) {
  const groups = new Map();
  let listening = false;
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  const skipInitialReload = navigationType === 'reload';
  // A restrained back-out curve gives the traveling edge spring energy while
  // the curtain's clipped endpoint prevents any row geometry from rebounding.
  const easing = 'cubic-bezier(.34, 1.2, .64, 1)';
  const minimumDurationMultiplier = 1.125;
  const maximumDurationMultiplier = 1.395;
  const pixelsPerDuration = 500;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function translateY(node) {
    const transform = getComputedStyle(node).transform;
    if (!transform || transform === 'none') return 0;
    const matrix = transform.match(/^matrix\(([^)]+)\)$/)?.[1].split(',').map(Number.parseFloat);
    if (matrix?.length === 6) return Number.isFinite(matrix[5]) ? matrix[5] : 0;
    const matrix3d = transform.match(/^matrix3d\(([^)]+)\)$/)?.[1].split(',').map(Number.parseFloat);
    return matrix3d?.length === 16 && Number.isFinite(matrix3d[13]) ? matrix3d[13] : 0;
  }

  function visibleHeight(state) {
    return clamp(translateY(state.curtain), 0, state.target);
  }

  function visibleTravel(node, height) {
    const top = node.getBoundingClientRect().top;
    return clamp(globalThis.innerHeight - top, 0, height);
  }

  function framesFor(from, target, offset = 0) {
    return [
      { transform: `translateY(${clamp(from, 0, target)}px)`, offset },
      { transform: `translateY(${target}px)`, offset: 1 }
    ];
  }

  function retarget(state, from, target) {
    const keyframes = state.effect?.effect;
    if (typeof keyframes?.setKeyframes !== 'function') return false;
    const progress = clamp(
      keyframes.getComputedTiming().progress ?? 0, 0, 1 - Number.EPSILON);
    state.target = target;
    state.curtain.style.height = `${target}px`;
    keyframes.setKeyframes(framesFor(from, target, progress));
    return true;
  }

  function refresh(state) {
    if (!state.active) return;
    const from = visibleHeight(state);
    const height = state.node.getBoundingClientRect().height;
    const target = visibleTravel(state.node, height);
    if (state.deadline <= performance.now() || target <= from + .5 ||
        !retarget(state, from, target)) state.stop();
  }

  function restore(state) {
    state.effect?.cancel();
    state.effect = null;
    state.curtain?.remove();
    state.curtain = null;
    state.node.classList.remove('is-window-list-arriving');
    state.active = false;
  }

  function finish(state) {
    restore(state);
    state.node.removeEventListener('focusin', state.stop);
    state.node.removeEventListener('pointerdown', state.stop);
    document.removeEventListener('keydown', state.stop, true);
    window.removeEventListener('wheel', state.stop);
    window.removeEventListener('touchmove', state.stop);
    window.removeEventListener('scroll', state.stop);
    window.removeEventListener('resize', state.refresh);
  }

  function reveal(node, key, replace = () => {}) {
    if (!listening) {
      listening = true;
      reduced?.addEventListener?.('change', onPreference);
      document.addEventListener('visibilitychange', onVisibility);
    }

    let state = groups.get(key);
    const wasActive = !!state?.active;
    const from = wasActive ? visibleHeight(state) : 0;
    const curtain = wasActive ? state.curtain : null;
    const beforeCards = wasActive
      ? [...node.querySelectorAll('[data-tablist-card]')].map((item) => item.dataset.tablistCard)
      : [];
    const beforeRows = wasActive
      ? [...node.querySelectorAll('[data-tablist-row]')].map((item) => item.dataset.tablistRow)
      : [];
    curtain?.remove();
    replace();
    if (curtain) node.append(curtain);

    if (wasActive) {
      const afterCards = new Set([...node.querySelectorAll('[data-tablist-card]')]
        .map((item) => item.dataset.tablistCard));
      const afterRows = [...node.querySelectorAll('[data-tablist-row]')]
        .map((item) => item.dataset.tablistRow);
      const afterRowSet = new Set(afterRows);
      // Optional chip enrichment can add material and retarget the original
      // reveal. A disappearing live card or tab is different: release the
      // curtain before its prior, longer edge can paint over the smaller list.
      const removedLivePart = beforeCards.some((id) => !afterCards.has(id)) ||
        beforeRows.length > afterRows.length ||
        beforeRows.some((id) => !afterRowSet.has(id));
      if (removedLivePart) {
        state.stop();
        return;
      }
    }

    if (!state) {
      const style = getComputedStyle(node);
      const duration = Number.parseFloat(style.getPropertyValue('--motion-continuity')) || 180;
      state = {
        node,
        duration,
        deadline: 0,
        effect: null,
        curtain: null,
        target: 0,
        active: false
      };
      state.stop = () => finish(state);
      state.refresh = () => refresh(state);
      groups.set(key, state);
    } else if (!wasActive) {
      return;
    }

    if (!node.isConnected || skipInitialReload || reduced?.matches || document.hidden ||
        window.scrollY > 0 || typeof node.animate !== 'function' ||
        node.contains(document.activeElement)) {
      state.stop();
      return;
    }

    const height = node.getBoundingClientRect().height;
    const target = visibleTravel(node, height);
    if (target <= from + .5) {
      state.stop();
      return;
    }
    if (!state.deadline) {
      const multiplier = clamp(target / pixelsPerDuration,
        minimumDurationMultiplier, maximumDurationMultiplier);
      state.deadline = performance.now() + state.duration * multiplier;
    }
    const remaining = state.deadline - performance.now();
    if (remaining <= 0) {
      state.stop();
      return;
    }

    if (wasActive) {
      if (!retarget(state, from, target)) state.stop();
      return;
    }

    const movingCurtain = document.createElement('div');
    movingCurtain.className = 'window-list-curtain';
    movingCurtain.setAttribute('aria-hidden', 'true');
    movingCurtain.style.height = `${target}px`;
    node.append(movingCurtain);
    node.classList.add('is-window-list-arriving');
    const effect = movingCurtain.animate(framesFor(from, target),
      { duration: remaining, easing, fill: 'both' });
    state.effect = effect;
    state.curtain = movingCurtain;
    state.target = target;
    state.active = true;
    effect.finished.then(() => {
      if (state.effect === effect) finish(state);
    }, () => {});
    node.addEventListener('focusin', state.stop);
    node.addEventListener('pointerdown', state.stop);
    document.addEventListener('keydown', state.stop, true);
    window.addEventListener('wheel', state.stop, { passive: true });
    window.addEventListener('touchmove', state.stop, { passive: true });
    window.addEventListener('scroll', state.stop, { passive: true });
    window.addEventListener('resize', state.refresh, { passive: true });
  }

  const settle = () => { for (const state of groups.values()) state.stop(); };
  const onPreference = () => { if (reduced?.matches) settle(); };
  const onVisibility = () => { if (document.hidden) settle(); };

  return {
    reveal,
    destroy() {
      settle();
      groups.clear();
      if (listening) {
        reduced?.removeEventListener?.('change', onPreference);
        document.removeEventListener('visibilitychange', onVisibility);
        listening = false;
      }
    }
  };
}
