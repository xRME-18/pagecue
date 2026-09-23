// pagecue/src/ink-engine.js -- hand-drawn geometry, DOM-free and deterministic.
// Every generator takes a seed so a re-render (scroll, resize, collapse)
// redraws the exact same wobble instead of reshuffling the ink.

export function mulberry(seed) {
  let t = seed >>> 0;
  return function () {
    t |= 0; t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Sample a straight line into n points.
export function linePts(x1, y1, x2, y2, n = 10) {
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push([x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n]);
  return pts;
}

// Sample a quadratic curve (control point perpendicular to the chord).
export function curvePts(x1, y1, x2, y2, bend = 0.22, n = 18) {
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const dx = x2 - x1, dy = y2 - y1;
  const cx = mx - dy * bend, cy = my + dx * bend;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push([u * u * x1 + 2 * u * t * cx + t * t * x2, u * u * y1 + 2 * u * t * cy + t * t * y2]);
  }
  return pts;
}

// A marker-style circling: slightly more than one loop, radius drifting out.
export function ellipseLoopPts(cx, cy, rx, ry, seed, turns = 1.14, n = 44) {
  const rnd = mulberry(seed);
  const start = -Math.PI * (0.55 + rnd() * 0.3);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = start + t * turns * 2 * Math.PI;
    const drift = 1 + t * 0.07 + (rnd() - 0.5) * 0.02;
    pts.push([cx + Math.cos(a) * rx * drift, cy + Math.sin(a) * ry * drift]);
  }
  return pts;
}

// Jitter points and join them with midpoint quadratics -> an SVG path d.
export function roughD(pts, seed, amp = 1.7) {
  const rnd = mulberry(seed);
  const j = pts.map(([x, y], i) => {
    const k = i === 0 || i === pts.length - 1 ? 0.6 : 1;
    return [x + (rnd() - 0.5) * 2 * amp * k, y + (rnd() - 0.5) * 2 * amp * k];
  });
  const f = (v) => (Math.round(v * 10) / 10).toString();
  let d = `M${f(j[0][0])} ${f(j[0][1])}`;
  for (let i = 1; i < j.length - 1; i++) {
    const mx = (j[i][0] + j[i + 1][0]) / 2, my = (j[i][1] + j[i + 1][1]) / 2;
    d += ` Q${f(j[i][0])} ${f(j[i][1])} ${f(mx)} ${f(my)}`;
  }
  const last = j[j.length - 1];
  d += ` L${f(last[0])} ${f(last[1])}`;
  return d;
}

// Arrowhead: two short strokes at the tip, given the incoming angle.
export function arrowheadD(x, y, angle, seed, size = 11) {
  const a1 = angle + Math.PI - 0.45, a2 = angle + Math.PI + 0.45;
  const d1 = roughD(linePts(x + Math.cos(a1) * size, y + Math.sin(a1) * size, x, y, 4), seed + 1, 1.1);
  const d2 = roughD(linePts(x, y, x + Math.cos(a2) * size, y + Math.sin(a2) * size, 4), seed + 2, 1.1);
  return `${d1} ${d2}`;
}

export function angleOf(pts) {
  const [ax, ay] = pts[pts.length - 2], [bx, by] = pts[pts.length - 1];
  return Math.atan2(by - ay, bx - ax);
}

// Diagonal hatch segments clipped to a rect: [{x1,y1,x2,y2}, ...]
export function hatchSegs(x, y, w, h, gap = 26) {
  const segs = [];
  for (let c = -h; c < w; c += gap) {
    const p1 = [Math.max(x, x + c), c < 0 ? y - c : y];
    const p2 = [Math.min(x + w, x + c + h), c + h > w ? y + (w - c) : y + h];
    if (p1[0] < x + w && p2[0] > x) segs.push({ x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1] });
  }
  return segs;
}

// Where to draw ink for a field whose section is collapsed: park it on the
// section header. Pure decision helper so it is testable.
export function anchorPlan(fieldRects, headerRects, fieldToSection, collapsedSet, fields) {
  return fields.map((f) => {
    const sec = fieldToSection(f);
    if (collapsedSet.has(sec)) return { field: f, parked: true, section: sec, rect: headerRects(sec) };
    return { field: f, parked: false, section: sec, rect: fieldRects(f) };
  });
}

