// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "../lib/failure-diagnostic.js";
import { msg } from "../lib/i18n.js";
import { el } from "./dom.js";

export const DATA_AREA_IDS = Object.freeze(["recover", "transfer", "vault"]);
const ownedRenderResults = new WeakMap();

/** Convert a Data/Vault render rejection into one named, payload-free diagnostic.
 * Reusing a coalesced Promise reuses its owned result, so one failure is logged once. */
export function ownDataRender(promise, label, report = console.error) {
  const existing = ownedRenderResults.get(promise);
  if (existing) return existing;
  const operation = label === "Data" ? "Data render" : label === "Vault" ? "Vault render" : "operation";
  const owned = promise.then(
    () => true,
    (error) => {
      reportFailure(operation, error, report);
      return false;
    }
  );
  ownedRenderResults.set(promise, owned);
  return owned;
}

/** Resolve current and compatibility hashes without widening the page router. */
export function dataRoute(raw) {
  if (raw === "vault") return { page: "data", area: "vault" };
  if (raw === "data") return { page: "data", area: null };
  const match = /^data:(recover|transfer|vault)$/.exec(raw);
  return match ? { page: "data", area: match[1] } : null;
}

/** Advance only for a real hash change, not the router's duplicate delivery. */
export function nextDataRouteState(previous, hash) {
  return previous.hash === hash
    ? previous
    : { hash, generation: previous.generation + 1 };
}

/** One retained Data workspace: jump navigation plus independent core/Vault slots. */
export function createDataHub({ onJump }) {
  const coreHost = el("div", { class: "data-core" });
  const vaultHeading = el("h3", { class: "data-area-title" }, msg("shell_section_vault"));
  const vaultBody = el("div", { class: "data-vault-body" });
  const vaultArea = el("div", {
    class: "data-area", id: "data-area-vault", "data-data-area": "vault"
  }, vaultHeading, vaultBody);

  const labels = {
    recover: msg("data_nav_recover"),
    transfer: msg("data_nav_transfer"),
    vault: msg("shell_section_vault")
  };
  const buttons = Object.fromEntries(DATA_AREA_IDS.map((id) => [id, el("button", {
    type: "button", class: "settings-nav-chip",
    title: labels[id],
    onclick: () => onJump(id)
  }, labels[id])]));
  const nav = el("div", {
    class: "settings-nav data-nav section-local-sticky", role: "navigation",
    "aria-label": msg("data_nav_aria")
  }, ...DATA_AREA_IDS.map((id) => buttons[id]));
  const element = el("div", { class: "data-workspace" }, nav, coreHost, vaultArea);
  const measureNav = () => {
    element.style.setProperty("--data-nav-h", `${nav.getBoundingClientRect().height}px`);
  };
  measureNav();
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(measureNav).observe(nav);
  return {
    element,
    coreHost,
    vaultBody,
    vaultHeading,
    buttons,
    nav
  };
}
