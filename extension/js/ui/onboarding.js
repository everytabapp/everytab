/** Six-step first run and the separate permanent Help library. */
import { el } from "./dom.js";
import { icon } from "./icons.js";
import { getSettings, patchSettings } from "../lib/store.js";
import { dashboardHref } from "../lib/newtab-focus.js";
import { SCHEME_ACCENTS, SCHEME_GROUPS, SCHEME_LABELS } from "../lib/schemes.js";
import { pickVaultFolder, getVaultStatus } from "../vault/vault.js";
import {
  HELP_GROUPS, HELP_TOPICS, ONBOARDING_PAGES, helpTopicId, onboardingStatic, onboardingStepId
} from "../lib/onboarding-copy.js";
import { createAutomationThresholdControls } from "./automation-threshold-controls.js";
import {
  settingsDurationLabel, settingsGroupTitle, settingsRowCopy, settingsSchemeGroupLabel
} from "./settings-copy.js";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

let tourOverlay = null;
let helpOverlay = null;

export async function maybeShowOnboarding() {
  const { onboardingDone } = await chrome.storage.local.get("onboardingDone");
  if (!onboardingDone) await showOnboarding();
}

/** Reset first-run progress and open the introduction in the current surface. */
export async function replayOnboarding() {
  await chrome.storage.local.remove(["onboardingDone", "onboardingPage"]);
  await showOnboarding();
}

function focusableItems(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((node) =>
    !node.hidden && node.getAttribute("aria-hidden") !== "true" && node.getClientRects().length > 0);
}

