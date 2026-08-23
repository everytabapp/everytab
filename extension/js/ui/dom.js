/**
 * Tiny DOM helper: el("div", {class: "x", onclick: fn}, child1, child2)
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...(Node|string|null|undefined)} children
 * @returns {HTMLElement}
 */
/**
 * F45r: real boolean HTML attributes are on when PRESENT, whatever their value,
 * so `setAttribute("disabled", "false")` disables the control. Passing a plain
 * `false` here used to do exactly that, silently — it is what made the Starred
 * reorder arrows inert. Enumerated attributes (`aria-*`, `draggable`,
 * `contenteditable`) genuinely need the string "false", so only these are
 * special-cased.
 */
const BOOLEAN_ATTRS = new Set([
  "disabled", "checked", "hidden", "readonly", "required",
  "selected", "multiple", "open", "autofocus", "novalidate"
]);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2), v);
    } else if (BOOLEAN_ATTRS.has(k)) {
      if (v !== false) node.setAttribute(k, "");
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(child);
  }
  return node;
}

/**
 * Wrap an async render function so concurrent calls can't interleave their
 * DOM writes (clear-then-append from two runs = duplicated content).
 * While a run is in flight, further calls coalesce into one trailing re-run.
 * Returns the in-flight promise (N12) so callers — the dashboard boot — can
 * await the initial render pass; fire-and-forget callers are unaffected.
 * @param {() => Promise<void>} fn
 * @returns {() => Promise<unknown>}
 */
export function coalesce(fn) {
  let running = false;
  let queued = false;
  let inflight = Promise.resolve();
  return function run() {
    if (running) {
      queued = true;
      return inflight;
    }
    running = true;
    inflight = Promise.resolve(fn()).finally(() => {
      running = false;
      if (queued) {
        queued = false;
        run();
      }
    });
    return inflight;
  };
}

/**
 * N42: run an instant scroll anchor again over the next two frames. A cold page
 * is still filling the sections around the target and still measuring its
 * sticky chrome, so a first anchor can be right and then drift — which is how a
 * jumped-to multi-window session ended up scrolled past its first window. Every
 * pass is instant, so a correction never reads as travel.
 * @param {() => void} anchor
 */
export function settleAnchor(anchor) {
  const frame = typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : (fn) => setTimeout(fn, 16);
  frame(() => { anchor(); frame(anchor); });
}

/**
 * N43: hold a decorative arrival cue until it lands on a card that survives.
 *
 * `coalesce` resolves an awaited render with the promise of the run that was
 * ALREADY in flight, and a queued run follows it. A cross-section jump routes
 * first (which starts a render) and then awaits the same renderer, so on the
 * first arrival of a page's life the cue was applied to a card that a queued
 * run then replaced — the jump landed correctly and the highlight vanished.
 * Re-apply only when the cued node was actually detached, so a surviving
 * animation is never restarted.
 * @param {() => Element|null|undefined} findCard
 * @param {(card: Element) => void} cue
 */
export function settleCue(findCard, cue) {
  let cued = null;
  const apply = () => {
    const card = findCard();
    if (!card || (card === cued && card.isConnected)) return;
    cued = card;
    cue(card);
  };
  apply();
  for (const delay of [16, 120, 320, 640]) setTimeout(apply, delay);
}

/** @param {number} ts */
export function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
