/** Source contract for the global Crisp/Soft shape system. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(new URL("../manifest.json", import.meta.url)));
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

const tokens = read("css/tokens.css");
const primitives = read("css/primitives.css");
const dashboard = read("css/dashboard.css");
const sidepanel = read("css/sidepanel.css");
const tablist = read("css/tablist-d4.css");
const newtab = read("css/newtab.css");
const popup = read("popup.html");
const settings = read("options.html");
const settingsSchemes = read("css/settings-schemes.css");
const settingsSurface = `${settings}\n${settingsSchemes}`;

for (const declaration of [
  "--r-mini: var(--shape-mini);",
  "--r-btn: var(--shape-control);",
  "--r-search: var(--shape-search);",
  "--r-card: var(--shape-card);",
  "--shape-mini: 3px;",
  "--shape-row: 0;",
  "--shape-nav: 3px;",
  "--shape-focus: 2px;",
  "--shape-control: 5px;",
  "--shape-search: 4px;",
  "--shape-keeper: 7px;",
  "--shape-panel: 9px;",
  "--shape-card: 10px;"
]) check(tokens.includes(declaration), `missing Crisp shape declaration: ${declaration}`);

const soft = tokens.slice(
  tokens.indexOf('[data-corner-style="soft"]'),
  tokens.indexOf("\nbody {")
);
for (const declaration of [
  "--shape-mini: 7px;",
  "--shape-nav: 8px;",
  "--shape-focus: 9px;",
  "--shape-control: 12px;",
  "--shape-search: 18px;",
  "--shape-keeper: 13px;",
  "--shape-panel: 14px;",
  "--shape-card: 14px;"
]) check(soft.includes(declaration), `missing Soft shape declaration: ${declaration}`);
check(!soft.includes("--shape-row:"), "Soft must not round connected ledger rows");

const productionShapeSources = [
  "css/tokens.css", "css/primitives.css", "css/dashboard.css", "css/sidepanel.css",
  "css/tablist-d4.css", "css/newtab.css", "css/settings-schemes.css", "css/scheme-editor.css",
  "popup.html", "options.html", "focus.html"
];
const componentCornerOverrides = productionShapeSources.flatMap((file) => {
  if (file === "css/tokens.css") return [];
  return [...read(file).matchAll(/\[data-corner-style=["']soft["']\]/g)]
    .map(() => file);
});
check(componentCornerOverrides.length === 0,
  `Corner profiles must remain token-only, found component overrides in ${componentCornerOverrides.join(", ")}`);

check(!productionShapeSources.some((file) => read(file).includes("var(--r-row)")),
  "the ambiguous legacy --r-row alias must not drive production geometry");
check(!/:where\(button, a\[href\], summary, \[tabindex\]\):focus-visible\s*\{[^}]*border-radius:/s
  .test(primitives), "the shared focus ring must retain each component's semantic radius");

for (const [source, contract] of [
  [primitives, ["border-radius: var(--r-btn);", "border-radius: var(--shape-control);",
    "border-radius: 0 0 var(--shape-search) var(--shape-search);",
    "border-radius: var(--shape-search) var(--shape-search) 0 0;"]],
  [dashboard, ["border-radius: var(--shape-search);", "border-radius: var(--shape-nav);",
    "border-radius: var(--shape-card);", "border-radius: var(--shape-focus);"]],
  [sidepanel, ["border-radius: var(--shape-panel);", "border-radius: var(--shape-control);",
    "border-radius: var(--shape-focus);"]],
  [tablist, ["border-radius: var(--shape-panel);", "border-radius: var(--shape-control);",
    "border-radius: var(--shape-keeper);", "border-radius: var(--shape-row);"]],
  [newtab, ["border-radius: var(--shape-panel);", "border-radius: var(--r-search);"]],
  [popup, ["border-radius: var(--shape-control);", "border-radius: var(--r-btn);"]],
  [settingsSurface, ["border-radius: var(--r-btn);", "border-radius: var(--r-card);"]]
]) {
  for (const declaration of contract) {
    check(source.includes(declaration), `surface lost semantic shape use: ${declaration}`);
  }
}

check(
  tablist.includes(".tablist:not([data-compact]) .trow {") &&
    tablist.includes("border-radius: 0;") &&
    !tablist.includes('[data-corner-style="soft"] .tablist .trow'),
  "connected tab rows and selected bands must remain square in both profiles"
);

/* These shapes encode meaning or source imagery and must not follow Corner style. */
for (const fixed of [
  [popup, ".chip { display: inline-flex; align-items: center; border-radius: 99px;"],
  [settingsSchemes, ".scheme-swatch { width: 11px; height: 11px; flex: none; border-radius: 50%;"],
  [popup, ".tabhead .fav { width: 16px; height: 16px; border-radius: 4px;"],
  [newtab, ".minimal-fav { flex: 0 0 auto; width: 26px; height: 26px; border-radius: 7px;"],
  [dashboard, ".close-day-favicon { width: 20px; height: 20px; border-radius: 7px;"],
  [tablist, '[data-checkbox-shape="round"] .tablist input[type="checkbox"] { border-radius: 50%; }']
]) check(fixed[0].includes(fixed[1]), `semantic fixed-radius exception changed: ${fixed[1]}`);

console.log("PASS: Corner style source contract");