// ---------------------------------------------------------------- placement
// Below this line is layout, not wobble. Real pages are not single columns, so
// where a note *goes* is a decision with several candidates -- and a decision
// is only trustworthy if it can be tested. All of it is rect algebra: no DOM,
// no measurement, so test/run.mjs can assert "inside bounds, not overlapping"
// on layouts a browser would take a screenshot to disprove.

export const clamp = (v, lo, hi) => (hi < lo ? lo : v < lo ? lo : v > hi ? hi : v);

export function rectsOverlap(a, b, pad = 0) {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad
      && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

export function rectInside(r, bounds, eps = 0.01) {
  return r.x >= bounds.x - eps && r.y >= bounds.y - eps
      && r.x + r.w <= bounds.x + bounds.w + eps
      && r.y + r.h <= bounds.y + bounds.h + eps;
}

// Word wrap to a pixel budget. The real width comes from getBBox() after
// insertion, but wrapping has to happen *before* there is anything to measure,
// so glyph width is estimated from the font size; SVG text is measured after.
export function wrapText(str, maxWidth, size = 14, charRatio = 0.54) {
  const per = Math.max(1, size * charRatio);
  const maxChars = Math.max(6, Math.floor(maxWidth / per));
  const lines = [];
  let line = '';
  for (const word of String(str).split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= maxChars) line += ' ' + word;
    else { lines.push(line); line = word; }
    while (line.length > maxChars) { lines.push(line.slice(0, maxChars)); line = line.slice(maxChars); }
  }
  if (line) lines.push(line);
  if (!lines.length) lines.push('');
  const w = Math.max(...lines.map((l) => l.length)) * per;
  return { lines, w, h: lines.length * (size + 3), lineHeight: size + 3 };
}

// How much horizontal room a note has on either side of a target.
export function gutters(target, bounds, { gap = 16, margin = 8 } = {}) {
  const L = bounds.x + margin, R = bounds.x + bounds.w - margin;
  return {
    left: { side: 'left', from: L, to: target.x - gap },
    right: { side: 'right', from: target.x + target.w + gap, to: R },
    space: (g) => g.to - g.from,
  };
}

// Pick where a note of size `note` hangs off `target` without leaving `bounds`.
// The old renderer had one rail on the right; on a two-column form the right
// column has no right gutter at all, so the rail is a *hint* here: snap to it
// when it lands inside the chosen gutter, otherwise hug the target or flush to
// the page margin. If neither gutter fits, drop below (or above) the target --
// a note under the field still reads; a note off the page does not.
export function chooseGutter(target, bounds, note, opts = {}) {
  const { gap = 16, margin = 8, rail = null, prefer = 'right', desiredY = null, avoid = [] } = opts;
  const L = bounds.x + margin, R = bounds.x + bounds.w - margin;
  const yLo = bounds.y + margin, yHi = bounds.y + bounds.h - margin - note.h;
  // Each gutter offers a range of x: hugging the target at one end, flush with
  // the page margin at the other. The rail picks a point in that range when it
  // falls inside it, which keeps notes aligned where the old rail worked.
  const snap = (lo, hi, dflt) => (rail == null ? dflt : clamp(rail, lo, Math.max(lo, hi)));

  const cands = {};
  const rFrom = target.x + target.w + gap;
  if (R - rFrom >= note.w) cands.right = { side: 'right', x: snap(rFrom, R - note.w, rFrom), space: R - rFrom };
  const lTo = target.x - gap;
  if (lTo - L >= note.w) cands.left = { side: 'left', x: snap(L, lTo - note.w, lTo - note.w), space: lTo - L };

  // No gutter: stack it vertically, below by preference -- that is where the eye
  // goes next, and the band directly above a field is where its label lives.
  const stackX = clamp(target.x, L, Math.max(L, R - note.w));
  cands.below = { side: 'below', x: stackX, space: 0, y: target.y + target.h + gap };
  cands.above = { side: 'above', x: stackX, space: 0, y: target.y - gap - note.h };

  const yWant = desiredY == null ? target.y + target.h / 2 - note.h / 2 : desiredY;
  const other = prefer === 'right' ? 'left' : 'right';
  const order = [cands[prefer], cands[other], cands.below, cands.above].filter(Boolean);

  // Ink already on the page (and the label band around each target) is passed in
  // as `avoid`; a candidate that lands on top of it slides down until it clears.
  const settleY = (c) => {
    let y = clamp(c.y == null ? yWant : c.y, yLo, Math.max(yLo, yHi));
    for (let pass = 0; pass < avoid.length + 1; pass++) {
      let moved = false;
      for (const a of avoid) {
        if (rectsOverlap({ x: c.x, y, w: note.w, h: note.h }, a, 2)) { y = a.y + a.h + 4; moved = true; }
      }
      if (!moved) break;
    }
    const fits = y <= yHi + 0.01;
    return { y: clamp(y, yLo, Math.max(yLo, yHi)), fits };
  };

  for (const c of order) {
    const { y, fits } = settleY(c);
    if (fits && !avoid.some((a) => rectsOverlap({ x: c.x, y, w: note.w, h: note.h }, a, 2))) {
      return { ...c, x: clamp(c.x, L, Math.max(L, R - note.w)), y, clear: true };
    }
  }
  const c = order[0];
  return { ...c, x: clamp(c.x, L, Math.max(L, R - note.w)), y: clamp(c.y == null ? yWant : c.y, yLo, Math.max(yLo, yHi)), clear: false };
}

