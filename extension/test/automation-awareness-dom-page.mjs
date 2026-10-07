const result = document.querySelector("#result");
const catalogue = await fetch("../_locales/en/messages.json").then((response) => response.json());
chrome.i18n.getMessage = (key, substitutions = []) => {
  if (key === "@@ui_locale") return "en";
  if (key === "@@bidi_dir") return "ltr";
  const entry = catalogue[key];
  if (!entry) return "";
  const values = Array.isArray(substitutions) ? substitutions : [substitutions];
  let text = entry.message;
  for (const [name, placeholder] of Object.entries(entry.placeholders ?? {})) {
    const index = Math.max(0, Number(String(placeholder.content).replace("$", "")) - 1);
    text = text.replaceAll(`$${name.toUpperCase()}$`, String(values[index] ?? ""));
  }
  return text;
};

const { createAutomationAwareness } = await import("../js/ui/automation-awareness.js");
const { icon } = await import("../js/ui/icons.js");
const { createAnchoredPanel } = await import("../js/ui/tablist.js");
const { buildProtectionPanel, currentProtection } = await import("../js/ui/automation-protection.js");
const explanation = () => document.querySelector('.action-popover[data-kind="automation"]');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const action = (label) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mini";
  button.setAttribute("aria-label", label);
  const glyph = document.createElement("span");
  glyph.className = "action-icon";
  glyph.append(icon(({ Star: "star", Inbox: "inbox", Session: "sessions",
    Label: "labels", Snooze: "snooze", Protect: "shield", Suspend: "suspend", Close: "close",
    Restore: "refresh", Copy: "duplicates", Delete: "trash" })[label], 14));
  const text = document.createElement("span");
  text.className = "action-label";
  text.textContent = label;
  button.append(glyph, text);
  return button;
};

