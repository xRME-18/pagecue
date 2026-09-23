// pagecue/src/overlay.js -- the ink layer: an SVG sheet plus absolutely
// positioned suggestion chips, laid over whatever container the host gives it.
//
// It knows nothing about forms, fields or validation. Every coordinate it needs
// arrives through four callbacks, so the same renderer draws over a DOM-scanned
// checkout and over a hand-wired claim form:
//
//   rectOf(fieldId)   -> {x,y,w,h} page-relative, or null if there is nothing to draw on
//   sectionRect(secId)-> {x,y,w,h} for section-wide hatching, or null
//   isParked(fieldId) -> a parking key (usually a section id) when the anchor is
//                        merely hidden, or null when it is simply gone
//   railX()           -> x of the margin rail notes *prefer*; it is a hint, not
//                        a law -- see chooseGutter in ink-engine.js
//   stateOf(fieldId)  -> {filled, errors} so guide_path can tick its steps off
//
// Ink stores field ids, never coordinates; geometry is recomputed from live
// rects on every change (rAF-coalesced) and each ink carries an integer seed, so
// a redraw reproduces the identical hand-drawn jitter instead of reshuffling.
import * as G from './ink-engine.js';

const TONE = { error: 'var(--ink-red)', attention: 'var(--ink-blue)', praise: 'var(--ink-green)' };
const TONE_TEXT = { error: 'var(--ink-red-text)', attention: 'var(--ink-blue-text)', praise: 'var(--ink-green-text)' };
const SVG_NS = 'http://www.w3.org/2000/svg';

// Two palettes, chosen by measured contrast against the background actually
// behind the ink -- not by what the page says its theme is. Strokes clear 3:1
// and note text clears 4.5:1 on cream, white and near-black (see the contrast
// tests in test/run.mjs). Same hues, different lightness, so pagecue still looks
// like pagecue on a dark SaaS page.
export const PALETTES = {
  light: {
    stroke: { blue: '#2563eb', red: '#dc2626', green: '#149144', amber: '#c2690a', purple: '#7c3aed', gray: '#6b7280' },
    text: { blue: '#1d4ed8', red: '#b91c1c', green: '#15803d', amber: '#b45309', purple: '#6d28d9', gray: '#4b5563' },
    chip: { bg: '#eff6ff', fg: '#1e293b', dim: '#4a5f8a' },
    paper: '#f6f3ec',
  },
  dark: {
    stroke: { blue: '#60a5fa', red: '#f87171', green: '#4ade80', amber: '#fbbf24', purple: '#a78bfa', gray: '#9ca3af' },
    text: { blue: '#93c5fd', red: '#fca5a5', green: '#86efac', amber: '#fcd34d', purple: '#c4b5fd', gray: '#d1d5db' },
    chip: { bg: '#111a2e', fg: '#e6edf7', dim: '#9fb3d1' },
    paper: '#111a2e',
  },
};
const WHITE = { r: 255, g: 255, b: 255, a: 1 };