// Form labels and hints live in the band directly above a control (and errors
// just under it). The overlay cannot see them -- rectOf reports the control --
// so notes treat that band as occupied rather than landing on the words.
export function labelBand(rect, { above = 26, below = 4 } = {}) {
  return { x: rect.x, y: rect.y - above, w: rect.w, h: rect.h + above + below };
}

// ---------------------------------------------------------------- contrast
// Ink drawn for a cream page disappears on a near-black one. Colour choice is
// pure arithmetic on the sampled background, so it is decided here and tested.

export function parseColor(str) {
  const s = String(str || '').trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    const hex = m[1];
    const grab = (i, n) => parseInt(n === 1 ? hex[i] + hex[i] : hex.slice(i * 2, i * 2 + 2), 16);
    if (hex.length === 3 || hex.length === 4) {
      return { r: grab(0, 1), g: grab(1, 1), b: grab(2, 1), a: hex.length === 4 ? grab(3, 1) / 255 : 1 };
    }
    if (hex.length === 6 || hex.length === 8) {
      return { r: grab(0, 2), g: grab(1, 2), b: grab(2, 2), a: hex.length === 8 ? grab(3, 2) / 255 : 1 };
    }
    return null;
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    // Both legacy `rgba(0, 0, 0, .5)` and modern `rgb(0 0 0 / 50%)` come back
    // from getComputedStyle depending on the engine.
    const raw = m[1].split(/[\s,/]+/).filter(Boolean);
    const num = (v, pct) => (v.endsWith('%') ? (parseFloat(v) / 100) * pct : parseFloat(v));
    const parts = raw.map((v, i) => num(v, i < 3 ? 255 : 1));
    if (parts.length < 3 || parts.some(Number.isNaN)) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  if (/^transparent$/i.test(s)) return { r: 0, g: 0, b: 0, a: 0 };
  return null;
}

