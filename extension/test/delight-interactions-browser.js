import { createUndoToast } from "../js/ui/toast.js";
import { initTooltips } from "../js/ui/tooltip.js";
import { createTabList } from "../js/ui/tablist.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

/** Runs only in a disposable installed-extension Dashboard fixture. */
export async function runInteractionChecks(reduced) {
  const receipt = [];
  const host = document.createElement("section");
  host.style.cssText = "position:absolute;top:100px;left:230px;width:650px;z-index:200;background:var(--bg-solid)";
  document.body.append(host);
  const outside = document.createElement("button");
  outside.textContent = "Fixture focus return";
  host.append(outside);
  outside.focus();
  let undoCalls = 0;
  let resolveUndo;
  let afterUndo = 0;
  const originalSend = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = (...args) => args[0]?.type === "undo-last"
    ? (undoCalls += 1, new Promise((resolve) => { resolveUndo = resolve; }))
    : originalSend.apply(chrome.runtime, args);
  const toast = createUndoToast({ afterUndo: () => { afterUndo += 1; } });
  document.body.append(toast.element);
  try {
    toast.showNotice("First notice");
    assert(toast.element.getAnimations().length === (reduced ? 0 : 1), "toast entry respects reduced motion");
    await wait(25);
    toast.hideToast();
    assert(toast.element.inert, "exiting toast immediately leaves interaction order");
    toast.showNotice("Latest notice");
    await wait(210);
    assert(!toast.element.classList.contains("hidden") && toast.element.textContent.includes("Latest notice"), "old exit cannot hide replacement");
    toast.showToast({ id: "fixture-undo", label: "Saved fixture" });
    const undo = [...toast.element.querySelectorAll("button")].find((button) => button.textContent === "Undo");
    undo.focus(); undo.click(); undo.click();
    assert(undoCalls === 1, "rapid Undo invokes worker once");
    toast.showNotice("Newer operation");
    resolveUndo({ status: "undone", entry: { id: "fixture-undo", label: "Saved fixture" } });
    await wait(30);
    assert(toast.element.textContent.includes("Newer operation") && afterUndo === 1, "late Undo refreshes data without replacing a newer notice");
    toast.hideToast();
    await wait(170);
    assert(toast.element.classList.contains("hidden") && !toast.element.style.transform, "toast exit completes without residual transform");
    receipt.push("toast entry, rapid exit/replacement, duplicate Undo, stale result, and cleanup");

    for (const kind of ["session", "label"]) {
      const refs = Array.from({ length: 5 }, (_, index) => ({ url: `https://example.com/${index}`, title: `Fixture ${index}` }));
      const group = { id: `fold-${kind}-${reduced}`, title: `Fixture ${kind}`, chips: [], ...(kind === "session" ? { windows: [{ refs, meta: "Window 1" }] } : { refs }) };
      const list = createTabList({ section: `fold-test-${kind}-${reduced}`, groups: [group], foldable: true });
      host.append(list);
      const card = () => list.querySelector(".item");
      const toggle = () => card().querySelector(".item-head-toggle");
      const initial = card().getBoundingClientRect().height;
      toggle().focus(); toggle().click();
      assert(toggle().getAttribute("aria-expanded") === "false", "card fold state updates immediately");
      assert(document.activeElement === toggle(), "card fold retains keyboard focus");
      assert([...card().querySelectorAll('[aria-hidden="true"]')].filter((node) => node.classList.contains("item-body-frame")).every((node) => node.inert), "outgoing body is inert");
      assert(card().getAnimations().length === (reduced ? 0 : 1), "card geometry motion respects preference");
      if (!reduced) assert(Math.abs(card().getBoundingClientRect().height - initial) < 3, "card starts shrinking from visible height");
      await wait(35); toggle().click();
      await wait(25); toggle().click();
      await wait(20); toggle().click();
      await wait(230);
      assert(toggle().getAttribute("aria-expanded") === "true", "rapid reversals keep final card state");
      assert(Math.abs(card().getBoundingClientRect().height - initial) < 1, "card returns to intrinsic geometry");
      assert(!card().style.blockSize && !card().style.overflow && !card().querySelector('.item-body-frame[aria-hidden="true"]'), "fold motion releases temporary layout and outgoing copy");
      toggle().click();
      const detached = card();
      const replacement = createTabList({ section: `fold-test-${kind}-${reduced}`, groups: [group], foldable: true });
      list.replaceWith(replacement);
      await wait(220);
      assert(!detached.style.blockSize && !detached.querySelector('.item-body-frame[aria-hidden="true"]'), "detached rerender releases old motion and clone");
      assert(!replacement.querySelector(".item-body-frame"), "ordinary rerender preserves folded state without rebuilding hidden rows");
      replacement.remove();
    }
    receipt.push("mounted Session and Label cards: normal/reduced motion, rapid reversals, focus, inert collapse and intrinsic cleanup");

    for (const page of ["sessions", "labels"]) {
      const group = document.querySelector(`.navgroup:has([data-page="${page}"])`);
      assert(group, `real ${page} navigation is mounted`);
      const trigger = group.querySelector(".twist");
      const branch = group.querySelector(".subnav");
      if (!group.classList.contains("open")) { trigger.click(); await wait(220); }
      branch.querySelector("button")?.focus();
      trigger.click();
      assert(branch.inert && trigger.getAttribute("aria-expanded") === "false", "sidebar closes its interaction surface immediately");
      assert(document.activeElement === trigger, "closing sidebar returns child focus to trigger");
      assert(branch.getAnimations().length === (reduced ? 0 : 1), "sidebar preference is respected");
      await wait(25); trigger.click(); await wait(25); trigger.click(); await wait(220);
      assert(branch.inert && branch.getBoundingClientRect().height === 0 && !branch.style.blockSize, "rapid sidebar toggle settles closed");
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await wait(220);
      assert(!branch.inert && branch.getBoundingClientRect().height > 0, "keyboard opens real sidebar branch");
    }
    receipt.push("real Dashboard Session/Label branches: immediate inert state, focus return, rapid and keyboard toggles");

    initTooltips();
    const buttons = ["First tip", "Adjacent tip", "Keyboard tip"].map((text) => {
      const button = document.createElement("button");
      button.className = "tip"; button.title = text; button.textContent = text;
      host.append(button); return button;
    });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(650);
    const over = (button, pointerType = "mouse") => button.dispatchEvent(new PointerEvent("pointerover", { pointerType, bubbles: true }));
    const out = (button) => button.dispatchEvent(new PointerEvent("pointerout", { pointerType: "mouse", bubbles: true }));
    const tip = () => document.querySelector(".tooltip");
    over(buttons[0]);
    assert(!tip()?.classList.contains("show"), "first hover does not flash immediately");
    await wait(75);
    assert(!tip()?.classList.contains("show"), "first hover retains short intent delay");
    await wait(75);
    assert(tip()?.classList.contains("show") && tip().textContent === "First tip", "first tooltip appears after 120ms intent delay");
    out(buttons[0]); over(buttons[1]);
    assert(tip().textContent === "Adjacent tip" && tip().classList.contains("instant"), "warm adjacent tooltip is immediate without entry animation");
    out(buttons[1]); over(buttons[0], "touch");
    await wait(150);
    assert(!tip().classList.contains("show"), "touch does not arm hover tooltip");
    buttons[2].focus();
    assert(buttons[2].matches(":focus-visible") && tip().textContent === "Keyboard tip" && tip().classList.contains("show"), "keyboard focus shows tooltip immediately");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert(!tip().classList.contains("show"), "Escape dismisses tooltip");
    receipt.push("tooltips: 120ms first intent, immediate warm adjacent and keyboard, touch suppression, Escape dismissal");
    return { reduced, receipt };
  } finally {
    chrome.runtime.sendMessage = originalSend;
    toast.hideToast();
    toast.element.remove();
    host.remove();
  }
}