const CSS = `
:root {
  --ink-blue: #2563eb; --ink-red: #dc2626; --ink-green: #149144;
  --ink-amber: #c2690a; --ink-purple: #7c3aed; --ink-gray: #6b7280;
  /* Note text runs a shade deeper than the stroke it belongs to: strokes only
     need 3:1, words need 4.5:1. The live values are set per ink by applyTheme. */
  --ink-blue-text: #1d4ed8; --ink-red-text: #b91c1c; --ink-green-text: #15803d;
  --ink-amber-text: #b45309; --ink-purple-text: #6d28d9; --ink-gray-text: #4b5563;
}
.pagecue-ink-layer { position: absolute; inset: 0; pointer-events: none; overflow: visible; z-index: 5; }
.pagecue-ink-layer .pagecue-fade-out { opacity: 0; transition: opacity .55s ease; }
.pagecue-note { font-family: "Bradley Hand", "Segoe Print", "Comic Sans MS", cursive; font-weight: 600; }
/* Ink text lands over whatever the page happens to have there, so every glyph
   carries a thin halo in the sampled background colour -- marker on glass, not
   a UI chip. paint-order keeps the halo behind the letterform. */
.pagecue-ink-layer text.pagecue-note { paint-order: stroke fill; stroke: var(--ink-halo, transparent);
  stroke-width: 3.5px; stroke-linejoin: round; stroke-linecap: round; stroke-opacity: .82; }
.pagecue-skip-tag { fill: var(--paper, #f6f3ec); opacity: .93; stroke: var(--ink-gray); stroke-width: 1; rx: 6; }
.pagecue-chips { position: absolute; inset: 0; pointer-events: none; z-index: 6; }
.pagecue-chip { position: absolute; pointer-events: auto; width: 235px; background: var(--chip-bg, #eff6ff);
  color: var(--chip-fg, inherit);
  border: 1.5px dashed var(--ink-blue); border-radius: 9px; padding: 8px 10px;
  font: 15px/1.45 -apple-system, "Segoe UI", system-ui, sans-serif;
  transform: rotate(-.7deg); box-shadow: 2px 3px 0 rgba(37,99,235,.12); }
.pagecue-chip-val { font-family: "Bradley Hand", "Segoe Print", cursive; font-weight: 700; color: var(--ink-blue-text); font-size: 15px; }
.pagecue-chip-why { font-size: 12px; color: var(--chip-dim, #4a5f8a); margin: 3px 0 6px; }
.pagecue-chip-row { display: flex; gap: 6px; }
.pagecue-chip-accept { background: var(--ink-blue); color: #fff; border: 0; border-radius: 6px;
  padding: 3px 12px; font-size: 12px; cursor: pointer; }
.pagecue-chip-accept:hover { background: #1d4ed8; }
.pagecue-chip-dismiss { background: transparent; border: 0; color: #8a8578; cursor: pointer; font-size: 12px; }
.pagecue-parked { font-size: 11px; color: var(--ink-blue); background: #dbeafe;
  border-radius: 999px; padding: 2px 8px; font-weight: 500; }

/* The activity strip. Same sheet as the ink, same opt-out attributes, but
   anchored to the viewport rather than to a target: it describes the page as a
   whole, so it does not belong beside any one thing on it. */
.pagecue-activity { position: fixed; left: 14px; bottom: 14px; z-index: 2147483000;
  font: 12px/1.45 -apple-system, "Segoe UI", system-ui, sans-serif;
  color: var(--strip-fg, #1e293b); max-width: min(320px, calc(100vw - 28px)); }
.pagecue-activity-pill { display: inline-flex; align-items: center; gap: 6px;
  background: var(--strip-bg, #ffffff); color: inherit;
  border: 1px solid var(--strip-line, #cbd5e1); border-radius: 999px;
  padding: 5px 12px; font: inherit; font-weight: 600; cursor: pointer;
  box-shadow: 0 2px 8px var(--strip-shadow, rgba(15,23,42,.14)); }
.pagecue-activity-pill:hover { border-color: var(--strip-dim, #64748b); }
.pagecue-activity-count { font-weight: 700; background: var(--strip-well, #eef2f7);
  border-radius: 999px; padding: 0 6px; }
.pagecue-activity-list { margin-top: 6px; background: var(--strip-bg, #ffffff);
  border: 1px solid var(--strip-line, #cbd5e1); border-radius: 10px; padding: 8px 10px;
  box-shadow: 0 6px 20px var(--strip-shadow, rgba(15,23,42,.16)); }
.pagecue-activity-row { display: flex; gap: 8px; padding: 3px 0; align-items: baseline; }
.pagecue-activity-row + .pagecue-activity-row { border-top: 1px solid var(--strip-well, #eef2f7); }
.pagecue-activity-who { flex: none; font-weight: 700; font-size: 10px; text-transform: uppercase;
  letter-spacing: .04em; color: var(--strip-dim, #64748b); min-width: 62px; }
.pagecue-activity-what { flex: 1 1 auto; }
.pagecue-activity-empty { color: var(--strip-dim, #64748b); }
.pagecue-activity-note { margin-top: 6px; padding-top: 6px; font-size: 10px; line-height: 1.35;
  color: var(--strip-dim, #64748b); border-top: 1px solid var(--strip-well, #eef2f7); }
`;

export function injectStyles(doc = document, nonce = '') {
  if (!doc || !doc.head || doc.getElementById('pagecue-overlay-styles')) return;
  const s = doc.createElement('style');
  s.id = 'pagecue-overlay-styles';
  if (nonce) s.nonce = nonce;
  s.textContent = CSS;
  doc.head.appendChild(s);
}

// The overlay is transparent, so "what colour is behind the ink" means walking
// up for the first element that actually paints a background and compositing
// anything translucent on the way. Module scope, because the activity strip
// answers the same question about its own corner of the page.
export function bgUnder(el) {
  let acc = null;
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.hasAttribute && n.hasAttribute('data-pagecue-overlay')) continue; // our own sheet
    const c = G.parseColor(getComputedStyle(n).backgroundColor);
    if (!c || !c.a) continue;
    acc = acc ? G.overColor(acc, c) : c;
    if (acc.a >= 0.999) return { ...acc, a: 1 };
  }
  // Nothing opaque all the way up: the canvas is whatever the UA paints.
  const root = el && el.ownerDocument ? el.ownerDocument.documentElement : null;
  const rc = root ? G.parseColor(getComputedStyle(root).backgroundColor) : null;
  const base = rc && rc.a >= 0.999 ? rc : WHITE;
  return acc ? { ...G.overColor(acc, base), a: 1 } : base;
}

