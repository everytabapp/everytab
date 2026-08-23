// PROTOTYPE ONLY: five structurally different Minimal directions.
const VARIANTS = [
  ["A", "Monument"],
  ["B", "Starred orbit"],
  ["C", "Editor desk"],
  ["D", "Horizon"],
  ["E", "Split day"]
];
const links = [
  ["G", "Gmail"], ["C", "Calendar"], ["Y", "YouTube"], ["N", "Notes"], ["R", "Research"]
];
const prototype = document.querySelector("#prototype");
const label = document.querySelector("#variant-label");
const scheme = document.querySelector("#scheme");

const search = () => `<label class="search"><span class="sr-only">Search</span><input placeholder="Search open and saved tabs…" /></label>`;
const launcher = () => `<div class="launcher">${links.map(([letter, name]) =>
  `<button class="launch" type="button"><span class="fav">${letter}</span><span class="launch-name">${name}</span></button>`
).join("")}</div>`;
const quiet = () => `<div class="quiet-links"><span>Dashboard</span><span>Settings</span></div>`;
const clock = () => `<div class="clock-block"><p class="time">09:41</p><p class="date">Tuesday, 18 August</p></div>`;

const renderers = {
  A: () => `<section class="direction variant-a">${clock()}${search()}${quiet()}</section>`,
  B: () => `<section class="direction variant-b">${clock()}${launcher()}${search()}${quiet()}</section>`,
  C: () => `<section class="direction variant-c">${clock()}<div class="desk">${search()}${launcher()}${quiet()}</div></section>`,
  D: () => `<section class="direction variant-d">${clock()}<div class="deck">${search()}${launcher()}${quiet()}</div></section>`,
  E: () => `<section class="direction variant-e"><div>${clock()}${search()}</div><aside class="launchpad"><h2>Starred</h2>${launcher()}${quiet()}</aside></section>`
};

function selectedVariant() {
  const value = new URL(location.href).searchParams.get("variant")?.toUpperCase();
  return VARIANTS.some(([id]) => id === value) ? value : "A";
}
function replaceVariant(id) {
  const url = new URL(location.href);
  url.searchParams.set("variant", id);
  history.replaceState(null, "", url);
  render();
}
function render() {
  const id = selectedVariant();
  prototype.innerHTML = renderers[id]();
  label.textContent = `${id} · ${VARIANTS.find(([key]) => key === id)[1]}`;
}
function cycle(delta) {
  const current = VARIANTS.findIndex(([id]) => id === selectedVariant());
  replaceVariant(VARIANTS[(current + delta + VARIANTS.length) % VARIANTS.length][0]);
}
document.querySelector("#previous").addEventListener("click", () => cycle(-1));
document.querySelector("#next").addEventListener("click", () => cycle(1));
document.addEventListener("keydown", (event) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target?.tagName) || event.target?.isContentEditable) return;
  if (event.key === "ArrowLeft") cycle(-1);
  if (event.key === "ArrowRight") cycle(1);
});
scheme.addEventListener("change", () => {
  const [id, mode] = scheme.value.split(":");
  document.documentElement.dataset.scheme = id;
  document.documentElement.dataset.mode = mode;
});
render();
