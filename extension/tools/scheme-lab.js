import { SCHEMES, SCHEME_META } from "../js/lib/schemes.js";
import {
  COLOR_ROLE_KEYS,
  MODES,
  ROLE_DEFINITIONS,
  SIMPLE_COLOR_KEYS,
  SIMPLE_COLOR_LABELS,
  compileSimpleMode,
  createDraftFixture,
  parseBuiltInTokenCss,
  parseDraftFixture,
  roleMapToCssProperties,
  serializeDraftFixture,
  validateRoleMap
} from "../js/lib/scheme-tokens.js";
import { icon } from "../js/ui/icons.js";
import {
  createProductionListSpecimen,
  inspectProductionListSpecimen,
  inspectProductionShellSpecimen,
  specimenSurfaceContract
} from "./scheme-lab-specimen.js";

const cssText = await fetch("../css/tokens.css").then((response) => {
  if (!response.ok) throw new Error(`Could not load production tokens (${response.status}).`);
  return response.text();
});
const parsed = parseBuiltInTokenCss(cssText);
if (!parsed.ok) throw new Error(parsed.errors.map(({ message }) => message).join("\n"));

const root = document.documentElement;
const body = document.body;
const byId = (id) => document.getElementById(id);
const controls = {
  source: byId("lab-source"),
  scheme: byId("lab-scheme"),
  mode: byId("lab-mode"),
  width: byId("lab-width"),
  gradient: byId("lab-gradient"),
  actions: byId("lab-actions"),
  palette: byId("lab-palette"),
  tooltip: byId("lab-tooltip"),
  name: byId("lab-name")
};

const clone = (value) => structuredClone(value);
const sourceFromRoles = (roles) => ({
  page: roles.bgSolid,
  surface: roles.surface,
  raisedSurface: roles.surface2,
  text: roles.ink,
  accent: roles.accent,
  secondaryAccent: roles.accentStrong,
  border: roles.border
});

const initialSimple = Object.fromEntries(MODES.map((mode) => [
  mode, sourceFromRoles(parsed.maps.cream[mode])
]));
const initialRoles = Object.fromEntries(MODES.map((mode) => [
  mode, compileSimpleMode(initialSimple[mode], { mode }).roles
]));
const state = {
  source: "built-in",
  scheme: "cream",
  mode: "light",
  width: 1280,
  gradient: false,
  showActions: true,
  showPalette: true,
  showTooltip: true,
  authoringMode: "simple",
  draft: {
    name: "Quiet Harbor",
    defaultMode: "light",
    simple: clone(initialSimple),
    roles: clone(initialRoles)
  },
  lastValid: clone(initialRoles)
};

for (const scheme of SCHEMES) {
  controls.scheme.append(Object.assign(document.createElement("option"), {
    value: scheme,
    textContent: SCHEME_META[scheme].label
  }));
}
byId("lab-mark").append(icon("mark", 44));

function clearCustomProperties(target) {
  for (const { css } of ROLE_DEFINITIONS) target.style.removeProperty(css);
  target.style.removeProperty("--bg-grad");
}

function applyRoles(target, roles, mode) {
  clearCustomProperties(target);
  const result = roleMapToCssProperties(roles, { mode });
  if (!result.ok) return false;
  for (const [property, value] of Object.entries(result.value)) {
    target.style.setProperty(property, value);
  }
  return true;
}

function currentDraftResult() {
  if (state.authoringMode === "simple") {
    const compiled = compileSimpleMode(state.draft.simple[state.mode], { mode: state.mode });
    if (compiled.roles) state.draft.roles[state.mode] = clone(compiled.roles);
    return compiled;
  }
  const roles = state.draft.roles[state.mode];
  const validation = validateRoleMap(roles, { id: "draft", mode: state.mode });
  return { ...validation, roles };
}

