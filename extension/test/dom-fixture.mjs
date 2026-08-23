/** Minimal connected DOM used by behavior tests; deliberately not a markup parser. */

const dataKey = (name) => name.replace(/-([a-z])/g, (_m, letter) => letter.toUpperCase());

class FixtureText {
  constructor(value, ownerDocument) {
    this.nodeType = 3;
    this.value = String(value);
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.isConnected = false;
  }
  get textContent() { return this.value; }
  set textContent(value) { this.value = String(value); }
}

function simpleMatch(element, selector) {
  if (!(element instanceof FixtureElement)) return false;
  const attributes = [...selector.matchAll(/\[([^\]=]+)(?:=["']?([^\]"']*)["']?)?\]/g)];
  selector = selector.replace(/\[[^\]]+\]/g, "");
  const id = selector.match(/#([\w-]+)/)?.[1];
  if (id && element.id !== id) return false;
  const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
  if (classes.some((name) => !element.classList.contains(name))) return false;
  const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
  if (tag && element.tagName !== tag.toUpperCase()) return false;
  for (const [, name, expected] of attributes) {
    const actual = element.getAttribute(name);
    if (actual == null || (expected !== undefined && actual !== expected)) return false;
  }
  return true;
}

function complexMatch(element, selector) {
  const tokens = selector.trim().replace(/\s*>\s*/g, " > ").split(/\s+/).filter(Boolean);
  let current = element;
  let index = tokens.length - 1;
  if (!simpleMatch(current, tokens[index])) return false;
  index--;
  while (index >= 0) {
    if (tokens[index] === ">") {
      current = current.parentElement;
      index--;
      if (!current || !simpleMatch(current, tokens[index])) return false;
      index--;
      continue;
    }
    let ancestor = current.parentElement;
    while (ancestor && !simpleMatch(ancestor, tokens[index])) ancestor = ancestor.parentElement;
    if (!ancestor) return false;
    current = ancestor;
    index--;
  }
  return true;
}

function setConnected(node, connected) {
  node.isConnected = connected;
  for (const child of node.childNodes ?? []) setConnected(child, connected);
}

