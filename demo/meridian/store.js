// pagecue/demo/meridian/store.js -- form state and validation for the demo app.
//
// This is a CONSUMER of pagecue, not part of it. It owns the claim form's shape,
// its cross-field rules, and its values -- nothing more. The ink registry that
// used to live here is now src/registry.js and is form-agnostic.
//
// Authority seam: createStore() returns {store, writer}. `store` is read-only.
// `writer.setValue` is wired to the human's own keystrokes in ui.js, and
// `writer.commit` is exposed to pagecue as adapter.commit(), reachable only from
// a suggestion chip's Accept button. Neither is ever handed to the tools.

export const FORM = {
  title: 'Meridian Mutual — Claim Form 220 (Water Damage)',
  sections: [
    { id: 'sec_claimant', label: 'A · Claimant', fields: [
      { id: 'full_name', label: 'Full name', type: 'text', required: true },
      { id: 'policy_no', label: 'Policy number', type: 'text', required: true, hint: 'Format MM-123456 (on your policy schedule)' },
      { id: 'email', label: 'Email', type: 'text', required: true },
      { id: 'phone', label: 'Phone', type: 'text' },
    ]},
    { id: 'sec_incident', label: 'B · Incident', fields: [
      { id: 'incident_date', label: 'Date of incident', type: 'date', required: true },
      { id: 'discovery_date', label: 'Date damage was discovered', type: 'date', required: true },
      { id: 'cause', label: 'Cause of damage', type: 'select', required: true,
        options: ['', 'burst_pipe', 'appliance_leak', 'roof_leak', 'storm_ingress', 'other'] },
      { id: 'description', label: 'What happened', type: 'textarea', required: true },
      { id: 'emergency_repairs', label: 'Emergency repairs were carried out', type: 'checkbox' },
      { id: 'repair_cost', label: 'Emergency repair cost', type: 'number', hint: 'Only if emergency repairs were carried out' },
    ]},
    { id: 'sec_items', label: 'C · Damaged items', fields: [
      { id: 'item1_desc', label: 'Item 1 — description', type: 'text' },
      { id: 'item1_value', label: 'Item 1 — value', type: 'number' },
      { id: 'item2_desc', label: 'Item 2 — description', type: 'text' },
      { id: 'item2_value', label: 'Item 2 — value', type: 'number' },
      { id: 'item3_desc', label: 'Item 3 — description', type: 'text' },
      { id: 'item3_value', label: 'Item 3 — value', type: 'number' },
      { id: 'total_claimed', label: 'Total amount claimed', type: 'number', required: true, hint: 'Item values plus emergency repair cost' },
    ]},
    { id: 'sec_payout', label: 'D · Payout details', protected: true, fields: [
      { id: 'account_holder', label: 'Account holder name', type: 'text', required: true, protected: true },
      { id: 'account_no', label: 'Account number', type: 'text', required: true, protected: true },
      { id: 'sort_code', label: 'Sort code', type: 'text', required: true, protected: true },
    ]},
    { id: 'sec_declare', label: 'E · Declaration', fields: [
      { id: 'accuracy_confirm', label: 'I confirm the information given is accurate', type: 'checkbox', required: true },
      { id: 'signature', label: 'Signature (type your full legal name)', type: 'text', required: true, protected: true },
      { id: 'sign_date', label: 'Date signed', type: 'date', required: true },
    ]},
  ],
};

export function fieldIndex(form) {
  const idx = new Map();
  for (const sec of form.sections) {
    for (const f of sec.fields) idx.set(f.id, { ...f, sectionId: sec.id, sectionProtected: !!sec.protected });
  }
  return idx;
}

