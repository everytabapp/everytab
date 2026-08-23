/**
 * P11-16 regression: a cold render may finish its async reads quickly and then
 * spend longer than the Loading threshold building a large legacy-profile DOM.
 * The visual feedback must be mounted before that synchronous work begins so
 * CSS can reveal it even while the main thread is occupied.
 */

class FakeNode {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.everConnected = false;
  }
  append(...children) {
    for (const child of children) {
      this.childNodes.push(child);
      if (child instanceof FakeNode) {
        child.parentNode = this;
        child.markConnected();
      }
    }
  }
  replaceChildren(...children) {
    for (const child of this.childNodes) {
      if (child instanceof FakeNode) child.parentNode = null;
    }
    this.childNodes = [];
    this.append(...children);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.childNodes = this.parentNode.childNodes.filter((child) => child !== this);
    this.parentNode = null;
  }
  markConnected() {
    this.everConnected = true;
    for (const child of this.childNodes) {
      if (child instanceof FakeNode) child.markConnected();
    }
  }
}

globalThis.document = { createElement: (tag) => new FakeNode(tag) };

const { showLoadingFeedback } = await import("../js/ui/loading.js");
const host = new FakeNode("section");
host.markConnected();
const startedAt = performance.now();
const loading = showLoadingFeedback(host, { label: "Loading open tabs…" });

await new Promise((resolve) => setTimeout(() => {
  // The async read returned before 180ms, then the old profile's large saved
  // index/list render monopolized the main thread past the threshold.
  const blockUntil = performance.now() + 180;
  while (performance.now() < blockUntil) { /* deterministic render pressure */ }
  host.replaceChildren(new FakeNode("div"));
  loading.stop();
  resolve();
}, 120));

const elapsed = performance.now() - startedAt;
if (elapsed < 280) throw new Error(`fixture did not cross the threshold (${elapsed.toFixed(1)}ms)`);
if (!loading.element.everConnected) {
  console.error(`FAIL: ${elapsed.toFixed(1)}ms cold render completed without mounting Loading feedback`);
  process.exit(1);
}
console.log(`PASS: Loading feedback mounted before the ${elapsed.toFixed(1)}ms cold render completed`);
