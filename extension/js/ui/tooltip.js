// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * B5 — custom themed tooltip. Native `title` tooltips carry the OS's ~1s delay
 * and can't be themed; this shows a themed bubble after a short initial delay instead, for the
 * places the backlog names: row actions and nav glyphs.
 *
 * It works by delegation (so it covers rows re-rendered on every tab event) and
 * *adopts* the native title the first time an element is hovered/focused: the
 * `title` is moved to `data-tip` and removed, which kills the slow native tip
 * while keeping the text. Accessibility is preserved — every element in the
 * trigger set already carries an `aria-label` or visible text as its accessible
 * name, so dropping `title` (which is only a supplementary hint on them) changes
 * nothing in the a11y tree.
 */

// Row actions (.mini / .mini2 / .iconbtn) + nav glyphs (.gear) + the sidebar
// vault pill + a generic `.tip` opt-in (used by controls whose `title` was their
// only accessible name once they've been given an explicit aria-label, e.g. the
// select-all checkboxes and the history-permission button). Anything whose
// accessible name would depend solely on `title` must carry aria-label before it
// joins this set, since the module removes `title` when it adopts it.
// D4-3a: `[data-nav="rail"] .navitem` joins the set only while the icon rail is
// showing, so the tooltip explains an icon whose label is hidden instead of
// repeating a label that is already on screen. `closest()` resolves the ancestor
// part of the selector, so no extra class or re-render is involved. Every nav
// item carries an explicit aria-label, which the set requires.
const TRIGGER = '.mini, .mini2, .iconbtn, .gear, .vault-pill, .tip, [data-nav="rail"] .navitem';
const DELAY = 120;
const WARM_WINDOW = 600;

let tipEl = null;
let timer = 0;
let currentTarget = null;
let warmUntil = 0;
let initialized = false;

function ensureTipEl() {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "tooltip";
    tipEl.setAttribute("role", "tooltip");
    tipEl.setAttribute("aria-hidden", "true");
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

/** Adopt a slow native title once (title → data-tip), then read the text. */
function textFor(node) {
  if (node.hasAttribute("title")) {
    node.dataset.tip = node.getAttribute("title");
    node.removeAttribute("title");
  }
  return node.dataset.tip || "";
}

function position(node) {
  const t = ensureTipEl();
  const r = node.getBoundingClientRect();
  const gap = 8;
  const tw = t.offsetWidth;
  const th = t.offsetHeight;
  let top = r.top - th - gap; // prefer above
  if (top < 4) top = r.bottom + gap; // no room → flip below
  let left = r.left + r.width / 2 - tw / 2; // centered on the trigger
  left = Math.max(6, Math.min(left, window.innerWidth - tw - 6)); // clamp to viewport
  t.style.left = `${Math.round(left)}px`;
  t.style.top = `${Math.round(top)}px`;
}

function show(node, instant = false) {
  if (!node.isConnected) return; // row may have been re-rendered away
  const text = textFor(node);
  if (!text) return;
  const t = ensureTipEl();
  t.classList.toggle("instant", instant);
  t.textContent = text;
  t.classList.add("show");
  t.setAttribute("aria-hidden", "false");
  position(node);
}

function hide() {
  clearTimeout(timer);
  timer = 0;
  currentTarget = null;
  if (tipEl) {
    if (tipEl.classList.contains("show")) warmUntil = performance.now() + WARM_WINDOW;
    tipEl.classList.remove("show");
    tipEl.setAttribute("aria-hidden", "true");
  }
}

function arm(node, keyboard = false) {
  if (node === currentTarget && !keyboard) return;
  clearTimeout(timer);
  textFor(node); // suppress the native title before the first delay starts
  currentTarget = node;
  const instant = keyboard || performance.now() < warmUntil;
  if (instant) show(node, true);
  else timer = setTimeout(() => {
    if (currentTarget === node) show(node);
  }, DELAY);
}

/** Call once per page that has row actions / nav glyphs. */
export function initTooltips() {
  if (initialized) return;
  initialized = true;
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") { hide(); return; }
    const node = e.target.closest?.(TRIGGER);
    if (node?.closest(".action-popover")) {
      // Palette controls already have visible labels. Adopt any legacy title so
      // the OS tooltip cannot appear later, but keep this floating layer quiet.
      textFor(node);
      hide();
    } else if (node) {
      arm(node);
    }
  });
  document.addEventListener("pointerout", (e) => {
    const node = e.target.closest?.(TRIGGER);
    // leaving the trigger entirely (not just moving onto a child)
    if (node && node === currentTarget && !node.contains(e.relatedTarget)) hide();
  });
  document.addEventListener("focusin", (e) => {
    const node = e.target.closest?.(TRIGGER);
    // Programmatic focus after a pointer-opened palette is functional focus,
    // not a request for a tooltip. Keyboard focus still receives discovery.
    if (node?.matches?.(":focus-visible") && !node.closest(".action-popover")) arm(node, true);
  });
  document.addEventListener("focusout", (e) => {
    const node = e.target.closest?.(TRIGGER);
    if (node && node === currentTarget) hide();
  });
  // Any of these means the tip is stale: clicking the action, pressing Esc,
  // or the page scrolling under a fixed-position bubble.
  document.addEventListener("click", hide, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
  window.addEventListener("scroll", hide, true);
}