export function relLuminance({ r, g, b }) {
  const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(a, b) {
  const l1 = relLuminance(a), l2 = relLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// Composite a possibly translucent colour over an opaque one.
export function overColor(fg, bg) {
  const a = fg.a == null ? 1 : fg.a;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}

// Pick whichever palette actually reads on this background -- not whichever the
// page's theme claims. Score is the worst contrast in the palette, so one
// unreadable hue disqualifies it.
export function pickPalette(bg, palettes) {
  let best = null;
  for (const [name, pal] of Object.entries(palettes)) {
    let worst = Infinity;
    for (const key of Object.keys(pal)) {
      const c = parseColor(pal[key]);
      if (!c) continue;
      worst = Math.min(worst, contrastRatio(overColor(c, bg), bg));
    }
    if (!best || worst > best.score) best = { name, pal, score: worst };
  }
  return best;
}

// The point on a placed note that the connector leaves from, and the point on
// the target it lands on -- so the arrow always visibly joins the two.
export function connectorEnds(target, note, side) {
  const nMidY = note.y + note.h / 2, nMidX = note.x + note.w / 2;
  if (side === 'left') return { from: [note.x + note.w + 4, nMidY], to: [target.x - 5, target.y + target.h / 2] };
  if (side === 'right') return { from: [note.x - 4, nMidY], to: [target.x + target.w + 5, target.y + target.h / 2] };
  if (side === 'below') return { from: [nMidX, note.y - 4], to: [target.x + target.w / 2, target.y + target.h + 5] };
  return { from: [nMidX, note.y + note.h + 4], to: [target.x + target.w / 2, target.y - 5] };
}

// Stack overlapping boxes downward, first-come-first-served by y. Returns new
// boxes in the caller's order so a chip can be matched back to its field.
export function stackBoxes(boxes, { gap = 8, bounds = null, margin = 8 } = {}) {
  const order = boxes.map((b, i) => ({ b, i })).sort((p, q) => (p.b.y - q.b.y) || (p.i - q.i));
  const placed = [];
  const out = new Array(boxes.length);
  for (const { b, i } of order) {
    const x = bounds ? clamp(b.x, bounds.x + margin, Math.max(bounds.x + margin, bounds.x + bounds.w - margin - b.w)) : b.x;
    let y = b.y;
    for (let pass = 0; pass < placed.length + 1; pass++) {
      let moved = false;
      for (const p of placed) {
        if (rectsOverlap({ x, y, w: b.w, h: b.h }, p, gap)) { y = p.y + p.h + gap; moved = true; }
      }
      if (!moved) break;
    }
    const box = { ...b, x, y };
    placed.push(box);
    out[i] = box;
  }
  return out;
}

// A circle that fits its target rather than its target's aspect ratio. The
// radii never shrink inside the target box -- ink that crosses the words it
// circles is worse than a wide ellipse -- so a 900px heading gets a lozenge by
// growing the short axis into nearby whitespace, capped so it cannot balloon
// over the elements above and below.
export function clampCircle(rect, { pad = 12, maxAspect = 4.5, minR = 16, grow = 0.8 } = {}) {
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  let rx = Math.max(rect.w / 2 + pad, minR);
  let ry = Math.max(rect.h / 2 + pad, minR);
  const room = (v, extent) => v + Math.max(extent * grow, pad * 2);
  if (rx / ry > maxAspect) ry = Math.min(rx / maxAspect, room(ry, rect.h));
  else if (ry / rx > maxAspect) rx = Math.min(ry / maxAspect, room(rx, rect.w));
  return { cx, cy, rx, ry };
}

// Numbered route markers: gutter side chosen per step (a form flush against
// x=0 has no left gutter; a right-column field's left gutter belongs to the
// left column's ink), then nudged apart so two steps at the same y never sit
// on top of each other or on top of ink already on the page.
export function planStepMarkers(rects, bounds, opts = {}) {
  const { r = 12, gap = 14, margin = 4, minGap = 8, avoid = [], prefer = 'left' } = opts;
  const inner = { x: bounds.x + margin, y: bounds.y + margin, w: bounds.w - margin * 2, h: bounds.h - margin * 2 };
  const box = (x, y) => ({ x: x - r, y: y - r, w: r * 2, h: r * 2 });
  const fits = (x) => x - r >= inner.x && x + r <= inner.x + inner.w;
  const sides = rects.map((rect) => ({ left: rect.x - gap - r, right: rect.x + rect.w + gap + r }));

  // A route is one object. Picking the gutter per step independently scatters
  // the numbers across the page; picking it once -- by which side has room for
  // the most steps -- keeps 1-2-3-4 reading as a line you can follow.
  const other = prefer === 'left' ? 'right' : 'left';
  const room = (side) => sides.filter((c) => fits(c[side])).length;
  const side = room(prefer) >= room(other) ? prefer : other;

  const placed = [];
  return rects.map((rect, i) => {
    const c = sides[i];
    const x = fits(c[side]) ? c[side] : (fits(c[other]) ? c[other] : clamp(c[side], inner.x + r, inner.x + inner.w - r));
    // Keep the side, move along y: sliding a number down its gutter still reads
    // as the same route, jumping it to the far margin does not.
    let y = clamp(rect.y + rect.h / 2, inner.y + r, inner.y + inner.h - r);
    const need = r * 2 + minGap;
    for (let pass = 0; pass < avoid.length + placed.length + 2; pass++) {
      let moved = false;
      for (const a of avoid) {
        if (rectsOverlap(box(x, y), a, 2)) { y = a.y + a.h + r + 2; moved = true; }
      }
      for (const pm of placed) {
        const dx = Math.abs(pm.x - x);
        if (dx < need) {
          const span = Math.sqrt(Math.max(0, need * need - dx * dx));
          if (Math.abs(pm.y - y) < span) { y = pm.y + span; moved = true; }
        }
      }
      if (!moved) break;
    }
    const m = { x, y, side: x < rect.x + rect.w / 2 ? 'left' : 'right', index: i };
    placed.push(m);
    return m;
  });
}