function trapTab(event, root) {
  if (event.key !== "Tab") return;
  const items = focusableItems(root);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** @param {object} page */
function renderPageBody(page) {
  const body = el("div", { class: "ob-body" });
  const title = el("h2", { tabindex: "-1" }, page.title);
  body.append(title);
  if (page.essence) body.append(el("p", { class: "ob-essence" }, page.essence));
  for (const paragraph of page.why ?? []) body.append(el("p", {}, paragraph));
  if (page.terms?.length) {
    body.append(el("dl", { class: "ob-terms" }, ...page.terms.flatMap(([term, description]) => [
      el("dt", {}, term), el("dd", {}, description)
    ])));
  }
  if (page.steps?.length) {
    body.append(el("ol", { class: "ob-steps" },
      ...page.steps.map((item) => el("li", {}, item))));
  }
  if (page.how?.length) {
    body.append(el("ul", { class: "ob-how" }, ...page.how.map((item) => el("li", {}, item))));
  }
  if (page.example) {
    body.append(el("p", { class: "ob-example" },
      el("b", {}, `${onboardingStatic.example()} `), page.example));
  }
  if (page.special === "newtab") body.append(newTabChoices());
  if (page.special === "automation") body.append(automationPanel());
  if (page.special === "scheme") body.append(schemeChoices());
  if (page.special === "vault") body.append(vaultActions());
  if (page.note) body.append(el("p", { class: "ob-note ob-note-block" }, page.note));
  if (page.settingsGroups?.length) body.append(helpSettingsLinks(page.settingsGroups));
  if (page.settingsClosure) body.append(settingsClosure());
  return { body, title };
}

function newTabChoices() {
  const modes = [
    ["dashboard", onboardingStatic.newTabDashboard(), onboardingStatic.newTabDashboardDesc()],
    ["minimal", onboardingStatic.newTabMinimal(), onboardingStatic.newTabMinimalDesc()],
    ["blank", onboardingStatic.newTabBlank(), onboardingStatic.newTabBlankDesc()]
  ];
  const cards = modes.map(([mode, name, description]) => el("button", {
    type: "button", class: "ob-choice", "aria-pressed": "false",
    onclick: async () => {
      await patchSettings({ newTabMode: mode });
      for (const card of cards) {
        const selected = card.dataset.mode === mode;
        card.classList.toggle("on", selected);
        card.setAttribute("aria-pressed", String(selected));
      }
    }, "data-mode": mode
  }, el("b", {}, name), el("span", {}, description)));
  void getSettings().then((settings) => {
    const current = modes.some(([mode]) => mode === settings.newTabMode) ? settings.newTabMode : "dashboard";
    for (const card of cards) {
      const selected = card.dataset.mode === current;
      card.classList.toggle("on", selected);
      card.setAttribute("aria-pressed", String(selected));
    }
  });
  return el("div", { class: "ob-choices", role: "group", "aria-label": onboardingStatic.newTabAria() }, ...cards);
}

function schemeChoices() {
  const buttons = [];
  const select = (scheme) => {
    for (const button of buttons) {
      const selected = button.dataset.scheme === scheme;
      button.classList.toggle("on", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
  };
  const groups = SCHEME_GROUPS.map((group) => el("section", {
    class: "ob-scheme-group", "aria-label": settingsSchemeGroupLabel(group.defaultMode, group.tone)
  },
  el("h3", {}, settingsSchemeGroupLabel(group.defaultMode, group.tone)),
  el("div", { class: "ob-scheme-options" }, ...group.ids.map((scheme) => {
    const label = SCHEME_LABELS[scheme] ?? scheme;
    const button = el("button", {
      type: "button", class: "ob-scheme-choice", "aria-pressed": "false",
      "aria-label": label, "data-scheme": scheme,
      onclick: async () => {
        select(scheme);
        try {
          await patchSettings({ uiScheme: scheme });
        } catch {
          select((await getSettings()).uiScheme);
        }
      }
    },
    el("span", { class: "ob-scheme-swatch", style: `--swatch:${SCHEME_ACCENTS[scheme]}` }),
    el("span", { class: "ob-scheme-name", title: label }, label));
    buttons.push(button);
    return button;
  }))));
  void getSettings().then((settings) => select(settings.uiScheme));
  return el("div", {
    class: "ob-scheme-choices", role: "group", "aria-label": onboardingStatic.schemeAria()
  }, ...groups);
}

function automationPanel() {
  const summaryValue = el("span", { class: "ob-tune-value" }, onboardingStatic.tuneAutomationHint());
  const summary = el("summary", {},
    el("span", { class: "ob-tune-title" }, onboardingStatic.tuneAutomation()), summaryValue);
  const rows = el("div", { class: "ob-thresholds" });
  const saved = el("div", { class: "ob-tune-saved", role: "status", "aria-live": "polite" });
  const details = el("details", { class: "ob-tune" }, summary, rows, saved);
  const more = el("button", {
    type: "button", class: "ob-more-settings",
    onclick: () => {
      details.open = true;
      more.remove();
      summary.focus({ preventScroll: true });
    }
  }, onboardingStatic.moreAutomation());

  void getSettings().then((initial) => {
    let settings = initial;
    let controls;
    let savedTimer = 0;
    const renderSummary = () => {
      const autoSave = settingsDurationLabel(settings.autoArchiveEnabled ? settings.autoDumpAfterMinutes : 0, "auto");
      const suspend = settingsDurationLabel(settings.suspendEnabled ? settings.suspendAfterMinutes : 0);
      const snapshots = settingsDurationLabel(settings.snapshotEveryMinutes);
      const keep = Number(settings.snapshotKeep) > 0
        ? onboardingStatic.keepSnapshots(settings.snapshotKeep)
        : onboardingStatic.keepAllSnapshots();
      summaryValue.textContent = onboardingStatic.automationSummary(autoSave, suspend, snapshots, keep);
    };
    const update = async (patch) => {
      settings = { ...settings, ...patch };
      await patchSettings(patch);
      settings = await getSettings();
      controls.sync();
      renderSummary();
      saved.textContent = onboardingStatic.settingsSaved();
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => { saved.textContent = ""; }, 1500);
    };
    controls = createAutomationThresholdControls({ readSettings: () => settings, update });
    const thresholdRow = (id, control) => {
      const copy = settingsRowCopy(id);
      return el("div", { class: "ob-threshold-row" },
        el("span", { class: "ob-threshold-copy" },
          el("span", { class: "ob-threshold-title" }, copy.title),
          el("span", { class: "ob-threshold-description" }, copy.description)),
        control);
    };
    rows.replaceChildren(
      thresholdRow("autoSaveAfter", controls.autoSaveAfter),
      thresholdRow("maxTabsOpen", controls.maxTabsOpen),
      thresholdRow("inboxExpiry", controls.inboxExpiry),
      thresholdRow("suspendAfter", controls.suspendAfter),
      thresholdRow("suspendMinTabs", controls.suspendMinTabs),
      thresholdRow("suspendMaxTabs", controls.suspendMaxTabs),
      thresholdRow("snapshotEvery", controls.snapshotEvery),
      thresholdRow("snapshotsKeep", controls.snapshotsKeep)
    );
    renderSummary();
  });
  return el("div", { class: "ob-automation" }, details, more);
}

function helpSettingsLinks(groupIds) {
  return el("aside", { class: "ob-help-settings", "aria-label": onboardingStatic.helpRelatedSettings() },
    el("span", { class: "ob-help-settings-label" }, onboardingStatic.helpRelatedSettings()),
    el("div", { class: "ob-help-actions" }, ...groupIds.map((groupId) => el("a", {
      class: "ob-help-link", href: dashboardHref(`settings:${groupId}`), target: "_blank", rel: "noopener"
    }, onboardingStatic.helpSettingsLink(settingsGroupTitle(groupId))))));
}

function settingsClosure() {
  return el("aside", { class: "ob-final-settings" },
    el("p", {}, onboardingStatic.finalSettingsCopy()),
    el("a", {
      class: "ob-more-settings", href: dashboardHref("settings"), target: "_blank", rel: "noopener"
    }, onboardingStatic.openSettings()));
}

function vaultActions() {
  const status = el("span", { class: "ob-vault-status", role: "status", "aria-live": "polite" });
  const connect = el("button", { type: "button", class: "ob-vault-action" }, onboardingStatic.vaultConnect());
  const later = el("button", {
    type: "button", class: "ob-vault-action",
    onclick: () => { status.textContent = onboardingStatic.vaultLocal(); }
  }, onboardingStatic.vaultLater());
  connect.addEventListener("click", async () => {
    connect.disabled = true;
    try {
      const next = await pickVaultFolder();
      status.textContent = next.state === "connected"
        ? onboardingStatic.vaultConnected(next.name)
        : onboardingStatic.vaultUnavailable();
    } finally {
      connect.disabled = false;
    }
  });
  void getVaultStatus().then((current) => {
    if (current.state === "connected") status.textContent = onboardingStatic.vaultConnected(current.name);
  });
  return el("div", { class: "ob-vault-setup" },
    el("div", { class: "ob-vault-actions" }, connect, later), status);
}

/** Open the complete Help library at one topic. */
export function openHelp(requestedId = "open") {
  if (helpOverlay) return;
  const previousFocus = document.activeElement;
  let activeId = helpTopicId(requestedId);
  const nav = el("nav", { class: "ob-help-nav", "aria-label": onboardingStatic.helpTopics() });
  const topicById = new Map(HELP_TOPICS.map((topic) => [topic.id, topic]));
  const select = el("select", { class: "ob-help-select", "aria-label": onboardingStatic.helpChooseTopic() },
    ...HELP_GROUPS.map((group) => el("optgroup", { label: group.title },
      ...group.topicIds.map((id) => topicById.get(id)).filter(Boolean)
        .map((topic) => el("option", { value: topic.id }, topic.title)))));
  const bodyHost = el("div", { class: "ob-help-body" });
  const buttons = new Map();

  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    helpOverlay?.remove();
    helpOverlay = null;
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
  };
  const renderTopic = (id, { focusTitle = false } = {}) => {
    activeId = helpTopicId(id);
    const topic = HELP_TOPICS.find((entry) => entry.id === activeId) ?? HELP_TOPICS[0];
    const rendered = renderPageBody(topic);
    bodyHost.replaceChildren(rendered.body);
    bodyHost.scrollTop = 0;
    select.value = activeId;
    for (const [topicId, button] of buttons) {
      const selected = topicId === activeId;
      button.classList.toggle("on", selected);
      button.setAttribute("aria-current", selected ? "page" : "false");
    }
    if (focusTitle) rendered.title.focus();
    return rendered.title;
  };
  for (const group of HELP_GROUPS) {
    nav.append(el("div", { class: "ob-help-group" }, group.title));
    for (const id of group.topicIds) {
      const topic = topicById.get(id);
      if (!topic) continue;
      const button = el("button", {
        type: "button", class: "ob-help-topic",
        onclick: () => renderTopic(topic.id)
      }, topic.title);
      buttons.set(topic.id, button);
      nav.append(button);
    }
  }
  select.addEventListener("change", () => renderTopic(select.value, { focusTitle: true }));
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    trapTab(event, helpOverlay);
  };
  const card = el("div", {
    class: "ob-card ob-help", role: "dialog", "aria-modal": "true",
    "aria-label": onboardingStatic.helpTitle()
  },
  el("div", { class: "ob-head" },
    el("span", { class: "ob-brand" }, icon("mark", 18), onboardingStatic.helpBrand()),
    el("button", { class: "mini2", type: "button", onclick: close }, onboardingStatic.helpClose())),
  el("div", { class: "ob-help-layout" },
    el("div", { class: "ob-help-navigation" }, select, nav), bodyHost));
  helpOverlay = el("div", {
    class: "ob-overlay", onclick: (event) => { if (event.target === helpOverlay) close(); }
  }, card);
  document.body.append(helpOverlay);
  document.addEventListener("keydown", onKey, true);
  renderTopic(activeId, { focusTitle: true });
}

