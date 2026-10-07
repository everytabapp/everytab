const result = document.querySelector("#result");
const fixture = document.querySelector("#fixture");
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

try {
  globalThis.chrome = {
    runtime: { getURL: (path) => `chrome-extension://everytab/${path}` }
  };
  const { createBrowserI18nMock } = await import("./i18n-browser-mock.mjs");
  chrome.i18n = await createBrowserI18nMock();
  const { createTabList, fromOpenWindows } = await import("../js/ui/tablist.js");

  let prepared = 0;
  const tabsFor = (windowId, offset, count) => Array.from({ length: count }, (_, index) => ({
    id: offset + index + 1,
    windowId,
    index,
    url: `https://example.com/${offset + index}`,
    title: `Tab ${offset + index}`
  }));
  const groups = fromOpenWindows([
    { id: 7, focused: true, tabs: tabsFor(7, 0, 400) },
    { id: 8, focused: false, tabs: tabsFor(8, 400, 50) }
  ], null, 7, null, null,
    { onPrepareRef: () => { prepared += 1; } }
  );
  let root;
  let changeDone = Promise.resolve();
  const rerender = () => {
    changeDone = Promise.resolve().then(() => {
      const previousScroll = window.scrollY;
      mount();
      if (window.scrollY !== previousScroll) window.scrollTo(0, previousScroll);
    });
    return changeDone;
  };
  const mount = () => {
    root = createTabList({
      section: "open-preparation-fixture",
      groups,
      selectable: "tab",
      rowCap: 50,
      initialRowBudget: 50,
      rowKey: (entry, index) => `t${entry.live[index].tabId}`,
      rowSelectable: (context) => context.live.selectable,
      selectionSelectable: (entry, index) => entry.live[index].selectable,
      selectionCount: (entry) => entry.selectableCount,
      onChange: rerender
    });
    fixture.replaceChildren(root);
  };
  const startedAt = performance.now();
  mount();
  const firstPaintMs = performance.now() - startedAt;

  if (root.querySelectorAll("[data-tablist-row]").length !== 50) {
    throw new Error("the fixture did not render the expected 50 rows");
  }
  if (prepared !== 50) {
    throw new Error(`first paint prepared ${prepared} refs instead of 50`);
  }
  root.querySelectorAll("button.disclosure-row")[1]?.click();
  await changeDone;
  root.querySelectorAll("button.disclosure-row")[0]?.click();
  await changeDone;
  if (root.querySelectorAll("[data-tablist-row]").length !== 450) {
    throw new Error("Show all did not render both complete windows");
  }
  if (prepared !== 450) {
    throw new Error(`Show all prepared ${prepared} refs instead of 450`);
  }
  const showFewer = root.querySelectorAll("button.disclosure-row")[0];
  showFewer.scrollIntoView({ block: "center", behavior: "auto" });
  await frame();
  const expandedScroll = window.scrollY;
  const disclosureTop = showFewer.getBoundingClientRect().top;
  showFewer.click();
  await changeDone;
  const showMore = root.querySelectorAll("button.disclosure-row")[0];
  const replacementTop = showMore.getBoundingClientRect().top;
  if (Math.abs(replacementTop - disclosureTop) > 1) {
    throw new Error(`Show fewer moved its disclosure control from ${disclosureTop.toFixed(1)} to ${replacementTop.toFixed(1)}`);
  }
  result.dataset.status = "pass";
  result.textContent = `PASS: 50 of 450 mounted Open refs prepared before first paint in ${firstPaintMs.toFixed(1)} ms; Show all prepared every row; Show fewer preserved position (${expandedScroll.toFixed(1)} scroll, ${disclosureTop.toFixed(1)} to ${replacementTop.toFixed(1)} top)`;
} catch (error) {
  result.dataset.status = "fail";
  result.textContent = error?.stack || error?.message || String(error);
}