const isEmpty = (v) => v === undefined || v === null || v === '' || v === false;
const num = (v) => { if (isEmpty(v)) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

// Pure: values -> [{field, code, message}]. `today` is ISO yyyy-mm-dd (injected for tests).
export function validate(values, today) {
  const errs = [];
  const push = (field, code, message) => errs.push({ field, code, message });
  const idx = fieldIndex(FORM);
  for (const [id, f] of idx) {
    if (f.required && isEmpty(values[id])) push(id, 'required', `${f.label} is required`);
  }
  const v = values;
  if (!isEmpty(v.policy_no) && !/^MM-\d{6}$/.test(v.policy_no))
    push('policy_no', 'format', 'Policy number must look like MM-123456');
  if (!isEmpty(v.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email))
    push('email', 'format', 'That does not look like an email address');
  if (!isEmpty(v.incident_date) && today && v.incident_date > today)
    push('incident_date', 'future', 'Incident date is in the future');
  if (!isEmpty(v.incident_date) && !isEmpty(v.discovery_date) && v.discovery_date < v.incident_date)
    push('discovery_date', 'order', 'Damage cannot be discovered before the incident date');
  if (v.emergency_repairs === true && (num(v.repair_cost) === null || num(v.repair_cost) <= 0))
    push('repair_cost', 'required_if', 'Emergency repairs are ticked, so a repair cost is required');
  if (v.emergency_repairs !== true && num(v.repair_cost) !== null)
    push('emergency_repairs', 'orphan', 'A repair cost is given but the emergency-repairs box is not ticked');
  for (const n of [1, 2, 3]) {
    const d = v[`item${n}_desc`], val = v[`item${n}_value`];
    if (!isEmpty(val) && isEmpty(d)) push(`item${n}_desc`, 'pair', `Item ${n} has a value but no description`);
    if (!isEmpty(d) && isEmpty(val)) push(`item${n}_value`, 'pair', `Item ${n} has a description but no value`);
  }
  const parts = [num(v.item1_value), num(v.item2_value), num(v.item3_value)];
  const repairs = v.emergency_repairs === true ? num(v.repair_cost) : null;
  const anyPart = parts.some((p) => p !== null) || repairs !== null;
  if (anyPart && num(v.total_claimed) !== null) {
    const expected = parts.reduce((a, p) => a + (p ?? 0), 0) + (repairs ?? 0);
    if (num(v.total_claimed) !== expected)
      push('total_claimed', 'mismatch', `Total does not add up: items${repairs !== null ? ' + repairs' : ''} come to ${expected}`);
  }
  if (!isEmpty(v.sign_date) && isEmpty(v.signature))
    push('sign_date', 'unsigned', 'Dated but not signed');
  return errs;
}

export function createStore({ today } = {}) {
  const idx = fieldIndex(FORM);
  const values = {};
  const collapsed = new Set();
  const subs = new Set();
  const todayIso = () => today || new Date().toISOString().slice(0, 10);

  const emit = (type, detail = {}) => { for (const fn of [...subs]) fn({ type, ...detail }); };
  const errors = () => validate(values, todayIso());
  const errorsFor = (field) => errors().filter((e) => e.field === field);
  const isFilled = (field) => {
    const f = idx.get(field);
    if (!f) return false;
    return f.type === 'checkbox' ? values[field] === true : !isEmpty(values[field]);
  };

  function setValueInternal(field, value, { humanEdit } = {}) {
    if (!idx.has(field)) throw new Error(`Unknown field ${field}`);
    values[field] = value;
    emit('value', { field, humanEdit: !!humanEdit });
  }

  const store = {
    form: FORM,
    fields: idx,
    today: todayIso,
    get: (field) => values[field],
    isFilled,
    errors,
    errorsFor,
    isCollapsed: (sec) => collapsed.has(sec),
    setCollapsed(sec, val) {
      if (!FORM.sections.some((s) => s.id === sec)) return false;
      if (val) collapsed.add(sec); else collapsed.delete(sec);
      emit('layout', { section: sec });
      return true;
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };

  const writer = {
    // The human typing.
    setValue: (field, value) => setValueInternal(field, value, { humanEdit: true }),
    // The human clicking Accept on a suggestion chip. Handed to pagecue as
    // adapter.commit(); tools never see it.
    commit: (field, value) => setValueInternal(field, value, { humanEdit: false }),
  };

  return { store, writer };
}