try {
  const settingsRoutes = [];
  let currentTime = Date.now();
  let refresh = null;
  const awareness = createAutomationAwareness({
    openSettings: (group) => settingsRoutes.push(group),
    now: () => currentTime,
    schedule: (callback, delay) => {
      const id = setTimeout(callback, delay);
      if (delay >= 1000) refresh = { callback, id };
      return id;
    }
  });
  const trigger = awareness.row({
    display: "timed", action: "suspend", state: "running", reason: null,
    awayAt: Date.now() - 45 * 60_000, awayMs: 45 * 60_000,
    afterMs: 60 * 60_000, progress: 0.75, settingsGroup: "suspension"
  });
  const row = document.createElement("div");
  row.className = "trow selrow";
  row.dataset.tablistRow = "t1";
  row.innerHTML = `<span class="row-select-slot"><input type="checkbox" aria-label="Select"></span>
    <span class="fv-placeholder">ET</span>
    <span class="row-copy"><span class="t"><a href="#">A long production-shaped tab title</a></span>
      <span class="row-subline"><span class="host">example.com</span><span class="row-recency item-meta">45m ago</span></span></span>
    <span class="row-chip-slot"></span><span class="tacts"></span>`;
  row.querySelector(".row-subline").append(trigger);
  const actions = row.querySelector(".tacts");
  for (const label of ["Star", "Inbox", "Session", "Label", "Snooze", "Protect", "Suspend", "Close"]) {
    actions.append(action(label));
  }
  const openList = document.createElement("div");
  openList.className = "tablist";
  openList.dataset.tablist = "open";
  const rows = document.createElement("div");
  rows.className = "tl-rows";
  rows.append(row);
  openList.append(rows);

  const inboxView = {
    display: "rule", savedAt: Date.now() - 12 * 86_400_000,
    afterDays: 30, afterMs: 30 * 86_400_000, settingsGroup: "autosave"
  };
  const inboxTrigger = awareness.inbox(inboxView);
  const inboxList = document.createElement("div");
  inboxList.className = "tablist";
  inboxList.dataset.tablist = "inbox";
  inboxList.innerHTML = `<div class="item"><div class="item-head-shell"><div class="item-head">
    <button class="item-head-toggle" type="button"><span class="item-title">Research sprint</span><span class="item-meta">saved · 12d ago</span></button>
    <span class="gacts"></span></div></div></div>`;
  const inboxHead = inboxList.querySelector(".item-head");
  inboxHead.insertBefore(inboxTrigger, inboxHead.querySelector(".gacts"));
  for (const label of ["Restore", "Copy", "Session", "Label", "Snooze", "Delete"]) {
    inboxHead.querySelector(".gacts").append(action(label));
  }
  document.querySelector("#fixture").append(openList, inboxList);
  awareness.sync();

  const rowBefore = row.getBoundingClientRect();
  const actionBefore = actions.getBoundingClientRect();
  const meter = trigger.querySelector(".automation-awareness-meter").getBoundingClientRect();
  check(Math.abs(rowBefore.height - 40) < 0.1,
    `Detailed Open row is not 40px (${rowBefore.height}px)`);
  check(actions.children.length === 8, "Open action rail does not retain its protection action");
  check(trigger.tabIndex === -1 && inboxTrigger.tabIndex === -1,
    "inline awareness must not add keyboard stops");
  check(Math.abs(meter.width - 48) < 0.1 && Math.abs(meter.height - 2) < 0.1,
    "Timed track is not 48x2px");
  check(!inboxTrigger.querySelector(".automation-awareness-meter"),
    "Inbox header must not render a track");
  check(inboxTrigger.parentElement === inboxHead &&
    inboxTrigger.previousElementSibling.matches(".item-head-toggle"),
    "Inbox rule is not a sibling of the fold control");

  trigger.focus();
  await wait(340);
  check(document.activeElement === trigger, "focus reveal stole focus");
  check(!explanation(), "focus alone opened details");
  trigger.dispatchEvent(new PointerEvent("pointerenter"));
  await wait(340);
  check(!explanation(), "hover alone opened details");
  check(getComputedStyle(trigger).cursor === "pointer", "status does not use the regular pointer");
  const rowFocused = row.getBoundingClientRect();
  const actionFocused = actions.getBoundingClientRect();
  check(Math.abs(rowFocused.height - rowBefore.height) < 0.1, "focus changed row height");
  check(Math.abs(actionFocused.left - actionBefore.left) < 0.1 &&
    Math.abs(actionFocused.width - actionBefore.width) < 0.1,
    "focus moved the action rail");

  trigger.click();
  await wait(20);
  check(explanation()?.querySelector(".action-popover-stem"), "picker has no shared anchor notch");
  check(document.activeElement?.matches("[data-awareness-settings]"),
    "explicit activation did not enter the explanation controls");
  const focusedControl = document.activeElement;
  currentTime += 60_000;
  clearTimeout(refresh.id);
  refresh.callback();
  check(document.activeElement === focusedControl,
    "minute refresh replaced a focused explanation control");
  document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  check(!explanation() && document.activeElement === trigger,
    "Escape did not close and restore the source");
  await wait(340);
  check(!explanation(), "Escape immediately reopened the explanation");
  document.querySelector("#outside").focus();
  trigger.focus();
  await wait(340);
  check(!explanation(), "focus re-entry opened details without activation");
  trigger.click();

  explanation().querySelector("[data-awareness-settings]").click();
  check(settingsRoutes[0] === "suspension", "manage action used the wrong Settings route");
  inboxTrigger.click();
  check(!explanation().textContent.includes("null"), "explanation printed a null child");
  explanation().querySelector("[data-awareness-settings]").click();
  check(settingsRoutes[1] === "autosave", "Inbox manage action used the wrong Settings route");

  const excluded = awareness.row({ display: "state", action: "suspend",
    state: "active", reason: null, settingsGroup: "protection",
    protection: { kind: "page", protected: true } });
  row.querySelector(".row-subline").append(excluded);
  excluded.click();
  check(excluded.classList.contains("is-protected") &&
    !excluded.querySelector(".automation-awareness-shield").hidden &&
    excluded.textContent.includes("Active") && excluded.textContent.includes("Protected"),
  "an active protected tab must retain both facts and its shield");
  check(explanation().textContent.includes("not suspended or auto-saved automatically"),
    "shared protection details did not explain both automatic actions");
  check(!explanation().textContent.includes("null"), "excluded state printed a null caveat");
  openList.style.display = "none";
  awareness.sync();
  check(!explanation(), "hidden section left its explanation open");
  openList.style.display = "";
  excluded.remove();
  document.querySelector("#outside").focus();
  trigger.dispatchEvent(new PointerEvent("pointerenter"));
  await wait(340);
  check(!explanation(), "pointer entry opened details without a click");
  trigger.click();
  trigger.dispatchEvent(new PointerEvent("pointerleave"));
  await wait(200);
  check(explanation(), "pointer departure dismissed a clicked picker");
  document.querySelector("#outside").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  check(!explanation(), "outside pointer did not dismiss details");
  trigger.click();
  explanation().querySelector(".action-popover-close").click();
  check(!explanation() && document.activeElement === trigger, "close control did not restore focus");
  const otherSlot = document.createElement("div");
  document.body.append(otherSlot);
  const otherPicker = createAnchoredPanel(otherSlot);
  trigger.click();
  otherPicker.anchor(document.querySelector("#outside"));
  otherPicker.toggle(() => document.createElement("input"), "label");
  check(!explanation() && document.querySelectorAll(".action-popover").length === 1,
    "Label picker did not replace the automation picker");
  trigger.click();
  check(explanation() && document.querySelectorAll(".action-popover").length === 1,
    "automation details did not share the single-picker owner");
  explanation().querySelector(".action-popover-close").click();
  otherSlot.remove();

  document.documentElement.dataset.rowInfo = "useful";
  check(getComputedStyle(trigger).display === "none", "Useful density retained Detailed awareness");
  document.documentElement.dataset.rowInfo = "detailed";
  document.querySelector("#fixture").style.width = "390px";
  await wait(20);
  check(row.scrollWidth <= row.clientWidth + 1, "narrow Open row overflows horizontally");
  check(inboxHead.scrollWidth <= inboxHead.clientWidth + 1, "narrow Inbox header overflows horizontally");
  check(inboxHead.querySelector(".gacts").children.length === 6,
    "narrow Inbox header lost actions");
  openList.dataset.compact = "";
  const compactHeight = row.getBoundingClientRect().height;
  trigger.focus();
  await wait(340);
  check(row.getBoundingClientRect().height === compactHeight,
    "compact awareness reveal changed the row height");
  check(row.scrollWidth <= row.clientWidth + 1, "compact awareness row overflows");
  trigger.click();
  check(explanation().hasAttribute("data-compact"),
    "shared picker lost its compact source styling");
  explanation().querySelector(".action-popover-close").click();
  delete openList.dataset.compact;

  const protectionSlot = document.createElement("div");
  check(currentProtection({ protected: true, kind: "tab", expiresAt: 10,
    afterExpiry: { protected: true, kind: "site" } }, 11).kind === "site",
  "temporary expiry hides the permanent website rule");
  check(currentProtection({ protected: true, kind: "tab", expiresAt: null,
    afterExpiry: { protected: true, kind: "site" } }, 11).kind === "tab",
    "until-closed tab protection was treated as an expired timer");
  document.body.append(protectionSlot);
  const protectionPicker = createAnchoredPanel(protectionSlot);
  const choices = [];
  const batches = [];
  let displayedProtection = {};
  const service = {
    read: async () => ({ kind: "none", protected: false, hostname: "shop.example", url: "https://shop.example/cart", ...displayedProtection }),
    set: async (tabId, scope, duration) => { choices.push([tabId, scope, duration]); return { ok: true }; },
    queryWindow: async () => [
      { id: 1, url: "https://shop.example/cart" }, { id: 2, url: "https://shop.example/cart" },
      { id: 3, url: "https://news.example/story" }, { id: 4, url: "chrome://extensions" }
    ],
    setMany: async (targets, scope, duration) => { batches.push({ targets, scope, duration }); return { ok: true }; },
    remove: async () => ({ ok: true })
  };
  for (const scope of ["tab", "site", "page"]) for (const duration of ["day", "always"]) {
    protectionPicker.anchor(actions.querySelector('[aria-label="Protect"]'));
    protectionPicker.toggle(() => buildProtectionPanel(17, {
      close: (options) => protectionPicker.close(options), openSettings: () => {}
    }, service), "protection");
    await wait(20);
    const popup = document.querySelector('.action-popover[data-kind="protection"]');
    check(popup?.querySelector(".action-popover-stem"), "protection picker lost shared anatomy");
    check(!popup.textContent.includes("null"), "optional protection content rendered null text");
    check(popup.textContent.includes("shop.example") && popup.textContent.includes("tab or browser closes"),
      "protection choices do not explain navigation scope");
    check(popup.querySelectorAll(".protection-choice").length === 6,
      "protection does not expose both durations for all three scopes");
    check(popup.scrollWidth <= popup.clientWidth + 1,
      "six protection choices overflow the shared picker");
    popup.querySelector(`[data-scope="${scope}"][data-duration="${duration}"]`).click();
    await wait(20);
    check(choices.at(-1)?.[0] === 17 && choices.at(-1)?.[1] === scope && choices.at(-1)?.[2] === duration,
      `protection picker sent the wrong ${scope}/${duration} choice`);
    check(!document.querySelector('.action-popover[data-kind="protection"]'),
      "successful protection choice left its picker open");
  }
  for (const scope of ["tab", "site", "page"]) for (const duration of ["day", "always"]) {
    protectionPicker.anchor(actions.querySelector('[aria-label="Protect"]'));
    protectionPicker.toggle(() => buildProtectionPanel({ windowId: 7 }, {
      close: (options) => protectionPicker.close(options), openSettings: () => {}
    }, service), "protection");
    await wait(20);
    const popup = document.querySelector('.action-popover[data-kind="protection"]');
    check(popup.textContent.includes("window: 3") && popup.textContent.includes("Domains: 2") &&
      popup.textContent.includes("Exact addresses: 2"), "window protection scope counts are not precise");
    popup.querySelector(`[data-scope="${scope}"][data-duration="${duration}"]`).click();
    await wait(20);
    check(batches.at(-1)?.targets.length === 3 && batches.at(-1)?.scope === scope &&
      batches.at(-1)?.duration === duration, "window protection lost its frozen web-tab targets or duration");
  }
  protectionPicker.close();
  protectionPicker.anchor(actions.querySelector('[aria-label="Protect"]'));
  protectionPicker.toggle(() => buildProtectionPanel({ tabs: [
    { id: 2, url: "https://shop.example/cart" }
  ] }, {
    close: (options) => protectionPicker.close(options), openSettings: () => {}
  }, service), "protection");
  await wait(20);
  const selectedPopup = document.querySelector('.action-popover[data-kind="protection"]');
  check(selectedPopup.textContent.includes("Selected web tabs: 1"),
    "selected protection expands to unselected tabs");
  selectedPopup.querySelector('[data-scope="tab"][data-duration="always"]').click();
  await wait(20);
  check(batches.at(-1)?.targets.length === 1 && batches.at(-1)?.targets[0].tabId === 2,
    "selected protection loses the exact selected occurrence");
  for (const kind of ["tab", "site", "page", "temporary-site", "temporary-page", "rule", "expired", "none"]) {
    displayedProtection = { kind, protected: !["expired", "none"].includes(kind),
      rule: "shop.example", ...(kind.startsWith("temporary") ? { expiresAt: Date.now() + 60_000 } : {}) };
    protectionPicker.anchor(actions.querySelector('[aria-label="Protect"]'));
    protectionPicker.toggle(() => buildProtectionPanel(17, {
      close: (options) => protectionPicker.close(options), openSettings: () => {}
    }, service), "protection");
    await wait(20);
    const popup = document.querySelector('.action-popover[data-kind="protection"]');
    const current = popup.querySelector('.protection-current');
    check(Boolean(current) === displayedProtection.protected,
      `${kind} has an incorrect current-protection section`);
    if (current) {
      check(current.querySelector('strong')?.textContent === "Current protection" &&
        current.querySelectorAll('p').length === 2 && current.getAttribute('role') === "status",
        "active protection and its scope description are not grouped under one clear label");
      check(getComputedStyle(current.querySelector('p')).marginTop === "0px",
        "current protection text keeps a detached paragraph margin");
    }
    check(popup.textContent.includes("Stays protected when you navigate to other pages in this tab."),
      "tab scope does not use the approved same-tab navigation wording");
    protectionPicker.close();
  }
  protectionSlot.remove();

  document.documentElement.dataset.scheme = "laser";
  document.documentElement.dataset.mode = "dark";
  check(getComputedStyle(trigger).color !== "", "dark scheme did not resolve awareness ink");
  if (new URL(location.href).searchParams.has("preview")) {
    displayedProtection = { kind: "page", protected: true };
    document.querySelector("#fixture").style.width = "1200px";
    document.documentElement.dataset.scheme = "ink";
    document.documentElement.dataset.mode = "light";
    document.body.append(protectionSlot);
    protectionPicker.anchor(actions.querySelector('[aria-label="Protect"]'));
    protectionPicker.toggle(() => buildProtectionPanel(17, {
      close: (options) => protectionPicker.close(options), openSettings: () => {}
    }, service), "protection");
    await wait(340);
    check(document.querySelector('.action-popover[data-kind="protection"]')?.matches(':popover-open'),
      "the protection preview did not remain visible after settling");
    result.hidden = true;
  } else awareness.close();
  result.dataset.status = "pass";
  result.textContent = "automation-awareness DOM and geometry: pass";
} catch (error) {
  result.dataset.status = "fail";
  result.textContent = error.stack || String(error);
}