function currentResult() {
  const roles = state.source === "built-in"
    ? parsed.maps[state.scheme][state.mode]
    : currentDraftResult().roles;
  const validation = roles
    ? validateRoleMap(roles, {
        id: state.source === "built-in" ? state.scheme : "draft",
        mode: state.mode
      })
    : currentDraftResult();
  return { roles, validation };
}

function updateDocumentTheme(roles, validation) {
  root.dataset.mode = state.mode;
  root.dataset.gradient = state.gradient ? "true" : "false";
  body.classList.toggle("gradient", state.gradient);
  if (state.source === "built-in") {
    clearCustomProperties(root);
    root.dataset.scheme = state.scheme;
  } else {
    root.dataset.scheme = "cream";
    if (validation.ok) {
      state.lastValid[state.mode] = clone(roles);
      applyRoles(root, roles, state.mode);
    } else {
      applyRoles(root, state.lastValid[state.mode], state.mode);
    }
  }
}

function appendActionIcon(button, name) {
  const wrap = document.createElement("span");
  wrap.className = "action-icon";
  wrap.append(icon(name, 14));
  button.prepend(wrap);
}

function searchMarkup() {
  return `<div class="search-box"><div class="search-field lab-force-focus">
    <span class="scope-chip-host">
      <span class="chip search-scope-chip">
        <span class="search-scope-label">in:open</span>
        <button class="x" type="button" aria-label="Clear Open filter">×</button>
      </span>
    </span>
    <input class="search-input" aria-label="Search specimen" value="design system" />
  </div></div>`;
}

function switcherMarkup() {
  return `<div class="switcher" aria-label="Side panel navigation specimen">
    <div class="switcher-tabs" role="tablist">
      <button class="switch-tab" type="button" role="tab" aria-selected="true">Open</button>
      <button class="switch-tab" type="button" role="tab" aria-selected="false">Inbox</button>
      <button class="switch-tab" type="button" role="tab" aria-selected="false">Sessions</button>
      <button class="switch-tab" type="button" role="tab" aria-selected="false">Labels</button>
    </div>
    <button class="switch-more" type="button" aria-label="More sections">More</button>
  </div>`;
}

function stateCardsMarkup() {
  return `<div class="lab-specimen-states">
    <section class="lab-state-card">
      <h3>Buttons and statuses</h3>
      <div class="lab-button-row">
        <button class="primary" type="button">Keep tabs</button>
        <button type="button">Neutral</button>
        <button disabled type="button">Disabled</button>
        <button class="warn" type="button">Review warning</button>
        <button class="danger" type="button">Delete forever</button>
      </div>
      <div class="lab-status-row">
        <span class="status ok">Success</span>
        <span class="status warn">Warning</span>
        <span class="status danger">Danger</span>
      </div>
      <div class="empty">Empty state: everything is clear.</div>
      <div class="loading-feedback">Loading sessions…</div>
    </section>
    <section class="lab-state-card">
      <h3>Fold, palette, and tooltip</h3>
      <div class="item-head">
        <button class="item-head-toggle" type="button">
          <span class="item-title">Eight favicon fold</span>
          <span class="item-folded-mark">folded</span>
          <span class="fold-strip" data-lab-fold-strip></span>
        </button>
      </div>
      <div class="item-head">
        <button class="item-head-toggle" type="button">
          <span class="item-title">Nine tab fallback</span>
          <span class="item-folded-mark">folded</span>
          <span class="item-meta">9 tabs</span>
        </button>
      </div>
      <div class="tagmenu" data-lab-palette>
        <button class="tagopt on" type="button">Add label: research</button>
        <button class="tagopt" type="button">Create new label</button>
      </div>
      <div class="tooltip show" role="tooltip" data-lab-tooltip>
        Save every current window as a Session
      </div>
    </section>
    <section class="lab-state-card">
      <h3>Materials and reversible action</h3>
      <div class="lab-surface-samples">
        <div class="lab-solid-sample">Solid page</div>
        <div class="lab-gradient-sample">Gradient atmosphere</div>
        <div class="lab-raised-sample">Raised surface</div>
        <div class="lab-workbench-sample">Workbench row and header</div>
      </div>
      <div class="toast" role="status">
        <span>Saved 12 tabs to Inbox</span>
        <button class="mini2" type="button">Undo</button>
        <button class="mini2" type="button" aria-label="Dismiss">×</button>
      </div>
    </section>
  </div>`;
}