class FixtureElement {
  constructor(tagName, ownerDocument) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.isConnected = false;
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this._classes = new Set();
    this._rect = null;
    this._clientWidth = null;
    this._scrollWidth = null;
    const element = this;
    this.classList = {
      add: (...names) => names.forEach((name) => element._classes.add(name)),
      remove: (...names) => names.forEach((name) => element._classes.delete(name)),
      contains: (name) => element._classes.has(name),
      toggle(name, force) {
        const on = force ?? !element._classes.has(name);
        if (on) element._classes.add(name); else element._classes.delete(name);
        return on;
      }
    };
    const styleValues = new Map();
    this.style = {
      setProperty: (name, value) => styleValues.set(name, String(value)),
      getPropertyValue: (name) => styleValues.get(name) ?? ""
    };
  }

  get parentElement() { return this.parentNode instanceof FixtureElement ? this.parentNode : null; }
  get children() { return this.childNodes.filter((child) => child instanceof FixtureElement); }
  get className() { return [...this._classes].join(" "); }
  set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get id() { return this.getAttribute("id") ?? ""; }
  set id(value) { this.setAttribute("id", value); }
  get textContent() { return this.childNodes.map((child) => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(String(value)); }
  get clientWidth() { return this._clientWidth ?? this.getBoundingClientRect().width; }
  set clientWidth(value) { this._clientWidth = Number(value); }
  get scrollWidth() { return this._scrollWidth ?? this.clientWidth; }
  set scrollWidth(value) { this._scrollWidth = Number(value); }

  setAttribute(name, value) {
    const string = String(value);
    this.attributes.set(name, string);
    if (name === "class") this.className = string;
    if (name === "hidden") this.hidden = true;
    if (name === "disabled") this.disabled = true;
    if (name === "value") this.value = string;
    if (name.startsWith("data-")) this.dataset[dataKey(name.slice(5))] = string;
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "hidden") this.hidden = false;
    if (name === "disabled") this.disabled = false;
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  async dispatch(type, init = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...init
    };
    for (const listener of this.listeners.get(type) ?? []) await listener(event);
    return event;
  }
  append(...nodes) {
    for (let child of nodes) {
      if (child == null) continue;
      if (!(child instanceof FixtureElement) && !(child instanceof FixtureText)) {
        child = new FixtureText(child, this.ownerDocument);
      }
      child.parentNode?.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      setConnected(child, this.isConnected);
    }
  }
  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index < 0) return;
    this.childNodes.splice(index, 1);
    if (this.ownerDocument.activeElement instanceof FixtureElement &&
        child.contains?.(this.ownerDocument.activeElement)) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
    child.parentNode = null;
    setConnected(child, false);
  }
  replaceChildren(...nodes) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    this.append(...nodes);
  }
  remove() { this.parentNode?.removeChild(this); }
  replaceWith(replacement) {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.childNodes.indexOf(this);
    parent.removeChild(this);
    let node = replacement;
    if (!(node instanceof FixtureElement) && !(node instanceof FixtureText)) {
      node = new FixtureText(node, this.ownerDocument);
    }
    node.parentNode = parent;
    parent.childNodes.splice(index, 0, node);
    setConnected(node, parent.isConnected);
  }
  contains(other) {
    for (let node = other; node; node = node.parentNode) if (node === this) return true;
    return false;
  }
  matches(selector) { return selector.split(",").some((part) => complexMatch(this, part)); }
  closest(selector) {
    for (let node = this; node instanceof FixtureElement; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }
  querySelectorAll(selector) {
    const selectors = selector.split(",").map((part) => part.trim()).filter(Boolean);
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (selectors.some((part) => complexMatch(child, part))) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  focus() { this.ownerDocument.activeElement = this; }
  select() {}
  setRect(rect) {
    const left = rect.left ?? 0;
    const top = rect.top ?? 0;
    const width = rect.width ?? ((rect.right ?? left) - left);
    const height = rect.height ?? ((rect.bottom ?? top) - top);
    this._rect = { left, top, width, height, right: left + width, bottom: top + height };
    return this;
  }
  getBoundingClientRect() {
    if (this._rect) return { ...this._rect };
    if (this.classList.contains("pu-star-row")) {
      const rows = this.parentElement?.children.filter((child) => child.classList.contains("pu-star-row")) ?? [];
      const top = Math.max(0, rows.indexOf(this)) * 32;
      return { left: 0, top, width: 280, height: 32, right: 280, bottom: top + 32 };
    }
    return { left: 0, top: 0, width: 100, height: 20, right: 100, bottom: 20 };
  }
  animate(keyframes, options) {
    const animation = {
      cancelled: false,
      cancel() { this.cancelled = true; }
    };
    this.ownerDocument.animations.push({ element: this, keyframes, options, animation });
    this.ownerDocument.onAnimate?.(this, keyframes, options, animation);
    return animation;
  }
  set innerHTML(value) { this._innerHTML = String(value); }
  get innerHTML() { return this._innerHTML ?? ""; }
}

class FixtureDocument {
  constructor() {
    this.animations = [];
    this.onAnimate = null;
    this.documentElement = new FixtureElement("html", this);
    this.body = new FixtureElement("body", this);
    this.documentElement.append(this.body);
    setConnected(this.documentElement, true);
    this.activeElement = this.body;
  }
  createElement(tag) { return new FixtureElement(tag, this); }
  createElementNS(_namespace, tag) { return this.createElement(tag); }
  querySelector(selector) {
    if (this.documentElement.matches(selector)) return this.documentElement;
    return this.documentElement.querySelector(selector);
  }
  querySelectorAll(selector) {
    const own = this.documentElement.matches(selector) ? [this.documentElement] : [];
    return [...own, ...this.documentElement.querySelectorAll(selector)];
  }
  getElementById(id) { return this.querySelector(`#${id}`); }
  hasFocus() { return true; }
}

export function installDomFixture() {
  const previous = new Map();
  for (const key of ["document", "window", "Element", "HTMLElement", "Node", "getComputedStyle", "localStorage"]) {
    previous.set(key, globalThis[key]);
  }
  const document = new FixtureDocument();
  const storage = new Map();
  globalThis.document = document;
  globalThis.Element = FixtureElement;
  globalThis.HTMLElement = FixtureElement;
  globalThis.Node = FixtureElement;
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  globalThis.getComputedStyle = (element) => ({
    getPropertyValue(name) {
      if (name === "--motion-continuity") return "180ms";
      if (name === "--ease-out") return "cubic-bezier(.2,.8,.2,1)";
      return element?.style?.getPropertyValue?.(name) ?? "";
    }
  });
  globalThis.localStorage = {
    getItem: (key) => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key)
  };
  return {
    document,
    animations: document.animations,
    restore() {
      for (const [key, value] of previous) {
        if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
      }
    }
  };
}
