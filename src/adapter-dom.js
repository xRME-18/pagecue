// pagecue/src/adapter-dom.js -- tier 1, zero configuration.
//
// Scan the document for labelled controls and present them as pagecue targets. A
// site adds one script tag and the agent can see its form; nothing else.
//
// Opt-outs and opt-ins the page can use:
//   data-pagecue-ignore     on a node or any ancestor -> invisible to pagecue
//   data-pagecue-protected  on a control, or on any ancestor (fieldset, wrapper)
//                         -> value masked AND suggest_value refused. ="false" on
//                         a control un-protects it inside a protected container.
//   data-pagecue-readonly   -> suggest_value refused, value still readable
//   data-pagecue-group="x"  wrapper whose controls are one logical field
//   data-pagecue-target     opt a non-control element in as a landmark; the
//                         attribute value, when present, is its label
//
// Everything above the DOM is pure and lives at the top of this file, so the
// discovery rules are unit-testable in Node with no browser at all.
import { createHooksAdapter, PROTECTED_MASK } from './adapter-hooks.js';

// ---------------------------------------------------------------- pure part

// 'user[email]' -> 'user_email'. Returns '' when nothing usable survives.
export function sanitizeFieldId(raw) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw).trim().replace(/[^A-Za-z0-9_-]+/g, '_');
  s = s.replace(/_{2,}/g, '_').replace(/^[_-]+|[_-]+$/g, '');
  if (!s) return '';
  if (/^[0-9]/.test(s)) s = 'f_' + s;
  return s;
}