function specimenMarkup(surface) {
  const compact = surface === "sidepanel";
  const navigation = compact ? "" : `
    <aside class="lab-specimen-nav sidebar" aria-label="Production navigation specimen">
      <div class="lab-specimen-brand brand"><span data-lab-mark></span><span>EveryTab</span></div>
      <button class="navitem active" type="button">
        <span class="navtext">Open tabs</span><span class="n">147</span>
      </button>
      <button class="navitem" type="button"><span class="navtext">Inbox</span><span class="n">38</span></button>
      <button class="navitem" type="button"><span class="navtext">Sessions</span><span class="n">6</span></button>
      <button class="navitem" type="button"><span class="navtext">Labels</span><span class="n">18</span></button>
      <div class="lab-specimen-vault">
        <button class="vault-pill" type="button">
          <span class="dot"></span><span class="vp-text">synced 4m ago</span>
        </button>
      </div>
    </aside>`;
  const stickyShell = compact
    ? `<div class="panel-chrome">${searchMarkup()}${switcherMarkup()}</div>`
    : `<div class="hero"><div class="hero-panel">${searchMarkup()}</div></div>`;
  const sectionLead = compact
    ? `<div class="panel-section-lead">
        <h2 class="panel-heading">Open tabs</h2>
        <div class="panel-section-actions"><button type="button">Save all to session</button></div>
      </div>`
    : `<div class="lab-specimen-heading section-lead">
        <div class="section-identity"><h2>Open tabs</h2><span>147 tabs · 3 windows · updated 4m ago</span></div>
        <div class="section-actions"><button type="button">Save all to session</button></div>
      </div>`;
  const localStack = `<div class="section-local-sticky lab-specimen-local">
    <div class="lab-specimen-summary">
      <span class="status ok">Vault synced</span><span class="status warn">3 idle tabs</span>
    </div>
  </div>`;
  return `
    <div class="lab-production-shell ${compact ? "sidepanel-shell" : "app"}">
      <span class="orb o1" aria-hidden="true"></span>
      <span class="orb o2" aria-hidden="true"></span>
      ${navigation}
      <main class="lab-specimen-main ${compact ? "panel-body" : "content"}">
        ${stickyShell}
        ${sectionLead}
        ${localStack}
        <div data-lab-production-list></div>
        ${stateCardsMarkup()}
      </main>
    </div>`;
}

function buildSpecimen({
  scheme, mode, roles, width, gradient = false,
  showActions = true, showPalette = true, showTooltip = true,
  custom = false
}) {
  const specimen = document.createElement("article");
  specimen.className = `scheme-specimen scheme-role-scope${gradient ? " gradient lab-gradient" : ""}`;
  specimen.dataset.scheme = custom ? "cream" : scheme;
  specimen.dataset.mode = mode;
  specimen.dataset.labWidth = String(width);
  const surfaceContract = specimenSurfaceContract(width);
  specimen.dataset.surface = surfaceContract.surface;
  specimen.dataset.gradient = gradient ? "true" : "false";
  specimen.style.setProperty("--lab-canvas-width", `${width}px`);
  if (custom) applyRoles(specimen, roles, mode);
  specimen.innerHTML = specimenMarkup(surfaceContract.surface);
  const productionList = createProductionListSpecimen({
    width,
    instanceId: `${scheme}-${mode}-${width}-${buildSpecimen.instanceId++}`
  });
  specimen.querySelector("[data-lab-production-list]").replaceWith(productionList);
  const anatomy = inspectProductionListSpecimen(productionList, surfaceContract);
  if (!anatomy.ok || anatomy.surface !== surfaceContract.surface) {
    throw new Error(`Production specimen anatomy drifted: ${JSON.stringify(anatomy)}`);
  }
  specimen.querySelector("[data-lab-mark]")?.append(icon("mark", 24));
  for (const button of specimen.querySelectorAll("[data-lab-icon]")) {
    appendActionIcon(button, button.dataset.labIcon);
  }
  for (let index = 0; index < 8; index++) {
    specimen.querySelector("[data-lab-fold-strip]").append(
      Object.assign(document.createElement("span"), { className: "fv-placeholder" })
    );
  }
  specimen.classList.toggle("lab-hide-actions", !showActions);
  specimen.querySelector("[data-lab-palette]").hidden = !showPalette;
  specimen.querySelector("[data-lab-tooltip]").hidden = !showTooltip;
  specimen.querySelectorAll("a[href='#']").forEach((link) =>
    link.addEventListener("click", (event) => event.preventDefault()));
  specimen.dataset.labShellContract = "pending-mount";
  return specimen;
}
buildSpecimen.instanceId = 0;

