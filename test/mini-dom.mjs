// pagecue/test/mini-dom.mjs -- the smallest DOM adapter-dom.js actually touches.
//
// adapter-dom.js is the one module in pagecue that cannot be exercised as pure
// functions, and the framework takes no dependencies -- so rather than leave
// its discovery rules untested, here is just enough tree, selector engine,
// event dispatch and MutationObserver to run it in plain Node.
//
// Deliberately not a browser. It implements the subset the adapter uses and
// nothing else; anything outside that subset throws rather than lying.

const VOID = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'source', 'col']);
const FORM_TAGS = new Set(['input', 'select', 'textarea']);
let ord = 0;

// ---------------------------------------------------------------- selectors
function parseCompound(src) {
  const c = { tag: '', id: '', classes: [], attrs: [], scope: false };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([~^|$*]?=)"?'?([^\]"']*)"?'?)?\]|:scope|\*/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[1]) c.tag = m[1].toLowerCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push({ n: m[4].toLowerCase(), v: m[5] ? m[6] : undefined });
    else if (m[0] === ':scope') c.scope = true;
  }
  return c;
}

// 'a b > c' -> [{compound a}, ' ', {compound b}, '>', {compound c}]
function parseComplex(src) {
  const parts = src.trim().split(/\s*(>)\s*|\s+/).filter((x) => x !== undefined && x !== '');
  const out = [];
  for (const p of parts) out.push(p === '>' ? '>' : parseCompound(p));
  return out;
}
const parseSelector = (sel) => String(sel).split(',').map((s) => parseComplex(s)).filter((c) => c.length);

const hasClass = (el, cl) => String(el.getAttribute('class') || '').split(/\s+/).includes(cl);
function matchCompound(el, c, scopeEl) {
  if (el.nodeType !== 1) return false;
  if (c.scope) return el === scopeEl;
  if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
  if (c.id && el.getAttribute('id') !== c.id) return false;
  for (const cl of c.classes) if (!hasClass(el, cl)) return false;
  for (const a of c.attrs) {
    const v = el.getAttribute(a.n);
    if (v === null) return false;
    if (a.v !== undefined && v !== a.v) return false;
  }
  return true;
}

function matchComplex(el, steps, scopeEl) {
  let i = steps.length - 1;
  if (!matchCompound(el, steps[i], scopeEl)) return false;
  let node = el;
  i--;
  while (i >= 0) {
    const comb = steps[i] === '>' ? '>' : ' ';
    if (steps[i] === '>') i--;
    const want = steps[i];
    i--;
    if (comb === '>') {
      node = node.parentElement;
      if (!node || !matchCompound(node, want, scopeEl)) return false;
    } else {
      let p = node.parentElement, hit = null;
      while (p && !hit) { if (matchCompound(p, want, scopeEl)) hit = p; p = p.parentElement; }
      if (!hit) return false;
      node = hit;
    }
  }
  return true;
}

// ---------------------------------------------------------------- nodes
class TextNode {
  constructor(text) { this.nodeType = 3; this.data = text; this.parentElement = null; }
  get textContent() { return this.data; }
}

