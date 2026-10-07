await import("../../tools/custom-scheme-harness.js");

const result = document.getElementById("result");
const checks = [];
const check = (condition, message) => {
  if (!condition) throw new Error(message);
  checks.push(message);
};
const waitFor = async (fn, message, limit = 2000) => {
  const deadline = performance.now() + limit;
  while (performance.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
};

try {
  const editorLink = await waitFor(() => [...document.querySelectorAll("a")]
    .find((node) => node.textContent.trim() === "Open color scheme editor"),
  "Settings form did not mount the dedicated editor route");
  check(editorLink.href.includes("scheme-editor.html") && editorLink.href.includes("builtin%3Acream"),
    "Appearance opens the dedicated editor from the safe Cream built-in");
  check(!document.querySelector(".custom-scheme-editor, .custom-colour-field"),
    "Appearance stays a compact library and no longer embeds the editor");
  check(![...document.querySelectorAll("option")].some((option) => option.textContent === "null"),
    "empty custom selector never renders null copy");

  const [{ createDefaultCustomSchemeDraft, createCustomSchemeRecord }, { newMeta, upsertItem }, { STORE_KEYS }] =
    await Promise.all([
      import("../js/lib/custom-schemes.js"),
      import("../js/lib/store.js"),
      import("../js/lib/types.js")
    ]);
  const draft = createDefaultCustomSchemeDraft("Mounted Harbor");
  const created = createCustomSchemeRecord(draft.value, await newMeta());
  check(created.ok, "fixture custom scheme passes the strict creation boundary");
  await upsertItem(STORE_KEYS.customSchemes, created.value);
  const row = await waitFor(() => [...document.querySelectorAll(".custom-scheme-row")]
    .find((node) => node.textContent.includes("Mounted Harbor")),
  "saved custom scheme did not join the compact library");
  check(document.querySelector(
    `.scheme-category-yours .scheme-favorite[data-scheme-id="custom:${created.value.id}"]`
  ), "saved scheme joins the Yours catalogue group");
  const edit = [...row.querySelectorAll("a")].find((node) => node.textContent === "Edit");
  check(edit?.href.includes(`custom%3A${created.value.id}`),
    "Edit routes the exact saved custom record into the dedicated editor");

  [...row.querySelectorAll("button")].find((node) => node.textContent === "Apply").click();
  try {
    await waitFor(() => document.documentElement.dataset.scheme === "custom",
      "saved custom scheme did not apply live");
  } catch (error) {
    throw new Error(`${error.message}; observed scheme=${document.documentElement.dataset.scheme ?? "missing"}, ` +
      `selection=${globalThis.__customSchemeHarnessState.settings?.uiScheme ?? "missing"}, ` +
      `custom ids=${Object.keys(globalThis.__customSchemeHarnessState.customSchemes ?? {}).join(",") || "none"}, ` +
      `painted custom=${document.documentElement.dataset.customScheme ?? "none"}, ` +
      `runtime errors=${globalThis.__customSchemeHarnessErrors.join(" | ") || "none"}`);
  }
  check(Boolean(document.documentElement.style.getPropertyValue("--bg-solid")) &&
    Boolean(document.documentElement.dataset.customScheme),
  "live custom theme projects complete inline identity and roles");

  const activeRow = await waitFor(() => [...document.querySelectorAll(".custom-scheme-row")]
    .find((node) => node.textContent.includes("Mounted Harbor") &&
      [...node.querySelectorAll("button")].some((button) => button.disabled && button.textContent === "Applied")),
  "active row did not settle after Apply");
  [...activeRow.querySelectorAll("button")].find((node) => node.textContent === "Delete").click();
  const armedRow = await waitFor(() => [...document.querySelectorAll(".custom-scheme-row")]
    .find((node) => node.textContent.includes("Confirm delete")), "delete did not arm");
  check([...armedRow.querySelectorAll("button")].some((node) => node.textContent === "Confirm delete"),
    "delete still requires an inline second press");
  [...armedRow.querySelectorAll("button")].find((node) => node.textContent === "Confirm delete").click();
  await waitFor(() => document.querySelectorAll(".custom-scheme-row").length === 0,
    "confirmed delete did not remove the live record");
  check(globalThis.__customSchemeHarnessState.settings.uiScheme === "cream" &&
    document.querySelector('.scheme-favorite[data-scheme-id="cream"] .scheme-apply')
      ?.getAttribute("aria-pressed") === "true",
  "deleting the active scheme atomically repairs Settings to Cream");

  await chrome.storage.local.set({
    settings: {
      ...globalThis.__customSchemeHarnessState.settings,
      uiScheme: "custom:99999999-9999-4999-8999-999999999999"
    }
  });
  try {
    await waitFor(() => globalThis.__customSchemeHarnessState.customSchemeNotice &&
      globalThis.__customSchemeHarnessState.settings.uiScheme === "cream",
    "missing custom theme did not repair");
  } catch (error) {
    throw new Error(`${error.message}; selection=${globalThis.__customSchemeHarnessState.settings?.uiScheme ?? "missing"}, ` +
      `notice=${JSON.stringify(globalThis.__customSchemeHarnessState.customSchemeNotice ?? null)}, ` +
      `runtime errors=${globalThis.__customSchemeHarnessErrors.join(" | ") || "none"}`);
  }
  check(document.documentElement.dataset.scheme === "cream" &&
    globalThis.__customSchemeHarnessState.customSchemeNotice.message.includes("replaced with Cream"),
  "a missing active custom record paints Cream, repairs Settings, and records one notice");

  const bootFrame = document.createElement("iframe");
  bootFrame.hidden = true;
  bootFrame.src = "../../tools/custom-theme-boot-harness.html";
  await new Promise((resolve, reject) => {
    bootFrame.addEventListener("load", resolve, { once: true });
    bootFrame.addEventListener("error", () => reject(new Error("cold theme fixture did not load")), { once: true });
    document.body.append(bootFrame);
  });
  const bootRoot = bootFrame.contentDocument.documentElement;
  check(bootRoot.dataset.scheme === "custom" && bootRoot.dataset.mode === "dark" &&
    bootRoot.dataset.customScheme === "11111111-1111-4111-8111-111111111111" &&
    bootRoot.style.getPropertyValue("--bg-solid") === "#171b1f" &&
    bootRoot.dataset.gradient === "true",
  "classic head boot applies cached custom identity, mode, gradient, and roles before modules");
  bootFrame.remove();

  check(document.documentElement.scrollWidth === document.documentElement.clientWidth,
    "compact Appearance library introduces no horizontal overflow");
  result.dataset.status = "pass";
  result.textContent = `Custom scheme mounted DOM passed: ${checks.length} checks.`;
} catch (error) {
  result.dataset.status = "fail";
  result.textContent = error?.stack ?? String(error);
}
