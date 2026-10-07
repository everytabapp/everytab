import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";

const fixture = installDomFixture();
globalThis.chrome = { i18n: createChromeI18nMock() };

try {
  const { createLabelInput } = await import("../js/ui/labelinput.js");
  const control = createLabelInput({ loadOptions: () => ["Design", "Research"] });
  document.body.append(control.element);
  await Promise.resolve();

  const input = control.element.querySelector(".taginput");
  input.value = "Roadmap";
  await input.dispatch("input");
  const create = control.element.querySelector(".tagopt.create");
  if (!create || create.textContent !== "Create new label “Roadmap”") {
    throw new Error(`Missing explicit create-label choice: ${create?.textContent ?? "none"}`);
  }
  await create.dispatch("mousedown");
  if (control.getLabels().join("|") !== "Roadmap") {
    throw new Error(`Create-label choice did not commit: ${control.getLabels().join("|")}`);
  }
  input.value = "Design";
  await input.dispatch("input");
  await input.dispatch("keydown", { key: "Enter" });
  const entries = await control.getEntries();
  if (entries.length !== 2 || !entries.find((entry) => entry.name === "Roadmap")?.isNew ||
      entries.find((entry) => entry.name === "Design")?.isNew !== false) {
    throw new Error(`Label creation identity was not preserved: ${JSON.stringify(entries)}`);
  }

  // A typed prefix is only a query when the user explicitly chooses one of
  // the existing matches. Applying afterwards must not also create the raw
  // one-letter query as a second Label.
  const filteredControl = createLabelInput({ loadOptions: () => ["video", "travel"] });
  document.body.append(filteredControl.element);
  const filteredInput = filteredControl.element.querySelector(".taginput");
  await filteredInput.dispatch("focus");
  await Promise.resolve();
  filteredInput.value = "v";
  await filteredInput.dispatch("input");
  const existingMatch = [...filteredControl.element.querySelectorAll(".tagopt")]
    .find((option) => option.textContent === "video");
  await existingMatch.dispatch("mousedown");
  // Chromium can deliver a late value-restoration step after the option's
  // pointer-down removed the menu. Model that event-order edge without a new
  // user input event: it is still the old query, not a second intended Label.
  filteredInput.value = "v";
  const filteredEntries = await filteredControl.getEntries();
  if (filteredEntries.length !== 1 || filteredEntries[0].name !== "video" ||
      filteredEntries[0].isNew !== false) {
    throw new Error(`Choosing a filtered Label also committed its query: ${JSON.stringify(filteredEntries)}`);
  }
  console.log("PASS: label entry exposes an explicit create-new-label choice");
} finally {
  fixture.restore();
}
