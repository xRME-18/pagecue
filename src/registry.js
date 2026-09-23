// pagecue/src/registry.js -- the ink registry and its lifecycle.
//
// Form-agnostic on purpose: this module knows nothing about any particular
// form. It talks to an adapter through three calls only -- fields(), sections()
// and read(id) -- so the same registry drives a DOM-scanned checkout page and a
// hand-wired claim form without a line of difference.
//
// It is also the *only* mutable thing the agent's tools can touch. Adding ink
// is the whole of the agent's authority; nothing here can write a field value.

export const INK_KINDS = ['point', 'circle', 'link', 'skip', 'suggest', 'path'];

export function createRegistry(adapter, { seed = 7 } = {}) {
  const inks = new Map();
  const subs = new Set();
  let nextInk = 1;
  let seedBase = seed;

  const emit = (type, detail = {}) => { for (const fn of [...subs]) fn({ type, ...detail }); };

  const fieldMap = () => {
    const m = new Map();
    for (const f of adapter.fields()) m.set(f.id, f);
    return m;
  };

  function requireFields(ids, idx) {
    for (const f of ids) if (!idx.has(f)) return `Unknown field "${f}". Call read_page to see valid target ids.`;
    return null;
  }

  // add(kind, spec) -> {id} | {error}. The error strings are part of the agent's
  // feedback loop, so they name the offending id and point back at read_page.
  function add(kind, spec = {}) {
    if (!INK_KINDS.includes(kind)) return { error: `Unknown ink kind "${kind}"` };
    const idx = fieldMap();
    const bad = requireFields(spec.fields || [], idx);
    if (bad) return { error: bad };
    if (kind === 'suggest') {
      const f = idx.get(spec.fields[0]);
      if (f.kind === 'landmark') {
        return { error: `"${f.id}" is a landmark (${f.label}), not a form field -- it holds no value, so there is nothing to suggest. Point at it or circle it instead.` };
      }
      // writeRefuse is the real gate; `protected` is the legacy alias that set both
      // halves at once. Backstop only -- tools.js refuses first.
      if (f.writeRefuse ?? f.protected) {
        return { error: `"${f.id}" is a protected field (${f.label}). The agent may not supply values for identity, payment, or signature fields — you can point at it and explain, but the human must fill it themselves.` };
      }
    }
    if (kind === 'skip' && !adapter.sections().some((s) => s.id === spec.section)) {
      return { error: `Unknown section "${spec.section}"` };
    }
    const id = `ink_${nextInk++}`;
    const ink = { id, kind, seed: seedBase = (seedBase * 31 + 17) % 100000, status: 'active', ...spec };
    inks.set(id, ink);
    emit('ink', { id });
    return { id };
  }

  function resolve(id, reason) {
    const ink = inks.get(id);
    if (!ink || ink.status !== 'active') return false;
    ink.status = 'resolved';
    ink.resolvedReason = reason;
    emit('ink', { id, resolved: reason });
    return true;
  }

  // Ink that knows when it is obsolete: error-circles fade once their field
  // turns valid; suggestions fade when the human edits the field themselves.
  function settle(changedField, { humanEdit } = {}) {
    if (!changedField) return;
    let state;
    const clean = () => {
      if (state === undefined) {
        const r = adapter.read(changedField) || {};
        state = !!r.filled && (r.errors || []).length === 0;
      }
      return state;
    };
    for (const ink of inks.values()) {
      if (ink.status !== 'active') continue;
      if (!(ink.fields || []).includes(changedField)) continue;
      if (ink.kind === 'circle' && ink.tone === 'error' && clean()) resolve(ink.id, 'satisfied');
      if (ink.kind === 'suggest' && humanEdit) resolve(ink.id, 'dismissed');
      if (ink.kind === 'point' && ink.fadeWhenFilled && clean()) resolve(ink.id, 'satisfied');
    }
  }

  const active = () => [...inks.values()].filter((i) => i.status === 'active');

  return {
    add,
    resolve,
    settle,
    clear(ids) {
      const targets = ids && ids.length ? ids : active().map((i) => i.id);
      let n = 0;
      for (const id of targets) if (resolve(id, 'cleared')) n++;
      return n;
    },
    gc: (id) => { inks.delete(id); },
    get: (id) => inks.get(id),
    list: () => [...inks.values()],
    active,
    // What read_page reports back as "your own ink".
    summary: () => active().map((i) => ({
      id: i.id, kind: i.kind, fields: i.fields || [], section: i.section,
      note: i.note || i.label || i.why || '',
    })),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}