// 'work_email' -> 'Work email'; 'billingZip' -> 'Billing zip'.
export function humanize(raw) {
  const s = String(raw || '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().replace(/[\s*:]+$/, '').trim();
const slug = (s) => sanitizeFieldId(String(s || '').toLowerCase().replace(/\s+/g, '_'));
const cap = (s, n) => (s.length > n ? s.slice(0, n) : s);

// Label derivation from an attribute map -- no element required, so this is the
// piece the tests pin down. Precedence runs from most explicit to most guessed.
export function deriveLabel(attrs = {}) {
  const tries = [
    attrs.labelText, attrs.ariaLabel, attrs.ariaLabelledbyText,
    attrs.placeholder, attrs.title,
    humanize(attrs.name), humanize(attrs.id),
  ];
  for (const t of tries) {
    const c = clean(t);
    if (c) return c.length > 80 ? c.slice(0, 80) : c;
  }
  return '';
}

// HTML boolean-ish attribute -> tri-state. undefined means "not stated here".
export function attrFlag(v) {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === '' || s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return true;
}

// Precedence: the control's own attribute wins over what the control *is*,
// which wins over its container's, which wins over the init option, which
// defaults to not protected. A control may say data-pagecue-protected="false" to
// escape a protected fieldset -- or to un-mask a field pagecue guessed at.
export function resolveProtected({ field, sensitive, container, option } = {}) {
  if (field !== undefined) return field;
  if (sensitive !== undefined) return sensitive;
  if (container !== undefined) return container;
  if (option !== undefined) return option;
  return false;
}

// ValidityState -> pagecue error codes, most specific first.
export function validityCodes(validity) {
  if (!validity || validity.valid) return [];
  const map = [
    ['valueMissing', 'required'], ['typeMismatch', 'format'], ['patternMismatch', 'format'],
    ['tooShort', 'length'], ['tooLong', 'length'],
    ['rangeUnderflow', 'range'], ['rangeOverflow', 'range'],
    ['stepMismatch', 'step'], ['badInput', 'format'], ['customError', 'custom'],
  ];
  const out = [];
  for (const [k, code] of map) if (validity[k] && !out.includes(code)) out.push(code);
  return out.length ? out : ['invalid'];
}

// A zero-config install also lands on login and checkout pages, where nobody
// stamped anything. Recognise the secret classes of input by what they are.
const SENSITIVE_AUTOCOMPLETE = new Set([
  'cc-number', 'cc-csc', 'new-password', 'current-password', 'one-time-code',
]);
export function isSensitiveControl({ type, autocomplete } = {}) {
  if (String(type || '').toLowerCase() === 'password') return true;
  for (const t of String(autocomplete || '').toLowerCase().split(/\s+/)) {
    if (SENSITIVE_AUTOCOMPLETE.has(t) || t.startsWith('cc-exp')) return true;
  }
  return false;
}

// Which third of a composite date a control is. Word-exact on purpose:
// "Birthday" must not read as a day, or a lone text box becomes a date part.
export function datePartRole(text) {
  for (const w of String(text || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ')) {
    if (w === 'day' || w === 'dd') return 'day';
    if (w === 'month' || w === 'mm') return 'month';
    if (w === 'year' || w === 'yyyy') return 'year';
  }
  return '';
}

// Three boxes -> one ISO date, and back. A partial date has no serialization,
// so it reads as empty and trips the required check rather than inventing one.
export function serializeDateParts({ day, month, year } = {}) {
  const d = String(day ?? '').trim(), m = String(month ?? '').trim(), y = String(year ?? '').trim();
  if (!/^\d{1,2}$/.test(d) || !/^\d{1,2}$/.test(m) || !/^\d{4}$/.test(y)) return '';
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}
export function parseDateParts(value) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(value ?? '').trim());
  return m ? { year: m[1], month: m[2].padStart(2, '0'), day: m[3].padStart(2, '0') } : null;
}

// A long page has thousands of pointable nodes and the agent has a context
// window. Keep document order, but decide *what* to drop by usefulness.
export const LANDMARK_CAP = 150;
const LANDMARK_RANK = { heading: 1, button: 2, link: 3, image: 4, row: 5, region: 6, text: 7 };
export function capLandmarks(items, limit = LANDMARK_CAP) {
  if (items.length <= limit) return items;
  const keep = new Set(items
    .map((it, order) => ({ it, order, rank: it.explicit ? 0 : (LANDMARK_RANK[it.role] || 9) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, limit)
    .map((x) => x.it));
  return items.filter((it) => keep.has(it));
}

// ---------------------------------------------------------------- DOM part

const CONTROLS = 'input, select, textarea';
const DEAD_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file']);
const HEADINGS = 'h1, h2, h3, h4, h5, h6, legend';
const LANDMARKS = 'h1, h2, h3, h4, h5, h6, button, [role="button"], input[type="submit"], a[href], img[alt], tr, [data-pagecue-target]';
const CONTAINERISH = new Set(['section', 'div', 'nav', 'aside', 'main', 'form', 'table', 'ul', 'ol', 'article', 'header', 'footer']);

const tagOf = (el) => el.tagName.toLowerCase();
const controlType = (el) => {
  const tag = tagOf(el);
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';
  return (el.getAttribute('type') || 'text').toLowerCase();
};
const headingRank = (el) => (/^h[1-6]$/.test(tagOf(el)) ? Number(tagOf(el)[1]) : 2);
const isErrorNode = (n) => !!n && (n.getAttribute('role') === 'alert' || /error|invalid/i.test(n.getAttribute('class') || ''));

// The raw hooks object, exported so the discovery rules can be pinned directly
// without going through the tier-2 wrapper's normalisation.
export function createDomHooks({ root, container, protectedList = [], ignore: ignoreInit = [] } = {}) {
  let ignore = [...ignoreInit];
  const scope = root || document.body;
  const box = container || scope;
  const doc = scope.ownerDocument;
  const subs = new Set();
  let scanned = null;
  let committing = false;

  const emit = (ev) => { for (const fn of [...subs]) fn(ev); };
  const invalidate = () => { scanned = null; };

  const matchesSel = (el, sel) => { try { return !!el.closest(sel); } catch { return false; } };
  const matchesOption = (el, id) => protectedList.some((p) => {
    if (!p) return false;
    if (p === id) return true;
    try { return el.matches(p); } catch { return false; }
  });
  // The SPA had to hand-stamp data-pagecue-ignore on its devtools panel from its
  // own MutationObserver; a selector list at init does the same job.
  const ignored = (el) => !!el.closest('[data-pagecue-ignore]') || !!el.closest('[data-pagecue-overlay]')
    || ignore.some((sel) => sel && matchesSel(el, sel));

  const byId = (ref) => (ref ? ref.split(/\s+/).map((id) => doc.getElementById(id)).filter(Boolean) : []);

  function labelTextFor(el) {
    let text = '';
    if (el.id) {
      const l = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) text = l.textContent;
    }
    if (!text) {
      const wrap = el.closest('label');
      if (wrap) text = wrap.textContent;
    }
    return text;
  }

  function labelledbyText(el) {
    return byId(el.getAttribute('aria-labelledby')).map((n) => n.textContent).join(' ');
  }

  // The authored sentence under the input -- "For example, QQ 12 34 56 C".
  // Error nodes hang off the same attribute, so they are filtered out here and
  // picked up as errors instead.
  function describedbyText(el) {
    return clean(byId(el.getAttribute('aria-describedby')).filter((n) => !isErrorNode(n)).map((n) => n.textContent).join(' '));
  }

  const labelOf = (el) => deriveLabel({
    labelText: labelTextFor(el),
    ariaLabel: el.getAttribute('aria-label'),
    ariaLabelledbyText: labelledbyText(el),
    placeholder: el.getAttribute('placeholder'),
    title: el.getAttribute('title'),
    name: el.getAttribute('name'), id: el.id,
  });

  function scan() {
    if (scanned) return scanned;
    const sections = new Map();
    const fields = [];
    const landmarks = [];
    const units = new Map();
    const usedIds = new Set();
    const usedSectionIds = new Set();

    // -------------------------------------------------- 1. eligible controls
    const controls = [...scope.querySelectorAll(CONTROLS)].filter((el) =>
      !ignored(el) && !el.disabled && !(tagOf(el) === 'input' && DEAD_TYPES.has(controlType(el))));

    // -------------------------------------------------- 2. logical units
    // A control is not a field: three date boxes are one, and N radios sharing
    // a name are one. Group first, so everything downstream counts logically.
    const partRole = (c) => datePartRole(String(c.getAttribute('autocomplete') || '').replace(/^bday-/, ''))
      || datePartRole(labelTextFor(c)) || datePartRole(c.getAttribute('aria-label'))
      || datePartRole(c.getAttribute('placeholder')) || datePartRole(c.getAttribute('name')) || datePartRole(c.id);

    // Explicit data-pagecue-group is authoritative about the *grouping*; the
    // built-in fieldset guess is not, so both still have to name all three
    // parts from the markup. Guessing which box is the month from its position
    // would silently mis-date every US-ordered form.
    function dateUnit(el) {
      const w = el.closest('[data-pagecue-group]') || el.closest('fieldset');
      if (!w || !scope.contains(w)) return null;
      const parts = controls.filter((c) => w.contains(c));
      if (parts.length !== 3) return null;
      const roles = new Map();
      for (const c of parts) { const r = partRole(c); if (r && !roles.has(r)) roles.set(r, c); }
      if (roles.size !== 3) return null;
      return {
        kind: 'field', type: 'date-parts', wrapper: w,
        els: [roles.get('day'), roles.get('month'), roles.get('year')],
        parts: { day: roles.get('day'), month: roles.get('month'), year: roles.get('year') },
        group: sanitizeFieldId(w.getAttribute('data-pagecue-group')) || '',
      };
    }

    const formOf = (el) => el.closest('form') || scope;
    const list = [];
    const claimed = new Set();
    for (const el of controls) {
      if (claimed.has(el)) continue;
      const d = dateUnit(el);
      if (d) { for (const e of d.els) claimed.add(e); list.push(d); continue; }
      const t = controlType(el);
      const name = el.getAttribute('name');
      if (name && (t === 'radio' || t === 'checkbox')) {
        const mates = controls.filter((o) => controlType(o) === t && o.getAttribute('name') === name && formOf(o) === formOf(el));
        if (t === 'radio' || mates.length > 1) {
          for (const e of mates) claimed.add(e);
          list.push({ kind: 'field', type: t === 'radio' ? 'radio' : 'checkbox-group', els: mates, wrapper: null });
          continue;
        }
      }
      claimed.add(el);
      list.push({ kind: 'field', type: t, els: [el], wrapper: null });
    }

    const unitOf = new Map();
    for (const u of list) for (const e of u.els) unitOf.set(e, u);
    const logicalCount = (node) => new Set(controls.filter((c) => node.contains(c)).map((c) => unitOf.get(c))).size;
    // A choice group alone in its fieldset: that fieldset is the group's box.
    for (const u of list) {
      if (u.type !== 'radio' && u.type !== 'checkbox-group') continue;
      const fs = u.els[0].closest('fieldset');
      if (fs && scope.contains(fs) && logicalCount(fs) === 1) u.wrapper = fs;
    }

    // -------------------------------------------------- 3. sections
    // A fieldset earns section status only if it groups more than one logical
    // field: the SPA wraps every input in <fieldset class="form-group">, and
    // honouring those produced five sections all called "Section".
    const usableFieldset = (fs) => {
      const lg = fs.querySelector('legend');
      return !!(lg && clean(lg.textContent) && logicalCount(fs) >= 2);
    };
    const headings = [...scope.querySelectorAll(HEADINGS)]
      .filter((h) => !(tagOf(h) === 'legend' && h.parentElement && tagOf(h.parentElement) === 'fieldset' && !usableFieldset(h.parentElement)));

    const registerSection = (el, label) => {
      let id = sanitizeFieldId(el.id ? 'sec_' + el.id : 'sec_' + (label || ''));
      if (!id) id = 'sec_' + (sections.size + 1);
      let unique = id, n = 2;
      while (usedSectionIds.has(unique) && sections.get(unique)?.el !== el) unique = `${id}_${n++}`;
      if (sections.has(unique)) return unique;
      usedSectionIds.add(unique);
      const heading = el.querySelector(HEADINGS);
      sections.set(unique, {
        id: unique, label: clean(label) || unique, el,
        heading: heading && el.contains(heading) ? heading : el,
        protectedFlag: attrFlag(el.getAttribute('data-pagecue-protected')),
      });
      return unique;
    };

    const precedes = (h, el) => !!(h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);

    // <h2>Sign up</h2><h3>It's free</h3> under one parent is one section titled
    // by the h2; the h3 is a subtitle, not a second section.
    const labelAt = (best, el) => {
      let pick = best;
      for (const h of headings) {
        if (h.parentElement !== best.parentElement || !precedes(h, el)) continue;
        if (headingRank(h) < headingRank(pick)) pick = h;
      }
      return pick.textContent;
    };

    const sectionOf = (el) => {
      for (let fs = el.closest('fieldset'); fs && scope.contains(fs); fs = fs.parentElement && fs.parentElement.closest('fieldset')) {
        if (usableFieldset(fs)) return registerSection(fs, fs.querySelector('legend').textContent);
      }
      let best = null;
      for (const h of headings) if (precedes(h, el)) best = h;
      if (best) {
        // The heading's own parent is often a <div class="text-center"> holding
        // only the headings. Registering that as the section would hatch a box
        // the fields are not in, so climb until the container actually holds it.
        let c = best.parentElement;
        while (c && (!c.contains(el) || (tagOf(c) === 'fieldset' && !usableFieldset(c)))) c = c.parentElement;
        if (c && (c === scope || scope.contains(c))) return registerSection(c, labelAt(best, el));
      }
      return registerSection(scope, doc.title || 'Form');
    };

    // -------------------------------------------------- 4. fields
    const uniqueId = (id) => {
      let unique = id, n = 2;
      while (usedIds.has(unique)) unique = `${id}_${n++}`;
      usedIds.add(unique);
      return unique;
    };

    for (const u of list) {
      const anchor = u.wrapper || u.els[0];
      const legend = u.wrapper ? u.wrapper.querySelector('legend') : null;
      const label = (u.els.length > 1 || u.type === 'radio')
        ? clean(legend ? legend.textContent : '') || clean(u.wrapper && u.wrapper.getAttribute('aria-label'))
          || humanize(u.els[0].getAttribute('name')) || labelOf(u.els[0])
        : labelOf(u.els[0]);
      if (!label) continue; // unlabelled controls are not addressable guidance targets

      const sectionId = sectionOf(u.els[0]);
      // A never-reset counter renamed field_3 to field_4 across a remount and
      // stranded every ink pointing at it. Structure is stable; a counter is not.
      const explicit = [
        anchor.getAttribute('data-pagecue-id'), u.els[0].getAttribute('data-pagecue-id'),
        u.group, u.els.length > 1 ? '' : u.els[0].id,
        u.type === 'date-parts' ? '' : u.els[0].getAttribute('name'),
        u.type === 'date-parts' && u.wrapper ? u.wrapper.id : '',
      ].map(sanitizeFieldId).find(Boolean);
      const id = uniqueId(explicit || sanitizeFieldId(`${sectionId}_${slug(label)}_${u.type}`) || 'field');
      for (const e of u.els) if (e.getAttribute('data-pagecue-id') !== id) e.setAttribute('data-pagecue-id', id);

      const holder = u.els[0].parentElement && u.els[0].parentElement.closest('[data-pagecue-protected]');
      const sensitive = u.els.some((e) => isSensitiveControl({ type: controlType(e), autocomplete: e.getAttribute('autocomplete') }));
      const readMask = resolveProtected({
        field: attrFlag(u.els[0].getAttribute('data-pagecue-protected')),
        sensitive: sensitive || undefined,
        container: holder ? attrFlag(holder.getAttribute('data-pagecue-protected')) : undefined,
        option: u.els.some((e) => matchesOption(e, id)) || undefined,
      });
      const roHolder = u.els[0].parentElement && u.els[0].parentElement.closest('[data-pagecue-readonly]');
      const writeRefuse = readMask || resolveProtected({
        field: attrFlag(u.els[0].getAttribute('data-pagecue-readonly')),
        container: roHolder ? attrFlag(roHolder.getAttribute('data-pagecue-readonly')) : undefined,
      });

      const hint = describedbyText(u.els[0]) || (u.wrapper ? describedbyText(u.wrapper) : '');
      const rec = {
        id, kind: 'field', label, type: u.type,
        required: u.els.some((e) => e.required) || u.els.some((e) => attrFlag(e.getAttribute('aria-required')) === true)
          || (u.wrapper ? attrFlag(u.wrapper.getAttribute('aria-required')) === true : false),
        readMask, writeRefuse,
        // Legacy alias: the tier-2 wrapper and tools.js still gate on this one
        // boolean, and over-refusing a suggestion beats leaking a value.
        protected: readMask || writeRefuse,
        section: sectionId,
        sectionLabel: sections.get(sectionId)?.label || '',
      };
      if (hint) rec.hint = cap(hint, 240);
      if (u.group) rec.group = u.group;
      if (u.type === 'date-parts' && !u.group) rec.group = id;
      if (u.type === 'select') rec.options = [...u.els[0].options].map((o) => ({ value: o.value, label: clean(o.textContent) || o.value }));
      if (u.type === 'radio' || u.type === 'checkbox-group') {
        rec.options = u.els.map((e) => ({ value: e.value, label: clean(labelTextFor(e)) || clean(e.getAttribute('aria-label')) || humanize(e.value) }));
      }
      u.record = rec;
      units.set(id, u);
      fields.push(rec);
    }

    // -------------------------------------------------- 5. landmarks
    // Not everything worth pointing at is a field: a heading, the Continue
    // button, a row of a table. Read-only anchors, no value, never writable.
    const sectionAt = (el) => {
      let best = null;
      for (const s of sections.values()) {
        if (s.el === scope || !s.el.contains(el)) continue;
        if (!best || best.el.contains(s.el)) best = s;
      }
      return best;
    };
    const marks = [];
    for (const el of scope.querySelectorAll(LANDMARKS)) {
      if (ignored(el)) continue;
      const tag = tagOf(el);
      const explicit = el.hasAttribute('data-pagecue-target');
      let role = '';
      if (/^h[1-6]$/.test(tag)) role = 'heading';
      else if (tag === 'button' || tag === 'input' || el.getAttribute('role') === 'button') role = 'button';
      else if (tag === 'a') role = 'link';
      else if (tag === 'img') role = 'image';
      else if (tag === 'tr') role = 'row';
      else role = CONTAINERISH.has(tag) ? 'region' : 'text';
      // A data table has header cells and body cells; a layout table has neither.
      if (role === 'row' && !explicit) {
        const table = el.closest('table');
        if (!table || !table.querySelector('th') || !el.querySelector('td')) continue;
      }
      const text = role === 'image' ? clean(el.getAttribute('alt'))
        : role === 'row' ? el.querySelectorAll('td, th').map((c) => clean(c.textContent)).filter(Boolean).join(' · ')
        : clean(el.textContent);
      const label = cap(clean(el.getAttribute('data-pagecue-target')) || text, 80);
      if (!label || label.length < 2) continue;
      const id = uniqueId(sanitizeFieldId(el.getAttribute('data-pagecue-id')) || sanitizeFieldId(el.id)
        || sanitizeFieldId(`lm_${role}_${slug(label)}`) || 'lm');
      const s = sectionAt(el);
      const rec = { id, kind: 'landmark', role, label };
      if (text && text !== label) rec.text = cap(text, 200);
      if (role === 'row' || role === 'text' || role === 'region') rec.text = cap(text, 200);
      if (s) { rec.section = s.id; rec.sectionLabel = s.label; }
      if (tag === 'a') rec.href = el.getAttribute('href') || '';
      marks.push({ role, explicit, rec, el });
    }
    for (const m of capLandmarks(marks)) {
      if (m.el.getAttribute('data-pagecue-id') !== m.rec.id) m.el.setAttribute('data-pagecue-id', m.rec.id);
      units.set(m.rec.id, { kind: 'landmark', type: m.role, els: [m.el], record: m.rec });
      landmarks.push(m.rec);
    }

    scanned = { fields, landmarks, sections, units };
    return scanned;
  }

  const rel = (r) => {
    const c = box.getBoundingClientRect();
    const cs = getComputedStyle(box);
    const ox = c.left + (parseFloat(cs.borderLeftWidth) || 0);
    const oy = c.top + (parseFloat(cs.borderTopWidth) || 0);
    return { x: r.left - ox, y: r.top - oy, w: r.width, h: r.height };
  };
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

  // Authored error text beats the browser's generic sentence, and two of the
  // three field-tested sites emit no HTML5 validity signal at all.
  function authoredError(u) {
    const nodes = [];
    let invalid = false;
    for (const el of [...u.els, ...(u.wrapper ? [u.wrapper] : [])]) {
      if (el.getAttribute('aria-invalid') === 'true') invalid = true;
      nodes.push(...byId(el.getAttribute('aria-errormessage')));
      nodes.push(...byId(el.getAttribute('aria-describedby')).filter(isErrorNode));
    }
    const text = clean(nodes.filter((n) => visible(n) || !n.getClientRects).map((n) => n.textContent).join(' '));
    return { text: cap(text, 240), invalid: invalid || !!text };
  }

  function valueOf(u) {
    switch (u.type) {
      case 'radio': {
        const on = u.els.find((e) => e.checked);
        return { value: on ? on.value : '', filled: !!on };
      }
      case 'checkbox-group': {
        const on = u.els.filter((e) => e.checked).map((e) => e.value);
        return { value: on, filled: on.length > 0 };
      }
      case 'checkbox': return { value: u.els[0].checked === true, filled: u.els[0].checked === true };
      case 'date-parts': {
        const v = serializeDateParts({ day: u.parts.day.value, month: u.parts.month.value, year: u.parts.year.value });
        return { value: v, filled: !!v };
      }
      default: {
        const v = u.els[0].value;
        return { value: v, filled: String(v ?? '').trim() !== '' };
      }
    }
  }

  const fire = (el) => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const hooks = {
    fields: () => [...scan().fields, ...scan().landmarks],

    read(id) {
      const u = scan().units.get(id);
      if (!u || u.kind === 'landmark') return { value: '', filled: false, errors: [] };
      const { value, filled } = valueOf(u);
      const el = u.els[0];
      let codes = [];
      if (typeof el.checkValidity === 'function' && !el.checkValidity()) codes = validityCodes(el.validity);
      // GOV.UK deliberately omits required/aria-required, and the Bootstrap
      // template keeps its rules in data-sb-validations, so nothing reaches the
      // browser's validity object. Requiredness we know about we say ourselves.
      if (u.record.required && !filled && !codes.includes('required')) codes.unshift('required');
      const authored = authoredError(u);
      let errors = [];
      if (codes.length || authored.invalid) {
        const code = codes[0] || 'invalid';
        errors = [{
          code,
          message: authored.text || el.validationMessage
            || (code === 'required' ? 'This field is required.' : 'This value is not valid.'),
        }];
      }
      return { value: u.record.readMask ? PROTECTED_MASK : value, filled, errors };
    },

    sections: () => [...scan().sections.values()].map((s) => ({
      id: s.id, label: s.label,
      protected: s.protectedFlag === true,
      collapsed: !visible(s.el),
    })),

    rectOf(id) {
      const u = scan().units.get(id);
      if (!u) return null;
      // A grouped choice is one target: the box has to cover every option.
      const els = u.wrapper && visible(u.wrapper) ? [u.wrapper] : u.els.filter(visible);
      if (!els.length) return null;
      const rects = els.map((e) => e.getBoundingClientRect());
      const left = Math.min(...rects.map((r) => r.left));
      const top = Math.min(...rects.map((r) => r.top));
      const right = Math.max(...rects.map((r) => r.left + r.width));
      const bottom = Math.max(...rects.map((r) => r.top + r.height));
      return rel({ left, top, width: right - left, height: bottom - top });
    },

    sectionRect(id) {
      const s = scan().sections.get(id);
      if (!s || !visible(s.el)) return null;
      return rel(s.el.getBoundingClientRect());
    },

    setCollapsed(id, val) {
      const s = scan().sections.get(id);
      if (!s) return false;
      if (val) s.el.setAttribute('hidden', '');
      else { s.el.removeAttribute('hidden'); if (s.el.style.display === 'none') s.el.style.display = ''; }
      emit({ type: 'layout', section: id });
      return true;
    },

    // The single write path. Reachable only from a suggestion chip's Accept
    // button; tools.js never sees this function (see readView there).
    commit(id, value) {
      const u = scan().units.get(id);
      if (!u || u.kind === 'landmark') return false;
      committing = true;
      try {
        switch (u.type) {
          case 'radio': {
            // Never assign to a radio's .value: that rewrites the option itself
            // and leaves the group unchecked.
            const hit = u.els.find((e) => e.value === String(value));
            if (!hit) return false;
            hit.checked = true;
            fire(hit);
            return true;
          }
          case 'checkbox-group': {
            const want = new Set((Array.isArray(value) ? value : [value]).map(String));
            const known = u.els.some((e) => want.has(e.value));
            if (!known && want.size) return false;
            for (const e of u.els) {
              const next = want.has(e.value);
              if (e.checked === next) continue;
              e.checked = next;
              fire(e);
            }
            return true;
          }
          case 'checkbox': {
            u.els[0].checked = value === true || value === 'true';
            fire(u.els[0]);
            return true;
          }
          case 'date-parts': {
            const p = parseDateParts(value);
            if (!p) return false;
            for (const [k, el] of Object.entries(u.parts)) { el.value = p[k]; fire(el); }
            return true;
          }
          case 'select': {
            const want = String(value);
            if (![...u.els[0].options].some((o) => o.value === want)) return false;
            u.els[0].value = want;
            fire(u.els[0]);
            return true;
          }
          default:
            u.els[0].value = String(value);
            fire(u.els[0]);
            return true;
        }
      } finally { committing = false; }
    },

    railX() {
      let right = 0;
      for (const f of scan().fields) {
        const r = hooks.rectOf(f.id);
        if (r) right = Math.max(right, r.x + r.w);
      }
      const w = box.getBoundingClientRect().width;
      if (!right) return w - 265;
      return Math.min(right + 44, Math.max(w - 250, right + 12));
    },

    onParked(counts) {
      for (const s of scan().sections.values()) {
        const host = s.heading || s.el;
        let badge = host.querySelector(':scope > .pagecue-parked');
        const n = counts.get(s.id) || 0;
        if (!n) { if (badge) badge.remove(); continue; }
        if (!badge) {
          badge = doc.createElement('span');
          badge.className = 'pagecue-parked';
          badge.setAttribute('data-pagecue-overlay', '');
          host.appendChild(badge);
        }
        badge.textContent = `✎ ${n} note${n > 1 ? 's' : ''} inside`;
      }
    },

    // A host that re-inits with a new ignore list should not have to rebuild.
    setIgnore(list) {
      ignore = [...(list || [])];
      invalidate();
      emit({ type: 'dom' });
    },

    title: () => doc.title || '',
    today: () => new Date().toISOString().slice(0, 10),

    onChange(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },

    dispose() {
      obs.disconnect();
      unschedule();
      doc.removeEventListener('visibilitychange', onVisible);
      scope.removeEventListener('input', onInput, true);
      scope.removeEventListener('change', onInput, true);
      subs.clear();
      for (const el of scope.querySelectorAll('[data-pagecue-id]')) el.removeAttribute('data-pagecue-id');
      for (const b of scope.querySelectorAll('.pagecue-parked')) b.remove();
    },
  };

  function onInput(e) {
    const el = e.target;
    if (!el || !el.matches || !el.matches(CONTROLS)) return;
    const id = el.getAttribute('data-pagecue-id');
    if (!id) { invalidate(); emit({ type: 'dom' }); return; }
    emit({ type: 'value', field: id, humanEdit: !committing });
  }
  scope.addEventListener('input', onInput, true);
  scope.addEventListener('change', onInput, true);

  // Watch the page: a re-render that swaps the nodes out must not strand ink.
  let pending = false, frame = 0, timer = 0;
  const unschedule = () => {
    pending = false;
    if (frame) cancelAnimationFrame(frame);
    if (timer) clearTimeout(timer);
    frame = timer = 0;
  };
  const flush = () => {
    if (!pending) return;
    unschedule();
    invalidate();
    emit({ type: 'dom' });
  };
  // rAF never fires in a background tab. Latching on it alone wedged the
  // adapter permanently -- the latch outlived the hidden tab and no later
  // mutation could ever re-resolve the DOM again. The timer is the floor;
  // visibilitychange is the catch-up when the tab comes back.
  const schedule = () => {
    if (pending) return;
    pending = true;
    frame = requestAnimationFrame(flush);
    timer = setTimeout(flush, 250);
  };
  const onVisible = () => { if (!doc.hidden) flush(); };
  doc.addEventListener('visibilitychange', onVisible);

  const obs = new MutationObserver((records) => {
    const real = records.some((r) => {
      const t = r.target;
      if (t && t.nodeType === 1 && t.closest('[data-pagecue-overlay]')) return false;
      if (r.type === 'childList') {
        const nodes = [...r.addedNodes, ...r.removedNodes];
        if (nodes.length && nodes.every((n) => n.nodeType === 1 && n.hasAttribute && n.hasAttribute('data-pagecue-overlay'))) return false;
      }
      return true;
    });
    if (real) schedule();
  });
  obs.observe(scope, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['id', 'name', 'required', 'disabled', 'hidden', 'type', 'style', 'class', 'href', 'alt', 'role',
      'data-pagecue-protected', 'data-pagecue-readonly', 'data-pagecue-ignore', 'data-pagecue-group', 'data-pagecue-target',
      'aria-label', 'aria-required', 'aria-describedby', 'aria-errormessage', 'aria-invalid', 'autocomplete', 'placeholder'],
  });

  return hooks;
}

export function createDomAdapter(options = {}) {
  // The scan has already dropped the ignored elements; handing the list on too
  // keeps adapter.ignore reading back the same on tier 1 as on tier 2.
  return createHooksAdapter(createDomHooks(options), { ignore: options.ignore || [] });
}
