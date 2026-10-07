// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "../lib/failure-diagnostic.js";
/** Six-step first run and the separate permanent Help library. */
import { el } from "./dom.js";
import { icon } from "./icons.js";
import { getSettings, patchSettings } from "../lib/store.js";
import { dashboardHref } from "../lib/newtab-focus.js";
import { msg } from "../lib/i18n.js";
import { createNewTabChoices } from "./new-tab-choices.js";
import { createOnboardingAutomation, createOnboardingAppearance } from "./onboarding-choices.js";
import { pickVaultFolder, getVaultStatus } from "../vault/vault.js";
import {
  HELP_GROUPS, HELP_TOPICS, ONBOARDING_FEATURES, ONBOARDING_PAGES,
  helpTopicId, onboardingStatic, onboardingStepId
} from "../lib/onboarding-copy.js";
import { settingsGroupTitle } from "./settings-copy.js";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

let tourOverlay = null;
let helpOverlay = null;
let tourOpening = null;

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
function renderPageBody(page, choices) {
  const body = el("div", { class: "ob-body", "data-onboarding-page": page.id });
  const title = el("h2", { tabindex: "-1" }, page.title);
  body.append(title);
  if (page.essence) body.append(el("p", { class: "ob-essence" }, page.essence));
  if (page.special === "vault") body.append(el("div", { class: "ob-vault-mark" }, icon("folder", 34),
    el("div", {}, el("strong", {}, msg("onboarding_vault_name")),
      el("span", {}, msg("onboarding_vault_caption")))));
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
  if (page.benefits) body.append(el("ul", { class: "ob-benefits" },
    ...page.benefits.map(([name, copy]) => el("li", {}, icon(name, 22), copy))));
  if (page.definitions) body.append(el("div", { class: "ob-definitions" },
    ...page.definitions.map(([name, heading, copy]) => el("section", {},
      icon(name, 26), el("div", {}, el("h3", {}, heading), el("p", {}, copy))))));
  if (page.special === "newtab") body.append(createNewTabChoices(choices));
  if (page.special === "automation") body.append(createOnboardingAutomation(choices));
  if (page.special === "scheme") body.append(createOnboardingAppearance(choices));
  if (page.special === "vault") body.append(vaultActions());
  if (page.note) body.append(el("p", { class: "ob-note ob-note-block" }, page.note));
  if (page.settingsGroups?.length) body.append(helpSettingsLinks(page.settingsGroups));
  return { body, title };
}

function helpSettingsLinks(groupIds) {
  return el("aside", { class: "ob-help-settings", "aria-label": onboardingStatic.helpRelatedSettings() },
    el("span", { class: "ob-help-settings-label" }, onboardingStatic.helpRelatedSettings()),
    el("div", { class: "ob-help-actions" }, ...groupIds.map((groupId) => el("a", {
      class: "ob-help-link", href: dashboardHref(`settings:${groupId}`), target: "_blank", rel: "noopener"
    }, onboardingStatic.helpSettingsLink(settingsGroupTitle(groupId))))));
}

