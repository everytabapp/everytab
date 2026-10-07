import { installDomFixture } from "./dom-fixture.mjs";

const checks = [];
const check = (condition, name) => {
  if (!condition) throw new Error(name);
  checks.push(name);
};

const fixture = installDomFixture();
try {
  const { createMinimalNavigation } = await import("../js/ui/minimal-navigation.js");
  const search = document.createElement("input");
  const deck = document.createElement("section");
  const launcher = document.createElement("div");
  launcher.className = "minimal-launcher";
  const first = document.createElement("button");
  first.className = "minimal-launch";
  const second = document.createElement("button");
  second.className = "minimal-launch";
  const third = document.createElement("button");
  third.className = "minimal-launch";
  const fourth = document.createElement("button");
  fourth.className = "minimal-launch";
  const fifth = document.createElement("button");
  fifth.className = "minimal-launch";
  const sixth = document.createElement("button");
  sixth.className = "minimal-launch";
  const seventh = document.createElement("button");
  seventh.className = "minimal-launch";
  const links = document.createElement("div");
  links.className = "links";
  const dashboard = document.createElement("a");
  dashboard.setAttribute("href", "#dashboard");
  links.append(dashboard);
  launcher.append(first, second, third, fourth, fifth, sixth, seventh);
  deck.append(search, launcher, links);
  const place = (node, left, top) => {
    node.getBoundingClientRect = () => ({
      left, right: left + 100, top, bottom: top + 40,
      width: 100, height: 40, x: left, y: top
    });
  };
  [first, second, third, fourth, fifth].forEach((node, index) => place(node, index * 120, 0));
  [sixth, seventh].forEach((node, index) => place(node, index * 120, 60));
  place(dashboard, 240, 130);
  document.body.append(deck);

  const controller = createMinimalNavigation(deck, search);
  check(controller.focusBoundary() && document.activeElement === deck,
    "Escape can retain a neutral Minimal keyboard boundary");
  await deck.dispatch("keydown", { key: "ArrowDown", target: deck });
  check(document.activeElement === first,
    "Down from the neutral boundary enters the first Starred launcher");
  controller.focusBoundary();
  await deck.dispatch("keydown", { key: "ArrowRight", target: deck });
  check(document.activeElement === first,
    "Right from the neutral boundary enters the first Starred launcher");
  check(controller.focusFirst() && document.activeElement === first,
    "empty Search enters the first visible Starred launcher");
  await deck.dispatch("keydown", { key: "ArrowDown", target: first });
  check(document.activeElement === sixth, "Down stays in the same visual Starred column");
  await deck.dispatch("keydown", { key: "ArrowRight", target: sixth });
  check(document.activeElement === seventh, "Right advances within the same Starred row");
  await deck.dispatch("keydown", { key: "ArrowLeft", target: seventh });
  check(document.activeElement === sixth, "Left returns within the same Starred row");
  await deck.dispatch("keydown", { key: "ArrowDown", target: sixth });
  check(document.activeElement === dashboard, "Down reaches the nearest footer action");
  first.focus();
  await deck.dispatch("keydown", { key: "ArrowUp", target: first });
  check(document.activeElement === search, "Up from the first launcher returns to Search");
  controller.destroy();
} finally {
  fixture.restore();
}

console.log(`PASS ${checks.length}: ${checks.join(" | ")}`);
