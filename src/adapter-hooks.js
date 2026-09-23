// pagecue/src/adapter-hooks.js -- tier 2/3: wrap a host-provided hooks object.
//
// A site that already owns its form state (a React store, a validation engine,
// a custom widget set) hands pagecue a plain object of callbacks; this module
// normalises it into the adapter interface the rest of pagecue consumes, fills in
// the optional pieces, and enforces the one invariant no host should be trusted
// to remember: a read-masked value never reaches the agent.
//
// The Meridian demo is exactly this tier. adapter-dom.js is built on top of it.
//
// TARGET RECORDS. fields() returns two kinds of record, because the agent
// points at more of the page than the inputs:
//
//   { id, kind: 'field',    label, type, required, readMask, writeRefuse,
//     section, sectionLabel, hint?, options?: [{value,label}], group? }
//   { id, kind: 'landmark', role, label, text?, section?, sectionLabel?, href? }
//
// readMask and writeRefuse are INDEPENDENT. A total can be masked but still
// suggestible (you compute it, you never see it); a terms checkbox can be
// perfectly readable and still refuse suggestions. The legacy boolean
// `protected` sets both, and is still accepted.

export const PROTECTED_MASK = '(hidden — protected field)';

export const LANDMARK_ROLES = ['heading', 'button', 'link', 'text', 'image', 'region', 'row'];

const bool = (v) => !!v;
const fn = (f) => typeof f === 'function';
// undefined means "not stated" -> fall back to the legacy flag, not to false.
const flag = (v, fallback) => (v === undefined ? fallback : !!v);

const normOptions = (opts) => (Array.isArray(opts) ? opts : []).map((o) => (
  o && typeof o === 'object'
    ? { value: String(o.value ?? o.label ?? ''), label: String(o.label ?? o.value ?? '') }
    : { value: String(o), label: String(o) }
));

export function createHooksAdapter(hooks, { ignore = [] } = {}) {
  if (!hooks || !fn(hooks.fields) || !fn(hooks.read) || !fn(hooks.onChange)) {
    throw new Error('pagecue: an adapter needs at least fields(), read(id) and onChange(cb)');
  }
  // A hooks host names its own targets, so a selector list can only be matched
  // by id here; hosts that understand selectors get handed the raw list.
  const ignored = new Set(ignore);
  if (ignore.length && fn(hooks.setIgnore)) hooks.setIgnore([...ignore]);

  const normLandmark = (f) => ({
    id: f.id,
    kind: 'landmark',
    role: LANDMARK_ROLES.includes(f.role) ? f.role : 'text',
    label: f.label || f.id,
    // Landmarks carry no value, so masking is moot -- but `protected` is the
    // legacy alias registry.js reads to refuse suggest, and a landmark can
    // never take one. Setting it here closes that path below tools.js too.
    protected: true,
    readMask: false,
    writeRefuse: true,
    ...(f.text ? { text: String(f.text) } : {}),
    ...(f.href ? { href: String(f.href) } : {}),
    ...(f.section ? { section: f.section, sectionLabel: f.sectionLabel || f.section } : {}),
  });

  const normField = (f) => {
    const legacy = bool(f.protected);
    const readMask = flag(f.readMask, legacy);
    const writeRefuse = flag(f.writeRefuse, legacy);
    return {
      id: f.id,
      kind: 'field',
      label: f.label || f.id,
      type: f.type || 'text',
      required: bool(f.required),
      readMask,
      writeRefuse,
      // Legacy alias, consumed by registry.js's suggest guard: "no writes here".
      protected: writeRefuse,
      section: f.section || 'section_main',
      sectionLabel: f.sectionLabel || f.section || '',
      ...(f.hint ? { hint: String(f.hint) } : {}),
      ...(f.options ? { options: normOptions(f.options) } : {}),
      ...(f.group ? { group: String(f.group) } : {}),
    };
  };

  const fields = () => hooks.fields()
    .filter((f) => f && f.id && !ignored.has(f.id))
    .map((f) => (f.kind === 'landmark' ? normLandmark(f) : normField(f)));

  const fieldMap = () => {
    const m = new Map();
    for (const f of fields()) m.set(f.id, f);
    return m;
  };

  // Masking is applied here, not left to the host: even a careless read()
  // implementation cannot leak a masked value into read_page. Landmarks have
  // no value at all, so they read back inert rather than throwing.
  function read(id) {
    const f = fieldMap().get(id);
    if (f && f.kind === 'landmark') return { value: '', filled: false, errors: [] };
    const raw = hooks.read(id) || {};
    const out = {
      value: raw.value ?? '',
      filled: bool(raw.filled),
      errors: (raw.errors || []).map((e) => ({ code: e.code || 'invalid', message: e.message || String(e) })),
    };
    if (f && f.readMask) out.value = out.filled ? PROTECTED_MASK : '';
    return out;
  }

  function sections() {
    if (fn(hooks.sections)) {
      return hooks.sections().map((s) => ({
        id: s.id, label: s.label || s.id, protected: bool(s.protected), collapsed: bool(s.collapsed),
      }));
    }
    // Derive from the fields themselves when the host does not model sections.
    const seen = new Map();
    for (const f of fields()) {
      if (f.kind !== 'field') continue;
      if (!seen.has(f.section)) seen.set(f.section, { id: f.section, label: f.sectionLabel || f.section, protected: false, collapsed: false });
    }
    return [...seen.values()];
  }

  const adapter = {
    fields, read, sections,
    onChange: (cb) => hooks.onChange(cb),
    // rectOf resolves BOTH kinds -- an arrow to a heading is drawn the same way.
    rectOf: fn(hooks.rectOf) ? (id) => hooks.rectOf(id) : () => null,
    sectionRect: fn(hooks.sectionRect) ? (id) => hooks.sectionRect(id) : () => null,
    setCollapsed: (id, val) => {
      if (!sections().some((s) => s.id === id)) return false;
      return fn(hooks.setCollapsed) ? hooks.setCollapsed(id, !!val) !== false : false;
    },
    title: fn(hooks.title) ? () => hooks.title() : () => '',
    today: fn(hooks.today) ? () => hooks.today() : () => '',
    ignore: [...ignore],
  };

  // Optional extras. commit() is the human "accept a suggestion" bridge and is
  // the single write path in the whole framework; it is deliberately attached
  // here and never handed to tools.js (see readView there).
  if (fn(hooks.commit)) adapter.commit = (id, value) => hooks.commit(id, value);
  if (fn(hooks.railX)) adapter.railX = () => hooks.railX();
  if (fn(hooks.onParked)) adapter.onParked = (counts) => hooks.onParked(counts);
  if (fn(hooks.dispose)) adapter.dispose = () => hooks.dispose();

  return adapter;
}