export function createOverlay({
  container, registry,
  rectOf, sectionRect, isParked, railX,
  stateOf = () => ({ filled: false, errors: [] }),
  onAccept, onDismiss, onParked, styleNonce = '',
}) {
  injectStyles(container.ownerDocument, styleNonce);
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'pagecue-ink-layer');
  svg.setAttribute('data-pagecue-overlay', '');
  svg.setAttribute('aria-hidden', 'true');
  const chips = document.createElement('div');
  chips.className = 'pagecue-chips';
  chips.setAttribute('data-pagecue-overlay', '');
  container.append(svg, chips);

  const drawn = new Map();      // inkId -> {g, fading}
  const animatedIds = new Set(); // ink that already played its draw-in
  let raf = 0;
  let disposed = false;

  const schedule = () => {
    if (disposed || raf) return;
    raf = requestAnimationFrame(() => { raf = 0; draw(); });
  };

  // The sheet must be as tall as the host's content -- but measuring with
  // scrollHeight would include the sheet itself, which then never shrinks
  // again (an absolutely positioned child counts toward scroll overflow).
  // Measure the container's own layout height plus its real children instead.
  function contentHeight() {
    const top = container.getBoundingClientRect().top;
    let h = container.clientHeight;
    for (const child of container.children) {
      if (child === svg || child === chips) continue;
      if (child.nodeType === 1 && child.hasAttribute('data-pagecue-overlay')) continue;
      const r = child.getBoundingClientRect();
      if (r.width || r.height) h = Math.max(h, r.bottom - top);
    }
    return Math.ceil(h);
  }

  // ------------------------------------------------------------- palette
  let theme = { name: 'light', pal: PALETTES.light, bg: WHITE };

  function themeFor(bg) {
    const pick = G.pickPalette(bg, { light: PALETTES.light.text, dark: PALETTES.dark.text });
    return { name: pick.name, pal: PALETTES[pick.name], bg };
  }

  function applyTheme(el, t) {
    const css = (k, v) => el.style.setProperty(k, v);
    for (const [k, v] of Object.entries(t.pal.stroke)) css(`--ink-${k}`, v);
    for (const [k, v] of Object.entries(t.pal.text)) css(`--ink-${k}-text`, v);
    css('--ink-halo', `rgb(${Math.round(t.bg.r)} ${Math.round(t.bg.g)} ${Math.round(t.bg.b)})`);
    css('--paper', t.pal.paper);
    css('--chip-bg', t.pal.chip.bg); css('--chip-fg', t.pal.chip.fg); css('--chip-dim', t.pal.chip.dim);
  }

  // Per-ink sampling: a dark page can hold a white card, and ink for a field on
  // that card has to read against the card. Probe *around* the target -- the
  // ink lands beside it, not inside it, and an input's own white box says
  // nothing about the page it sits on. Any disagreement between the probes, or
  // anything off-screen, keeps the sheet-wide choice.
  function themeAt(r) {
    const doc = container.ownerDocument;
    const view = doc && doc.defaultView;
    if (!view || typeof doc.elementFromPoint !== 'function') return theme;
    const c = container.getBoundingClientRect();
    const cs = getComputedStyle(container);
    const ox = c.left + (parseFloat(cs.borderLeftWidth) || 0);
    const oy = c.top + (parseFloat(cs.borderTopWidth) || 0);
    const probes = [
      [r.x - 10, r.y + r.h / 2], [r.x + r.w + 10, r.y + r.h / 2], [r.x + r.w / 2, r.y - 14],
    ];
    let found = null;
    for (const [px, py] of probes) {
      const x = ox + px, y = oy + py;
      if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) continue;
      const hit = doc.elementFromPoint(x, y);
      if (!hit || (hit.closest && hit.closest('[data-pagecue-overlay]'))) continue;
      const t = themeFor(bgUnder(hit));
      if (found && found.name !== t.name) return theme;   // ambiguous: stay global
      found = found || t;
    }
    if (!found || found.name === theme.name) return theme;
    return found;
  }

  const MARGIN = 8;          // ink never lands closer than this to the sheet edge
  const NOTE_MAX = 240;      // a hand-written note wider than this stops reading as one
  const NOTE_MIN = 110;

  let bounds = { x: 0, y: 0, w: 0, h: 0 };
  let pendingChips = [];     // suggest chips are laid out after every ink is measured

  function draw() {
    if (disposed) return;
    const p = container.getBoundingClientRect();
    const h = contentHeight();
    svg.setAttribute('width', p.width); svg.setAttribute('height', h);
    svg.setAttribute('viewBox', `0 0 ${p.width} ${h}`);
    bounds = { x: 0, y: 0, w: p.width, h };
    textRectCache = new Map();   // one frame's worth of measured page text
    theme = themeFor(bgUnder(container));
    applyTheme(svg, theme); applyTheme(chips, theme);

    chips.replaceChildren();
    pendingChips = [];
    const parked = new Map();
    const seen = new Set();
    const live = [];
    for (const ink of registry.list()) {
      seen.add(ink.id);
      if (ink.status === 'resolved') { fadeOut(ink); continue; }
      const keys = (ink.fields || []).map((f) => isParked(f)).filter(Boolean);
      if (ink.kind !== 'skip' && (ink.fields || []).length && keys.length === ink.fields.length) {
        for (const k of keys) parked.set(k, (parked.get(k) || 0) + 1);
        removeGroup(ink.id); continue; // fully parked: badge only
      }
      live.push(ink);
    }
    // Placement needs to know what is already spoken for before the first
    // stroke lands: the circles' footprints (pure math, no DOM) and the label
    // band above every annotated control -- rectOf reports the control, but the
    // words that name it sit just above it and a note must not land on them.
    const occupied = [];
    const bands = [];
    for (const ink of live) {
      for (const f of ink.fields || []) {
        const r = rectOf(f);
        if (r) bands.push(G.labelBand(r));
      }
      if (ink.kind !== 'circle') continue;
      const r = rectOf(ink.fields[0]); if (!r) continue;
      const c = G.clampCircle(r, circleOpts(r));
      occupied.push({ x: c.cx - c.rx, y: c.cy - c.ry, w: c.rx * 2, h: c.ry * 2 });
    }
    const env = { occupied, bands };
    for (const ink of live) renderInk(ink, env);
    layoutChips(env);
    for (const [id, d] of drawn) if (!seen.has(id)) { d.g.remove(); drawn.delete(id); }
    if (onParked) onParked(parked);
  }

  function removeGroup(id) { const d = drawn.get(id); if (d) { d.g.remove(); drawn.delete(id); } }

  function fadeOut(ink) {
    const d = drawn.get(ink.id);
    if (d) {
      if (!d.fading) {
        d.fading = true;
        d.g.classList.add('pagecue-fade-out');
        setTimeout(() => { d.g.remove(); drawn.delete(ink.id); registry.gc(ink.id); }, 700);
      }
    } else registry.gc(ink.id);
  }

  function group(ink) {
    removeGroup(ink.id);
    const g = document.createElementNS(SVG_NS, 'g');
    g.dataset.ink = ink.id;
    svg.appendChild(g);
    const wasAnimated = animatedIds.has(ink.id);
    drawn.set(ink.id, { g, animated: wasAnimated });
    return { g, first: !wasAnimated };
  }

  function stroke(g, d, color, wpx, dash) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d); path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color); path.setAttribute('stroke-width', wpx);
    path.setAttribute('stroke-linecap', 'round');
    if (dash) path.setAttribute('stroke-dasharray', dash);
    g.appendChild(path);
    return path;
  }

  function addSpan(t, str, x, y) {
    const s = document.createElementNS(SVG_NS, 'tspan');
    s.setAttribute('x', x); s.setAttribute('y', y); s.textContent = str; t.appendChild(s);
  }

  // A note is measured, not guessed. wrapText picks the line breaks from a glyph
  // estimate, then the inserted text reports its real box via getBBox and *that*
  // is what placement gets -- which is the only way to promise a note never
  // crosses the edge of the sheet.
  function noteBlock(g, str, color, size, maxWidth) {
    const wrap = G.wrapText(str, maxWidth, size);
    const holder = document.createElementNS(SVG_NS, 'g');
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('fill', color); t.setAttribute('class', 'pagecue-note');
    t.setAttribute('font-size', size);
    wrap.lines.forEach((ln, i) => addSpan(t, ln, 0, (i + 1) * wrap.lineHeight));
    holder.appendChild(t); g.appendChild(holder);
    // getBBox throws (or reports nothing) while the sheet is display:none; the
    // estimate carries that frame and the next draw measures for real.
    let box = { x: 0, y: 0, width: wrap.w, height: wrap.h };
    try { const b = t.getBBox(); if (b.width > 0) box = b; } catch { /* unrendered */ }
    return {
      el: holder, w: box.width, h: box.height,
      place(x, y) {
        holder.setAttribute('transform', `translate(${(x - box.x).toFixed(1)} ${(y - box.y).toFixed(1)})`);
        return { x, y, w: box.width, h: box.height };
      },
      raise() { g.appendChild(holder); }, // keep ink under the words it explains
    };
  }

  // Widest note this target can afford, before anything is measured. Wrapping
  // to the gutter that will actually hold it is what keeps a note beside its
  // field instead of exiled to the page margin.
  function noteBudget(r, prefer = 'right') {
    const gt = G.gutters(r, bounds, { gap: 18, margin: MARGIN });
    const near = gt.space(gt[prefer]), far = gt.space(gt[prefer === 'right' ? 'left' : 'right']);
    // Wrap to the near gutter whenever it can hold a note at all: a narrower
    // note beside its field beats a wide one exiled across the page.
    const room = near >= NOTE_MIN ? near : (far >= NOTE_MIN ? far : bounds.w - MARGIN * 2);
    return G.clamp(room, NOTE_MIN, NOTE_MAX);
  }

  // Padding scales a little with the target so an icon button gets a tight loop
  // and a whole region gets a loose one, and never so tight it inks the text.
  function circleOpts(r) {
    return { pad: G.clamp(Math.min(r.w, r.h) * 0.22, 10, 22), maxAspect: 4.5, minR: 16 };
  }

  // rectOf reports controls, not prose, so the sheet cannot know from geometry
  // alone where a page's words are. Probe the live page under a placed box and
  // measure what is actually there: a block element is mostly empty space, and
  // the blank half of a label's line is a perfectly good place for a note.
  const CONTROL = /^(INPUT|SELECT|TEXTAREA|BUTTON|A|SUMMARY|IMG|SVG)$/;
  let textRectCache = new Map();

  function sheetOffset() {
    const c = container.getBoundingClientRect(), cs = getComputedStyle(container);
    return [c.left + (parseFloat(cs.borderLeftWidth) || 0), c.top + (parseFloat(cs.borderTopWidth) || 0)];
  }

  // The line boxes of an element's own text, in sheet coordinates.
  function textRects(el, ox, oy) {
    if (textRectCache.has(el)) return textRectCache.get(el);
    const out = [];
    const doc = container.ownerDocument;
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.textContent.trim()) continue;
      const range = doc.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (r.width || r.height) out.push({ x: r.left - ox, y: r.top - oy, w: r.width, h: r.height });
      }
    }
    textRectCache.set(el, out);
    return out;
  }

  function hitsWords(box) {
    const doc = container.ownerDocument, view = doc && doc.defaultView;
    if (!view || typeof doc.elementFromPoint !== 'function') return false;
    const [ox, oy] = sheetOffset();
    const probes = [
      [box.x + 4, box.y + 4], [box.x + box.w - 4, box.y + 4],
      [box.x + 4, box.y + box.h - 4], [box.x + box.w - 4, box.y + box.h - 4],
      [box.x + box.w / 2, box.y + box.h / 2],
    ];
    for (const [px, py] of probes) {
      const x = ox + px, y = oy + py;
      if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) continue;
      const el = doc.elementFromPoint(x, y);
      if (!el || (el.closest && el.closest('[data-pagecue-overlay]'))) continue;
      // Never cover something the human can click or type into, whatever it holds.
      if (CONTROL.test(el.tagName)) return true;
      for (const tr of textRects(el, ox, oy)) if (G.rectsOverlap(box, tr)) return true;
    }
    return false;
  }

  // Look for a clear spot near the chosen one: the same row at another x first
  // (the blank end of a label's line), then a little further down. If nothing
  // within reach is clear the original spot stands -- the halo keeps the words
  // legible, and a note that wandered half a page away is worse.
  function slideClear(box, side, xs = [], avoid = []) {
    const opts = [box.x, ...xs].map((x) => G.clamp(x, MARGIN, Math.max(MARGIN, bounds.w - MARGIN - box.w)))
      .filter((x, i, a) => a.indexOf(x) === i);
    const dir = side === 'above' ? -1 : 1;
    for (let i = 0; i <= 10; i++) {
      const y = box.y + dir * i * 12;
      if (y < MARGIN || y + box.h > bounds.h - MARGIN) break;
      for (const x of opts) {
        const t = { ...box, x, y };
        if (!avoid.some((a) => G.rectsOverlap(t, a, 2)) && !hitsWords(t)) return t;
      }
    }
    return box;
  }

  // Place a measured note and record its footprint, so the next ink in this
  // frame treats it as occupied instead of drawing over it.
  function placeNote(block, target, env, opts) {
    const avoid = env.bands.concat(env.occupied);
    const spot = G.chooseGutter(target, bounds, { w: block.w, h: block.h }, {
      gap: 18, margin: MARGIN, rail: railX(), avoid, ...opts,
    });
    // On a full-bleed layout there is no gutter, so the note also gets to try
    // the far end of the target's own row before it settles.
    const clear = slideClear({ x: spot.x, y: spot.y, w: block.w, h: block.h }, spot.side,
      [target.x + target.w - block.w, target.x + target.w / 2 - block.w / 2], env.occupied);
    const box = block.place(clear.x, clear.y);
    const placed = { ...box, side: spot.side };
    env.occupied.push({ x: placed.x, y: placed.y, w: placed.w, h: placed.h });
    return placed;
  }

  function connect(g, target, note, seed, color, width = 2.2, dash) {
    const { from, to } = G.connectorEnds(target, note, note.side);
    const pts = G.curvePts(from[0], from[1], to[0], to[1], 0.16, 16);
    stroke(g, G.roughD(pts, seed, 1.6), color, width, dash);
    return pts;
  }

  function animateIn(inkObj, g, first) {
    if (!first) return;
    animatedIds.add(inkObj.id);
    let delay = 0;
    for (const path of g.querySelectorAll('path')) {
      const L = path.getTotalLength();
      path.style.strokeDasharray = path.getAttribute('stroke-dasharray') ? path.style.strokeDasharray : `${L}`;
      path.style.strokeDashoffset = `${L}`;
      path.getBoundingClientRect();
      path.style.transition = `stroke-dashoffset .45s ease ${delay}s`;
      path.style.strokeDashoffset = '0';
      delay += 0.12;
    }
    for (const t of g.querySelectorAll('text')) {
      t.style.opacity = '0'; t.getBoundingClientRect();
      t.style.transition = `opacity .4s ease ${delay}s`; t.style.opacity = '1';
    }
  }

  function renderInk(ink, env = { occupied: [], bands: [] }) {
    const seed = ink.seed;
    if (ink.kind === 'circle') {
      const r = rectOf(ink.fields[0]); if (!r) { removeGroup(ink.id); return; }
      const { g, first } = group(ink);
      applyTheme(g, themeAt(r));
      const color = TONE[ink.tone] || TONE.attention;
      const c = G.clampCircle(r, circleOpts(r));
      const pts = G.ellipseLoopPts(c.cx, c.cy, c.rx, c.ry, seed);
      stroke(g, G.roughD(pts, seed, 2.2), color, 2.6);
      if (ink.note) {
        const block = noteBlock(g, ink.note, TONE_TEXT[ink.tone] || TONE_TEXT.attention, 14, noteBudget(r));
        // Hang the note off the *loop*, not the field, or a clamped wide circle
        // swallows it.
        const loop = { x: c.cx - c.rx, y: c.cy - c.ry, w: c.rx * 2, h: c.ry * 2 };
        const note = placeNote(block, loop, env, { desiredY: r.y - 4 });
        // A note that ended up far from its loop needs a thread back to it.
        const far = note.side === 'below' || note.side === 'above'
          || Math.abs((note.side === 'left' ? loop.x - (note.x + note.w) : note.x - (loop.x + loop.w))) > 40;
        if (far) connect(g, loop, note, seed + 3, color, 1.6, '4 6');
        block.raise();
      }
      animateIn(ink, g, first);
    } else if (ink.kind === 'point') {
      const r = rectOf(ink.fields[0]); if (!r) { removeGroup(ink.id); return; }
      const { g, first } = group(ink);
      applyTheme(g, themeAt(r));
      const color = 'var(--ink-blue)';
      const block = noteBlock(g, ink.note, 'var(--ink-blue-text)', 14, noteBudget(r));
      const note = placeNote(block, r, env, { desiredY: r.y - 8 + (seed % 3) * 6 });
      const pts = connect(g, r, note, seed, color);
      stroke(g, G.arrowheadD(pts[pts.length - 1][0], pts[pts.length - 1][1], G.angleOf(pts), seed), color, 2.2);
      block.raise();
      animateIn(ink, g, first);
    } else if (ink.kind === 'link') {
      const a = rectOf(ink.fields[0]), b = rectOf(ink.fields[1]);
      if (!a || !b) { removeGroup(ink.id); return; }
      const { g, first } = group(ink);
      applyTheme(g, themeAt(a));
      const color = 'var(--ink-amber)';
      // The arc bulges into whichever margin actually exists; on a two-column
      // form the right one often does not.
      const rightRoom = bounds.w - MARGIN - Math.max(a.x + a.w, b.x + b.w);
      const leftRoom = Math.min(a.x, b.x) - MARGIN;
      const right = rightRoom >= leftRoom;
      const x1 = right ? a.x + a.w + 6 : a.x - 6, y1 = a.y + a.h / 2;
      const x2 = right ? b.x + b.w + 6 : b.x - 6, y2 = b.y + b.h / 2;
      const bulge = G.clamp(right ? Math.min(rightRoom, 70) : Math.min(leftRoom, 70), 18, 70);
      const cx = right ? Math.max(x1, x2) + bulge : Math.min(x1, x2) - bulge;
      const cy = (y1 + y2) / 2;
      const pts = [];
      for (let i = 0; i <= 22; i++) { const t = i / 22, u = 1 - t; pts.push([u * u * x1 + 2 * u * t * cx + t * t * x2, u * u * y1 + 2 * u * t * cy + t * t * y2]); }
      stroke(g, G.roughD(pts, seed, 1.8), color, 2.3);
      stroke(g, G.arrowheadD(x2, y2, G.angleOf(pts), seed), color, 2.3);
      const block = noteBlock(g, ink.label, 'var(--ink-amber-text)', 14, G.clamp(bulge + 90, NOTE_MIN, NOTE_MAX));
      // The label rides the bend, but not on top of a label band or earlier ink.
      const at = G.chooseGutter({ x: cx - 4, y: cy - 4, w: 8, h: 8 }, bounds, { w: block.w, h: block.h }, {
        gap: 8, margin: MARGIN, prefer: right ? 'right' : 'left',
        desiredY: cy - block.h / 2, avoid: env.bands.concat(env.occupied),
      });
      const spot = slideClear({ x: at.x, y: at.y, w: block.w, h: block.h }, at.side, [], env.occupied);
      block.place(spot.x, spot.y);
      env.occupied.push(spot);
      block.raise();
      animateIn(ink, g, first);
    } else if (ink.kind === 'skip') {
      const r = sectionRect(ink.section); if (!r) { removeGroup(ink.id); return; }
      const { g, first } = group(ink);
      applyTheme(g, themeAt(r));
      const color = 'var(--ink-gray)';
      // Hatch density follows the region: dense strokes over a tall section read
      // as a smear and hide the text underneath it.
      const gap = G.clamp(Math.min(r.w, r.h) / 6, 30, 64);
      for (const s of G.hatchSegs(r.x + 4, r.y + 4, r.w - 8, r.h - 8, gap)) {
        const path = stroke(g, G.roughD(G.linePts(s.x1, s.y1, s.x2, s.y2, 6), seed + s.x1, 2.5), color, 1.6);
        path.setAttribute('stroke-opacity', '.5'); // the section stays readable through it
      }
      const tag = document.createElementNS(SVG_NS, 'g');
      g.appendChild(tag);
      const label = noteBlock(tag, 'skip — ' + ink.reason, 'var(--ink-gray-text)', 13,
        G.clamp(r.w - 40, NOTE_MIN, NOTE_MAX));
      const padX = 12, padY = 8;
      const tw = label.w + padX * 2, th = label.h + padY * 2;
      const tx = G.clamp(r.x + r.w / 2 - tw / 2, MARGIN, Math.max(MARGIN, bounds.w - MARGIN - tw));
      // Centred in the section, but nudged down its middle if that lands on a
      // line of the very text it is explaining away.
      const ty = slideClear({ x: tx, y: G.clamp(r.y + r.h / 2 - th / 2, MARGIN, Math.max(MARGIN, bounds.h - MARGIN - th)), w: tw, h: th }, 'below', [], env.occupied).y;
      env.occupied.push({ x: tx, y: ty, w: tw, h: th });
      const bg = document.createElementNS(SVG_NS, 'rect');
      bg.setAttribute('x', tx); bg.setAttribute('y', ty);
      bg.setAttribute('width', tw); bg.setAttribute('height', th);
      bg.setAttribute('class', 'pagecue-skip-tag'); tag.appendChild(bg);
      label.place(tx + padX, ty + padY);
      label.raise();
      animateIn(ink, g, first);
    } else if (ink.kind === 'path') {
      const rects = ink.fields.map((f) => ({ f, r: rectOf(f) })).filter((x) => x.r);
      if (rects.length < 2) { removeGroup(ink.id); return; }
      const { g, first } = group(ink);
      applyTheme(g, themeAt(rects[0].r));
      const color = 'var(--ink-purple)';
      const R = 12;
      // Markers pick their own gutter per step and step around each other and
      // around ink already drawn, so a two-column route stays a route.
      const marks = G.planStepMarkers(rects.map((x) => x.r), bounds, {
        r: R, gap: 14, minGap: 8, prefer: 'left',
        avoid: env.occupied.concat(rects.map((x) => x.r)),
      });
      for (let i = 0; i < marks.length - 1; i++) {
        const a = marks[i], b = marks[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
        const off = R + 4;
        const pts = G.curvePts(a.x + ux * off, a.y + uy * off, b.x - ux * off, b.y - uy * off, 0.1, 12);
        stroke(g, G.roughD(pts, seed + i, 1.5), color, 1.8, '5 7');
      }
      rects.forEach(({ f }, i) => {
        const st = stateOf(f) || { filled: false, errors: [] };
        const done = st.filled && st.errors.length === 0;
        const m = marks[i];
        const pts = G.ellipseLoopPts(m.x, m.y, R, R, seed + i * 7, 1.05, 24);
        stroke(g, G.roughD(pts, seed + i * 7, 1.2), done ? 'var(--ink-green)' : color, 2);
        const n = document.createElementNS(SVG_NS, 'text');
        n.setAttribute('x', m.x); n.setAttribute('y', m.y + 5);
        n.setAttribute('text-anchor', 'middle'); n.setAttribute('class', 'pagecue-note');
        n.setAttribute('font-size', 14); n.setAttribute('fill', done ? 'var(--ink-green)' : color);
        n.textContent = done ? '✓' : String(i + 1);
        g.appendChild(n);
      });
      for (const m of marks) env.occupied.push({ x: m.x - R, y: m.y - R, w: R * 2, h: R * 2 });
      if (ink.note) {
        // The caption used to sit a fixed 26px above step 1 -- which on a real
        // form is exactly where that field's label is. Let it choose a gutter
        // like every other note, with the whole route counted as occupied.
        const block = noteBlock(g, ink.note, 'var(--ink-purple)', 13, NOTE_MAX);
        const head = rects[0].r;
        placeNote(block, { x: Math.min(marks[0].x - R, head.x), y: head.y, w: Math.max(head.x + head.w, marks[0].x + R) - Math.min(marks[0].x - R, head.x), h: head.h }, env,
          { prefer: marks[0].side === 'left' ? 'left' : 'right', desiredY: marks[0].y - R - block.h - 6 });
        block.raise();
      }
      animateIn(ink, g, first);
    } else if (ink.kind === 'suggest') {
      const r = rectOf(ink.fields[0]); if (!r) { removeGroup(ink.id); return; }
      const { g, first } = group(ink);
      const t = themeAt(r);
      applyTheme(g, t);
      const chip = document.createElement('div');
      chip.className = 'pagecue-chip';
      applyTheme(chip, t);
      const value = document.createElement('div');
      value.className = 'pagecue-chip-val';
      value.textContent = `✎ ${ink.value}`;
      const why = document.createElement('div');
      why.className = 'pagecue-chip-why';
      why.textContent = ink.why || '';
      chip.append(value, why);
      const row = document.createElement('div');
      row.className = 'pagecue-chip-row';
      const acc = document.createElement('button');
      acc.className = 'pagecue-chip-accept'; acc.type = 'button'; acc.textContent = 'Accept';
      acc.setAttribute('aria-label', `Accept suggestion for ${ink.fields[0]}`);
      acc.onclick = () => onAccept && onAccept(ink);
      const dis = document.createElement('button');
      dis.className = 'pagecue-chip-dismiss'; dis.type = 'button'; dis.textContent = '✕';
      dis.title = 'Dismiss suggestion';
      dis.setAttribute('aria-label', `Dismiss suggestion for ${ink.fields[0]}`);
      dis.onclick = () => (onDismiss ? onDismiss(ink) : registry.resolve(ink.id, 'dismissed'));
      row.append(acc, dis); chip.appendChild(row); chips.appendChild(chip);
      // Position comes later: a chip's height is only known once it is in the
      // DOM, and where it lands depends on every other chip in this frame.
      pendingChips.push({ ink, chip, r, g, first });
    }
  }

  // Chips are HTML, so they are placed in one pass at the end of the frame:
  // choose a gutter each, stack the overlaps downward, then draw each
  // connector to the field it belongs to -- after the stacking moved it.
  function layoutChips(env = { occupied: [], bands: [] }) {
    if (!pendingChips.length) return;
    const avoid = env.bands.concat(env.occupied);
    const boxes = pendingChips.map(({ chip, r }) => {
      const w = chip.offsetWidth || 235, h = chip.offsetHeight || 96;
      const spot = G.chooseGutter(r, bounds, { w, h }, {
        gap: 18, margin: MARGIN, rail: railX(), desiredY: r.y - 6, avoid,
      });
      const clear = slideClear({ x: spot.x, y: spot.y, w, h }, spot.side, [r.x + r.w - w], env.occupied);
      return { x: clear.x, y: clear.y, w, h, side: spot.side };
    });
    const placed = G.stackBoxes(boxes, { gap: 10, bounds, margin: MARGIN });
    for (const b of placed) env.occupied.push({ x: b.x, y: b.y, w: b.w, h: b.h });
    pendingChips.forEach((pc, i) => {
      const box = { ...placed[i], side: boxes[i].side };
      pc.chip.style.left = box.x + 'px';
      pc.chip.style.top = box.y + 'px';
      // Stacking may have pushed the chip past its field, so the connector is
      // drawn from the final box and still lands on the right field.
      connect(pc.g, pc.r, box, pc.ink.seed, 'var(--ink-blue)', 1.8, '3 6');
      animateIn(pc.ink, pc.g, pc.first);
    });
    pendingChips = [];
  }

  const unsub = registry.subscribe(schedule);
  const ro = new ResizeObserver(schedule);
  ro.observe(container);
  window.addEventListener('resize', schedule);
  // A theme flip repaints the page under the ink; the palette is re-sampled on
  // the next draw, so all this has to do is ask for one.
  const scheme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  if (scheme && scheme.addEventListener) scheme.addEventListener('change', schedule);
  schedule();

  return {
    schedule, draw,
    element: svg,
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      unsub(); ro.disconnect();
      window.removeEventListener('resize', schedule);
      if (scheme && scheme.removeEventListener) scheme.removeEventListener('change', schedule);
      svg.remove(); chips.remove();
      drawn.clear();
    },
  };
}

