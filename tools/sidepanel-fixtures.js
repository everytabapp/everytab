/** Test-only side-panel pressure fixtures. Production never imports this file. */

export const FOLDED_PRESSURE_WIDTHS = Object.freeze([320, 400, 520]);
export const EXPANDED_COPY_SCALE = 1.4;

const node = (document, tag, className, text = "") => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
};

export function applyFoldedPressureFixture(document, {
  faviconUrl = "../extension/icon16.png",
  brokenFaviconUrl = "../extension/missing-folded-favicon.png"
} = {}) {
  const card = document.querySelector(".tablist > .item");
  const toggle = card?.querySelector(".item-head-toggle");
  const title = toggle?.querySelector(".item-title");
  if (!card || !toggle || !title) throw new Error("Folded pressure fixture card is incomplete");

  title.textContent =
    "An intentionally long folded-window title that must yield before its controls";
  const badge = node(document, "span", "item-badge", "(current window)");
  const foldedMark = node(document, "span", "item-folded-mark", "folded");
  const strip = node(document, "span", "fold-strip");
  const count = node(document, "span", "fold-count", "8 tabs");
  const summary = node(document, "span", "fold-summary");
  strip.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 8; index += 1) {
    const image = node(document, "img", "fv");
    image.src = index === 3 ? brokenFaviconUrl : faviconUrl;
    image.alt = "";
    image.setAttribute("data-fixture-favicon", index === 3 ? "broken" : "loaded");
    image.addEventListener("error", (event) => {
      const fallback = node(document, "span", "fv-placeholder");
      fallback.setAttribute("data-fixture-favicon", "fallback");
      event.currentTarget.replaceWith(fallback);
    });
    strip.append(image);
  }
  summary.append(strip, count);
  toggle.replaceChildren(title, badge, foldedMark, summary);
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label",
    `${title.textContent}, ${badge.textContent}, 8 tabs. Expand.`);
  card.classList.add("is-folded");
  card.setAttribute("data-pressure-fixture", "folded-eight");
  card.querySelector(".item-body-frame")?.remove();
  return { card, toggle, title, badge, foldedMark, summary, strip, count };
}

export function applyExpandedCopyFixture(document) {
  const heading = document.querySelector(".panel-heading");
  if (!heading) throw new Error("Expanded-copy fixture heading is missing");
  heading.textContent = "Currently open browser tabs requiring review (1,248)";
  const switchCopy = ["Open browser tabs", "Incoming saved tabs", "Saved work sessions", "Organized labels"];
  [...document.querySelectorAll(".switch-tab")].forEach((button, index) => {
    if (switchCopy[index]) button.textContent = switchCopy[index];
  });
  const title = document.querySelector(".item-title");
  if (title) title.textContent =
    "Current research window with an intentionally expanded descriptive name";
  const firstRowTitle = document.querySelector("#rows-one .t a");
  if (firstRowTitle) firstRowTitle.textContent =
    "A deliberately expanded saved-tab title that remains secondary to its available actions";
  const firstHost = document.querySelector("#rows-one .host");
  if (firstHost) firstHost.textContent =
    "an-intentionally-unbroken-research-subdomain.example.com";
  document.documentElement.setAttribute("data-copy-fixture", "expanded-40");
  return { heading, switchCopy, title, firstRowTitle, firstHost };
}

export function foldedPressureGeometry(document, { zoom = 100 } = {}) {
  const card = document.querySelector('[data-pressure-fixture="folded-eight"]');
  const head = card?.querySelector(".item-head");
  const toggle = card?.querySelector(".item-head-toggle");
  const actions = card?.querySelector(".gacts");
  const strip = card?.querySelector(".fold-strip");
  const count = card?.querySelector(".fold-count");
  if (!card || !head || !toggle || !actions || !strip || !count) {
    return { pass: false, reason: "fixture-incomplete" };
  }
  const headRect = head.getBoundingClientRect();
  const toggleRect = toggle.getBoundingClientRect();
  const actionsRect = actions.getBoundingClientRect();
  const stripRect = strip.getBoundingClientRect();
  const countRect = count.getBoundingClientRect();
  const summaryRect = stripRect.width > 0 ? stripRect : countRect;
  const epsilon = 1;
  const visibleToggleParts = [...toggle.children]
    .map((child) => child.getBoundingClientRect())
    .filter((rect) => rect.width > epsilon && rect.height > epsilon);
  const partsSeparated = visibleToggleParts.every((rect, index) =>
    index === 0 || visibleToggleParts[index - 1].right <= rect.left + epsilon);
  const reachable = toggleRect.width >= 1 && actionsRect.width >= 1 &&
    toggle.getAttribute("aria-expanded") === "false" &&
    [...actions.querySelectorAll("button")].every((button) => button.getBoundingClientRect().width >= 1);
  const contained = toggleRect.left >= headRect.left - epsilon &&
    actionsRect.right <= headRect.right + epsilon && summaryRect.right <= toggleRect.right + epsilon;
  // Crowded Open/Session headers may deliberately put their complete action
  // lane on a second line. Horizontal separation and vertical separation are
  // equally valid as long as both remain contained and reachable.
  const separated = toggleRect.right <= actionsRect.left + epsilon ||
    toggleRect.bottom <= actionsRect.top + epsilon;
  const pass = reachable && contained && separated && partsSeparated &&
    card.scrollWidth <= card.clientWidth + epsilon;
  return {
    pass, zoom, reachable, contained, separated, partsSeparated,
    overflow: Math.max(0, card.scrollWidth - card.clientWidth),
    head: [headRect.left, headRect.right],
    toggle: [toggleRect.left, toggleRect.right, toggleRect.top, toggleRect.bottom],
    actions: [actionsRect.left, actionsRect.right, actionsRect.top, actionsRect.bottom],
    summary: [summaryRect.left, summaryRect.right]
  };
}