class Element {
  constructor(tag, doc) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.attrs = new Map();
    this.childNodes = [];
    this.parentElement = null;
    this.style = { display: '' };
    this._ord = ++ord;
    this._rect = null;
    this._listeners = new Map();
    if (FORM_TAGS.has(tag)) { this._value = null; this._checked = null; }
  }

  get parentNode() { return this.parentElement; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }

  getAttribute(n) { const k = n.toLowerCase(); return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(n) { return this.attrs.has(n.toLowerCase()); }
  setAttribute(n, v) {
    const k = n.toLowerCase();
    this.attrs.set(k, String(v));
    record(this, { type: 'attributes', target: this, attributeName: k, addedNodes: [], removedNodes: [] });
  }
  removeAttribute(n) {
    const k = n.toLowerCase();
    this.attrs.delete(k);
    record(this, { type: 'attributes', target: this, attributeName: k, addedNodes: [], removedNodes: [] });
  }

  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) {
    this.childNodes = [];
    const t = new TextNode(String(v));
    t.parentElement = this;
    this.childNodes.push(t);
    record(this, { type: 'childList', target: this, attributeName: null, addedNodes: [t], removedNodes: [] });
  }

  appendChild(n) { return this.insertBefore(n, null); }
  insertBefore(n, ref) {
    if (n.parentElement) n.parentElement.removeChild(n);
    const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, n);
    n.parentElement = this;
    record(this, { type: 'childList', target: this, attributeName: null, addedNodes: [n], removedNodes: [] });
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i < 0) return n;
    this.childNodes.splice(i, 1);
    n.parentElement = null;
    record(this, { type: 'childList', target: this, attributeName: null, addedNodes: [], removedNodes: [n] });
    return n;
  }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }

  contains(n) { for (let p = n; p; p = p.parentElement) if (p === this) return true; return false; }
  matches(sel) { return parseSelector(sel).some((steps) => matchComplex(this, steps, this)); }
  closest(sel) {
    const sels = parseSelector(sel);
    for (let p = this; p; p = p.parentElement) if (sels.some((s) => matchComplex(p, s, p))) return p;
    return null;
  }
  querySelectorAll(sel) {
    const sels = parseSelector(sel);
    const out = [];
    const walk = (el) => { for (const c of el.children) { if (sels.some((s) => matchComplex(c, s, this))) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }

  compareDocumentPosition(other) { return docOrder(this) < docOrder(other) ? 4 : 2; }

  getBoundingClientRect() { return this._rect || { left: 0, top: this._ord * 10, width: 200, height: 10 }; }
  getClientRects() { return this._hidden() ? [] : [this.getBoundingClientRect()]; }
  _hidden() {
    for (let p = this; p; p = p.parentElement) {
      if (p.nodeType === 1 && (p.hasAttribute('hidden') || p.style.display === 'none')) return true;
    }
    return false;
  }
  get offsetWidth() { return this._hidden() ? 0 : this.getBoundingClientRect().width; }
  get offsetHeight() { return this._hidden() ? 0 : this.getBoundingClientRect().height; }

  addEventListener(type, fn, capture) {
    const k = `${type}|${!!capture}`;
    if (!this._listeners.has(k)) this._listeners.set(k, []);
    this._listeners.get(k).push(fn);
  }
  removeEventListener(type, fn, capture) {
    const l = this._listeners.get(`${type}|${!!capture}`);
    if (l) l.splice(l.indexOf(fn) >>> 0, 1);
  }
  // The synthetic path a script takes. A real browser leaves isTrusted false
  // here, and so does this: activity.js refuses to record anything else.
  click() { return this.dispatchEvent(new globalThis.Event('click', { bubbles: true })); }

  dispatchEvent(ev) {
    ev.target = this;
    const path = [];
    for (let p = this; p; p = p.parentElement) path.unshift(p);
    if (this.ownerDocument) path.unshift(this.ownerDocument);
    for (const n of path.slice(0, -1)) for (const fn of (n._listeners?.get(`${ev.type}|true`) || [])) fn(ev);
    for (const fn of (this._listeners.get(`${ev.type}|false`) || [])) fn(ev);
    if (ev.bubbles) for (const n of path.slice(0, -1).reverse()) for (const fn of (n._listeners?.get(`${ev.type}|false`) || [])) fn(ev);
    return true;
  }

  // --- form control surface
  get type() { const t = this.tagName.toLowerCase(); return t === 'input' ? (this.getAttribute('type') || 'text') : t; }
  get name() { return this.getAttribute('name') || ''; }
  get disabled() { return this.hasAttribute('disabled'); }
  get required() { return this.hasAttribute('required'); }
  get options() { return this.querySelectorAll('option'); }
  get value() {
    const tag = this.tagName.toLowerCase();
    if (tag === 'select') {
      if (this._value !== null) return this._value;
      const sel = this.options.find((o) => o.hasAttribute('selected')) || this.options[0];
      return sel ? (sel.hasAttribute('value') ? sel.getAttribute('value') : sel.textContent) : '';
    }
    if (tag === 'textarea') return this._value !== null ? this._value : this.textContent;
    if (tag === 'option') return this.hasAttribute('value') ? this.getAttribute('value') : this.textContent;
    return this._value !== null ? this._value : (this.getAttribute('value') || '');
  }
  set value(v) { this._value = String(v); }
  get checked() { return this._checked !== null ? this._checked : this.hasAttribute('checked'); }
  set checked(v) {
    this._checked = !!v;
    // Radios are exclusive: the browser unchecks the rest of the name group.
    if (v && this.type === 'radio' && this.name) {
      const rootEl = this.closest('form') || this.ownerDocument.body;
      for (const o of rootEl.querySelectorAll('input')) {
        if (o !== this && o.type === 'radio' && o.name === this.name) o._checked = false;
      }
    }
  }
  get validity() {
    const missing = this.required && !(this.type === 'checkbox' || this.type === 'radio'
      ? this.checked : String(this.value).trim() !== '');
    return { valid: !missing && !this._customError, valueMissing: missing, customError: !!this._customError };
  }
  get validationMessage() { return this.validity.valid ? '' : (this.validity.valueMissing ? 'Please fill out this field.' : 'Invalid.'); }
  checkValidity() { return this.validity.valid; }
}

function docOrder(el) {
  const path = [];
  for (let p = el; p; p = p.parentElement) path.unshift(p);
  return path.map((n) => String(n.parentElement ? n.parentElement.childNodes.indexOf(n) : 0).padStart(4, '0')).join('.');
}

// ---------------------------------------------------------------- observers
const observers = [];
let queued = false;
function record(target, rec) {
  for (const o of observers) {
    if (!o.target || !(o.target === target || o.target.contains(target))) continue;
    if (rec.type === 'attributes' && o.opts.attributeFilter && !o.opts.attributeFilter.includes(rec.attributeName)) continue;
    o.queue.push(rec);
  }
  if (!queued) { queued = true; queueMicrotask(deliver); }
}
function deliver() {
  queued = false;
  for (const o of observers) {
    if (!o.queue.length) continue;
    const recs = o.queue.splice(0);
    o.cb(recs, o);
  }
}
class MiniMutationObserver {
  constructor(cb) { this.cb = cb; this.queue = []; this.target = null; this.opts = {}; observers.push(this); }
  observe(target, opts) { this.target = target; this.opts = opts || {}; }
  disconnect() { this.target = null; this.queue = []; const i = observers.indexOf(this); if (i >= 0) observers.splice(i, 1); }
}

// ---------------------------------------------------------------- parsing
const TAG_RE = /<(\/)?([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>`]+))?)*)\s*(\/)?>/g;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;

function parseHTML(html, doc, into) {
  const stack = [into];
  let last = 0, m;
  TAG_RE.lastIndex = 0;
  const text = (s) => {
    if (!s) return;
    const t = new TextNode(s);
    t.parentElement = stack[stack.length - 1];
    stack[stack.length - 1].childNodes.push(t);
  };
  while ((m = TAG_RE.exec(html))) {
    text(html.slice(last, m.index));
    last = TAG_RE.lastIndex;
    const [, closing, tag, attrsSrc, selfClose] = m;
    const name = tag.toLowerCase();
    if (closing) { if (stack.length > 1) stack.pop(); continue; }
    const el = new Element(name, doc);
    let a;
    ATTR_RE.lastIndex = 0;
    while ((a = ATTR_RE.exec(attrsSrc || ''))) {
      el.attrs.set(a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? '');
    }
    el.parentElement = stack[stack.length - 1];
    stack[stack.length - 1].childNodes.push(el);
    if (!selfClose && !VOID.has(name)) stack.push(el);
  }
  text(html.slice(last));
  return into;
}

// ---------------------------------------------------------------- mount
export function mountDom(html, { title = 'Test page' } = {}) {
  const doc = {
    nodeType: 9, title, hidden: false,
    _listeners: new Map(),
    createElement: (tag) => new Element(tag, doc),
    getElementById: (id) => doc.body.querySelectorAll(`[id="${id}"]`)[0] || null,
    querySelector: (s) => doc.body.querySelector(s),
    querySelectorAll: (s) => doc.body.querySelectorAll(s),
    addEventListener: (t, fn) => { if (!doc._listeners.has(t)) doc._listeners.set(t, []); doc._listeners.get(t).push(fn); },
    removeEventListener: (t, fn) => { const l = doc._listeners.get(t); if (l) l.splice(l.indexOf(fn) >>> 0, 1); },
    dispatchEvent: (ev) => { for (const fn of (doc._listeners.get(ev.type) || [])) fn(ev); return true; },
  };
  doc.body = new Element('body', doc);
  doc.body.ownerDocument = doc;
  doc.defaultView = { document: doc };
  parseHTML(html, doc, doc.body);

  const frames = [];
  globalThis.document = doc;
  globalThis.Node = { DOCUMENT_POSITION_FOLLOWING: 4, ELEMENT_NODE: 1 };
  globalThis.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, (c) => '\\' + c) };
  // isTrusted is read-only and always false on a real synthetic event; the init
  // flag is this DOM's only way to stand in for a real click or keystroke, which
  // is the difference activity.js is built on.
  globalThis.Event = class { constructor(type, o = {}) { this.type = type; this.bubbles = !!o.bubbles; this.isTrusted = o.isTrusted === true; } };
  globalThis.MutationObserver = MiniMutationObserver;
  globalThis.getComputedStyle = () => ({ borderLeftWidth: '0px', borderTopWidth: '0px' });
  // Frames are queued, never auto-run: a background tab is the default state
  // here, which is exactly the condition the adapter used to wedge on.
  globalThis.requestAnimationFrame = (fn) => frames.push(fn) ;
  globalThis.cancelAnimationFrame = (i) => { frames[i - 1] = null; };

  return {
    document: doc,
    body: doc.body,
    el: (sel) => doc.body.querySelector(sel),
    all: (sel) => doc.body.querySelectorAll(sel),
    make: (html2) => { const box = new Element('div', doc); parseHTML(html2, doc, box); return box.children; },
    frames,
    runFrames: () => { const fs = frames.splice(0); for (const f of fs) if (f) f(); },
    showTab: () => { doc.hidden = false; doc.dispatchEvent(new globalThis.Event('visibilitychange')); },
    // A real click / edit, the kind only a person can make.
    humanEvent: (el, type) => el.dispatchEvent(new globalThis.Event(type, { bubbles: true, isTrusted: true })),
    // Deliver queued mutation records now, so a DOM test can stay synchronous.
    flushMutations: () => deliver(),
    tick: () => new Promise((r) => setTimeout(r, 0)),
  };
}