// createActivityStrip({ container, activity }) -> the visible half of the trail.
//
// The agent gets the same rows through read_activity; this is so the visitor can
// see the record that is being kept about them, on the page it is being kept
// about, without opening anything. It mounts exactly the way the ink sheet does
// -- a sibling of the page's own content, stamped data-pagecue-overlay so the
// adapter never scans it and the agent can never point at it.
//
// Collapsed by default: a running count, and nothing else, until it is asked.
//
// Its palette is picked the way the ink's is -- by measuring what is actually
// painted behind it, not by asking the OS what theme it prefers. A cream page
// in a dark-mode browser is still a cream page, and a panel that trusted
// prefers-color-scheme there would be a dark slab on light paper.
export const STRIP_PALETTES = {
  light: { fg: '#1e293b', bg: '#ffffff', line: '#cbd5e1', dim: '#64748b', well: '#eef2f7', shadow: 'rgba(15,23,42,.16)' },
  dark: { fg: '#e6edf7', bg: '#111a2e', line: '#33415c', dim: '#9fb3d1', well: '#1b2740', shadow: 'rgba(0,0,0,.45)' },
};

export function createActivityStrip({ container, activity, max = 8, styleNonce = '' }) {
  const doc = container.ownerDocument;
  injectStyles(doc, styleNonce);

  const box = doc.createElement('div');
  box.className = 'pagecue-activity';
  box.setAttribute('data-pagecue-overlay', '');
  box.setAttribute('data-pagecue-ignore', '');

  const pill = doc.createElement('button');
  pill.type = 'button';
  pill.className = 'pagecue-activity-pill';
  pill.setAttribute('aria-expanded', 'false');

  const title = doc.createElement('span');
  // Not "your": the rows labelled `input` were dispatched by the browser, and
  // the page cannot tell the person reading this from an agent driving it.
  title.textContent = 'Activity on this page';
  const count = doc.createElement('span');
  count.className = 'pagecue-activity-count';
  pill.append(title, count);

  const list = doc.createElement('div');
  list.className = 'pagecue-activity-list';
  list.hidden = true;
  box.append(pill, list);
  container.appendChild(box);

  let open = false;

  function row(entry) {
    const el = doc.createElement('div');
    el.className = 'pagecue-activity-row';
    const who = doc.createElement('span');
    who.className = 'pagecue-activity-who';
    who.textContent = activity.whoLabel(entry);
    const what = doc.createElement('span');
    what.className = 'pagecue-activity-what';
    what.textContent = activity.describe(entry);
    el.append(who, what);
    return el;
  }

  // Re-measured on every render: the host may repaint, and a strip that read the
  // page once at start-up would keep the first answer forever.
  function retheme() {
    if (typeof getComputedStyle !== 'function') return;
    const pick = G.pickPalette(bgUnder(container), { light: PALETTES.light.text, dark: PALETTES.dark.text });
    const pal = STRIP_PALETTES[pick.name] || STRIP_PALETTES.light;
    for (const [k, v] of Object.entries(pal)) box.style.setProperty(`--strip-${k}`, v);
  }

  function render() {
    retheme();
    // The identical rows the tool returns -- one source, so the visitor and the
    // agent can never be shown different records of the same page.
    const entries = activity.entries();
    count.textContent = String(entries.length);
    pill.setAttribute('aria-expanded', String(open));
    list.hidden = !open;
    if (!open) return;
    const shown = entries.slice(-max);
    // The same caveat the tool result carries, in small print under the rows:
    // the person the record is about reads exactly what the agent reads.
    const note = doc.createElement('div');
    note.className = 'pagecue-activity-note';
    note.textContent = activity.attestationNote;
    if (!shown.length) {
      const empty = doc.createElement('div');
      empty.className = 'pagecue-activity-empty';
      empty.textContent = 'Nothing recorded here yet.';
      list.replaceChildren(empty, note);
      return;
    }
    list.replaceChildren(...shown.map(row), note);
  }

  pill.addEventListener('click', () => { open = !open; render(); });
  const unsub = activity.subscribe(render);
  // A theme flip repaints the page under the strip; re-measure when it does.
  const scheme = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (scheme && scheme.addEventListener) scheme.addEventListener('change', render);
  render();

  return {
    element: box,
    render,
    get open() { return open; },
    dispose() {
      unsub();
      if (scheme && scheme.removeEventListener) scheme.removeEventListener('change', render);
      box.remove();
    },
  };
}