function activateHostContext(surface) {
  body.dataset.surface = surface;
  body.dataset.workbench = "true";
}

function verifyMountedSpecimen(specimen, surfaceContract, gradient) {
  const shell = inspectProductionShellSpecimen(
    specimen,
    { ...surfaceContract, gradient }
  );
  specimen.dataset.labShellContract = shell.ok ? "pass" : "fail";
  if (!shell.ok) {
    throw new Error(`Production sticky shell contract drifted: ${JSON.stringify(shell)}`);
  }
  return shell;
}

function renderErrors(validation) {
  const host = byId("lab-errors");
  host.replaceChildren();
  if (validation.ok) {
    host.append(Object.assign(document.createElement("p"), {
      className: "lab-pass-copy",
      textContent: `All ${validation.checks.length} production pairings pass. Manual visual review is still required.`
    }));
    return;
  }
  const list = document.createElement("ul");
  list.className = "lab-errors-list";
  for (const { message } of validation.errors) {
    list.append(Object.assign(document.createElement("li"), { textContent: message }));
  }
  host.append(list);
}

function renderRoles(roles) {
  const host = byId("lab-roles");
  host.replaceChildren();
  if (!roles) return;
  for (const definition of ROLE_DEFINITIONS) {
    const value = roles[definition.key] ?? "invalid";
    const item = document.createElement("div");
    item.className = "lab-role";
    const swatch = document.createElement("span");
    swatch.className = "lab-swatch";
    if (/^#[0-9a-f]{6}$/i.test(value)) swatch.style.background = value;
    const copy = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = definition.label;
    const code = document.createElement("code");
    code.textContent = `${definition.css}: ${value}`;
    copy.append(label, code);
    item.append(swatch, copy);
    host.append(item);
  }
  const gradient = document.createElement("div");
  gradient.className = "lab-role";
  const gradientSwatch = document.createElement("span");
  gradientSwatch.className = "lab-swatch";
  if (Array.isArray(roles.gradientStops)) {
    const stops = roles.gradientStops.map((color, index) => {
      const position = roles.gradientStopPositions?.[index];
      return `${color}${position == null ? "" : ` ${position}%`}`;
    });
    gradientSwatch.style.background =
      `linear-gradient(${roles.gradientAngle}deg, ${stops.join(", ")})`;
  }
  const gradientCopy = document.createElement("span");
  gradientCopy.append(
    Object.assign(document.createElement("strong"), { textContent: "Gradient stops" }),
    Object.assign(document.createElement("code"), {
      textContent: Array.isArray(roles.gradientStops)
        ? `${roles.gradientAngle}° · ${roles.gradientStops.map((color, index) => {
            const position = roles.gradientStopPositions?.[index];
            return `${color}${position == null ? "" : ` ${position}%`}`;
          }).join(" · ")}`
        : "invalid"
    })
  );
  gradient.append(gradientSwatch, gradientCopy);
  host.append(gradient);
}

function renderContrast(validation) {
  const host = byId("lab-contrast");
  host.replaceChildren();
  for (const check of validation.checks ?? []) {
    const row = document.createElement("tr");
    const outcome = document.createElement("span");
    outcome.className = `lab-check-result ${check.pass ? "pass" : "fail"}`;
    outcome.textContent = check.pass ? "Pass" : "Fail";
    const colors = document.createElement("span");
    colors.className = "lab-pair-swatches";
    for (const color of [check.foreground, check.background]) {
      const swatch = document.createElement("span");
      swatch.style.background = color;
      swatch.title = color;
      colors.append(swatch);
    }
    for (const value of [
      outcome,
      check.label,
      `${check.ratio.toFixed(2)}:1`,
      `${check.threshold}:1`,
      colors
    ]) {
      const cell = document.createElement("td");
      cell.append(value instanceof Node ? value : document.createTextNode(value));
      row.append(cell);
    }
    host.append(row);
  }
}

function colorField(key, label, value, onInput) {
  const row = document.createElement("label");
  row.className = "lab-color-row";
  row.append(Object.assign(document.createElement("span"), { textContent: label }));
  const picker = Object.assign(document.createElement("input"), {
    type: "color",
    value: /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"
  });
  const text = Object.assign(document.createElement("input"), {
    type: "text",
    value,
    maxLength: 7,
    spellcheck: false
  });
  picker.setAttribute("aria-label", `${label} colour picker`);
  text.setAttribute("aria-label", `${label} hex colour`);
  picker.addEventListener("input", () => {
    text.value = picker.value;
    onInput(picker.value);
  });
  text.addEventListener("input", () => {
    if (/^#[0-9a-f]{6}$/i.test(text.value)) picker.value = text.value;
    onInput(text.value);
  });
  row.append(picker, text);
  return row;
}

function renderEditorFields() {
  const simpleHost = byId("lab-simple-fields");
  const advancedHost = byId("lab-advanced-fields");
  simpleHost.hidden = state.authoringMode !== "simple";
  advancedHost.hidden = state.authoringMode !== "advanced";
  simpleHost.replaceChildren();
  advancedHost.replaceChildren();
  if (state.authoringMode === "simple") {
    for (const key of SIMPLE_COLOR_KEYS) {
      simpleHost.append(colorField(
        key,
        SIMPLE_COLOR_LABELS[key],
        state.draft.simple[state.mode][key],
        (value) => {
          state.draft.simple[state.mode][key] = value;
          updateOutput();
        }
      ));
    }
  } else {
    for (const { key, label } of ROLE_DEFINITIONS) {
      advancedHost.append(colorField(
        key,
        label,
        state.draft.roles[state.mode][key],
        (value) => {
          state.draft.roles[state.mode][key] = value;
          updateOutput();
        }
      ));
    }
    state.draft.roles[state.mode].gradientStops.forEach((value, index) => {
      advancedHost.append(colorField(
        `gradient-${index}`,
        `Gradient stop ${index + 1}`,
        value,
        (next) => {
          state.draft.roles[state.mode].gradientStops[index] = next;
          updateOutput();
        }
      ));
    });
  }
}

function updateOutput() {
  const { roles, validation } = currentResult();
  updateDocumentTheme(roles, validation);
  const surfaceContract = specimenSurfaceContract(state.width);
  activateHostContext(surfaceContract.surface);
  const specimen = buildSpecimen({
    scheme: state.scheme,
    mode: state.mode,
    roles: validation.ok ? roles : state.lastValid[state.mode],
    width: state.width,
    gradient: state.gradient,
    showActions: state.showActions,
    showPalette: state.showPalette,
    showTooltip: state.showTooltip,
    custom: state.source === "draft"
  });
  byId("lab-specimen-host").replaceChildren(specimen);
  verifyMountedSpecimen(specimen, surfaceContract, state.gradient);
  const sourceLabel = state.source === "built-in"
    ? SCHEME_META[state.scheme].label
    : state.draft.name;
  const gradientLabel = state.gradient ? "gradient on" : "solid";
  byId("lab-specimen-label").textContent =
    `${sourceLabel} · ${state.mode === "light" ? "Light" : "Dark"} · ` +
    `${state.width}px · ${gradientLabel}`;
  const badge = byId("lab-validation-badge");
  badge.className = `lab-result-badge ${validation.ok ? "pass" : "fail"}`;
  const failedPairings = validation.checks.filter(({ pass }) => !pass).length;
  badge.textContent = validation.ok
    ? `${validation.checks.length} production pairings pass`
    : `${failedPairings} of ${validation.checks.length} production pairings fail`;
  renderErrors(validation);
  renderRoles(roles);
  renderContrast(validation);
  byId("lab-editor").hidden = state.source !== "draft";
}

function copyBuiltInToDraft() {
  state.draft.simple = Object.fromEntries(MODES.map((mode) => [
    mode, sourceFromRoles(parsed.maps[state.scheme][mode])
  ]));
  state.draft.roles = Object.fromEntries(MODES.map((mode) => {
    if (state.authoringMode === "simple") {
      return [mode, compileSimpleMode(state.draft.simple[mode], { mode }).roles];
    }
    return [mode, clone(parsed.maps[state.scheme][mode])];
  }));
  for (const mode of MODES) {
    const validation = validateRoleMap(state.draft.roles[mode], { id: "draft", mode });
    if (validation.ok) state.lastValid[mode] = clone(state.draft.roles[mode]);
  }
  state.draft.name = `${SCHEME_META[state.scheme].label} study`;
  controls.name.value = state.draft.name;
  renderEditorFields();
  updateOutput();
}

function loadDraft() {
  const parsedDraft = parseDraftFixture(byId("lab-draft-json").value);
  if (!parsedDraft.ok) {
    const host = byId("lab-errors");
    const list = document.createElement("ul");
    list.className = "lab-errors-list";
    for (const error of parsedDraft.errors) {
      list.append(Object.assign(document.createElement("li"), { textContent: error.message }));
    }
    host.replaceChildren(list);
    return;
  }
  const draft = parsedDraft.value;
  state.source = "draft";
  state.authoringMode = draft.authoringMode;
  state.draft = {
    name: draft.name,
    defaultMode: draft.defaultMode,
    simple: clone(draft.simple),
    roles: clone(draft.roles)
  };
  state.lastValid = clone(draft.roles);
  controls.source.value = "draft";
  controls.name.value = draft.name;
  document.querySelector(`input[name="lab-authoring"][value="${state.authoringMode}"]`).checked = true;
  renderEditorFields();
  updateOutput();
}

function exportDraft() {
  state.draft.name = controls.name.value;
  const fixture = createDraftFixture({
    name: state.draft.name,
    defaultMode: state.draft.defaultMode,
    authoringMode: state.authoringMode,
    simple: state.draft.simple,
    roles: state.draft.roles
  });
  const serialized = fixture.ok ? serializeDraftFixture(fixture.value) : fixture;
  if (!serialized.ok) {
    const list = document.createElement("ul");
    list.className = "lab-errors-list";
    for (const error of serialized.errors) {
      list.append(Object.assign(document.createElement("li"), { textContent: error.message }));
    }
    byId("lab-errors").replaceChildren(list);
    return;
  }
  byId("lab-draft-json").value = serialized.text;
  byId("lab-draft-json").focus();
  byId("lab-draft-json").select();
}

controls.source.addEventListener("change", () => {
  state.source = controls.source.value;
  updateOutput();
});
controls.scheme.addEventListener("change", () => {
  state.scheme = controls.scheme.value;
  updateOutput();
});
controls.mode.addEventListener("change", () => {
  state.mode = controls.mode.value;
  renderEditorFields();
  updateOutput();
});
controls.width.addEventListener("change", () => {
  state.width = Number(controls.width.value);
  updateOutput();
});
controls.gradient.addEventListener("change", () => {
  state.gradient = controls.gradient.checked;
  updateOutput();
});
for (const [control, key] of [
  [controls.actions, "showActions"],
  [controls.palette, "showPalette"],
  [controls.tooltip, "showTooltip"]
]) {
  control.addEventListener("change", () => {
    state[key] = control.checked;
    updateOutput();
  });
}
controls.name.addEventListener("input", () => {
  state.draft.name = controls.name.value;
  updateOutput();
});
document.querySelectorAll('input[name="lab-authoring"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    state.authoringMode = radio.value;
    if (state.authoringMode === "simple") {
      for (const mode of MODES) {
        const compiled = compileSimpleMode(state.draft.simple[mode], { mode });
        if (compiled.roles) state.draft.roles[mode] = compiled.roles;
      }
    }
    renderEditorFields();
    updateOutput();
  });
});
byId("lab-seed").addEventListener("click", copyBuiltInToDraft);
byId("lab-load").addEventListener("click", loadDraft);
byId("lab-export").addEventListener("click", exportDraft);

