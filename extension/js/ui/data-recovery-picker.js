// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { el } from "./dom.js";

/**
 * Owns the shared candidate-selection lifecycle for Data recovery actions.
 * Discovery and recovery payloads stay with their domain adapters; this module
 * owns checkbox state, pending controls, retry state, and post-action refresh.
 *
 * The adapter names the only facts that vary between recovery domains:
 * candidate identity/content, six pieces of catalogue copy, the worker request,
 * and the follow-up read. Its recover hook returns a result or null on failure.
 */
export function createDataRecoveryPicker({
  body,
  status,
  checkControl,
  adapter
}) {
  let activeAction = null;
  let busy = false;

  function selectedKeys() {
    return [...body.querySelectorAll("input[type='checkbox']")]
      .filter((input) => input.checked)
      .map((input) => input.value);
  }

  function updateAction() {
    if (!activeAction) return;
    const count = selectedKeys().length;
    activeAction.disabled = busy || count === 0;
    activeAction.textContent = adapter.actionText(count);
  }

  function clear() {
    activeAction = null;
    body.replaceChildren();
  }

  function render(context, candidates) {
    busy = false;
    if (!candidates.length) {
      clear();
      status.textContent = adapter.emptyText();
      return;
    }

    const action = el("button", { class: "primary" });
    activeAction = action;
    action.addEventListener("click", async () => {
      if (busy) return;
      const keys = selectedKeys();
      if (!keys.length) return;
      busy = true;
      updateAction();
      checkControl.disabled = true;
      status.textContent = adapter.progressText(keys.length);

      const result = await Promise.resolve()
        .then(() => adapter.recover(context, keys))
        .catch(() => null);
      checkControl.disabled = false;
      if (!result) {
        busy = false;
        status.textContent = adapter.failureText();
        updateAction();
        return;
      }

      status.textContent = adapter.resultText(result);
      await adapter.refresh(context, { preserveStatus: true });
    });

    const rows = candidates.map((candidate) => {
      const checkbox = el("input", {
        type: "checkbox",
        value: adapter.candidateKey(candidate)
      });
      checkbox.checked = true;
      checkbox.addEventListener("change", updateAction);
      return el("label", { class: "data-recovery-row" },
        checkbox,
        adapter.candidateContent(candidate));
    });

    body.replaceChildren(
      el("div", { class: "data-recovery-list" }, ...rows),
      el("div", { class: "data-recovery-actions" }, action)
    );
    status.textContent = adapter.foundText(candidates.length);
    updateAction();
  }

  return { clear, render };
}
