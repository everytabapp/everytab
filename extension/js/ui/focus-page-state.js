/** Stable focus identities for the re-rendered guard-page surface. */
export function markGuardFocus(node, identity) {
  node.dataset.guardFocusId = identity;
  return node;
}

/** Capture focus only when it belongs to a control the guard render will replace. */
export function captureGuardFocus(document, surfaces) {
  const active = document.activeElement;
  const inside = !!active && surfaces.some((surface) => surface.contains(active));
  return {
    active,
    inside,
    identity: inside ? active.dataset?.guardFocusId ?? "" : ""
  };
}

/**
 * Restore the equivalent control after a settled guard render. A bounded late retry
 * tolerates a control landing one animation frame later. Deliberate movement to a static
 * control, or focus leaving the tab, cancels restoration.
 */
export function restoreGuardFocus({
  document, snapshot, primary, findIdentity, initial = false, forcePrimary = false,
  requestFrame = requestAnimationFrame, maxFrames = 2
}) {
  if (!initial && !snapshot.inside) return;
  let frames = 0;
  const land = () => {
    if (typeof document.hasFocus === "function" && !document.hasFocus()) return;
    const active = document.activeElement;
    const moved = active && active !== document.body && active !== snapshot.active && active.isConnected !== false;
    if (moved) return;
    const equivalent = !forcePrimary && snapshot.identity ? findIdentity(snapshot.identity) : null;
    const target = equivalent && equivalent.isConnected !== false ? equivalent : primary;
    if (target && target.isConnected !== false) {
      target.focus();
      return;
    }
    frames += 1;
    if (frames < maxFrames) requestFrame(land);
  };
  requestFrame(land);
}

/**
 * Drive the visual access-pause countdown from one fixed unlock boundary. Every tick
 * re-reads the clock, so delayed callbacks cannot drift or enable access early.
 */
export function createPauseCountdown({ now, setTimer, clearTimer, onTick, onUnlock }) {
  let timer = 0;
  let generation = 0;

  const stop = () => {
    generation += 1;
    if (timer) clearTimer(timer);
    timer = 0;
  };

  const start = (unlockAt) => {
    stop();
    const fixedUnlockAt = Number(unlockAt);
    const mine = generation;
    let announced = false;
    const tick = () => {
      if (mine !== generation) return;
      const remaining = Math.max(0, fixedUnlockAt - now());
      if (remaining <= 0) {
        timer = 0;
        onTick(0);
        if (!announced) {
          announced = true;
          onUnlock();
        }
        return;
      }
      onTick(remaining);
      const seconds = Math.ceil(remaining / 1000);
      const untilNextSecond = remaining - ((seconds - 1) * 1000);
      timer = setTimer(tick, Math.max(1, untilNextSecond));
    };
    tick();
  };

  return { start, stop };
}