function contactSamples(kind) {
  if (kind === "pressure") {
    return [
      ["cream", "light"],
      ["ink", "dark"],
      ["phosphor", "dark"],
      ["meadow", "light"]
    ];
  }
  return SCHEMES.flatMap((scheme) => MODES.map((mode) => [scheme, mode]));
}

function renderContactSheet(kind, requestedPage = 1) {
  const width = kind === "wide" ? 1280 : kind === "narrow" ? 400 : 320;
  const surfaceContract = specimenSurfaceContract(width);
  const samples = contactSamples(kind);
  const pageSize = kind === "pressure" ? 4 : 5;
  const pageCount = Math.ceil(samples.length / pageSize);
  const page = Math.max(1, Math.min(pageCount, requestedPage));
  const pageSamples = samples.slice((page - 1) * pageSize, page * pageSize);
  body.classList.add("lab-contact", "gradient");
  activateHostContext(surfaceContract.surface);
  const sheet = byId("lab-contact-sheet");
  sheet.hidden = false;
  sheet.dataset.contactKind = kind;
  sheet.dataset.contactPage = String(page);
  sheet.dataset.contactPages = String(pageCount);
  for (const [scheme, mode] of pageSamples) {
    const roles = parsed.maps[scheme][mode];
    const validation = validateRoleMap(roles, { id: scheme, mode });
    const entry = document.createElement("section");
    entry.className = "lab-contact-entry";
    const label = document.createElement("header");
    label.className = "lab-contact-label";
    label.append(
      Object.assign(document.createElement("span"), {
        textContent: `${SCHEME_META[scheme].label} · ` +
          `${mode === "light" ? "Light" : "Dark"}` +
          `${SCHEME_META[scheme].defaultMode === mode ? " · Scheme default" : ""}`
      }),
      Object.assign(document.createElement("span"), {
        textContent: `${validation.checks.filter(({ pass }) => !pass).length} of ` +
          `${validation.checks.length} production pairings fail`
      })
    );
    const specimen = buildSpecimen({
      scheme, mode, roles, width, gradient: true,
      showActions: true, showPalette: true, showTooltip: true
    });
    entry.append(label, specimen);
    sheet.append(entry);
    verifyMountedSpecimen(specimen, surfaceContract, true);
  }
  document.title = `EveryTab Scheme QA ${kind} ${page} of ${pageCount}`;
}

const contactParams = new URLSearchParams(location.search);
const contact = contactParams.get("contact");
if (["wide", "narrow", "pressure"].includes(contact)) {
  renderContactSheet(contact, Number(contactParams.get("page")) || 1);
} else {
  renderEditorFields();
  updateOutput();
}