/** Back-compatible section entry point. */
export function openOnboardingPage(id) {
  openHelp(id);
}

export async function showOnboarding() {
  if (tourOverlay) return;
  const previousFocus = document.activeElement;
  const { onboardingPage } = await chrome.storage.local.get("onboardingPage");
  let step = Math.max(0, ONBOARDING_PAGES.findIndex((page) => page.id === onboardingStepId(onboardingPage)));
  const last = ONBOARDING_PAGES.length - 1;
  const bodyHost = el("div", { class: "ob-body-host" });
  const progressCopy = el("span", { class: "ob-progress-copy" });
  const progress = el("div", { class: "ob-progress", role: "group", "aria-label": onboardingStatic.progressAria() });
  progress.style.setProperty("--ob-steps", ONBOARDING_PAGES.length);

  const finish = () => {
    document.removeEventListener("keydown", onKey, true);
    void chrome.storage.local.set({ onboardingDone: true });
    void chrome.storage.local.remove("onboardingPage");
    tourOverlay?.remove();
    tourOverlay = null;
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
  };
  const back = el("button", { class: "mini2", type: "button", onclick: () => goStep(step - 1) },
    onboardingStatic.back());
  const next = el("button", { class: "primary", type: "button",
    onclick: () => (step === last ? finish() : goStep(step + 1)) });
  const skip = el("button", { class: "mini2", type: "button", onclick: finish }, onboardingStatic.skip());
  const fullHelp = el("button", {
    class: "mini2", type: "button",
    onclick: () => { finish(); openHelp("open"); }
  }, onboardingStatic.openHelp());

  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      finish();
      return;
    }
    const ownsArrow = event.target instanceof Element &&
      event.target.closest("input,select,textarea,button,a,summary");
    if (!ownsArrow && event.key === "ArrowRight" && step < last) {
      event.preventDefault();
      goStep(step + 1);
      return;
    }
    if (!ownsArrow && event.key === "ArrowLeft" && step > 0) {
      event.preventDefault();
      goStep(step - 1);
      return;
    }
    trapTab(event, tourOverlay);
  };

  function goStep(index) {
    step = Math.max(0, Math.min(last, index));
    const page = ONBOARDING_PAGES[step];
    void chrome.storage.local.set({ onboardingPage: page.id });
    const rendered = renderPageBody(page);
    bodyHost.replaceChildren(rendered.body);
    bodyHost.scrollTop = 0;
    progressCopy.textContent = onboardingStatic.progress(step + 1, ONBOARDING_PAGES.length);
    progress.replaceChildren(...ONBOARDING_PAGES.map((entry, indexInList) => el("button", {
      type: "button", class: `ob-progress-step${indexInList === step ? " on" : ""}`,
      "aria-label": onboardingStatic.pageAria(indexInList + 1, ONBOARDING_PAGES.length, entry.title),
      "aria-current": indexInList === step ? "step" : "false",
      onclick: () => goStep(indexInList)
    })));
    back.hidden = step === 0;
    fullHelp.hidden = step !== last;
    next.textContent = step === last ? onboardingStatic.done() : onboardingStatic.next();
    rendered.title.focus();
  }

  const card = el("div", {
    class: "ob-card tour", role: "dialog", "aria-modal": "true",
    "aria-label": onboardingStatic.welcome()
  },
  el("div", { class: "ob-head" },
    el("span", { class: "ob-brand" }, icon("mark", 18), onboardingStatic.welcome()), skip),
  el("div", { class: "ob-progress-line" }, progressCopy, progress),
  bodyHost,
  el("div", { class: "ob-foot" }, back, el("span", { class: "ob-foot-spacer" }), fullHelp, next));
  tourOverlay = el("div", { class: "ob-overlay" }, card);
  document.body.append(tourOverlay);
  document.addEventListener("keydown", onKey, true);
  goStep(step);
}