function vaultActions() {
  const status = el("span", { class: "ob-vault-status", role: "status", "aria-live": "polite" });
  const connect = el("button", { type: "button", class: "primary" }, onboardingStatic.vaultConnect());
  let chosen = false;
  connect.addEventListener("click", async () => {
    chosen = true;
    connect.disabled = true;
    status.textContent = msg("onboarding_vault_connecting");
    try {
      const next = await pickVaultFolder();
      status.textContent = next.state === "connected"
        ? onboardingStatic.vaultConnected(next.name)
        : next.state === "cancelled"
          ? msg("onboarding_vault_cancelled") : msg("vault_folder_selection_guidance");
    } catch (error) {
      status.textContent = onboardingStatic.vaultUnavailable();
      reportFailure("onboarding Vault connection", error);
    } finally {
      connect.disabled = false;
    }
  });
  void getVaultStatus().then((current) => {
    if (!chosen && current.state === "connected") {
      status.textContent = onboardingStatic.vaultConnected(current.name);
    }
  }).catch((error) => {
    if (!chosen) status.textContent = onboardingStatic.vaultUnavailable();
    reportFailure("onboarding Vault status", error);
  });
  return el("div", { class: "ob-vault-setup" },
    el("div", { class: "ob-vault-actions" }, connect), status);
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

export function showOnboarding() {
  if (tourOverlay) return Promise.resolve();
  if (!tourOpening) tourOpening = mountOnboarding().finally(() => { tourOpening = null; });
  return tourOpening;
}

async function mountOnboarding() {
  if (tourOverlay) return;
  const previousFocus = document.activeElement;
  const { onboardingPage } = await chrome.storage.local.get("onboardingPage");
  let step = Math.max(0, ONBOARDING_PAGES.findIndex((page) => page.id === onboardingStepId(onboardingPage)));
  const last = ONBOARDING_PAGES.length - 1;
  let settings = await getSettings();
  let syncCurrent = [];
  let pendingSave = Promise.resolve();
  const failedChoices = new Set();
  const saveStatus = el("p", { class: "ob-save-status", role: "status", "aria-live": "polite" });
  const choices = {
    readSettings: () => settings,
    registerSync: (sync) => syncCurrent.push(sync),
    update: (patch) => {
      // Preserve click order and patch only the chosen fields. A rejected save
      // is handled here so every first-run control can recover and try again.
      pendingSave = pendingSave.then(async () => {
        try {
          await patchSettings(patch);
          settings = await getSettings();
          for (const key of Object.keys(patch)) failedChoices.delete(key);
          saveStatus.textContent = failedChoices.size
            ? msg("onboarding_choice_failed") : onboardingStatic.settingsSaved();
          saveStatus.classList.toggle("bad", failedChoices.size > 0);
          return true;
        } catch (error) {
          for (const key of Object.keys(patch)) failedChoices.add(key);
          saveStatus.textContent = msg("onboarding_choice_failed");
          saveStatus.classList.add("bad");
          reportFailure("onboarding choice save", error);
          return false;
        } finally {
          for (const sync of syncCurrent) sync();
        }
      });
      return pendingSave;
    }
  };
  const bodyHost = el("div", { class: "ob-body-host" });
  const progressCopy = el("span", { class: "ob-progress-copy" });
  const progress = el("div", { class: "ob-progress", role: "group", "aria-label": onboardingStatic.progressAria() });
  progress.style.setProperty("--ob-steps", ONBOARDING_PAGES.length);

  let finishing = false;
  const finish = async () => {
    if (finishing) return;
    finishing = true;
    try {
      // A failed choice does not trap the user in setup. It was not applied;
      // reopening the tour reads the saved value.
      await pendingSave;
      await chrome.storage.local.remove("onboardingPage");
      await chrome.storage.local.set({ onboardingDone: true });
      document.removeEventListener("keydown", onKey, true);
      syncCurrent = [];
      tourOverlay?.remove();
      tourOverlay = null;
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    } catch (error) {
      saveStatus.textContent = msg("onboarding_finish_failed");
      reportFailure("onboarding completion save", error);
    } finally {
      finishing = false;
    }
  };
  const back = el("button", { class: "mini2", type: "button", onclick: () => goStep(step - 1) },
    onboardingStatic.back());
  const next = el("button", { class: "primary", type: "button",
    onclick: () => (step === last ? finish() : goStep(step + 1)) });
  const skip = el("button", { class: "mini2", type: "button", onclick: finish }, onboardingStatic.skip());
  const moreFeatures = el("details", { class: "ob-explore" },
    el("summary", {}, msg("onboarding_more_features")),
    el("div", { class: "ob-explore-topics" }, ...ONBOARDING_FEATURES.map((feature) => el("section", {},
      el("h3", {}, feature.title), el("p", {}, feature.description)))),
    el("button", { type: "button", class: "mini2", onclick: async () => {
      await finish();
      if (!tourOverlay) openHelp("open");
    } }, onboardingStatic.openHelp()));

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
    for (const disclosure of bodyHost.querySelectorAll("details")) disclosure.open = false;
    moreFeatures.open = false;
    step = Math.max(0, Math.min(last, index));
    const page = ONBOARDING_PAGES[step];
    void chrome.storage.local.set({ onboardingPage: page.id }).catch((error) =>
      reportFailure("introduction progress save", error));
    syncCurrent = [];
    const rendered = renderPageBody(page, choices);
    bodyHost.replaceChildren(rendered.body, moreFeatures);
    bodyHost.scrollTop = 0;
    progressCopy.textContent = onboardingStatic.progress(step + 1, ONBOARDING_PAGES.length);
    progress.replaceChildren(...ONBOARDING_PAGES.map((entry, indexInList) => el("button", {
      type: "button", class: `ob-progress-step${indexInList === step ? " on" : ""}`,
      "aria-label": onboardingStatic.pageAria(indexInList + 1, ONBOARDING_PAGES.length, entry.title),
      "aria-current": indexInList === step ? "step" : "false",
      onclick: () => goStep(indexInList)
    })));
    back.hidden = step === 0;
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
  bodyHost, saveStatus,
  el("div", { class: "ob-foot" }, back, el("span", { class: "ob-foot-spacer" }), next));
  tourOverlay = el("div", { class: "ob-overlay" }, card);
  document.body.append(tourOverlay);
  document.addEventListener("keydown", onKey, true);
  goStep(step);
}
