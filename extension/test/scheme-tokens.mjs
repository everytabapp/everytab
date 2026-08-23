#!/usr/bin/env node
/**
 * P11-09/P11-10 focused contract tests.
 *
 * The Scheme Lab mounts the real shared list renderer and applies the exact
 * Dashboard/side-panel host selector contract around it. These assertions are
 * the drift guard for role math, parser scope, renderer anatomy, paginated
 * capture coverage, artifact freshness, and the fixed brand mark.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SCHEMES, SCHEME_META } from "../js/lib/schemes.js";
import {
  COLOR_ROLE_KEYS,
  FIXED_BRAND_TOKENS,
  MODES,
  STAR_ACTION_STATES,
  STATUS_MARKER_PLACEMENTS,
  ROLE_KEYS,
  compileSimpleMode,
  createDraftFixture,
  contrastRatio,
  deriveComponentMaterials,
  gradientCss,
  mixHex,
  mixSrgb,
  parseBuiltInTokenCss,
  parseDraftFixture,
  parseGradientCss,
  roleMapToCssProperties,
  serializeDraftFixture,
  validateRoleMap,
  validateSimpleSource
} from "../js/lib/scheme-tokens.js";
import {
  SPECIMEN_SELECTOR_CONTRACT,
  createProductionListSpecimen,
  inspectProductionListSpecimen,
  inspectProductionShellSpecimen,
  specimenSurfaceContract
} from "../tools/scheme-lab-specimen.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const extension = path.resolve(here, "..");
const root = path.resolve(extension, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
let assertions = 0;
let failures = 0;

function check(condition, label) {
  assertions++;
  if (condition) return;
  failures++;
  console.error(`FAIL: ${label}`);
}

function same(actual, expected, label) {
  check(JSON.stringify(actual) === JSON.stringify(expected), label);
}

const tokensCss = read("extension/css/tokens.css");
const parsed = parseBuiltInTokenCss(tokensCss);
check(parsed.ok, "production tokens parse as bounded colour data");
const closeDayAccentRatios = Object.values(parsed.maps).flatMap((modes) => MODES.map((mode) => {
  const roles = modes[mode];
  const text = mixSrgb(mode === "dark" ? "#ffffff" : "#000000", roles.accent,
    mode === "dark" ? 0.8 : 0.6);
  return contrastRatio(text, roles.surface);
}));
check(tokensCss.includes("--accent-text:") && Math.min(...closeDayAccentRatios) >= 4.5,
  "primary-accent action copy keeps its hue and clears 4.5:1 across all 72 built-in maps");
check(Object.isFrozen(SCHEMES) && Object.isFrozen(SCHEME_META) &&
  Object.values(SCHEME_META).every(Object.isFrozen),
"built-in catalogue and every metadata record are immutable");
check(SCHEMES.length === 36 && new Set(SCHEMES).size === 36, "exactly 36 unique built-ins");
check(parsed.order.length === 72, "exactly 72 Light/Dark maps");
same(Object.keys(parsed.maps), SCHEMES, "CSS portfolio order matches the canonical catalogue");
check(!Object.hasOwn(parsed.maps, "everforest") && !Object.hasOwn(parsed.maps, "catppuccin") &&
  !Object.hasOwn(parsed.maps, "rosepine"), "legacy aliases never become built-in maps");

let completeMaps = 0;
let establishedBaseFailures = 0;
let statusPlacementChecks = 0;
let exactMaterialFailures = 0;
for (const scheme of SCHEMES) {
  const meta = SCHEME_META[scheme];
  check(Boolean(meta.label) && /^#[0-9a-f]{6}$/i.test(meta.accent), `${scheme} metadata is complete`);
  check(MODES.includes(meta.defaultMode), `${scheme} has a canonical mode`);
  check(parsed.maps[scheme][meta.defaultMode].accent === meta.accent,
    `${scheme} metadata swatch matches its canonical role map`);
  for (const mode of MODES) {
    const roles = parsed.maps[scheme][mode];
    check(ROLE_KEYS.every((key) => Object.hasOwn(roles, key)), `${scheme}/${mode} has every role`);
    check(Object.keys(roles).length === ROLE_KEYS.length, `${scheme}/${mode} has no arbitrary role`);
    const validation = validateRoleMap(roles, { id: scheme, mode });
    establishedBaseFailures += validation.checks.filter(({ pass, category }) =>
      !pass && category === "base").length;
    statusPlacementChecks += validation.checks.filter(({ category }) => category === "status").length;
    exactMaterialFailures += validation.checks.filter(({ pass, category }) =>
      !pass && category === "material").length;
    completeMaps++;
  }
}
check(completeMaps === 72, "all 72 role maps were validated");
check(establishedBaseFailures === 0, "all established base gates remain green");
check(statusPlacementChecks === 72 * 5,
  "status ledger enumerates five actual marker/tinted-background placements per role map");
check(exactMaterialFailures === 0,
  "the corrected dark Workbench ladder clears every unquantized material check");

const creamStatusChecks = validateRoleMap(parsed.maps.cream.light, {
  id: "cream", mode: "light"
}).checks.filter(({ category }) => category === "status");
same(creamStatusChecks.map(({ component, role, state }) => ({ component, role, state })), [
  { component: "vault-settings-status", role: "statusMarkerOutline", state: "ok-tint/page" },
  { component: "vault-settings-status", role: "statusMarkerOutline", state: "warn-tint/page" },
  { component: "vault-settings-status", role: "statusMarkerOutline", state: "danger-tint/page" },
  { component: "sidebar-vault-pill", role: "statusMarkerOutline", state: "ok-tint/side-navigation" },
  { component: "sidebar-vault-pill", role: "statusMarkerOutline", state: "warn-tint/side-navigation" }
], "status checks enumerate exact role/component/state production placements");
check(creamStatusChecks.every(({ foreground, background }) => foreground !== background),
  "status markers are compared with their composited --*-bg fills, not bare surfaces");
same(STATUS_MARKER_PLACEMENTS.map(({ component, surface, roles }) =>
  ({ component, surface, roles })), [
  { component: "vault-settings-status", surface: "page", roles: ["ok", "warn", "danger"] },
  { component: "sidebar-vault-pill", surface: "side-navigation", roles: ["ok", "warn"] }
], "the exported status placement ledger matches production components exactly");
same(STAR_ACTION_STATES.map(([state]) => state), [
  "row-hover", "row-selected", "row-selected-hover", "row-palette-source"
], "star-action ledger contains only visible/reachable production tray states");
const creamStarStates = validateRoleMap(parsed.maps.cream.light, {
  id: "cream", mode: "light"
}).checks.filter(({ component }) => component === "star-action").map(({ state }) => state);
same(creamStarStates, STAR_ACTION_STATES.map(([state]) => `accent-soft/${state}`),
  "star-action checks exclude headers and resting hidden rows");

const simpleSource = (scheme, mode) => {
  const roles = parsed.maps[scheme][mode];
  return {
    page: roles.bgSolid,
    surface: roles.surface,
    raisedSurface: roles.surface2,
    text: roles.ink,
    accent: roles.accent,
    secondaryAccent: roles.accentStrong,
    border: roles.border
  };
};
const lightSource = simpleSource("cream", "light");
const darkSource = simpleSource("ink", "dark");
const lightCompiled = compileSimpleMode(lightSource, { mode: "light" });
const darkCompiled = compileSimpleMode(darkSource, { mode: "dark" });
check(lightCompiled.ok && darkCompiled.ok, "guided seven-colour compiler makes complete valid maps");
same(compileSimpleMode(lightSource, { mode: "light" }).roles, lightCompiled.roles,
  "guided compiler is deterministic");
check(ROLE_KEYS.every((key) => Object.hasOwn(lightCompiled.roles, key)),
  "guided compiler produces every editable role");
check(COLOR_ROLE_KEYS.every((key) => /^#[0-9a-f]{6}$/.test(lightCompiled.roles[key])),
  "guided compiler emits canonical six-digit hex colours");

const safeCss = roleMapToCssProperties(lightCompiled.roles, { mode: "light" });
check(safeCss.ok && Object.keys(safeCss.value).length === COLOR_ROLE_KEYS.length + 1,
  "complete roles compile to the bounded CSS property set");
check(Object.keys(safeCss.value).every((key) => !key.startsWith("--brand-")),
  "editable role output cannot overwrite fixed brand identity");
check(Object.keys(FIXED_BRAND_TOKENS).every((token) => tokensCss.includes(`${token}:`)),
  "fixed brand identity remains in production tokens");

const unsafeSimple = { ...lightSource, accent: "#ffffff;url(https://example.invalid)" };
check(!validateSimpleSource(unsafeSimple).ok, "simple input rejects arbitrary CSS and URLs");
check(!validateSimpleSource({ ...lightSource, accent: "#fff" }).ok,
  "simple input rejects shorthand hex");
check(gradientCss(["#ffffff", "url(x)"]) === null, "gradient compiler rejects non-colour stops");
check(!parseGradientCss("linear-gradient(135deg, #ffffff 0%, url(x) 100%)").ok,
  "gradient parser rejects executable CSS");
check(!compileSimpleMode(lightSource, { mode: "light", overrides: { brandInk: "#000000" } }).ok,
  "advanced overrides reject unknown and brand roles");

const brokenRoles = structuredClone(lightCompiled.roles);
brokenRoles.ink = brokenRoles.bgSolid;
const broken = validateRoleMap(brokenRoles, { id: "draft", mode: "light" });
check(!broken.ok && broken.errors.some(({ message }) =>
  message.includes("needs") && message.includes("Adjust")),
"contrast failure is a plain-language actionable error");

const falsePassBackground = "#e83a14";
const falsePassAccent = "#5e70c3";
const exactTint = mixSrgb(falsePassBackground, falsePassAccent, 0.12);
const quantizedTint = mixHex(falsePassBackground, falsePassAccent, 0.12);
check(contrastRatio("#ffffff", exactTint) < 4.5 &&
  contrastRatio("#ffffff", quantizedTint) >= 4.5,
"unquantized sRGB rejects a boundary pairing that 8-bit colour-mix rounding falsely passes");

const laserMaterials = deriveComponentMaterials(parsed.maps.laser.dark, "dark");
check(contrastRatio(laserMaterials.workbenchRow, laserMaterials.workbenchHover) >= 1.14,
  "the exact Laser Dark Workbench ladder clears the material boundary without rounding");

const injectedDeclaration = tokensCss.replace(
  "--bg-solid: #f5efe3;",
  "--bg-solid: #f5efe3; background-image: url(https://example.invalid/x);"
);
check(parseBuiltInTokenCss(injectedDeclaration).errors.some(({ code }) =>
  code === "css.forbidden-declaration"),
"built-in parser rejects ordinary background-image declarations inside token scopes");
const injectedFont = tokensCss.replace(
  "--bg-solid: #f5efe3;",
  "--bg-solid: #f5efe3; font-family: fantasy; display: grid;"
);
check(parseBuiltInTokenCss(injectedFont).errors.filter(({ code }) =>
  code === "css.forbidden-declaration").length === 2,
"built-in parser rejects font and layout declarations inside token scopes");
const injectedScope = `${tokensCss}\n` +
  '[data-scheme="cream"][data-mode="light"] body { --bg-solid: #ffffff; }\n';
check(parseBuiltInTokenCss(injectedScope).errors.some(({ code }) => code === "css.forbidden-scope"),
  "built-in parser rejects scheme tokens placed in a descendant scope");

const godspeedGradient = parseGradientCss(
  "linear-gradient(160deg, #1a2230, #232f47)"
);
check(godspeedGradient.ok && godspeedGradient.angle === 160 &&
  godspeedGradient.positions.every((position) => position === null),
"gradient parser preserves a built-in's authored angle and omitted positions");
check(gradientCss(
  godspeedGradient.value,
  godspeedGradient.angle,
  godspeedGradient.positions
) === "linear-gradient(160deg, #1a2230, #232f47)",
"copying a built-in preserves gradient angle and stop-position syntax");

const fixture = createDraftFixture({
  name: "Quiet Harbor",
  defaultMode: "light",
  authoringMode: "simple",
  simple: { light: lightSource, dark: darkSource },
  roles: { light: lightCompiled.roles, dark: darkCompiled.roles }
});
check(fixture.ok, "valid ephemeral draft fixture is accepted");
const serialized = serializeDraftFixture(fixture.value);
check(serialized.ok && serialized.text.endsWith("\n"), "draft serialization is deterministic text");
same(parseDraftFixture(serialized.text).value, fixture.value, "draft fixture round-trips exactly");
const unknownFixture = JSON.parse(serialized.text);
unknownFixture.css = "body{display:none}";
check(!parseDraftFixture(JSON.stringify(unknownFixture)).ok, "draft envelope rejects unknown fields");
const futureFixture = JSON.parse(serialized.text);
futureFixture.formatVersion = 999;
check(!parseDraftFixture(JSON.stringify(futureFixture)).ok, "draft envelope rejects future formats");
check(!parseDraftFixture(`{"padding":"${"x".repeat(70 * 1024)}"}`).ok,
  "draft parser enforces the 64 KiB bound before decoding");

const moduleSource = read("extension/js/lib/scheme-tokens.js");
check(!/\b(document|window|getComputedStyle|localStorage|chrome\.storage)\b/.test(moduleSource),
  "shared scheme implementation stays DOM-free and storage-free");

const labHtml = read("extension/tools/scheme-lab.html");
const labJs = read("extension/tools/scheme-lab.js");
const labCss = read("extension/tools/scheme-lab.css");
for (const href of [
  "../css/tokens.css", "../css/primitives.css", "../css/dashboard.css",
  "../css/tablist-d4.css", "../css/sidepanel.css"
]) {
  check(labHtml.includes(`href="${href}"`), `Lab loads production stylesheet ${href}`);
}
const wideContract = specimenSurfaceContract(1280);
const narrowContract = specimenSurfaceContract(400);
const pressureContract = specimenSurfaceContract(320);
same(wideContract, {
  width: 1280,
  surface: "dashboard",
  presentation: "default",
  hasCompactAttribute: false
}, "wide specimen executes the Dashboard renderer contract");
check(narrowContract.surface === "sidepanel" && narrowContract.presentation === "compact" &&
  narrowContract.hasCompactAttribute,
"400px specimen executes the real compact side-panel renderer contract");
check(pressureContract.surface === "sidepanel" && pressureContract.hasCompactAttribute,
  "320px pressure specimen executes the same compact side-panel renderer contract");

class AnatomyNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this._classes = new Set();
    this.dataset = new Proxy({}, {
      set: (target, key, value) => {
        target[key] = String(value);
        const attr = `data-${String(key).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
        this.attributes.set(attr, String(value));
        return true;
      }
    });
    this.classList = {
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      remove: (...names) => names.forEach((name) => this._classes.delete(name)),
      contains: (name) => this._classes.has(name),
      toggle: (name, force) => {
        const on = force ?? !this._classes.has(name);
        on ? this._classes.add(name) : this._classes.delete(name);
        return on;
      }
    };
  }

  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get className() {
    return [...this._classes].join(" ");
  }

  setAttribute(name, value) {
    const text = String(value);
    this.attributes.set(name, text);
    if (name === "class") this.className = text;
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      Object.defineProperty(this.dataset, key, {
        value: text,
        writable: true,
        enumerable: true,
        configurable: true
      });
    }
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  addEventListener() {}

  append(...children) {
    for (const child of children) {
      if (child == null) continue;
      this.children.push(child);
      if (child instanceof AnatomyNode) child.parentNode = this;
    }
  }

  get childNodes() {
    return this.children;
  }

  matchesSimple(selector) {
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    const attr = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (attr) {
      return this.hasAttribute(attr[1]) &&
        (attr[2] == null || this.getAttribute(attr[1]) === attr[2]);
    }
    return this.tagName === selector.toUpperCase();
  }

  querySelectorAll(selector) {
    if (selector.startsWith(":scope > ")) {
      let nodes = [this];
      for (const part of selector.slice(9).split(" > ")) {
        nodes = nodes.flatMap((node) => node.children.filter((child) =>
          child instanceof AnatomyNode && child.matchesSimple(part)));
      }
      return nodes;
    }
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (!(child instanceof AnatomyNode)) continue;
        if (child.matchesSimple(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matchesSimple(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
}

const previousDocument = globalThis.document;
const previousWindow = globalThis.window;
const anatomyBody = new AnatomyNode("body");
globalThis.document = {
  activeElement: null,
  body: anatomyBody,
  hidden: false,
  addEventListener() {},
  createElement: (tag) => new AnatomyNode(tag),
  createElementNS: (_, tag) => new AnatomyNode(tag)
};
globalThis.window = { addEventListener() {}, innerWidth: 400, innerHeight: 900 };
const compactHost = new AnatomyNode("article");
compactHost.setAttribute("data-surface", "sidepanel");
const renderedList = createProductionListSpecimen({ width: 400, instanceId: "node-contract" });
compactHost.append(renderedList);
const renderedAnatomy = inspectProductionListSpecimen(renderedList, narrowContract);
check(renderedAnatomy.ok && renderedAnatomy.surface === "sidepanel" &&
  renderedAnatomy.cards === 1 && renderedAnatomy.rows === 4 && renderedAnatomy.actionTrays === 4,
"focused test executes createTabList and compares real compact anatomy, not source substrings");
const specimenRows = renderedList.querySelectorAll("[data-tablist-row]");
check(!specimenRows[0].classList.contains("kbd-reveal") &&
  specimenRows.slice(1).every((row) => row.classList.contains("kbd-reveal") || row.classList.contains("sel")),
"specimen exposes star actions only on reachable hover/focus/selected rows, never the resting row");

function shellFixture(contract, instanceId) {
  const specimen = new AnatomyNode("article");
  const shell = new AnatomyNode("div");
  shell.className = `lab-production-shell ${contract.surface === "sidepanel" ? "sidepanel-shell" : "app"}`;
  const orb = new AnatomyNode("span");
  orb.className = "orb o1";
  shell.append(orb);
  if (contract.surface === "sidepanel") {
    const chrome = new AnatomyNode("div");
    chrome.className = "panel-chrome";
    const search = new AnatomyNode("div");
    search.className = "search-box";
    const switchTab = new AnatomyNode("button");
    switchTab.className = "switch-tab";
    switchTab.setAttribute("aria-selected", "true");
    chrome.append(search, switchTab);
    const lead = new AnatomyNode("div");
    lead.className = "panel-section-lead";
    const local = new AnatomyNode("div");
    local.className = "section-local-sticky";
    shell.append(chrome, lead, local);
  } else {
    const nav = new AnatomyNode("button");
    nav.className = "navitem active";
    const hero = new AnatomyNode("div");
    hero.className = "hero";
    const lead = new AnatomyNode("div");
    lead.className = "section-lead";
    const local = new AnatomyNode("div");
    local.className = "section-local-sticky";
    shell.append(nav, hero, lead, local);
  }
  shell.append(createProductionListSpecimen({ width: contract.width, instanceId }));
  specimen.append(shell);
  return specimen;
}

function activeSpecimenStyle(node, pseudo = "") {
  const style = { display: "block", position: "static", backgroundImage: "none" };
  if (pseudo === "::before") {
    style.position = "absolute";
    style.backgroundImage = "linear-gradient(rgb(0 0 0), rgb(1 1 1))";
    return style;
  }
  if (node.classList.contains("orb")) style.position = "fixed";
  if (["hero", "panel-chrome", "section-lead", "panel-section-lead",
    "section-local-sticky"].some((name) => node.classList.contains(name))) {
    style.position = "sticky";
    style.backgroundImage = "linear-gradient(rgb(0 0 0), rgb(1 1 1))";
  }
  if (node.classList.contains("item-head-shell")) style.position = "sticky";
  return style;
}

const narrowShell = inspectProductionShellSpecimen(
  shellFixture(narrowContract, "narrow-shell"),
  { ...narrowContract, gradient: true },
  activeSpecimenStyle
);
const wideShell = inspectProductionShellSpecimen(
  shellFixture(wideContract, "wide-shell"),
  { ...wideContract, gradient: true },
  activeSpecimenStyle
);
check(narrowShell.ok && narrowShell.searchInsidePanelChrome &&
  narrowShell.stickyShell === "panel-chrome" && narrowShell.stickyLead === "panel-section-lead",
"compact specimen mounts Search inside the production sticky panel stack with active styles");
check(wideShell.ok && wideShell.stickyShell === "hero" && wideShell.stickyLead === "section-lead",
  "wide specimen mounts the production sticky hero and Canvas line with active styles");
const inactiveShell = inspectProductionShellSpecimen(
  shellFixture(wideContract, "inactive-shell"),
  { ...wideContract, gradient: true },
  () => ({ display: "block", position: "static", backgroundImage: "none" })
);
check(!inactiveShell.ok && !inactiveShell.stylesActive,
  "shell contract rejects matching class names when computed production styles are inactive");

function compoundMatches(node, rawCompound) {
  if (!node) return false;
  let compound = rawCompound.replace(/::(?:before|after)$/, "");
  for (const match of [...compound.matchAll(/:not\(([^)]+)\)/g)]) {
    if (compoundMatches(node, match[1])) return false;
  }
  compound = compound.replace(/:not\([^)]+\)/g, "");
  const tag = compound.match(/^[a-z][a-z0-9-]*/i)?.[0];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const [, className] of compound.matchAll(/\.([a-z0-9_-]+)/gi)) {
    if (!node.classList.contains(className)) return false;
  }
  for (const [, name, , quoted, bare] of compound.matchAll(
    /\[([\w-]+)(?:=(?:(["'])(.*?)\2|([^\]]+)))?\]/g
  )) {
    if (!node.hasAttribute(name)) return false;
    const expected = quoted ?? bare;
    if (expected != null && node.getAttribute(name) !== expected.trim()) return false;
  }
  return true;
}

function selectorMatches(node, selector) {
  const parts = selector.trim().replace(/\s*>\s*/g, " > ").split(/\s+/);
  let index = parts.length - 1;
  let current = node;
  if (!compoundMatches(current, parts[index])) return false;
  while (index > 0) {
    if (parts[index - 1] === ">") {
      current = current.parentNode;
      index -= 2;
      if (!compoundMatches(current, parts[index])) return false;
    } else {
      index -= 1;
      let ancestor = current.parentNode;
      while (ancestor && !compoundMatches(ancestor, parts[index])) ancestor = ancestor.parentNode;
      if (!ancestor) return false;
      current = ancestor;
    }
  }
  return true;
}

function attachToProductionBody(specimen, surface) {
  const fixtureBody = new AnatomyNode("body");
  fixtureBody.className = "gradient";
  fixtureBody.setAttribute("data-surface", surface);
  fixtureBody.setAttribute("data-workbench", "true");
  fixtureBody.append(specimen);
  return fixtureBody;
}

const narrowSelectorBody = attachToProductionBody(
  shellFixture(narrowContract, "narrow-selectors"), "sidepanel"
);
const wideSelectorBody = attachToProductionBody(
  shellFixture(wideContract, "wide-selectors"), "dashboard"
);
function contractTarget(bodyNode, selector) {
  const specimen = bodyNode.querySelector(".lab-production-shell");
  if (selector.includes(".orb")) return specimen.querySelector(".orb");
  if (selector.includes(".hero")) return specimen.querySelector(".hero");
  if (selector.includes(".panel-chrome > .search-box")) return specimen.querySelector(".search-box");
  if (selector.includes(".panel-chrome")) return specimen.querySelector(".panel-chrome");
  if (selector.includes(".panel-section-lead")) return specimen.querySelector(".panel-section-lead");
  if (selector.includes(".section-local-sticky")) return specimen.querySelector(".section-local-sticky");
  if (selector.includes(".section-lead")) return specimen.querySelector(".section-lead");
  if (selector.includes(".item-head-shell")) return specimen.querySelector(".item-head-shell");
  if (selector.includes(".item-body-frame")) return specimen.querySelector(".item-body-frame");
  if (selector.includes(".navitem")) return specimen.querySelector(".navitem");
  if (selector.includes(".switch-tab")) return specimen.querySelector(".switch-tab");
  if (selector.includes(".tacts")) return specimen.querySelector(".tacts");
  if (selector.includes(".tablist")) return specimen.querySelector(".tablist");
  return null;
}
for (const selector of SPECIMEN_SELECTOR_CONTRACT) {
  const compactSelector = selector.includes("sidepanel") || selector.includes("panel-") ||
    selector.includes("switch-tab") ||
    (selector.includes("[data-compact]") && !selector.includes(":not([data-compact])"));
  const fixtureBody = compactSelector ? narrowSelectorBody : wideSelectorBody;
  check(selectorMatches(contractTarget(fixtureBody, selector), selector),
    `production selector matches mounted specimen anatomy: ${selector}`);
}
if (previousDocument === undefined) delete globalThis.document;
else globalThis.document = previousDocument;
if (previousWindow === undefined) delete globalThis.window;
else globalThis.window = previousWindow;

const selectorSet = new Set();
const specimenCss = [
  labCss,
  tokensCss,
  read("extension/css/dashboard.css"),
  read("extension/css/tablist-d4.css"),
  read("extension/css/sidepanel.css")
].join("\n");
for (const match of specimenCss
  .replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)) {
  for (const selector of match[1].split(",")) {
    selectorSet.add(selector.trim().replace(/\s+/g, " "));
  }
}
for (const selector of SPECIMEN_SELECTOR_CONTRACT) {
  check(selectorSet.has(selector), `production specimen selector remains executable: ${selector}`);
}
function ruleBody(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}
const passResultRule = ruleBody(labCss, ".lab-check-result.pass");
const failResultRule = ruleBody(labCss, ".lab-check-result.fail");
check(passResultRule.includes("color: var(--ink)") && passResultRule.includes("var(--ok-bg)") &&
  failResultRule.includes("color: var(--ink)") && failResultRule.includes("var(--danger-bg)") &&
  !/color:\s*var\(--(?:ok|danger)\)/.test(`${passResultRule}${failResultRule}`),
"Lab outcome labels use AA status-pill text roles, never raw graphic colours as small text");
check(labJs.includes("createProductionListSpecimen") && labJs.includes("inspectProductionListSpecimen"),
  "Lab mounts the production list renderer and executes its anatomy assertion");
check(labJs.includes('icon("mark"') && !labCss.includes("--brand-accent:"),
  "Lab uses the fixed production mark without redefining brand tokens");
check([1280, 400, 320].every((width) => labJs.includes(String(width)) && labCss.includes(String(width))),
  "Lab and stylesheet keep 1280, 400, and 320 capture contracts");
check(!labCss.includes(".lab-specimen .") && !labCss.includes(".lab-specimen.lab-") &&
  [".scheme-specimen .toast", ".scheme-specimen .tagmenu", ".scheme-specimen .tooltip"]
    .every((selector) => labCss.includes(selector)),
"Lab-only state overrides target the mounted specimen root instead of a dead selector");
check(tokensCss.includes(":root, .scheme-role-scope") &&
  labJs.includes("scheme-specimen scheme-role-scope") &&
  labCss.includes('.scheme-specimen[data-gradient="true"] .orb'),
"nested specimens resolve derived roles locally and keep atmosphere inside their canvas");
check(labCss.includes('[data-contact-kind="narrow"]') &&
  labCss.includes('[data-contact-kind="pressure"]') &&
  labCss.includes(".lab-contact-label"),
"compact contact labels stack inside the declared 400px and 320px capture widths");
check(["wide", "narrow", "pressure"].every((mode) => labJs.includes(`"${mode}"`)),
  "Lab exposes all deterministic contact-sheet routes");
check(!/(localStorage|chrome\.storage|getSettings|saveSettings|VaultStatus|syncNow)/.test(labJs),
  "Lab runtime has no Settings, rotation, storage, or Vault integration");
check(!read("extension/manifest.json").includes("scheme-lab") &&
  !read("extension/dashboard.html").includes("scheme-lab"),
"internal Lab remains unlinked from the installed product");

const qaPath = path.join(root, "campaign-assets/p11-scheme-qa-results.json");
const planPath = path.join(root, "campaign-assets/p11-scheme-qa-capture-plan.json");
const humanPath = path.join(root, "campaign-assets/p11-scheme-qa-human-review.json");
const captureSessionPath = path.join(root, "campaign-assets/p11-scheme-qa-capture-session.json");
const qa = JSON.parse(fs.readFileSync(qaPath, "utf8"));
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const captureSession = JSON.parse(fs.readFileSync(captureSessionPath, "utf8"));
const humanBefore = fs.readFileSync(humanPath, "utf8");
check(qa.portfolio.actualBuiltIns === 36 && qa.portfolio.actualModeMaps === 72,
  "machine-readable QA result records the full portfolio");
const recordedChecks = qa.combinations.flatMap(({ checks }) => checks);
check(qa.productionPairingLedger.checks === recordedChecks.length &&
  qa.productionPairingLedger.failures === recordedChecks.filter(({ pass }) => !pass).length &&
  qa.productionPairingLedger.passes === recordedChecks.filter(({ pass }) => pass).length,
"authoritative production ledger wording/count is derived exactly from its recorded pairings");
check(["not-reviewed", "stale", "fail", "contact-sheets-pass", "pass"].includes(qa.visualStatus) &&
  qa.visualStatus === qa.humanReviewSummary.overall &&
  !qa.combinations.some(({ humanStatus }) => humanStatus),
"machine result reports only the durable human ledger summary without inventing per-map approval");
check(captureSession.sourceSha256 === qa.sourceSha256 &&
  captureSession.captures.length === plan.contactSheets.length &&
  captureSession.captures.every(({ output }) => fs.existsSync(path.join(root, output))),
"the durable review points to a complete current-source capture session");
check(captureSession.captures.every(({ viewport, geometry }) =>
  geometry.document.clientWidth === viewport.width &&
  geometry.document.scrollWidth === viewport.width &&
  geometry.entries.every(({ offenders }) => offenders.length === 0)),
"every reviewed contact sheet retains its exact width with no measured descendant bleed");
check(plan.contactSheets.length === 31 &&
  plan.contactSheets.filter(({ kind }) => kind === "wide").flatMap(({ combinations }) =>
    combinations).length === 72 &&
  plan.contactSheets.filter(({ kind }) => kind === "narrow").flatMap(({ combinations }) =>
    combinations).length === 72 &&
  plan.contactSheets.filter(({ kind }) => kind === "pressure").flatMap(({ combinations }) =>
    combinations).length === 4,
"paginated captures cover 72 wide, 72 narrow, and four 320px pressure specimens");
check(plan.contactSheets.every(({ combinations }) => combinations.length <= 5),
  "no contact route recreates the former 34k–41k pixel monolith");

function fingerprintsCurrent(artifact) {
  return artifact.inputFingerprint.entries.every((entry) => {
    const bytes = fs.readFileSync(path.join(root, entry.path));
    return createHash("sha256").update(bytes).digest("hex") === entry.sha256;
  });
}
check(fingerprintsCurrent(qa) && fingerprintsCurrent(plan),
  "every declared machine artifact input fingerprint is current");
const staleQa = structuredClone(qa);
staleQa.inputFingerprint.entries[0].sha256 = "0".repeat(64);
check(!fingerprintsCurrent(staleQa), "stale artifact detection rejects a changed input fingerprint");

const resultsBefore = fs.readFileSync(qaPath, "utf8");
const planBefore = fs.readFileSync(planPath, "utf8");
execFileSync(process.execPath, [path.join(root, "campaign-assets/run-p11-scheme-qa.mjs")], {
  cwd: root,
  stdio: "ignore"
});
check(fs.readFileSync(qaPath, "utf8") === resultsBefore &&
  fs.readFileSync(planPath, "utf8") === planBefore,
"machine QA artifacts regenerate deterministically from their fingerprinted inputs");
check(fs.readFileSync(humanPath, "utf8") === humanBefore,
  "machine regeneration never overwrites the durable human review ledger");

if (failures) {
  console.error(`P11 scheme token tests failed: ${failures}/${assertions} assertions.`);
  process.exit(1);
}
console.log(`P11 scheme token tests passed: ${assertions} assertions.`);
