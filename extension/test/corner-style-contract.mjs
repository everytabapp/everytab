/** Source contract for the global Soft/Crisp/Terminal Interface style system. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(new URL("../manifest.json", import.meta.url)));
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

const tokens = read("css/tokens.css");
const interfaceStyle = read("css/interface-style.css");
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
  "--r-mini: var(--shape-mini);", "--r-btn: var(--shape-control);",
  "--r-search: var(--shape-search);", "--r-card: var(--shape-card);",
  "--shape-mini: 3px;", "--shape-row: 0;", "--shape-nav: 3px;",
  "--shape-focus: 2px;", "--shape-control: 5px;", "--shape-search: 4px;",
  "--shape-keeper: 7px;", "--shape-panel: 9px;", "--shape-card: 10px;"
]) check(tokens.includes(declaration), `missing Crisp shape declaration: ${declaration}`);

const soft = tokens.slice(
  tokens.indexOf('[data-interface-style="soft"]'),
  tokens.indexOf('[data-interface-style="terminal"]')
);
for (const declaration of [
  "--shape-mini: 7px;", "--shape-nav: 8px;", "--shape-focus: 9px;",
  "--shape-control: 12px;", "--shape-search: 18px;", "--shape-keeper: 13px;",
  "--shape-panel: 14px;", "--shape-card: 14px;"
]) check(soft.includes(declaration), `missing Soft shape declaration: ${declaration}`);
check(!soft.includes("--shape-row:"), "Soft must not round connected ledger rows");

const terminal = tokens.slice(
  tokens.indexOf('[data-interface-style="terminal"]'),
  tokens.indexOf("\nbody {")
);
for (const declaration of [
  '--font-body: ui-monospace, "SF Mono", Menlo, Consolas, monospace;',
  "--shape-control: 0;", "--shape-search: 0;", "--shape-panel: 0;",
  "--shape-card: 0;", "--shadow-1: none;", "--btn-glow: none;"
]) check(terminal.includes(declaration), `missing Terminal declaration: ${declaration}`);

const productionHosts = [
  "dashboard.html", "newtab.html", "popup.html", "sidepanel.html",
  "options.html", "scheme-editor.html", "focus.html", "suspend.html"
];
for (const file of productionHosts) {
  const source = read(file);
  check(source.includes('data-interface-style="soft"'), `${file} lacks the safe style fallback`);
  check(source.includes('href="css/interface-style.css"'), `${file} does not load Interface style`);
  check(!source.includes("data-corner-style") && !source.includes("data-checkbox-shape"),
    `${file} still exposes a retired appearance attribute`);
}

const productionShapeSources = [
  "css/tokens.css", "css/interface-style.css", "css/primitives.css", "css/dashboard.css",
  "css/sidepanel.css", "css/tablist-d4.css", "css/newtab.css", "css/settings-schemes.css",
  "css/scheme-editor.css", "popup.html", "options.html", "focus.html"
];
const componentStyleOverrides = productionShapeSources.flatMap((file) => {
  if (["css/tokens.css", "css/interface-style.css"].includes(file)) return [];
  return [...read(file).matchAll(/\[data-interface-style=/g)].map(() => file);
});
check(componentStyleOverrides.length === 0,
  `Interface profiles must stay centralized, found overrides in ${componentStyleOverrides.join(", ")}`);
check(!productionShapeSources.some((file) => /data-(corner-style|checkbox-shape)/.test(read(file))),
  "retired appearance selectors must not drive production geometry");

for (const [source, contract] of [
  [primitives, ["border-radius: var(--r-btn);", "border-radius: var(--shape-control);",
    "border-radius: 0 0 var(--shape-search) var(--shape-search);",
    "border-radius: var(--shape-search) var(--shape-search) 0 0;"]],
  [dashboard, ["border-radius: var(--shape-search);", "border-radius: var(--shape-nav);",
    "border-radius: var(--shape-card);", "border-radius: var(--shape-focus);"]],
  [sidepanel, ["border-radius: var(--shape-panel);", "border-radius: var(--shape-control);",
    "border-radius: var(--shape-card);"]],
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

check(tablist.includes(".tablist:not([data-compact]) .trow {") &&
  tablist.includes("border-radius: 0;"),
"connected tab rows and selected bands must remain square in every style");
for (const contract of [
  ':root[data-interface-style="soft"] input[type="checkbox"]',
  ':root[data-interface-style="crisp"] input[type="checkbox"]',
  ':root[data-interface-style="terminal"] input[type="checkbox"]',
  'content: "[ ]";', 'content: "[x]";', 'content: "[-]";', "clip-path: none;"
]) check(interfaceStyle.includes(contract), `selection grammar is incomplete: ${contract}`);
check(/:root\[data-interface-style="terminal"\] \.tablist:not\(\[data-compact\]\)\s*\{[^}]*--tablist-select-column:\s*27px;/s.test(interfaceStyle) &&
  /:root\[data-interface-style="terminal"\] \.tablist:not\(\[data-compact\]\) \.row-select-slot\s*\{[^}]*width:\s*27px;[^}]*min-width:\s*27px;/s.test(interfaceStyle) &&
  tablist.includes("grid-template-columns: var(--tablist-select-column) 24px minmax(0, 1fr) auto auto;"),
  "Terminal reserves its 27px bracket lane through the shared list column token and checkbox slot");

/* These shapes encode status, source imagery, or a semantic removable tag. */
for (const fixed of [
  [popup, ".chip { display: inline-flex; align-items: center; border-radius: 99px;"],
  [settingsSchemes, ".scheme-swatch { width: 11px; height: 11px; flex: none; border-radius: 50%;"],
  [popup, ".tabhead .fav { width: 16px; height: 16px; border-radius: 4px;"],
  [newtab, ".minimal-fav { flex: 0 0 auto; width: 26px; height: 26px; border-radius: 7px;"]
]) check(fixed[0].includes(fixed[1]), `semantic fixed-radius exception changed: ${fixed[1]}`);

console.log("PASS: Interface style source contract");
