// pagecue/test/run.mjs -- plain Node test script. No framework.
//   node test/run.mjs
// Only DOM-free code is imported: the framework's registry/tools/adapters and
// their pure helpers, plus the Meridian demo's own store as a realistic host.

import assert from 'node:assert/strict';
import { FORM, fieldIndex, validate, createStore } from '../demo/meridian/store.js';
import { formHooks } from '../demo/meridian/adapter.js';
import { createRegistry, INK_KINDS } from '../src/registry.js';
import { createTools, readView } from '../src/tools.js';
import { createHooksAdapter, PROTECTED_MASK } from '../src/adapter-hooks.js';
import { acceptSuggestion } from '../src/pagecue.js';
import {
  sanitizeFieldId, humanize, deriveLabel, attrFlag, resolveProtected, validityCodes,
} from '../src/adapter-dom.js';
import {
  mulberry, linePts, curvePts, ellipseLoopPts, roughD, arrowheadD, angleOf, hatchSegs,
} from '../src/ink-engine.js';

// ---------------------------------------------------------------- tiny runner
let passed = 0;
const failures = [];
// Async tests are settled before the summary (see `await Promise.all(pending)`),
// so an assertion that lives after an `await` is still counted -- without this
// it would surface as an unhandled rejection and never touch the tally.
const pending = [];
const pass = (name) => { passed++; console.log(`ok    ${name}`); };
const fail = (name, e) => {
  failures.push({ name, e });
  console.log(`FAIL  ${name}`);
  console.log(`      ${(e && e.message ? e.message : String(e)).split('\n').join('\n      ')}`);
};
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => pass(name), (e) => fail(name, e)));
      return;
    }
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

// ---------------------------------------------------------------- helpers
const TODAY = '2026-08-29';
const ALL_FIELDS = [...fieldIndex(FORM).keys()];

// Build the whole stack the way pagecue.init() does -- demo store -> hooks
// adapter -> registry -> tools -- and hand back every seam of it.
function mk(values = {}, { today = TODAY } = {}) {
  const { store, writer } = createStore({ today });
  for (const [k, v] of Object.entries(values)) writer.setValue(k, v);
  const adapter = createHooksAdapter(formHooks(store, writer));
  const registry = createRegistry(adapter);
  // This is the wiring pagecue.js does: one adapter event drives the lifecycle.
  adapter.onChange((ev = {}) => {
    if (ev.type === 'value' && ev.field) registry.settle(ev.field, { humanEdit: ev.humanEdit !== false });
  });
  const accept = (inkId) => acceptSuggestion(registry, adapter, inkId);
  return { store, writer, adapter, registry, accept, tools: byName(createTools(adapter, registry)) };
}
function byName(list) {
  const m = {};
  for (const t of list) m[t.name] = t;
  m.__list = list;
  return m;
}
const codes = (errs, field) => errs.filter((e) => e.field === field).map((e) => e.code);
const has = (errs, field, code) => codes(errs, field).includes(code);
const errText = (r) => JSON.stringify(r.error || {});

// A complete, valid form -- the baseline the validation tests perturb.
const VALID = {
  full_name: 'Dana Okonjo',
  policy_no: 'MM-448120',
  email: 'dana@example.com',
  phone: '07700 900123',
  incident_date: '2026-08-11',
  discovery_date: '2026-08-12',
  cause: 'burst_pipe',
  description: 'Pipe under the kitchen sink split overnight.',
  emergency_repairs: false,
  item1_desc: 'Oak floorboards',
  item1_value: 900,
  total_claimed: 900,
  account_holder: 'Dana Okonjo',
  account_no: '12345678',
  sort_code: '04-00-04',
  accuracy_confirm: true,
  signature: 'Dana Okonjo',
  sign_date: '2026-08-29',
};

// =========================================================== 1. VALIDATION ===

test('validation: baseline VALID form has zero errors', () => {
  assert.deepEqual(mk(VALID).store.errors(), []);
});

test('validation: every required field is reported when the form is empty', () => {
  const errs = mk({}).store.errors();
  const required = ALL_FIELDS.filter((id) => fieldIndex(FORM).get(id).required);
  const reported = errs.filter((e) => e.code === 'required').map((e) => e.field).sort();
  assert.deepEqual(reported, [...required].sort());
  assert.equal(required.length, 14, 'expected 14 required fields in FORM');
  // Empty form should not invent cross-field complaints beyond the required ones.
  assert.deepEqual(errs.filter((e) => e.code !== 'required'), []);
});

test('validation: policy_no must match MM-123456', () => {
  for (const bad of ['MM123456', 'mm-123456', 'MM-12345', 'MM-1234567', 'XX-123456', 'MM-12a456']) {
    assert.ok(has(mk({ ...VALID, policy_no: bad }).store.errors(), 'policy_no', 'format'), `expected format error for ${bad}`);
  }
  assert.deepEqual(codes(mk({ ...VALID, policy_no: 'MM-000001' }).store.errors(), 'policy_no'), []);
});

test('validation: email format', () => {
  for (const bad of ['dana', 'dana@', '@example.com', 'dana@example', 'a b@c.com']) {
    assert.ok(has(mk({ ...VALID, email: bad }).store.errors(), 'email', 'format'), `expected format error for ${bad}`);
  }
  assert.deepEqual(codes(mk({ ...VALID, email: 'a.b+c@sub.example.co.uk' }).store.errors(), 'email'), []);
});

test('validation: discovery_date before incident_date is an order error', () => {
  const errs = mk({ ...VALID, incident_date: '2026-08-11', discovery_date: '2026-08-10' }).store.errors();
  assert.ok(has(errs, 'discovery_date', 'order'));
  // Same day is fine, and so is after.
  assert.deepEqual(codes(mk({ ...VALID, discovery_date: '2026-08-11' }).store.errors(), 'discovery_date'), []);
  assert.deepEqual(codes(mk({ ...VALID, discovery_date: '2026-08-20' }).store.errors(), 'discovery_date'), []);
});

test('validation: incident_date in the future (today injected via createStore)', () => {
  assert.ok(has(mk({ ...VALID, incident_date: '2026-08-30', discovery_date: '2026-08-31' }).store.errors(), 'incident_date', 'future'));
  // Today itself is not "future".
  assert.deepEqual(codes(mk({ ...VALID, incident_date: TODAY, discovery_date: TODAY }).store.errors(), 'incident_date'), []);
  // Injection actually takes effect: same values, a later "today", no error.
  assert.deepEqual(
    codes(mk({ ...VALID, incident_date: '2026-08-30', discovery_date: '2026-08-31' }, { today: '2026-12-01' }).store.errors(), 'incident_date'),
    [],
  );
  assert.equal(mk({}).store.today(), TODAY);
});

test('validation: repair_cost required iff emergency_repairs is ticked', () => {
  const ticked = mk({ ...VALID, emergency_repairs: true }).store.errors();
  assert.ok(has(ticked, 'repair_cost', 'required_if'));
  const zero = mk({ ...VALID, emergency_repairs: true, repair_cost: 0 }).store.errors();
  assert.ok(has(zero, 'repair_cost', 'required_if'), 'a zero repair cost is not a repair cost');
  const fixed = mk({ ...VALID, emergency_repairs: true, repair_cost: 300, total_claimed: 1200 }).store.errors();
  assert.deepEqual(fixed, []);
});

test('validation: orphan repair cost when the box is not ticked', () => {
  const errs = mk({ ...VALID, emergency_repairs: false, repair_cost: 300 }).store.errors();
  assert.ok(has(errs, 'emergency_repairs', 'orphan'));
  // ...and the orphan is charged to the checkbox, not the cost field.
  assert.deepEqual(codes(errs, 'repair_cost'), []);
});

test('validation: a blanked-out repair_cost is empty, not an orphan zero', () => {
  // The human types a cost, then clears the box -> the input holds ''.
  const errs = mk({ ...VALID, emergency_repairs: false, repair_cost: '' }).store.errors();
  assert.deepEqual(errs, [], 'empty string must not count as a numeric 0');
});

test('validation: item description/value must come in pairs', () => {
  const v1 = mk({ ...VALID, item2_value: 40, total_claimed: 940 }).store.errors();
  assert.ok(has(v1, 'item2_desc', 'pair'));
  const d1 = mk({ ...VALID, item3_desc: 'Rug' }).store.errors();
  assert.ok(has(d1, 'item3_value', 'pair'));
  const both = mk({ ...VALID, item2_desc: 'Rug', item2_value: 40, total_claimed: 940 }).store.errors();
  assert.deepEqual(both, []);
});

test('validation: a blanked-out item value is empty, not a numeric 0', () => {
  // No itemised losses at all: the human typed values then cleared them, so the
  // inputs hold ''. The total must then stand on its own, unchecked.
  const errs = mk({ ...VALID, item1_desc: '', item1_value: '', item2_value: '', total_claimed: 500 }).store.errors();
  assert.deepEqual(errs, [], 'empty string item values must not sum to an expected total of 0');
});

test('validation: total_claimed must equal items + repair cost, and fixing it clears the error', () => {
  const vals = {
    ...VALID,
    item1_desc: 'Oak floorboards', item1_value: 900,
    item2_desc: 'Rug', item2_value: 250,
    emergency_repairs: true, repair_cost: 120,
    total_claimed: 900,
  };
  const { store, writer, adapter, registry, accept, tools } = mk(vals);
  const bad = store.errors();
  assert.ok(has(bad, 'total_claimed', 'mismatch'));
  assert.match(bad.find((e) => e.code === 'mismatch').message, /1270/);
  writer.setValue('total_claimed', 1270);
  assert.deepEqual(store.errors(), [], 'correcting the total clears every error');
});

test('validation: total is not checked against repairs while the box is unticked', () => {
  // repair_cost is orphaned, so it must not be folded into the expected total.
  const errs = mk({ ...VALID, emergency_repairs: false, repair_cost: 120, total_claimed: 900 }).store.errors();
  assert.deepEqual(codes(errs, 'total_claimed'), []);
  assert.ok(has(errs, 'emergency_repairs', 'orphan'));
});

test('validation: sign_date without a signature is "unsigned"', () => {
  const errs = mk({ ...VALID, signature: '' }).store.errors();
  assert.ok(has(errs, 'sign_date', 'unsigned'));
  assert.ok(has(errs, 'signature', 'required'));
  // No date, no complaint about signing.
  assert.deepEqual(codes(mk({ ...VALID, signature: '', sign_date: '' }).store.errors(), 'sign_date'), ['required']);
});

test('validation: validate() is pure -- same values, same errors, no store needed', () => {
  const a = validate({ ...VALID, policy_no: 'nope' }, TODAY);
  const b = validate({ ...VALID, policy_no: 'nope' }, TODAY);
  assert.deepEqual(a, b);
});

// ================================================================ 2. TOOLS ===

test('tools: read_page masks filled protected fields and reveals unfilled ones as empty', () => {
  const { store, writer, adapter, registry, accept, tools } = mk({ account_no: '12345678', account_holder: 'Dana Okonjo' });
  const form = tools.read_page.execute({}).page;
  const flat = new Map();
  for (const s of form.sections) for (const f of s.fields) flat.set(f.id, f);

  assert.equal(flat.get('account_no').value, '(hidden — protected field)');
  assert.equal(flat.get('account_no').filled, true);
  assert.equal(flat.get('account_no').protected, true);
  assert.equal(flat.get('account_holder').value, '(hidden — protected field)');
  // Unfilled protected field: empty string, never the mask.
  assert.equal(flat.get('sort_code').value, '');
  assert.equal(flat.get('signature').value, '');
  // Non-protected values pass through verbatim.
  assert.equal(flat.get('full_name').value, '');
  // The raw value never leaks anywhere in the snapshot payload.
  assert.ok(!JSON.stringify(form).includes('12345678'), 'protected value leaked into read_page output');
  assert.equal(form.progress.required_total, 14);
  assert.equal(form.progress.required_filled, 2);
});

test('tools: read_page lists the agent\'s own active ink under your_ink', () => {
  const { store, writer, adapter, registry, accept, tools } = mk(VALID);
  assert.deepEqual(tools.read_page.execute({}).page.your_ink, []);
  const a = tools.point_at.execute({ target: 'policy_no', note: 'starts MM-' });
  const b = tools.mark_skip.execute({ section: 'sec_items', reason: 'nothing damaged' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const yourInk = tools.read_page.execute({}).page.your_ink;
  assert.equal(yourInk.length, 2);
  assert.deepEqual(yourInk.map((i) => i.id), [a.ink_id, b.ink_id]);
  assert.deepEqual(yourInk[0], { id: a.ink_id, kind: 'point', fields: ['policy_no'], section: undefined, note: 'starts MM-' });
  assert.equal(yourInk[1].kind, 'skip');
  assert.equal(yourInk[1].section, 'sec_items');
  // Cleared ink drops off the list.
  tools.clear_ink.execute({ ink_ids: [a.ink_id] });
  assert.deepEqual(tools.read_page.execute({}).page.your_ink.map((i) => i.id), [b.ink_id]);
});

test('tools: point_at on an unknown field is refused and points back at read_page', () => {
  const { store, writer, adapter, registry, accept, tools } = mk(VALID);
  const r = tools.point_at.execute({ target: 'policy_number', note: 'here' });
  assert.equal(r.ok, false);
  assert.match(errText(r), /read_page/);
  assert.match(errText(r), /policy_number/);
  assert.equal(registry.active().length, 0, 'a refused tool call must not leave ink behind');
});

test('tools: suggest_value is refused on protected fields', () => {
  const { store, writer, adapter, registry, accept, tools } = mk(VALID);
  for (const field of ['signature', 'account_no', 'sort_code', 'account_holder']) {
    const r = tools.suggest_value.execute({ field, value: 'guessed', why: 'I worked it out' });
    assert.equal(r.ok, false, `${field} should refuse suggestions`);
    assert.match(errText(r), /protected/);
  }
  assert.equal(registry.active().length, 0);
  // The same tool works on an ordinary field.
  assert.equal(tools.suggest_value.execute({ field: 'total_claimed', value: '1270', why: 'items + repairs' }).ok, true);
});

test('tools: other ink kinds may still point at protected fields', () => {
  const { store, writer, adapter, registry, accept, tools } = mk(VALID);
  assert.equal(tools.point_at.execute({ target: 'account_no', note: 'your own bank details' }).ok, true);
  assert.equal(tools.circle.execute({ target: 'signature', tone: 'attention' }).ok, true);
});

test('tools: link refuses from === to', () => {
  const { store, writer, adapter, registry, accept, tools } = mk(VALID);
  const r = tools.link.execute({ from: 'incident_date', to: 'incident_date', label: 'after this' });
  assert.equal(r.ok, false);
  assert.match(errText(r), /different/);
  assert.equal(registry.active().length, 0);
  assert.equal(tools.link.execute({ from: 'incident_date', to: 'discovery_date', label: 'after this' }).ok, true);
});

test('tools: link validates both endpoints', () => {
  const { store, writer, adapter, registry, accept, tools } = mk(VALID);
  assert.equal(tools.link.execute({ from: 'incident_date', to: 'nope_date', label: 'x' }).ok, false);
  assert.equal(tools.link.execute({ from: 'nope_date', to: 'incident_date', label: 'x' }).ok, false);
});

test('tools: mark_skip refuses an unknown section', () => {
  const { store, writer, adapter, registry, accept, tools } = mk(VALID);
  const r = tools.mark_skip.execute({ section: 'sec_damaged_items', reason: 'n/a' });
  assert.equal(r.ok, false);
  assert.match(errText(r), /sec_damaged_items/);
  assert.equal(registry.active().length, 0);
  assert.equal(tools.mark_skip.execute({ section: 'sec_items', reason: 'n/a' }).ok, true);
});

test('tools: reveal_section refuses an unknown section', () => {
  const { store, writer, adapter, registry, accept, tools } = mk(VALID);
  assert.equal(tools.reveal_section.execute({ section: 'sec_nope' }).ok, false);
  assert.equal(tools.reveal_section.execute({ section: 'sec_items' }).ok, true);
});

test('tools: guide_path refuses any unknown field id in the route', () => {
  const { store, writer, adapter, registry, accept, tools } = mk(VALID);
  const r = tools.guide_path.execute({ targets: ['full_name', 'policy_no', 'e_mail'], note: 'do these' });
  assert.equal(r.ok, false);
  assert.match(errText(r), /e_mail/);
  assert.equal(registry.active().length, 0, 'a partially valid route must not be drawn');
  assert.equal(tools.guide_path.execute({ targets: ['full_name', 'policy_no', 'email'] }).ok, true);
});

test('tools: clear_ink with no arguments clears all active ink and returns the count', () => {
  const { store, writer, adapter, registry, accept, tools } = mk(VALID);
  tools.point_at.execute({ target: 'full_name', note: 'start here' });
  tools.circle.execute({ target: 'policy_no', tone: 'attention' });
  const suggested = tools.suggest_value.execute({ field: 'phone', value: '07700 900123', why: 'from your policy' });
  assert.equal(registry.active().length, 3);

  const r = tools.clear_ink.execute();
  assert.equal(r.ok, true);
  assert.equal(r.cleared, 3);
  assert.equal(registry.active().length, 0);
  assert.equal(registry.get(suggested.ink_id).status, 'resolved');
  assert.equal(registry.get(suggested.ink_id).resolvedReason, 'cleared');
  // Clearing again is a no-op, not a double count.
  assert.equal(tools.clear_ink.execute({}).cleared, 0);
});

test('tools: clear_ink with explicit ids clears only those', () => {
  const { store, writer, adapter, registry, accept, tools } = mk(VALID);
  const a = tools.point_at.execute({ target: 'full_name', note: 'a' }).ink_id;
  const b = tools.point_at.execute({ target: 'email', note: 'b' }).ink_id;
  assert.equal(tools.clear_ink.execute({ ink_ids: [a] }).cleared, 1);
  assert.deepEqual(registry.active().map((i) => i.id), [b]);
});

// ==================================================== 3. INK LIFECYCLE ======

test('lifecycle: an error circle resolves as "satisfied" once the human fixes the field', () => {
  const { store, writer, adapter, registry, accept, tools } = mk({ ...VALID, policy_no: 'MM12345' });
  assert.ok(has(store.errors(), 'policy_no', 'format'));
  const id = tools.circle.execute({ target: 'policy_no', tone: 'error', note: 'needs the dash' }).ink_id;
  assert.equal(registry.get(id).status, 'active');

  // A change elsewhere leaves it alone.
  writer.setValue('phone', '07700 900999');
  assert.equal(registry.get(id).status, 'active');
  // A change that does not fix it leaves it alone too.
  writer.setValue('policy_no', 'MM-12345');
  assert.equal(registry.get(id).status, 'active');

  writer.setValue('policy_no', 'MM-448120');
  assert.equal(registry.get(id).status, 'resolved');
  assert.equal(registry.get(id).resolvedReason, 'satisfied');
  assert.equal(registry.active().length, 0);
});

test('lifecycle: an attention circle does NOT auto-resolve', () => {
  const { store, writer, adapter, registry, accept, tools } = mk({ ...VALID, policy_no: 'MM12345' });
  const id = tools.circle.execute({ target: 'policy_no', tone: 'attention' }).ink_id;
  writer.setValue('policy_no', 'MM-448120');
  assert.equal(registry.get(id).status, 'active', 'only tone=error is self-resolving');
});

test('lifecycle: a suggestion is DISMISSED when the human edits the field themselves', () => {
  const { store, writer, adapter, registry, accept, tools } = mk({ ...VALID, total_claimed: 900, item2_desc: 'Rug', item2_value: 250 });
  const id = tools.suggest_value.execute({ field: 'total_claimed', value: '1150', why: '900 + 250' }).ink_id;
  assert.equal(registry.get(id).status, 'active');

  writer.setValue('total_claimed', 1150);
  assert.equal(registry.get(id).status, 'resolved');
  assert.equal(registry.get(id).resolvedReason, 'dismissed', 'human typing it themselves is a dismissal, not an adoption');
  assert.equal(store.get('total_claimed'), 1150);
});

test('lifecycle: adopt() commits the suggested value and marks the chip "adopted"', () => {
  const { store, writer, adapter, registry, accept, tools } = mk({ ...VALID, total_claimed: 900, item2_desc: 'Rug', item2_value: 250 });
  assert.ok(has(store.errors(), 'total_claimed', 'mismatch'));
  const id = tools.suggest_value.execute({ field: 'total_claimed', value: '1150', why: '900 + 250' }).ink_id;

  assert.equal(accept(id), true);
  assert.equal(registry.get(id).status, 'resolved');
  assert.equal(registry.get(id).resolvedReason, 'adopted', 'adoption must not be recorded as a dismissal');
  assert.equal(store.get('total_claimed'), '1150', 'the suggested value is actually committed');
  assert.deepEqual(store.errors(), [], 'and it really fixes the form');

  // Adopting twice does nothing.
  assert.equal(accept(id), false);
  // Non-suggestion ink cannot be adopted.
  const circle = tools.circle.execute({ target: 'phone', tone: 'attention' }).ink_id;
  assert.equal(accept(circle), false);
  assert.equal(accept('ink_nope'), false);
});

test('lifecycle: point_at with fade_when_filled resolves when the field is validly filled', () => {
  const { store, writer, adapter, registry, accept, tools } = mk({});
  const fading = tools.point_at.execute({ target: 'full_name', note: 'start here', fade_when_filled: true }).ink_id;
  const sticky = tools.point_at.execute({ target: 'email', note: 'and then this' }).ink_id;

  writer.setValue('full_name', 'Dana Okonjo');
  assert.equal(registry.get(fading).status, 'resolved');
  assert.equal(registry.get(fading).resolvedReason, 'satisfied');

  // Without the flag, the arrow stays put.
  writer.setValue('email', 'dana@example.com');
  assert.equal(registry.get(sticky).status, 'active');
});

test('lifecycle: fade_when_filled does not fire while the filled value is still invalid', () => {
  const { store, writer, adapter, registry, accept, tools } = mk({});
  const id = tools.point_at.execute({ target: 'email', note: 'your email', fade_when_filled: true }).ink_id;
  writer.setValue('email', 'dana@');
  assert.equal(registry.get(id).status, 'active', 'filled but invalid is not satisfied');
  writer.setValue('email', 'dana@example.com');
  assert.equal(registry.get(id).status, 'resolved');
});

test('authority: the tool objects expose no writer -- only name/title/description/inputSchema/execute', () => {
  const { adapter, registry } = mk(VALID);
  const list = createTools(adapter, registry);
  const expected = ['description', 'execute', 'inputSchema', 'name', 'title'];
  for (const t of list) {
    assert.deepEqual(Object.keys(t).sort(), expected, `tool ${t.name} exposes unexpected keys`);
    assert.equal(typeof t.execute, 'function');
  }
  // The adapter really does carry the human bridge...
  assert.equal(typeof adapter.commit, 'function');
  // ...and the view the tools are bound to really does not.
  const view = readView(adapter);
  assert.ok(Object.isFrozen(view), 'the tools\' adapter view must be frozen');
  for (const banned of ['commit', 'setValue', 'adopt', 'writer', 'submit', 'set']) {
    assert.equal(view[banned], undefined, `readView must not expose ${banned}`);
  }
  assert.deepEqual(Object.keys(view).sort(), ['expandSection', 'fields', 'read', 'sections', 'title', 'today']);
});

test('authority: no tool can reach adapter.commit, even when handed the full adapter', () => {
  const { store, writer } = createStore({ today: TODAY });
  for (const [k, v] of Object.entries(VALID)) writer.setValue(k, v);
  let commits = 0;
  const hooks = formHooks(store, writer);
  const spied = { ...hooks, commit: (id, value) => { commits++; return hooks.commit(id, value); } };
  const adapter = createHooksAdapter(spied);
  const registry = createRegistry(adapter);
  const tools = byName(createTools(adapter, registry));

  // Every tool, including the ones that carry a value payload.
  tools.read_page.execute({});
  tools.suggest_value.execute({ field: 'total_claimed', value: '99999', why: 'inert' });
  tools.point_at.execute({ target: 'full_name', note: 'x' });
  tools.circle.execute({ target: 'policy_no', tone: 'error' });
  tools.link.execute({ from: 'incident_date', to: 'discovery_date', label: 'x' });
  tools.mark_skip.execute({ section: 'sec_items', reason: 'x' });
  tools.guide_path.execute({ targets: ['full_name', 'email'] });
  tools.reveal_section.execute({ section: 'sec_payout' });
  tools.clear_ink.execute({});
  assert.equal(commits, 0, 'a tool reached the write path');

  // The human clicking Accept is the only thing that does reach it.
  const id = tools.suggest_value.execute({ field: 'total_claimed', value: '1234', why: 'human accepts this' }).ink_id;
  assert.equal(acceptSuggestion(registry, adapter, id), true);
  assert.equal(commits, 1);
  assert.equal(store.get('total_claimed'), '1234');
});

test('authority: reveal_section can only expand, never collapse', () => {
  const { tools, store } = mk(VALID);
  store.setCollapsed('sec_items', true);
  assert.equal(store.isCollapsed('sec_items'), true);
  assert.equal(tools.reveal_section.execute({ section: 'sec_items' }).ok, true);
  assert.equal(store.isCollapsed('sec_items'), false);
  // The schema takes a section id and nothing else -- there is no collapse arg.
  assert.deepEqual(Object.keys(tools.reveal_section.inputSchema.properties), ['section']);
  assert.equal(tools.reveal_section.inputSchema.additionalProperties, false);
});

test('authority: executing every drawing tool changes not one form value', () => {
  const { store, writer, adapter, registry, accept, tools } = mk(VALID);
  const before = Object.fromEntries(ALL_FIELDS.map((f) => [f, store.get(f)]));
  const errsBefore = store.errors();

  const calls = [
    ['read_page', {}],
    ['point_at', { target: 'full_name', note: 'start here', fade_when_filled: true }],
    ['circle', { target: 'policy_no', tone: 'error', note: 'check the dash' }],
    ['circle', { target: 'account_no', tone: 'attention' }],
    ['link', { from: 'incident_date', to: 'discovery_date', label: 'must be after' }],
    ['suggest_value', { field: 'total_claimed', value: '99999', why: 'a total' }],
    ['suggest_value', { field: 'signature', value: 'Dana Okonjo', why: 'refused on purpose' }],
    ['mark_skip', { section: 'sec_items', reason: 'nothing damaged' }],
    ['guide_path', { targets: ['full_name', 'policy_no', 'email'], note: 'route' }],
    ['reveal_section', { section: 'sec_payout' }],
    ['point_at', { target: 'not_a_field', note: 'refused' }],
    ['clear_ink', {}],
  ];
  for (const [name, args] of calls) tools[name].execute(args);

  const after = Object.fromEntries(ALL_FIELDS.map((f) => [f, store.get(f)]));
  assert.deepEqual(after, before, 'a tool mutated the form');
  assert.deepEqual(store.errors(), errsBefore);
  // Not even the refused suggestion left a value lying around.
  assert.equal(store.get('signature'), VALID.signature);
  assert.equal(store.get('total_claimed'), VALID.total_claimed);
});

test('authority: a suggestion holds its value inert until a human adopts it', () => {
  const { store, writer, adapter, registry, accept, tools } = mk(VALID);
  const id = tools.suggest_value.execute({ field: 'phone', value: '999', why: 'nope' }).ink_id;
  assert.equal(registry.get(id).value, '999');
  assert.equal(store.get('phone'), VALID.phone, 'the chip carries the value, the field does not');
});

// ============================================ 4. FRAMEWORK, FORM-AGNOSTIC ===

// A deliberately un-Meridian world: different ids, different sections, its own
// rules. If the registry or the tools have learned anything about claim forms,
// this fixture breaks.
function fakeAdapter(overrides = {}) {
  const state = {
    sku: { value: 'WB-9', filled: true, errors: [] },
    qty: { value: '', filled: false, errors: [{ code: 'required', message: 'How many?' }] },
    card_pan: { value: '4111111111111111', filled: true, errors: [] },
    gift_note: { value: '', filled: false, errors: [] },
  };
  const subs = new Set();
  const hooks = {
    fields: () => [
      { id: 'sku', label: 'Item code', type: 'text', required: true, section: 'basket', sectionLabel: 'Basket' },
      { id: 'qty', label: 'How many', type: 'number', required: true, section: 'basket', sectionLabel: 'Basket' },
      { id: 'card_pan', label: 'Card number', type: 'text', required: true, protected: true, section: 'pay', sectionLabel: 'Payment' },
      { id: 'gift_note', label: 'Gift note', type: 'textarea', section: 'extras', sectionLabel: 'Extras' },
    ],
    read: (id) => state[id] || { value: '', filled: false, errors: [] },
    sections: () => [
      { id: 'basket', label: 'Basket' },
      { id: 'pay', label: 'Payment', protected: true },
      { id: 'extras', label: 'Extras', collapsed: true },
    ],
    onChange: (cb) => { subs.add(cb); return () => subs.delete(cb); },
    commit: (id, value) => { state[id] = { value, filled: value !== '', errors: [] }; fire(id, false); },
    ...overrides,
  };
  const fire = (field, humanEdit = true) => { for (const cb of subs) cb({ type: 'value', field, humanEdit }); };
  const adapter = createHooksAdapter(hooks);
  const registry = createRegistry(adapter);
  adapter.onChange((ev = {}) => { if (ev.field) registry.settle(ev.field, { humanEdit: ev.humanEdit !== false }); });
  return { state, adapter, registry, fire, tools: byName(createTools(adapter, registry)) };
}

test('framework: the registry works on arbitrary field ids from a foreign adapter', () => {
  const { registry, state, fire } = fakeAdapter();
  assert.deepEqual(INK_KINDS, ['point', 'circle', 'link', 'skip', 'suggest', 'path']);

  // Ids it has never heard of are refused, pointing back at the reader tool.
  // (registry.js still spells it read_form; tools.js translates on the way out.)
  assert.match(registry.add('point', { fields: ['policy_no'] }).error, /policy_no.*read_page/);
  assert.match(registry.add('skip', { fields: [], section: 'sec_items' }).error, /Unknown section "sec_items"/);
  assert.equal(registry.add('shade', { fields: ['sku'] }).error, 'Unknown ink kind "shade"');

  // Ids it has been told about are accepted, whatever they look like.
  const circle = registry.add('circle', { fields: ['qty'], tone: 'error' }).id;
  const skip = registry.add('skip', { fields: [], section: 'extras', reason: 'no gift' }).id;
  const link = registry.add('link', { fields: ['sku', 'qty'], label: 'one per line' }).id;
  assert.equal(registry.active().length, 3);
  assert.deepEqual(registry.summary().map((i) => i.id), [circle, skip, link]);

  // Protection is read off the adapter, not off any hard-coded field list.
  assert.match(registry.add('suggest', { fields: ['card_pan'], value: '4242', why: 'no' }).error, /protected/);
  assert.equal(registry.add('suggest', { fields: ['qty'], value: '2', why: 'yes' }).error, undefined);

  // ...and the lifecycle settles on this world's own validity.
  state.qty = { value: '2', filled: true, errors: [] };
  fire('qty');
  assert.equal(registry.get(circle).status, 'resolved');
  assert.equal(registry.get(circle).resolvedReason, 'satisfied');
  assert.equal(registry.get(skip).status, 'active', 'unrelated ink is untouched');
});

test('framework: read_page describes a foreign form with no Meridian anywhere in it', () => {
  const { tools } = fakeAdapter();
  const form = tools.read_page.execute({}).page;
  assert.deepEqual(form.sections.map((s) => s.id), ['basket', 'pay', 'extras']);
  assert.deepEqual(form.sections.map((s) => s.fields.map((f) => f.id)), [['sku', 'qty'], ['card_pan'], ['gift_note']]);
  assert.equal(form.sections[1].protected, true);
  assert.equal(form.sections[2].collapsed, true);
  assert.deepEqual(form.progress, { required_filled: 2, required_total: 3, error_count: 1 });
  // Masking is enforced by the framework even though this adapter never masks.
  assert.equal(form.sections[1].fields[0].value, PROTECTED_MASK);
  assert.ok(!JSON.stringify(form).includes('4111111111111111'));
  assert.equal(JSON.stringify(form).includes('Meridian'), false);
});

test('framework: an adapter that models no sections still gets one', () => {
  const hooks = {
    fields: () => [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', section: 'other', sectionLabel: 'Other' }],
    read: () => ({ value: '', filled: false, errors: [] }),
    onChange: () => () => {},
  };
  const adapter = createHooksAdapter(hooks);
  assert.deepEqual(adapter.sections().map((s) => s.id), ['section_main', 'other']);
  // Missing optional hooks degrade to inert defaults rather than throwing.
  assert.equal(adapter.rectOf('a'), null);
  assert.equal(adapter.sectionRect('section_main'), null);
  assert.equal(adapter.setCollapsed('section_main', false), false);
  assert.equal(adapter.setCollapsed('nope', false), false);
  assert.equal(adapter.commit, undefined, 'an adapter with no commit hook offers no write path at all');
  assert.throws(() => createHooksAdapter({ fields: () => [] }), /fields\(\), read\(id\) and onChange/);
});

test('framework: accepting a suggestion is a no-op when the adapter offers no commit', () => {
  const { adapter, registry, tools } = fakeAdapter({ commit: undefined });
  const id = tools.suggest_value.execute({ field: 'qty', value: '3', why: 'x' }).ink_id;
  assert.equal(acceptSuggestion(registry, adapter, id), false);
  assert.equal(registry.get(id).status, 'active', 'a refused accept must not silently erase the chip');
});

// ============================================ 5. DOM ADAPTER, PURE HELPERS ==
// adapter-dom.js cannot be exercised without a DOM, so its discovery rules are
// written as pure functions and pinned here.

test('adapter-dom: field ids are sanitised, deduplicable and never start with a digit', () => {
  assert.equal(sanitizeFieldId('work_email'), 'work_email');
  assert.equal(sanitizeFieldId('full-name'), 'full-name');
  assert.equal(sanitizeFieldId('user[email]'), 'user_email');
  assert.equal(sanitizeFieldId('  Card Number  '), 'Card_Number');
  assert.equal(sanitizeFieldId('billing.address.line1'), 'billing_address_line1');
  assert.equal(sanitizeFieldId('a//b\\c'), 'a_b_c', 'runs of junk collapse to one underscore');
  assert.equal(sanitizeFieldId('2fa_code'), 'f_2fa_code');
  assert.equal(sanitizeFieldId('---'), '');
  assert.equal(sanitizeFieldId(''), '');
  assert.equal(sanitizeFieldId(null), '');
  assert.equal(sanitizeFieldId(undefined), '');
  // Whatever comes out is a legal attribute-selector value and stable.
  assert.equal(sanitizeFieldId(sanitizeFieldId('user[email]')), 'user_email');
});

test('adapter-dom: humanize turns machine names into sentence case', () => {
  assert.equal(humanize('work_email'), 'Work email');
  assert.equal(humanize('full-name'), 'Full name');
  assert.equal(humanize('billingZip'), 'Billing zip');
  assert.equal(humanize('monthly_requests'), 'Monthly requests');
  assert.equal(humanize(''), '');
});

test('adapter-dom: label derivation follows label > aria-label > aria-labelledby > placeholder > title > name', () => {
  const all = {
    labelText: '  Work email *  ', ariaLabel: 'Email address', ariaLabelledbyText: 'Contact email',
    placeholder: 'you@company.com', title: 'Your work email', name: 'work_email', id: 'work-email',
  };
  assert.equal(deriveLabel(all), 'Work email', 'the <label for> wins, trimmed of decoration');
  assert.equal(deriveLabel({ ...all, labelText: '' }), 'Email address');
  assert.equal(deriveLabel({ ...all, labelText: '', ariaLabel: '' }), 'Contact email');
  assert.equal(deriveLabel({ ...all, labelText: '', ariaLabel: '', ariaLabelledbyText: '' }), 'you@company.com');
  assert.equal(deriveLabel({ ...all, labelText: '', ariaLabel: '', ariaLabelledbyText: '', placeholder: '' }), 'Your work email');
  assert.equal(deriveLabel({ name: 'work_email', id: 'work-email' }), 'Work email');
  assert.equal(deriveLabel({ id: 'billing-zip' }), 'Billing zip');
  assert.equal(deriveLabel({}), '', 'nothing to go on means nothing to point at');
  // Whitespace and trailing colons/asterisks are normalised away.
  assert.equal(deriveLabel({ labelText: 'Card\n   number:' }), 'Card number');
  assert.equal(deriveLabel({ labelText: 'x'.repeat(200) }).length, 80);
});

test('adapter-dom: attrFlag reads HTML boolean-ish attributes as a tri-state', () => {
  for (const v of ['', 'true', 'TRUE', '1', 'yes', 'on', 'anything']) assert.equal(attrFlag(v), true, `attrFlag(${JSON.stringify(v)})`);
  for (const v of ['false', 'FALSE', '0', 'no', 'off']) assert.equal(attrFlag(v), false, `attrFlag(${JSON.stringify(v)})`);
  assert.equal(attrFlag(null), undefined, 'an absent attribute states nothing');
  assert.equal(attrFlag(undefined), undefined);
});

test('adapter-dom: protected resolution is field > container > init option > false', () => {
  assert.equal(resolveProtected({}), false);
  assert.equal(resolveProtected({ option: true }), true);
  assert.equal(resolveProtected({ container: true, option: false }), true);
  assert.equal(resolveProtected({ field: true, container: false, option: false }), true);
  // The escape hatch: an opt-out on the control beats a protected container.
  assert.equal(resolveProtected({ field: false, container: true, option: true }), false);
  assert.equal(resolveProtected({ container: false, option: true }), false);
  // undefined at a level means "defer", not "no".
  assert.equal(resolveProtected({ field: undefined, container: undefined, option: true }), true);
});

test('adapter-dom: HTML5 validity maps onto pagecue error codes', () => {
  assert.deepEqual(validityCodes({ valid: true }), []);
  assert.deepEqual(validityCodes(null), []);
  assert.deepEqual(validityCodes({ valid: false, valueMissing: true }), ['required']);
  assert.deepEqual(validityCodes({ valid: false, typeMismatch: true }), ['format']);
  assert.deepEqual(validityCodes({ valid: false, patternMismatch: true }), ['format']);
  assert.deepEqual(validityCodes({ valid: false, rangeUnderflow: true }), ['range']);
  assert.deepEqual(validityCodes({ valid: false, stepMismatch: true }), ['step']);
  assert.deepEqual(validityCodes({ valid: false, customError: true }), ['custom']);
  // Several at once keep their order, and duplicates collapse.
  assert.deepEqual(validityCodes({ valid: false, valueMissing: true, patternMismatch: true }), ['required', 'format']);
  assert.deepEqual(validityCodes({ valid: false, typeMismatch: true, patternMismatch: true }), ['format']);
  // Invalid for a reason we do not model still produces a usable code.
  assert.deepEqual(validityCodes({ valid: false }), ['invalid']);
});

// ==================================================== 6. INK GEOMETRY =======

test('ink: mulberry(seed) is deterministic and seed-sensitive', () => {
  const draw = (s, n = 8) => { const r = mulberry(s); return Array.from({ length: n }, r); };
  assert.deepEqual(draw(1234), draw(1234));
  assert.notDeepEqual(draw(1234), draw(1235));
  for (const v of draw(99, 50)) {
    assert.ok(v >= 0 && v < 1, `mulberry produced ${v} outside [0,1)`);
  }
});

test('ink: roughD is identical for the same seed and different for another', () => {
  const pts = () => linePts(10, 20, 210, 120, 12);
  const a = roughD(pts(), 4242);
  const b = roughD(pts(), 4242);
  const c = roughD(pts(), 4243);
  assert.equal(a, b, 'same seed must redraw the exact same wobble');
  assert.notEqual(a, c, 'a different seed must wobble differently');
  // Not seed-blind in the other direction either: same seed, other geometry.
  assert.notEqual(a, roughD(linePts(10, 20, 210, 121, 12), 4242));
});

test('ink: roughD emits a path that starts with M and curves with Q', () => {
  const d = roughD(linePts(0, 0, 100, 60, 10), 7);
  assert.ok(d.startsWith('M'), `expected leading M, got ${d.slice(0, 12)}`);
  assert.ok(d.includes('Q'), 'expected quadratic segments');
  assert.ok(d.trimEnd().includes('L'), 'expected a closing line to the final point');
  assert.ok(!/NaN|undefined/.test(d), `path contains NaN/undefined: ${d}`);
  // 11 sampled points -> 9 Q segments (indices 1..n-2) + 1 L.
  assert.equal((d.match(/Q/g) || []).length, 9);
  // Jitter stays inside the stated amplitude (endpoints damped to 0.6).
  const head = d.match(/^M(-?[\d.]+) (-?[\d.]+)/);
  assert.ok(Math.hypot(Number(head[1]) - 0, Number(head[2]) - 0) <= 1.7 * 0.6 * Math.SQRT2 + 0.1);
});

test('ink: curvePts / angleOf / arrowheadD stay finite and deterministic', () => {
  const p = curvePts(0, 0, 100, 0, 0.22, 18);
  assert.equal(p.length, 19);
  assert.deepEqual(p[0], [0, 0]);
  assert.ok(Math.abs(p[18][0] - 100) < 1e-9 && Math.abs(p[18][1]) < 1e-9);
  assert.ok(p[9][1] > 0, 'the chord should bend off-axis');
  const ang = angleOf(p);
  assert.ok(Number.isFinite(ang));
  const head = arrowheadD(100, 0, ang, 31);
  assert.equal(head, arrowheadD(100, 0, ang, 31));
  assert.notEqual(head, arrowheadD(100, 0, ang, 32));
  assert.ok(!/NaN/.test(head));
});

test('ink: ellipseLoopPts draws more than one full loop', () => {
  const n = 44, turns = 1.14;
  const [cx, cy, rx, ry] = [100, 50, 60, 24];
  const pts = ellipseLoopPts(cx, cy, rx, ry, 9, turns, n);
  assert.equal(pts.length, n + 1);

  // Unwrap the swept angle around the centre: it must exceed a full turn.
  let swept = 0, prev = Math.atan2((pts[0][1] - cy) / ry, (pts[0][0] - cx) / rx);
  for (let i = 1; i < pts.length; i++) {
    const a = Math.atan2((pts[i][1] - cy) / ry, (pts[i][0] - cx) / rx);
    let d = a - prev;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    swept += d; prev = a;
  }
  assert.ok(Math.abs(swept) > 2 * Math.PI, `swept only ${Math.abs(swept).toFixed(3)} rad`);
  assert.ok(Math.abs(Math.abs(swept) - turns * 2 * Math.PI) < 1e-6);

  // The overlap means the last point is nowhere near the first.
  assert.ok(Math.hypot(pts[0][0] - pts[n][0], pts[0][1] - pts[n][1]) > 1, 'loop should overshoot its start');
  // Deterministic per seed, different across seeds.
  assert.deepEqual(pts, ellipseLoopPts(cx, cy, rx, ry, 9, turns, n));
  assert.notDeepEqual(pts, ellipseLoopPts(cx, cy, rx, ry, 10, turns, n));
});

test('ink: hatchSegs keeps every segment inside the rect', () => {
  const EPS = 1e-9;
  const rects = [
    [0, 0, 300, 120, 26], [12, 40, 90, 400, 26], [5, 5, 26, 26, 26],
    [-40, -10, 200, 60, 18], [0, 0, 500, 40, 7], [100, 100, 33, 200, 26],
  ];
  let total = 0;
  for (const [x, y, w, h, gap] of rects) {
    const segs = hatchSegs(x, y, w, h, gap);
    total += segs.length;
    for (const s of segs) {
      for (const [px, py] of [[s.x1, s.y1], [s.x2, s.y2]]) {
        assert.ok(px >= x - EPS && px <= x + w + EPS, `x ${px} outside [${x}, ${x + w}] for rect ${[x, y, w, h]}`);
        assert.ok(py >= y - EPS && py <= y + h + EPS, `y ${py} outside [${y}, ${y + h}] for rect ${[x, y, w, h]}`);
      }
      assert.ok(!Number.isNaN(s.x1 + s.y1 + s.x2 + s.y2));
      // Diagonal, 45 degrees, going down-right.
      assert.ok(s.x2 >= s.x1 && s.y2 >= s.y1);
    }
  }
  assert.ok(total > 20, 'expected the hatch generator to produce segments');
  assert.deepEqual(hatchSegs(0, 0, 300, 120, 26), hatchSegs(0, 0, 300, 120, 26));
});

test('ink: linePts samples n+1 points on the exact chord', () => {
  const p = linePts(0, 0, 100, 200, 10);
  assert.equal(p.length, 11);
  assert.deepEqual(p[0], [0, 0]);
  assert.deepEqual(p[10], [100, 200]);
  assert.deepEqual(p[5], [50, 100]);
});


// ================================== 7. PAGE TARGETS: FIELDS AND LANDMARKS ===
// Appended with the tool-surface wave: read_page, the landmark target kind, the
// readMask/writeRefuse split.

// A checkout page with all four protection shapes and three landmarks.
function pageAdapter({ hookOverrides = {}, options = {} } = {}) {
  const state = {
    email: { value: 'a@b.com', filled: true, errors: [] },
    total: { value: '42.00', filled: true, errors: [] },
    card: { value: '4111111111111111', filled: true, errors: [] },
    terms: { value: 'no', filled: true, errors: [] },
  };
  const subs = new Set();
  const setIgnoreCalls = [];
  const hooks = {
    fields: () => [
      { id: 'email', label: 'Email', type: 'email', required: true, section: 'contact', sectionLabel: 'Contact', hint: 'Only used for the receipt.' },
      // masked but suggestible: you compute the total, you never read it
      { id: 'total', label: 'Order total', type: 'text', section: 'pay', sectionLabel: 'Payment', readMask: true },
      // legacy single flag: both protections at once
      { id: 'card', label: 'Card number', type: 'text', section: 'pay', sectionLabel: 'Payment', protected: true },
      // readable but unsuggestible: consent is the human's to give
      { id: 'terms', label: 'Accept terms', type: 'select', required: true, section: 'pay', sectionLabel: 'Payment',
        writeRefuse: true, group: 'consent', options: ['yes', { value: 'no', label: 'No thanks' }] },
      { id: 'lm_h1', kind: 'landmark', role: 'heading', label: 'Checkout', section: 'contact' },
      { id: 'lm_pay', kind: 'landmark', role: 'button', label: 'Pay now', text: 'Pay now and finish the order. '.repeat(8) },
      { id: 'lm_help', kind: 'landmark', role: 'link', label: 'Delivery help', href: '/help/delivery' },
    ],
    read: (id) => state[id] || { value: '', filled: false, errors: [] },
    sections: () => [{ id: 'contact', label: 'Contact' }, { id: 'pay', label: 'Payment' }],
    onChange: (cb) => { subs.add(cb); return () => subs.delete(cb); },
    commit: (id, value) => { state[id] = { value, filled: true, errors: [] }; },
    setIgnore: (list) => setIgnoreCalls.push(list),
    ...hookOverrides,
  };
  const adapter = createHooksAdapter(hooks, options);
  const registry = createRegistry(adapter);
  return { state, adapter, registry, setIgnoreCalls, tools: byName(createTools(adapter, registry)) };
}
const flatFields = (page) => {
  const m = new Map();
  for (const s of page.sections) for (const f of s.fields) m.set(f.id, f);
  return m;
};

test('read_page: exposes hint, options, group and a landmarks list', () => {
  const { tools } = pageAdapter();
  const page = tools.read_page.execute({}).page;
  const f = flatFields(page);

  assert.equal(f.get('email').hint, 'Only used for the receipt.');
  assert.equal(f.get('email').options, undefined, 'a plain input carries no options');
  assert.deepEqual(f.get('terms').options, [{ value: 'yes', label: 'yes' }, { value: 'no', label: 'No thanks' }]);
  assert.equal(f.get('terms').group, 'consent');

  // Landmarks are their own list -- they are not fields and never appear in one.
  assert.deepEqual(page.landmarks.map((l) => l.id), ['lm_h1', 'lm_pay', 'lm_help']);
  assert.deepEqual(page.landmarks.map((l) => l.role), ['heading', 'button', 'link']);
  assert.equal(page.landmarks[0].section, 'contact');
  assert.equal(page.landmarks[2].href, '/help/delivery');
  assert.deepEqual([...f.keys()], ['email', 'total', 'card', 'terms']);
  // ...and they are not counted as work the human has to do.
  assert.deepEqual(page.progress, { required_filled: 2, required_total: 2, error_count: 0 });
});

test('read_page: landmark text is a teaser, and the list is capped not dumped', () => {
  const { tools } = pageAdapter();
  const long = tools.read_page.execute({}).page.landmarks[1];
  assert.equal(long.text.length, 90, 'landmark text is truncated, not transcribed');
  assert.ok(long.text.startsWith('Pay now and finish'));
  // A landmark whose text is just its label adds nothing and is dropped.
  assert.equal(tools.read_page.execute({}).page.landmarks[0].text, undefined);

  const many = [];
  for (let i = 0; i < 60; i++) many.push({ id: 'lm' + i, kind: 'landmark', role: 'row', label: 'Row ' + i });
  const { tools: t2 } = pageAdapter({ hookOverrides: { fields: () => many } });
  const page = t2.read_page.execute({}).page;
  assert.equal(page.landmarks.length, 40);
  assert.equal(page.landmarks_omitted, 20);
  assert.match(page.landmarks_note, /20 more landmarks/);
});

test('protection: readMask and writeRefuse are independent of each other', () => {
  const { tools, registry } = pageAdapter();
  const f = flatFields(tools.read_page.execute({}).page);

  // masked, still suggestible
  assert.equal(f.get('total').value, PROTECTED_MASK);
  assert.equal(f.get('total').read_masked, true);
  assert.equal(f.get('total').suggestions_refused, false);
  assert.equal(f.get('total').protected, false, '"protected" is the both-at-once shorthand');
  assert.equal(tools.suggest_value.execute({ field: 'total', value: '43.00', why: 'items + postage' }).ok, true);

  // readable, not suggestible
  assert.equal(f.get('terms').value, 'no');
  assert.equal(f.get('terms').read_masked, false);
  assert.equal(f.get('terms').suggestions_refused, true);
  const refused = tools.suggest_value.execute({ field: 'terms', value: 'yes', why: 'you need this' });
  assert.equal(refused.ok, false);
  assert.match(errText(refused), /protected/);

  // legacy `protected` still means both
  assert.equal(f.get('card').value, PROTECTED_MASK);
  assert.equal(f.get('card').read_masked, true);
  assert.equal(f.get('card').suggestions_refused, true);
  assert.equal(f.get('card').protected, true);
  assert.ok(!JSON.stringify(tools.read_page.execute({}).page).includes('4111111111111111'));
  assert.equal(tools.suggest_value.execute({ field: 'card', value: '4242', why: 'no' }).ok, false);

  // Exactly one suggestion survived: the masked-but-suggestible one.
  assert.deepEqual(registry.active().map((i) => i.fields[0]), ['total']);
});

test('read_page: a masked value is re-masked at the seam even if the adapter forgets', () => {
  // A tier-1 adapter that emits readMask but hands back the raw value anyway.
  const hooks = {
    fields: () => [{ id: 'ssn', kind: 'field', label: 'SSN', readMask: true, writeRefuse: true, section: 's', sectionLabel: 'S' }],
    read: () => ({ value: '111-22-3333', filled: true, errors: [] }),
    onChange: () => () => {},
  };
  const leaky = { ...createHooksAdapter(hooks), read: () => ({ value: '111-22-3333', filled: true, errors: [] }) };
  const registry = createRegistry(leaky);
  const page = byName(createTools(leaky, registry)).read_page.execute({}).page;
  assert.equal(page.sections[0].fields[0].value, PROTECTED_MASK);
  assert.ok(!JSON.stringify(page).includes('111-22-3333'), 'the seam masks even a careless adapter');
});

test('landmarks: every drawing tool accepts one, suggest_value refuses one', () => {
  const { tools, registry } = pageAdapter();
  assert.equal(tools.point_at.execute({ target: 'lm_pay', note: 'press this last' }).ok, true);
  assert.equal(tools.circle.execute({ target: 'lm_h1', tone: 'attention' }).ok, true);
  assert.equal(tools.link.execute({ from: 'terms', to: 'lm_pay', label: 'tick before pressing' }).ok, true);
  assert.equal(tools.guide_path.execute({ targets: ['email', 'terms', 'lm_pay'] }).ok, true);
  assert.equal(registry.active().length, 4);

  const r = tools.suggest_value.execute({ field: 'lm_pay', value: 'Pay now', why: 'it is a button' });
  assert.equal(r.ok, false);
  assert.match(errText(r), /landmark/);
  assert.match(errText(r), /point_at|circle/, 'the refusal must say what the agent may do instead');
  assert.equal(registry.active().length, 4, 'a refused suggestion leaves no ink');
  // An id that is neither is still refused, pointing back at the reader tool.
  assert.match(errText(tools.suggest_value.execute({ field: 'nope', value: 'x', why: 'y' })), /read_page/);
});

test('tools: the surface is the new nine, and the old names are gone', () => {
  const { tools } = pageAdapter();
  assert.deepEqual(tools.__list.map((t) => t.name), [
    'read_page', 'point_at', 'circle', 'link', 'suggest_value',
    'mark_skip', 'guide_path', 'reveal_section', 'clear_ink',
  ]);
  for (const dead of ['read_form', 'circle_field', 'link_fields', 'set_value', 'submit', 'focus']) {
    assert.equal(tools[dead], undefined, `${dead} must not exist`);
  }
  // Params speak of targets, not fields -- except the one fields-only tool.
  assert.deepEqual(tools.point_at.inputSchema.required, ['target', 'note']);
  assert.deepEqual(tools.circle.inputSchema.required, ['target', 'tone']);
  assert.deepEqual(tools.link.inputSchema.required, ['from', 'to', 'label']);
  assert.deepEqual(tools.guide_path.inputSchema.required, ['targets']);
  assert.deepEqual(tools.suggest_value.inputSchema.required, ['field', 'value', 'why']);
  for (const t of tools.__list) {
    if (t.name === 'suggest_value') continue;
    assert.equal(t.inputSchema.properties.field, undefined, `${t.name} still takes a "field"`);
  }
  // The descriptions carry the behaviour, so pin the load-bearing words.
  assert.match(tools.read_page.description, /landmark/i);
  assert.match(tools.point_at.description, /landmark/i);
  assert.match(tools.suggest_value.description, /landmark/i);
  for (const t of tools.__list) assert.equal(/read_form/.test(t.description), false, `${t.name} still says read_form`);
});

test('authority: the landmark path opens no write hole', () => {
  let commits = 0;
  const { tools, state, adapter, registry } = pageAdapter({
    hookOverrides: { commit: (id, value) => { commits++; state[id] = { value, filled: true, errors: [] }; } },
  });
  const before = JSON.stringify(state);
  const calls = [
    ['read_page', {}],
    ['point_at', { target: 'lm_pay', note: 'here' }],
    ['point_at', { target: 'lm_help', note: 'read this', fade_when_filled: true }],
    ['circle', { target: 'lm_h1', tone: 'error' }],
    ['link', { from: 'lm_h1', to: 'lm_pay', label: 'x' }],
    ['guide_path', { targets: ['lm_h1', 'lm_pay'] }],
    ['suggest_value', { field: 'lm_pay', value: 'pressed', why: 'refused' }],
    ['suggest_value', { field: 'card', value: '4242', why: 'refused' }],
    ['suggest_value', { field: 'terms', value: 'yes', why: 'refused' }],
    ['mark_skip', { section: 'pay', reason: 'x' }],
    ['clear_ink', {}],
  ];
  for (const [name, args] of calls) tools[name].execute(args);
  assert.equal(commits, 0, 'a tool reached the write path through a landmark');
  assert.equal(JSON.stringify(state), before, 'a tool mutated the page');
  // ...and the human bridge still cannot be aimed at a landmark either.
  const id = registry.add('suggest', { fields: ['lm_pay'], value: 'x', why: 'y' });
  assert.match(String(id.error), /landmark/, 'the registry refuses landmark suggestions too');
  assert.equal(commits, 0);
});

test('adapter: options.ignore drops targets and is handed to a host that wants it', () => {
  const { adapter, tools, setIgnoreCalls } = pageAdapter({ options: { ignore: ['card', '#devtools'] } });
  assert.deepEqual(adapter.fields().map((f) => f.id), ['email', 'total', 'terms', 'lm_h1', 'lm_pay', 'lm_help']);
  assert.deepEqual(adapter.ignore, ['card', '#devtools']);
  assert.deepEqual(setIgnoreCalls, [['card', '#devtools']], 'a host that models its own DOM gets the raw selectors');
  // An ignored target is not addressable at all.
  assert.equal(tools.point_at.execute({ target: 'card', note: 'x' }).ok, false);
});

// ------------------------------------------------- overlay placement (pure)
// The overlay itself needs a browser; the decisions it makes do not. Everything
// below asserts the properties a screenshot would be used to check: inside the
// sheet, not on top of each other, not on top of the words being annotated.
import * as GEO from '../src/ink-engine.js';
import { PALETTES } from '../src/overlay.js';

const SHEET = { x: 0, y: 0, w: 960, h: 1400 };
const inSheet = (b, bounds = SHEET) => GEO.rectInside(b, bounds);
const boxOf = (spot, note) => ({ x: spot.x, y: spot.y, w: note.w, h: note.h });

test('placement: a note never leaves the sheet, whatever the layout', () => {
  const note = { w: 210, h: 58 };
  const targets = [
    { x: 492, y: 300, w: 420, h: 120 },   // right column of a two-column form
    { x: 40, y: 300, w: 400, h: 40 },     // left column
    { x: 0, y: 10, w: 940, h: 44 },       // full-width heading
    { x: 0, y: 700, w: 300, h: 40 },      // form flush against x = 0
    { x: 930, y: 200, w: 24, h: 24 },     // icon button hard against the right edge
    { x: 300, y: 1380, w: 200, h: 30 },   // last thing on the page
  ];
  for (const rail of [null, 936, 1400, -50, 480]) {
    for (const t of targets) {
      const spot = GEO.chooseGutter(t, SHEET, note, { rail });
      const box = boxOf(spot, note);
      assert.ok(inSheet(box), `note ${JSON.stringify(box)} left the sheet (target ${JSON.stringify(t)}, rail ${rail})`);
      assert.ok(['left', 'right', 'below', 'above'].includes(spot.side));
    }
  }
});

test('placement: a rail past the page edge is clamped, not obeyed', () => {
  // The reported bug: railX() returned an x that put the note off the page.
  const t = { x: 40, y: 100, w: 400, h: 40 };
  const note = { w: 235, h: 60 };
  const spot = GEO.chooseGutter(t, SHEET, note, { rail: 5000 });
  assert.ok(inSheet(boxOf(spot, note)));
  assert.equal(spot.x + note.w, SHEET.w - 8);        // flush with the page margin
});

test('placement: no gutter fits -> the note drops below, still inside', () => {
  const t = { x: 0, y: 100, w: 960, h: 60 };          // full bleed, no gutters at all
  const note = { w: 240, h: 70 };
  const spot = GEO.chooseGutter(t, SHEET, note);
  assert.equal(spot.side, 'below');
  assert.ok(spot.y >= t.y + t.h);
  assert.ok(inSheet(boxOf(spot, note)));
});

test('placement: the right column falls back to the left gutter', () => {
  const t = { x: 492, y: 300, w: 420, h: 120 };       // ~48px of gutter on the right
  const note = { w: 200, h: 60 };
  const spot = GEO.chooseGutter(t, SHEET, note, { rail: 936 });
  assert.equal(spot.side, 'left');
  assert.ok(spot.x + note.w <= t.x, 'note overlapped the field it annotates');
  assert.ok(inSheet(boxOf(spot, note)));
});

test('placement: notes keep off label bands and off ink already placed', () => {
  const t = { x: 40, y: 400, w: 300, h: 40 };
  const note = { w: 220, h: 50 };
  const avoid = [GEO.labelBand(t), { x: 360, y: 380, w: 260, h: 90 }];
  const spot = GEO.chooseGutter(t, SHEET, note, { avoid });
  const box = boxOf(spot, note);
  assert.ok(inSheet(box));
  for (const a of avoid) assert.ok(!GEO.rectsOverlap(box, a), `note landed on ${JSON.stringify(a)}`);
});

test('placement: labelBand covers the words above a control', () => {
  const band = GEO.labelBand({ x: 10, y: 100, w: 200, h: 40 }, { above: 26, below: 4 });
  assert.deepEqual(band, { x: 10, y: 74, w: 200, h: 70 });
});

test('placement: connectorEnds joins the note to the target on every side', () => {
  const t = { x: 300, y: 200, w: 200, h: 40 };
  const sides = {
    left: { x: 40, y: 200, w: 200, h: 50 },
    right: { x: 560, y: 200, w: 200, h: 50 },
    below: { x: 300, y: 300, w: 200, h: 50 },
    above: { x: 300, y: 100, w: 200, h: 50 },
  };
  for (const [side, note] of Object.entries(sides)) {
    const { from, to } = GEO.connectorEnds(t, note, side);
    assert.ok(from.every(Number.isFinite) && to.every(Number.isFinite));
    // The tip lands on the target's edge, the tail on the note's facing edge.
    const near = Math.hypot(to[0] - (t.x + t.w / 2), to[1] - (t.y + t.h / 2));
    assert.ok(near <= Math.max(t.w, t.h) / 2 + 8, `${side} arrow does not reach the target`);
    if (side === 'left') assert.ok(from[0] >= note.x + note.w);
    if (side === 'right') assert.ok(from[0] <= note.x);
  }
});

test('placement: chips stack downward and stop overlapping', () => {
  const chips = [
    { x: 700, y: 100, w: 235, h: 92 },
    { x: 700, y: 118, w: 235, h: 92 },   // adjacent field: same rail, 18px apart
    { x: 700, y: 130, w: 235, h: 80 },
    { x: 120, y: 105, w: 235, h: 92 },   // other column: must not be moved
  ];
  const out = GEO.stackBoxes(chips, { gap: 10, bounds: SHEET });
  assert.equal(out.length, chips.length);
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      assert.ok(!GEO.rectsOverlap(out[i], out[j]), `chips ${i} and ${j} still overlap`);
    }
    assert.ok(out[i].y >= chips[i].y, 'chips only ever move downward');
    assert.equal(out[i].w, chips[i].w);
  }
  assert.equal(out[3].y, chips[3].y, 'a chip in another column was moved for no reason');
});

test('placement: stackBoxes clamps x into the sheet', () => {
  const out = GEO.stackBoxes([{ x: 900, y: 10, w: 235, h: 40 }], { bounds: SHEET });
  assert.ok(inSheet(out[0]));
});

test('route: step markers stay in the sheet and off each other', () => {
  const rects = [
    { x: 0, y: 100, w: 300, h: 40 },     // left column, flush against x = 0
    { x: 520, y: 104, w: 300, h: 40 },   // right column, same row
    { x: 0, y: 180, w: 300, h: 40 },
    { x: 520, y: 182, w: 300, h: 40 },
  ];
  const marks = GEO.planStepMarkers(rects, SHEET, { r: 12, minGap: 8 });
  assert.equal(marks.length, rects.length);
  for (const m of marks) {
    assert.ok(inSheet({ x: m.x - 12, y: m.y - 12, w: 24, h: 24 }), `marker ${JSON.stringify(m)} clipped`);
  }
  for (let i = 0; i < marks.length; i++) {
    for (let j = i + 1; j < marks.length; j++) {
      const d = Math.hypot(marks[i].x - marks[j].x, marks[i].y - marks[j].y);
      assert.ok(d >= 24 + 8 - 0.01, `markers ${i}/${j} sit on top of each other (${d.toFixed(1)}px apart)`);
    }
  }
  assert.deepEqual(marks, GEO.planStepMarkers(rects, SHEET, { r: 12, minGap: 8 }), 'marker plan is not stable');
});

test('route: a marker never lands on ink that is already drawn', () => {
  // The live failure: a step marker on top of the circle drawn for another field.
  const rects = [{ x: 360, y: 100, w: 300, h: 40 }, { x: 360, y: 200, w: 300, h: 40 }];
  const avoid = [{ x: 300, y: 70, w: 120, h: 100 }];   // a circle around a neighbour
  const marks = GEO.planStepMarkers(rects, SHEET, { r: 12, avoid });
  for (const m of marks) {
    const box = { x: m.x - 12, y: m.y - 12, w: 24, h: 24 };
    assert.ok(inSheet(box));
    for (const a of avoid) assert.ok(!GEO.rectsOverlap(box, a), 'marker landed on existing ink');
  }
});

test('circle: the loop always contains its target, however shaped', () => {
  const targets = [
    { x: 20, y: 60, w: 900, h: 44 },     // full-width heading
    { x: 20, y: 60, w: 24, h: 24 },      // icon button
    { x: 20, y: 60, w: 60, h: 800 },     // a whole region
    { x: 100, y: 100, w: 260, h: 38 },   // an ordinary input
  ];
  for (const t of targets) {
    const c = GEO.clampCircle(t);
    const long = Math.max(c.rx, c.ry), short = Math.min(c.rx, c.ry);
    assert.ok(c.rx >= t.w / 2 && c.ry >= t.h / 2, 'the loop cut into the target');
    assert.ok(short >= 16, 'loop smaller than a pen stroke');
    const raw0 = Math.max(t.w / t.h, t.h / t.w);
    assert.ok(long / short <= Math.max(4.5, raw0) + 1e-9, 'aspect got worse, not better');
    if (raw0 > 4.5) assert.ok(long / short < raw0, 'a grotesque ellipse was left grotesque');
  }
});

test('circle: a 900px heading gets a lozenge, not a balloon', () => {
  const c = GEO.clampCircle({ x: 20, y: 60, w: 900, h: 44 });
  assert.ok(c.rx / c.ry < 8, 'still grotesque');
  assert.ok(c.ry < 120, 'the loop ballooned over the neighbouring rows');
});

test('text: wrapText respects the pixel budget and is deterministic', () => {
  const str = 'This delivery address needs a postcode before the courier options appear';
  const w = GEO.wrapText(str, 200, 14);
  assert.ok(w.w <= 200 + 0.01, `wrapped to ${w.w}px, budget 200`);
  assert.ok(w.lines.length > 1);
  assert.equal(w.lines.join(' '), str);
  assert.deepEqual(GEO.wrapText(str, 200, 14), w);
  const long = GEO.wrapText('supercalifragilisticexpialidocious'.repeat(3), 90, 14);
  assert.ok(long.w <= 90 + 0.01, 'an unbreakable word was not hard-split');
});

test('ink palette: contrast clears WCAG on cream, white and near-black', () => {
  const bgs = { '#ffffff': 'light', '#f6f3ec': 'light', '#0b1020': 'dark', '#111827': 'dark', '#1f2937': 'dark' };
  for (const [hex, expected] of Object.entries(bgs)) {
    const bg = GEO.parseColor(hex);
    const pick = GEO.pickPalette(bg, { light: PALETTES.light.text, dark: PALETTES.dark.text });
    assert.equal(pick.name, expected, `${hex} chose the ${pick.name} palette`);
    assert.ok(pick.score >= 4.5, `note text on ${hex} is only ${pick.score.toFixed(2)}:1`);
    for (const [k, v] of Object.entries(PALETTES[pick.name].stroke)) {
      const c = GEO.contrastRatio(GEO.parseColor(v), bg);
      assert.ok(c >= 3, `${k} stroke on ${hex} is only ${c.toFixed(2)}:1`);
    }
  }
});

test('ink palette: colours parse in every form the DOM hands back', () => {
  assert.deepEqual(GEO.parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(GEO.parseColor('#0b1020'), { r: 11, g: 16, b: 32, a: 1 });
  assert.deepEqual(GEO.parseColor('rgb(17, 24, 39)'), { r: 17, g: 24, b: 39, a: 1 });
  assert.deepEqual(GEO.parseColor('rgba(0, 0, 0, 0.5)'), { r: 0, g: 0, b: 0, a: 0.5 });
  assert.deepEqual(GEO.parseColor('rgb(0 0 0 / 25%)'), { r: 0, g: 0, b: 0, a: 0.25 });
  assert.equal(GEO.parseColor('transparent').a, 0);
  assert.equal(GEO.parseColor('chartreuse'), null);
  // A translucent card over a dark page composites toward the card.
  const over = GEO.overColor({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 });
  assert.deepEqual(over, { r: 127.5, g: 127.5, b: 127.5, a: 1 });
});

test('ink palette: a white card on a dark page still gets dark-on-light ink', () => {
  const card = GEO.parseColor('#ffffff');
  const page = GEO.parseColor('#0b1020');
  const onCard = GEO.pickPalette(card, { light: PALETTES.light.text, dark: PALETTES.dark.text });
  const onPage = GEO.pickPalette(page, { light: PALETTES.light.text, dark: PALETTES.dark.text });
  assert.equal(onCard.name, 'light');
  assert.equal(onPage.name, 'dark');
});

// ================================================ 9. DOM ADAPTER, LIVE DOM ==
// Everything above this line runs on pure helpers. These run adapter-dom.js
// against test/mini-dom.mjs -- a hand-rolled tree just large enough to hold the
// markup the three field-tested sites actually shipped. Every case below is one
// of those sites' real shapes.
const { mountDom } = await import('./mini-dom.mjs');
const {
  createDomHooks, isSensitiveControl, datePartRole, serializeDateParts, parseDateParts, capLandmarks,
} = await import('../src/adapter-dom.js');
const { snapshot: domSnapshot } = await import('../src/tools.js');

const dom = (html, opts) => {
  const d = mountDom(html);
  d.body._rect = { left: 0, top: 0, width: 1000, height: 2000 };
  return { d, h: createDomHooks({ root: d.body, ...(opts || {}) }) };
};
const byId = (h, id) => h.fields().find((f) => f.id === id);
const kindsOf = (h, kind) => h.fields().filter((f) => f.kind === kind);

test('adapter-dom: committing a radio checks the option instead of overwriting its value', () => {
  const { d, h } = dom(`<h2>Permit</h2><fieldset><legend>What kind of permit?</legend>
    <input type="radio" id="p1" name="permitType" value="resident"><label for="p1">Resident</label>
    <input type="radio" id="p2" name="permitType" value="visitor"><label for="p2">Visitor</label>
    </fieldset>`);
  assert.equal(h.commit('permitType', 'visitor'), true);
  assert.equal(d.el('#p2').checked, true);
  assert.equal(d.el('#p1').checked, false, 'the rest of the name group is unchecked');
  assert.equal(d.el('#p2').getAttribute('value'), 'visitor', 'the option keeps its own value attribute');
  assert.deepEqual(h.read('permitType'), { value: 'visitor', filled: true, errors: [] });
  // No option matches -> refuse, and leave the group exactly as it was.
  assert.equal(h.commit('permitType', 'helicopter'), false);
  assert.equal(h.read('permitType').value, 'visitor');
  assert.equal(d.el('#p1').checked, false);
});

test('adapter-dom: committing a checkbox group sets the members named, and refuses unknown values', () => {
  const { d, h } = dom(`<h2>Contact</h2><fieldset><legend>How should we contact you?</legend>
    <input type="checkbox" id="c1" name="contact" value="email"><label for="c1">Email</label>
    <input type="checkbox" id="c2" name="contact" value="sms"><label for="c2">Text message</label>
    </fieldset>`);
  assert.equal(byId(h, 'contact').type, 'checkbox-group');
  assert.equal(h.commit('contact', ['sms']), true);
  assert.equal(d.el('#c2').checked, true);
  assert.equal(d.el('#c1').checked, false);
  assert.deepEqual(h.read('contact').value, ['sms']);
  assert.equal(h.commit('contact', ['carrier-pigeon']), false, 'nothing in the group matches');
  assert.deepEqual(h.read('contact').value, ['sms']);
});

test('adapter-dom: password and payment inputs are protected with no site configuration at all', () => {
  const { d, h } = dom(`<h2>Sign in</h2>
    <label for="pw">Password</label><input id="pw" type="password">
    <label for="cc">Card number</label><input id="cc" autocomplete="cc-number">
    <label for="csc">Security code</label><input id="csc" autocomplete="cc-csc">
    <label for="exp">Expiry month</label><input id="exp" autocomplete="cc-exp-month">
    <label for="otp">One time code</label><input id="otp" autocomplete="one-time-code">
    <label for="np">New password</label><input id="np" autocomplete="new-password">
    <label for="em">Email</label><input id="em" type="email">
    <label for="legacy">Legacy field</label><input id="legacy" type="password" data-pagecue-protected="false">`);
  for (const id of ['pw', 'cc', 'csc', 'exp', 'otp', 'np']) {
    assert.equal(byId(h, id).readMask, true, `${id} readMask`);
    assert.equal(byId(h, id).writeRefuse, true, `${id} writeRefuse`);
  }
  assert.equal(byId(h, 'em').readMask, false);
  // The site can still say "this one is fine", and keep its own judgement.
  assert.equal(byId(h, 'legacy').readMask, false);
  d.el('#pw').value = 'hunter2';
  assert.equal(h.read('pw').value, PROTECTED_MASK, 'a masked value never leaves the adapter');
  assert.equal(h.read('pw').filled, true, 'but the agent still learns that it is filled');
  assert.ok(isSensitiveControl({ type: 'password' }));
  assert.ok(isSensitiveControl({ type: 'text', autocomplete: 'shipping cc-exp-year' }));
  assert.ok(!isSensitiveControl({ type: 'text', autocomplete: 'email' }));
  assert.ok(!isSensitiveControl({}));
});

test('adapter-dom: data-pagecue-readonly refuses writes without hiding the value', () => {
  const { h } = dom(`<h2>Order</h2>
    <label for="ref">Order reference</label><input id="ref" value="A-1174" data-pagecue-readonly>
    <div data-pagecue-readonly><label for="tot">Total</label><input id="tot" value="42.00"></div>`);
  for (const id of ['ref', 'tot']) {
    assert.equal(byId(h, id).writeRefuse, true, `${id} writeRefuse`);
    assert.equal(byId(h, id).readMask, false, `${id} readMask`);
  }
  assert.equal(h.read('ref').value, 'A-1174', 'read-only is not secret');
});

test('adapter-dom: a hidden tab cannot wedge DOM re-resolution forever', () => {
  const { d, h } = dom('<h2>Order</h2><label for="q">Qty</label><input id="q" name="q">');
  const seen = [];
  h.onChange((ev) => seen.push(ev.type));
  // mini-dom queues animation frames and never runs them: that IS a background
  // tab, which is where the old rAF-only latch died and stayed dead.
  d.el('label').setAttribute('class', 'one');
  d.flushMutations();
  assert.deepEqual(seen, [], 'nothing has been flushed yet -- no frame has run');
  d.showTab();
  assert.deepEqual(seen, ['dom'], 'coming back to the foreground catches the page up');
  // The real regression: every LATER mutation was dead too. Prove it is not.
  d.el('label').setAttribute('class', 'two');
  d.flushMutations();
  d.showTab();
  assert.deepEqual(seen, ['dom', 'dom']);
  h.dispose();
});

test('adapter-dom: a timeout floor flushes even if no frame and no visibility change ever arrives', () => {
  const realSetTimeout = globalThis.setTimeout;
  const timers = [];
  try {
    const { d, h } = dom('<h2>Order</h2><label for="q">Qty</label><input id="q" name="q">');
    const seen = [];
    h.onChange((ev) => seen.push(ev.type));
    globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
    d.el('label').setAttribute('class', 'one');
    d.flushMutations();
    assert.equal(timers.length, 1, 'a mutation arms the floor as well as the frame');
    assert.ok(timers[0].ms > 0 && timers[0].ms <= 1000, 'the floor is short enough to feel live');
    timers[0].fn();
    assert.deepEqual(seen, ['dom']);
    h.dispose();
  } finally { globalThis.setTimeout = realSetTimeout; }
});

test('adapter-dom: aria-describedby becomes the hint, minus anything that is an error', () => {
  const { h } = dom(`<h1>Your details</h1>
    <label for="ni">National Insurance number</label>
    <input id="ni" name="ni" aria-describedby="ni-hint ni-err">
    <span id="ni-hint">For example, QQ 12 34 56 C</span>
    <span id="ni-err" class="govuk-error-message">Enter a National Insurance number</span>
    <label for="pc">Postcode</label><input id="pc" name="pc">`);
  assert.equal(byId(h, 'ni').hint, 'For example, QQ 12 34 56 C');
  assert.equal(byId(h, 'pc').hint, undefined, 'no describedby, no invented hint');
});

test('adapter-dom: requiredness the browser cannot see is still reported as an error', () => {
  const { h } = dom(`<h1>Details</h1>
    <label for="a">Full name</label><input id="a" name="a" aria-required="true">
    <label for="b">Nickname</label><input id="b" name="b">
    <label for="c">Email</label><input id="c" name="c" required>`);
  // GOV.UK ships no required/aria-required at all and the Bootstrap template
  // keeps its rules in data-sb-validations, so validity is empty on both.
  assert.equal(byId(h, 'a').required, true);
  assert.deepEqual(h.read('a').errors, [{ code: 'required', message: 'This field is required.' }]);
  assert.deepEqual(h.read('b').errors, [], 'optional and empty is not an error');
  assert.equal(h.read('c').errors[0].code, 'required', 'the HTML5 path still works');
  assert.equal(h.read('c').errors[0].message, 'Please fill out this field.', 'and keeps the browser sentence');
});

test('adapter-dom: the site own error sentence beats the browser generic one', () => {
  const { d, h } = dom(`<h1>Details</h1>
    <label for="ni">National Insurance number</label>
    <input id="ni" name="ni" required aria-invalid="true" aria-errormessage="ni-err">
    <span id="ni-err">Enter a National Insurance number in the correct format</span>
    <label for="dob">Date</label>
    <input id="dob" name="dob" aria-describedby="dob-err">
    <span id="dob-err" role="alert">Enter a real date</span>
    <label for="ok">Town</label><input id="ok" name="ok" aria-invalid="false">`);
  assert.deepEqual(h.read('ni').errors, [{ code: 'required', message: 'Enter a National Insurance number in the correct format' }]);
  assert.deepEqual(h.read('dob').errors, [{ code: 'invalid', message: 'Enter a real date' }]);
  assert.deepEqual(h.read('ok').errors, [], 'aria-invalid="false" is not an error');
  d.el('#ni').value = 'QQ123456C';
  assert.equal(h.read('ni').errors[0].code, 'invalid', 'filled but still flagged by the site');
});

test('adapter-dom: an unmount and remount gives a control the same id it had before', () => {
  const { d, h } = dom(`<h2>Order</h2><div id="panel">
      <label>Coupon <input placeholder="Coupon code"></label>
      <label>Gift note <input placeholder="Gift note"></label>
    </div><label>Notes <input placeholder="Notes"></label>`);
  const before = kindsOf(h, 'field').map((f) => f.id);
  assert.equal(before.length, 3);
  assert.ok(before.every((id) => !/^field_\d+$/.test(id)), `no counter ids, got ${before}`);
  const panel = d.el('#panel');
  const parent = panel.parentElement;
  const next = parent.childNodes[parent.childNodes.indexOf(panel) + 1];
  // A React re-render hands back brand new nodes: drop pagecue's stamp too.
  for (const el of panel.querySelectorAll('input')) el.removeAttribute('data-pagecue-id');
  panel.remove();
  parent.insertBefore(panel, next);
  d.flushMutations();
  const after = createDomHooks({ root: d.body });
  assert.deepEqual(kindsOf(after, 'field').map((f) => f.id), before, 'ink anchored to these ids survives the re-render');
});

test('adapter-dom: a section container must actually contain its fields', () => {
  const { d, h } = dom(`<section id="signup">
      <div class="text-center"><h2>Create your account</h2><h3>It only takes a minute</h3></div>
      <form><label for="em">Work email</label><input id="em" name="em"></form>
    </section>`);
  d.el('#signup')._rect = { left: 0, top: 0, width: 600, height: 400 };
  d.el('.text-center')._rect = { left: 0, top: 0, width: 600, height: 60 };
  d.el('#em')._rect = { left: 20, top: 120, width: 300, height: 40 };
  const f = byId(h, 'em');
  // <h2> and <h3> under one parent are one section, titled by the higher rank.
  assert.equal(f.sectionLabel, 'Create your account');
  const sec = h.sectionRect(f.section), fld = h.rectOf('em');
  assert.ok(sec.y <= fld.y && sec.y + sec.h >= fld.y + fld.h,
    `the hatch box ${JSON.stringify(sec)} must enclose the field ${JSON.stringify(fld)}`);
});

test('adapter-dom: per-field fieldset wrappers do not become five sections called "Section"', () => {
  const { h } = dom(`<h2>Book a table</h2>
    <fieldset class="form-group"><label for="a">Name</label><input id="a" name="a"></fieldset>
    <fieldset class="form-group"><label for="b">Email</label><input id="b" name="b"></fieldset>
    <fieldset class="form-group"><legend>Party size</legend><label for="c">Guests</label><input id="c" name="c"></fieldset>
    <fieldset><legend>Where should we seat you?</legend>
      <label for="d">Area</label><input id="d" name="d">
      <label for="e">Table</label><input id="e" name="e"></fieldset>`);
  const secs = h.sections();
  assert.deepEqual(secs.map((s) => s.label), ['Book a table', 'Where should we seat you?'],
    'a fieldset earns a section only by grouping more than one field');
  assert.ok(!secs.some((s) => s.label === 'Section'), 'and never by falling back to the word "Section"');
  assert.equal(byId(h, 'c').sectionLabel, 'Book a table');
  assert.equal(byId(h, 'e').sectionLabel, 'Where should we seat you?');
});

test('adapter-dom: radios sharing a name are one field with options, not three fields', () => {
  const { d, h } = dom(`<h2>Permit</h2><fieldset id="pt"><legend>What kind of permit?</legend>
      <input type="radio" id="p1" name="permitType" value="resident"><label for="p1">Resident</label>
      <input type="radio" id="p2" name="permitType" value="visitor"><label for="p2">Visitor</label>
      <input type="radio" id="p3" name="permitType" value="trade"><label for="p3">Trade</label>
    </fieldset>
    <input type="radio" id="y1" name="post" value="y"><label for="y1">Yes</label>
    <input type="radio" id="y2" name="post" value="n"><label for="y2">No</label>`);
  const ids = kindsOf(h, 'field').map((f) => f.id);
  assert.deepEqual(ids, ['permitType', 'post'], 'no permitType-2 / permitType-3 fragments');
  const f = byId(h, 'permitType');
  assert.equal(f.type, 'radio');
  assert.equal(f.label, 'What kind of permit?', 'the legend labels the group');
  assert.deepEqual(f.options, [
    { value: 'resident', label: 'Resident' }, { value: 'visitor', label: 'Visitor' }, { value: 'trade', label: 'Trade' },
  ]);
  assert.equal(byId(h, 'post').label, 'Post', 'no fieldset: the shared name names the group');
  // One field means one box: it has to cover every option.
  d.el('#pt')._rect = { left: 10, top: 100, width: 400, height: 120 };
  assert.deepEqual(h.rectOf('permitType'), { x: 10, y: 100, w: 400, h: 120 });
  d.el('#y1')._rect = { left: 10, top: 300, width: 20, height: 20 };
  d.el('#y2')._rect = { left: 10, top: 340, width: 20, height: 20 };
  assert.deepEqual(h.rectOf('post'), { x: 10, y: 300, w: 20, h: 60 }, 'un-fieldsetted options union up');
});

test('adapter-dom: three date boxes are one date field, and only when that is obvious', () => {
  const { d, h } = dom(`<h1>Details</h1>
    <fieldset data-pagecue-group="dob" aria-describedby="dob-hint"><legend>Date of birth</legend>
      <span id="dob-hint">For example, 31 3 1980</span>
      <label for="dd">Day</label><input id="dd" name="dob-day">
      <label for="mm">Month</label><input id="mm" name="dob-month">
      <label for="yy">Year</label><input id="yy" name="dob-year">
    </fieldset>
    <fieldset><legend>Issue date</legend>
      <label for="d2">Day</label><input id="d2" name="i-day">
      <label for="m2">Month</label><input id="m2" name="i-month">
      <label for="y2">Year</label><input id="y2" name="i-year">
    </fieldset>
    <fieldset><legend>Your address</legend>
      <label for="l1">Line 1</label><input id="l1" name="l1">
      <label for="l2">Line 2</label><input id="l2" name="l2">
      <label for="l3">Town</label><input id="l3" name="l3">
    </fieldset>`);
  assert.deepEqual(kindsOf(h, 'field').map((f) => f.id), ['dob', 'sec_Details_issue_date_date-parts', 'l1', 'l2', 'l3'],
    'day/month/year collapse; three unrelated boxes stay three plain fields');
  const f = byId(h, 'dob');
  assert.equal(f.type, 'date-parts');
  assert.equal(f.label, 'Date of birth');
  assert.equal(f.group, 'dob');
  assert.equal(f.hint, 'For example, 31 3 1980');
  assert.deepEqual(h.read('dob'), { value: '', filled: false, errors: [] }, 'nothing typed yet');
  d.el('#dd').value = '31'; d.el('#mm').value = '3';
  assert.equal(h.read('dob').filled, false, 'a partial date is not a date');
  assert.equal(h.commit('dob', '1980-03-31'), true);
  assert.deepEqual([d.el('#dd').value, d.el('#mm').value, d.el('#yy').value], ['31', '03', '1980']);
  assert.equal(h.read('dob').value, '1980-03-31');
  assert.equal(h.commit('dob', 'last tuesday'), false);
  // and the pure pieces underneath
  assert.equal(datePartRole('Day'), 'day');
  assert.equal(datePartRole('Birthday'), '', 'word-exact, so "Birthday" is not a day box');
  assert.equal(serializeDateParts({ day: '1', month: '2', year: '1999' }), '1999-02-01');
  assert.equal(serializeDateParts({ day: '1', month: '2', year: '99' }), '', 'a two-digit year is a guess, so it is refused');
  assert.deepEqual(parseDateParts('1980-03-31'), { year: '1980', month: '03', day: '31' });
  assert.equal(parseDateParts('31/03/1980'), null);
});

test('adapter-dom: select options carry their human labels, not just their codes', () => {
  const { h } = dom(`<h2>Where</h2><label for="r">Region</label>
    <select id="r" name="r">
      <option value="">Choose a region</option>
      <option value="yh">Yorkshire and the Humber</option>
      <option value="sw">South West</option>
    </select>`);
  assert.deepEqual(byId(h, 'r').options, [
    { value: '', label: 'Choose a region' },
    { value: 'yh', label: 'Yorkshire and the Humber' },
    { value: 'sw', label: 'South West' },
  ]);
  assert.equal(h.commit('r', 'yh'), true);
  assert.equal(h.read('r').value, 'yh');
  assert.equal(h.commit('r', 'atlantis'), false, 'a value with no option is refused');
});

test('adapter-dom: landmarks make non-field things pointable, and never writable', () => {
  const { d, h } = dom(`<h1>Your orders</h1>
    <button>Continue</button>
    <span role="button">Cancel</span>
    <a href="/help">Help centre</a>
    <a href="#"> </a>
    <img src="logo.png" alt="Kestrel Rail">
    <table><thead><tr><th>Item</th><th>Qty</th></tr></thead>
      <tbody><tr><td>Mug</td><td>2</td></tr></tbody></table>
    <table><tr><td>layout</td></tr></table>
    <p data-pagecue-target="The small print">Terms apply to all orders.</p>
    <label for="q">Qty</label><input id="q" name="q">`);
  const marks = kindsOf(h, 'landmark');
  assert.deepEqual(marks.map((m) => m.role),
    ['heading', 'button', 'button', 'link', 'image', 'row', 'text']);
  assert.deepEqual(marks.map((m) => m.label),
    ['Your orders', 'Continue', 'Cancel', 'Help centre', 'Kestrel Rail', 'Mug · 2', 'The small print']);
  assert.equal(marks.find((m) => m.role === 'link').href, '/help');
  assert.ok(marks.every((m) => !('readMask' in m) && m.kind === 'landmark'));
  // A landmark is an anchor, not a field: no value, and nothing to commit to.
  const row = marks.find((m) => m.role === 'row');
  assert.deepEqual(h.read(row.id), { value: '', filled: false, errors: [] });
  assert.equal(h.commit(row.id, 'x'), false);
  d.el('button')._rect = { left: 5, top: 50, width: 90, height: 30 };
  assert.deepEqual(h.rectOf(marks[1].id), { x: 5, y: 50, w: 90, h: 30 }, 'rectOf resolves landmarks too');
  assert.equal(marks[0].section, undefined, 'a landmark outside every section claims none');
});

test('adapter-dom: landmark discovery is capped, keeping the most pointable ones', () => {
  let html = '<h1>Catalogue</h1>';
  for (let i = 0; i < 200; i++) html += `<a href="/p/${i}">Product ${i}</a>`;
  for (let i = 0; i < 40; i++) html += `<h3>Section ${i}</h3>`;
  html += '<p data-pagecue-target="Fine print">Legal</p>';
  const { h } = dom(html);
  const marks = kindsOf(h, 'landmark');
  assert.equal(marks.length, 150, 'a catalogue page must not blow up the model context');
  assert.equal(marks.filter((m) => m.role === 'heading').length, 41, 'headings survive ahead of links');
  assert.ok(marks.some((m) => m.label === 'Fine print'), 'an explicit data-pagecue-target is never dropped');
  assert.equal(marks[0].label, 'Catalogue', 'and what survives stays in document order');
  // The ranking itself, without a 240-node page.
  const items = [{ role: 'link' }, { role: 'text', explicit: true }, { role: 'heading' }];
  assert.deepEqual(capLandmarks(items, 2), [items[1], items[2]]);
  assert.deepEqual(capLandmarks(items, 9), items, 'under the cap nothing is touched');
});

test('adapter-dom: the ignore option hides a subtree without the page stamping it', () => {
  const html = `<h2>Order</h2><label for="q">Qty</label><input id="q" name="q">
    <div class="devtools"><h3>State inspector</h3><label for="dbg">Debug</label><input id="dbg" name="dbg"></div>
    <div data-pagecue-ignore><label for="x">Internal</label><input id="x" name="x"></div>`;
  const open = dom(html).h;
  assert.ok(byId(open, 'dbg'), 'without the option the devtools panel is just more DOM');
  const { h } = dom(html, { ignore: ['.devtools'] });
  assert.equal(byId(h, 'dbg'), undefined);
  assert.equal(byId(h, 'x'), undefined);
  assert.ok(byId(h, 'q'));
  assert.ok(!kindsOf(h, 'landmark').some((m) => m.label === 'State inspector'), 'landmarks respect it too');
});

test('adapter-dom: the tier-2 wrapper still accepts everything the DOM scan produces', () => {
  const { h } = dom(`<h2>Sign in</h2><label for="pw">Password</label><input id="pw" type="password" value="s3cret">
    <label for="em">Email</label><input id="em" name="em" required>`);
  const adapter = createHooksAdapter(h);
  const snap = domSnapshot(adapter, createRegistry(adapter));
  const flat = snap.sections.flatMap((s) => s.fields);
  assert.equal(flat.find((f) => f.id === 'pw').value, PROTECTED_MASK);
  assert.equal(flat.find((f) => f.id === 'pw').protected, true);
  assert.equal(flat.find((f) => f.id === 'em').errors[0].code, 'required');
  assert.equal(snap.progress.required_total, 1);
});

// ---------------------------------------------------------------- 9. registration surface
// WebMCP moved from navigator.modelContext to document.modelContext, and both
// names are live in the field (Chrome 150 keeps the old one as an alias; older
// origin-trial builds only have it). registerNative has to find either, prefer
// document, and say which it used -- the lab log records that per browser.

import { findModelContext, registerNative, unregisterNative, instrumentTools, withResultHint, withAvailability, availabilityOf, availabilityNote, registerLive } from '../src/tools.js';

// A stand-in modelContext that records what was registered on it. No DOM: the
// only surface under test is the two global property names.
function fakeMc() {
  const registered = new Map();
  return {
    registered,
    registerTool: (spec) => registered.set(spec.name, spec),
    unregisterTool: (name) => registered.delete(name),
  };
}
// Install globals for one call, then put the world back exactly as it was.
function withGlobals({ doc, nav }, fn) {
  const had = { doc: 'document' in globalThis, nav: 'navigator' in globalThis };
  const prev = { doc: globalThis.document, nav: globalThis.navigator };
  const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  const drop = (k) => { delete globalThis[k]; };
  try {
    doc === undefined ? drop('document') : set('document', doc);
    nav === undefined ? drop('navigator') : set('navigator', nav);
    return fn();
  } finally {
    had.doc ? set('document', prev.doc) : drop('document');
    had.nav ? set('navigator', prev.nav) : drop('navigator');
  }
}
const TOOLS = [{ name: 'point_at', title: 'T', description: 'D', inputSchema: {}, execute: () => ({ ok: true }) }];

test('surface: no modelContext anywhere reports "none" and registers nothing', () => {
  withGlobals({ doc: {}, nav: {} }, () => {
    assert.equal(findModelContext().surface, 'none');
    const r = registerNative(TOOLS);
    assert.deepEqual(r, { registered: false, surface: 'none', names: [] });
  });
});

test('surface: document.modelContext is used when present', () => {
  const mc = fakeMc();
  withGlobals({ doc: { modelContext: mc }, nav: {} }, () => {
    const r = registerNative(TOOLS);
    assert.equal(r.surface, 'document');
    assert.deepEqual(r.names, ['pagecue.point_at']);
    assert.ok(mc.registered.has('pagecue.point_at'));
  });
});

test('surface: navigator.modelContext is the fallback when document has none', () => {
  const mc = fakeMc();
  withGlobals({ doc: {}, nav: { modelContext: mc } }, () => {
    const r = registerNative(TOOLS);
    assert.equal(r.surface, 'navigator', 'the older global still counts as a real surface');
    assert.ok(mc.registered.has('pagecue.point_at'));
  });
});

test('surface: document wins when a build exposes both names', () => {
  const d = fakeMc(), n = fakeMc();
  withGlobals({ doc: { modelContext: d }, nav: { modelContext: n } }, () => {
    assert.equal(registerNative(TOOLS).surface, 'document');
    assert.equal(d.registered.size, 1);
    assert.equal(n.registered.size, 0, 'the deprecated alias must not get a second copy');
  });
});

test('surface: an object without registerTool is not a surface', () => {
  const mc = fakeMc();
  withGlobals({ doc: { modelContext: { getTools: () => [] } }, nav: { modelContext: mc } }, () => {
    assert.equal(registerNative(TOOLS).surface, 'navigator');
  });
});

test('surface: prefix lets a host page register its own tools beside pagecue', () => {
  const mc = fakeMc();
  withGlobals({ doc: { modelContext: mc }, nav: {} }, () => {
    registerNative(TOOLS);
    registerNative([{ name: 'personalize', title: 'P', description: 'D', inputSchema: {}, execute: () => ({ ok: true }) }], { prefix: '' });
    assert.deepEqual([...mc.registered.keys()], ['pagecue.point_at', 'personalize']);
    unregisterNative(TOOLS);
    assert.deepEqual([...mc.registered.keys()], ['personalize'], 'pagecue unregisters only its own namespace');
  });
});

test('surface: annotations come from the tool when it declares them', () => {
  const mc = fakeMc();
  withGlobals({ doc: { modelContext: mc }, nav: {} }, () => {
    registerNative([
      { name: 'read_page', title: 'R', description: 'D', inputSchema: {}, execute: () => ({ ok: true }) },
      { name: 'circle', title: 'C', description: 'D', inputSchema: {}, execute: () => ({ ok: true }) },
      { name: 'report_agent_friction', title: 'F', description: 'D', inputSchema: {}, annotations: { readOnlyHint: true, idempotentHint: true }, execute: () => ({ ok: true }) },
    ], { prefix: '' });
    assert.deepEqual(mc.registered.get('read_page').annotations, { readOnlyHint: true });
    assert.deepEqual(mc.registered.get('circle').annotations, { readOnlyHint: false });
    assert.deepEqual(mc.registered.get('report_agent_friction').annotations, { readOnlyHint: true, idempotentHint: true });
  });
});

test('instrument: the observer sees name, input, result and a duration', async () => {
  const seen = [];
  const tools = instrumentTools([{ name: 'circle', execute: (i) => ({ ok: true, echoed: i.target }) }], (c) => seen.push(c));
  const out = await tools[0].execute({ target: 'name' });
  assert.deepEqual(out, { ok: true, echoed: 'name' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'circle');
  assert.deepEqual(seen[0].input, { target: 'name' });
  assert.equal(seen[0].result.ok, true);
  assert.ok(Number.isFinite(seen[0].durationMs) && seen[0].durationMs >= 0);
});

test('instrument: a tool that throws becomes a structured refusal, still observed', async () => {
  const seen = [];
  const tools = instrumentTools([{ name: 'boom', execute: () => { throw new Error('anchor gone'); } }], (c) => seen.push(c));
  const out = await tools[0].execute({});
  assert.equal(out.ok, false);
  assert.match(out.error.message, /boom.*anchor gone/, 'the agent gets an answer, not an exception');
  assert.equal(seen.length, 1, 'and the failure is logged like any other call');
  assert.equal(seen[0].result.ok, false);
});

test('instrument: an observer that throws cannot break the tool call', async () => {
  const tools = instrumentTools([{ name: 'circle', execute: () => ({ ok: true }) }], () => { throw new Error('logger down'); });
  assert.deepEqual(await tools[0].execute({}), { ok: true });
});

// ---------------------------------------------------------------- result hint
// The c6 probe: nudge the agent towards a tool through what every OTHER tool
// returns, without touching a single description.

test('resultHint: every successful result grows a when_done field', async () => {
  const tools = withResultHint([
    { name: 'read_page', execute: () => ({ ok: true, page: { title: 'x' } }) },
    { name: 'circle', execute: () => ({ ok: true, ink_id: 'i1' }) },
  ], 'before you finish, say what you could not find');
  const page = await tools[0].execute({});
  assert.equal(page.when_done, 'before you finish, say what you could not find');
  assert.deepEqual(page.page, { title: 'x' }, 'the original result is untouched');
  assert.equal((await tools[1].execute({})).when_done, 'before you finish, say what you could not find');
});

test('resultHint: a refusal is left alone', async () => {
  const tools = withResultHint(
    [{ name: 'circle', execute: () => ({ ok: false, error: { message: 'unknown target' } }) }],
    'before you finish, report friction',
  );
  const out = await tools[0].execute({});
  assert.equal(out.ok, false);
  assert.equal('when_done' in out, false, 'an agent that just failed is not also given a chore');
});

test('resultHint: an empty or missing hint leaves the tools exactly as they were', () => {
  const mkTool = () => ({ name: 'circle', execute: () => ({ ok: true }) });
  for (const hint of [undefined, null, '', '   ', 42]) {
    const t = mkTool();
    const before = t.execute;
    assert.equal(withResultHint([t], hint)[0].execute, before, `hint ${JSON.stringify(hint)} must be a no-op`);
  }
});

test('resultHint: the hint is inside the instrumentation, so the observer sees it', async () => {
  const seen = [];
  const tools = instrumentTools(
    withResultHint([{ name: 'read_page', execute: () => ({ ok: true }) }], 'call report_agent_friction'),
    (c) => seen.push(c),
  );
  await tools[0].execute({});
  assert.equal(seen[0].result.when_done, 'call report_agent_friction');
});

test('resultHint: a tool that throws still refuses, and carries no hint', async () => {
  const tools = instrumentTools(
    withResultHint([{ name: 'boom', execute: () => { throw new Error('anchor gone'); } }], 'call report_agent_friction'),
    () => {},
  );
  const out = await tools[0].execute({});
  assert.equal(out.ok, false);
  assert.equal('when_done' in out, false);
});

test('instrument: no observer leaves the tools exactly as they were', () => {
  const t = { name: 'circle', execute: () => ({ ok: true }) };
  const before = t.execute;
  assert.equal(instrumentTools([t])[0].execute, before);
});

// ============================================== 12. THE ACTIVITY TRAIL ======
// activity.js keeps the page's own record of what happened on it. The rows that
// matter are the `input` rows, and what they are allowed to claim is exactly
// one thing: page script did not write them. They do NOT say a person did it --
// WebDriver and CDP input reaches the page with isTrusted true as well. So the
// first case below is the forgery attempt page script loses, and the ones after
// it pin down the wording that must never over-claim again.
const {
  createActivity, createActivityLog, collectChoices, toolTargets, describeEntry, describeRow, whoLabel,
  MAX_ENTRIES, ATTESTATION_NOTE, composeHandoff, splitSentences, resolveSlotValue,
} = await import('../src/activity.js');
const { createDomAdapter: mkDomAdapter } = await import('../src/adapter-dom.js');

// The whole stack the way pagecue.init() builds it: DOM adapter -> registry ->
// activity -> instrumented tools, with the trail fed from the same observer.
function live(html) {
  const d = mountDom(html);
  d.body._rect = { left: 0, top: 0, width: 1000, height: 2000 };
  const adapter = mkDomAdapter({ root: d.body, container: d.body });
  const registry = createRegistry(adapter);
  const activity = createActivity({ adapter, root: d.body });
  const tools = byName(instrumentTools(createTools(adapter, registry, activity), (c) => activity.toolCall(c)));
  return { d, adapter, registry, activity, tools };
}

const CHIPS = `<h1>Set up your desktop</h1>
  <div class="ask"><p>Is this desk for work or personal?</p>
    <button type="button" data-pagecue-id="desk_work" data-pagecue-target="Work desk" aria-pressed="false">Work</button>
    <button type="button" data-pagecue-id="desk_personal" data-pagecue-target="Personal desk" aria-pressed="false">Personal</button>
  </div>`;

// The page's own click handler, bound where a real one is: after pagecue's
// capture listener has already written its row.
function chipHandler(d) {
  d.body.addEventListener('click', (ev) => {
    const chip = ev.target && ev.target.closest ? ev.target.closest('button[data-pagecue-target]') : null;
    if (!chip) return;
    for (const c of d.all('button[data-pagecue-target]')) c.setAttribute('aria-pressed', String(c === chip));
  });
}

test('activity: a page-script click is not an input event and is never recorded', () => {
  const { d, activity } = live(CHIPS);
  const chip = d.el('[data-pagecue-id="desk_work"]');
  chip.click();                                                       // element.click()
  chip.dispatchEvent(new globalThis.Event('click', { bubbles: true })); // hand-built event
  assert.deepEqual(activity.entries(), [], 'page script cannot write an input row');
  d.humanEvent(chip, 'click');
  assert.equal(activity.entries().length, 1, 'a browser-dispatched click still lands');
  assert.equal(activity.entries()[0].who, 'input');
});

test('activity: a browser-dispatched click records the target, its label and the state it left behind', async () => {
  const { d, activity, tools } = live(CHIPS);
  chipHandler(d);
  d.humanEvent(d.el('[data-pagecue-id="desk_work"]'), 'click');
  activity.settle();   // the page's handler has run; re-read what it left
  const rows = activity.entries();
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { who: rows[0].who, kind: rows[0].kind, target: rows[0].target, label: rows[0].label, state: rows[0].state },
    { who: 'input', kind: 'click', target: 'desk_work', label: 'Work desk', state: 'pressed' },
  );
  assert.equal(rows[0].seq, 1);
  assert.equal(typeof rows[0].t, 'number');

  const out = await tools.read_activity.execute({});
  assert.equal(out.ok, true);
  assert.deepEqual(out.entries, rows, 'the tool returns the buffer, not a second story');
  assert.equal(out.choices.desk_work.value, 'pressed', 'live state agrees with the trail');
  assert.equal(out.choices.desk_personal.value, 'not pressed');
  assert.equal(out.choices.desk_work.label, 'Work desk');
});

test('activity: a second chip is its own row, so both answers survive', () => {
  const { d, activity } = live(`${CHIPS}
    <div class="ask"><p>When do you use your Mac most?</p>
      <button type="button" data-pagecue-id="hours_evening" data-pagecue-target="Evening" aria-pressed="false">Evening</button>
    </div>`);
  chipHandler(d);
  d.humanEvent(d.el('[data-pagecue-id="desk_work"]'), 'click');
  d.humanEvent(d.el('[data-pagecue-id="hours_evening"]'), 'click');
  activity.settle();
  assert.deepEqual(activity.entries().map((e) => e.target), ['desk_work', 'hours_evening']);
});

test('activity: a tool call is recorded as the agent, with the ids it named', async () => {
  const { activity, tools } = live(`<h1>Order</h1><h2>Your details</h2>
    <label for="nm">Full name</label><input id="nm">`);
  await tools.circle.execute({ target: 'nm', tone: 'attention' });
  const rows = activity.entries({ who: 'agent' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].who, 'agent');
  assert.equal(rows[0].kind, 'tool');
  assert.equal(rows[0].label, 'circle');
  assert.equal(rows[0].target, 'nm');
  // A refusal is still a call, and is labelled as one.
  await tools.circle.execute({ target: 'nope', tone: 'error' });
  const after = activity.entries({ who: 'agent' });
  assert.equal(after.length, 2);
  assert.equal(after[1].state, 'refused');
  assert.equal(after[1].target, null, 'an id the page does not have is not recorded as one');
  // Reading the trail must not fill the trail with reads of the trail.
  await tools.read_activity.execute({});
  await tools.read_activity.execute({});
  assert.equal(activity.entries({ who: 'agent' }).length, 2);
});

test('activity: a page can put its own line on the record, labelled as the page', () => {
  const { activity } = live(`<h1>Download</h1>
    <section id="gate" data-pagecue-target="Get the Mac installer"><h2>Get the Mac installer</h2></section>`);
  const entry = activity.note('Separate builds per processor', { target: 'gate' });
  assert.equal(entry.who, 'site');
  assert.equal(entry.kind, 'note');
  assert.equal(entry.label, 'Separate builds per processor');
  assert.equal(entry.target, 'gate');
  assert.equal(activity.note('  ', {}), null, 'an empty note is not a row');
  // An id the page does not have is dropped, not invented.
  assert.equal(activity.note('anything', { target: 'not_here' }).target, null);
  assert.deepEqual(activity.entries({ who: 'site' }).map((e) => e.label),
    ['Separate builds per processor', 'anything']);
});

test('activity: free typing records its LENGTH and never its words', () => {
  const { d, activity } = live(`<h1>Request</h1><h2>Your idea</h2>
    <label for="idea">Your idea</label><input id="idea">`);
  const input = d.el('#idea');
  input.value = 'a widget for my bins';
  d.humanEvent(input, 'input');
  const rows = activity.entries();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'edit');
  assert.equal(rows[0].value, '20 chars');
  assert.ok(!JSON.stringify(rows).includes('bins'), 'nothing the visitor typed is on the trail');
  // Consecutive edits of the same field are one action carrying the final length.
  input.value = 'a widget';
  d.humanEvent(input, 'input');
  d.humanEvent(input, 'change');
  const after = activity.entries();
  assert.equal(after.length, 1, 'typing is one row, not one per keystroke');
  assert.equal(after[0].value, '8 chars');
});

test('activity: a choice field records the option the page named for it', () => {
  const { d, activity } = live(`<h1>Permit</h1><fieldset><legend>What kind of permit?</legend>
    <input type="radio" id="p1" name="permitType" value="resident"><label for="p1">Resident</label>
    <input type="radio" id="p2" name="permitType" value="visitor"><label for="p2">Visitor</label>
    </fieldset>`);
  d.el('#p2').checked = true;
  d.humanEvent(d.el('#p2'), 'change');
  const rows = activity.entries();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'change');
  assert.equal(rows[0].target, 'permitType');
  assert.equal(rows[0].value, 'visitor');
  assert.equal(rows[0].state, 'Visitor', 'the label the page wrote, not the raw value');
});

test('activity: a masked field is not recorded at all, not even that it was touched', () => {
  const { d, activity } = live(`<h1>Sign in</h1><h2>Your account</h2>
    <label for="pw">Password</label><input id="pw" type="password">
    <label for="em">Email</label><input id="em" type="email">`);
  const pw = d.el('#pw');
  pw.value = 'hunter2';
  d.humanEvent(pw, 'input');
  d.humanEvent(pw, 'change');
  d.humanEvent(pw, 'click');
  assert.deepEqual(activity.entries(), [], 'a protected field leaves no trace whatsoever');
  const em = d.el('#em');
  em.value = 'dana@example.com';
  d.humanEvent(em, 'input');
  assert.equal(activity.entries().length, 1, 'an ordinary field still records');
  assert.equal(activity.entries()[0].target, 'em');
});

test('activity: the buffer is a ring -- the oldest rows fall off the end', () => {
  const log = createActivityLog();
  for (let i = 1; i <= MAX_ENTRIES + 12; i++) log.add({ who: 'site', kind: 'note', label: `n${i}` });
  const rows = log.list();
  assert.equal(rows.length, MAX_ENTRIES);
  assert.equal(rows[0].label, 'n13', 'the first twelve were dropped');
  assert.equal(rows[0].seq, 13, 'seq keeps counting, so a reader can tell it lost some');
  assert.equal(rows[rows.length - 1].seq, MAX_ENTRIES + 12);
  const small = createActivityLog({ max: 2 });
  small.add({ who: 'site', kind: 'note', label: 'a' });
  small.add({ who: 'site', kind: 'note', label: 'b' });
  small.add({ who: 'site', kind: 'note', label: 'c' });
  assert.deepEqual(small.list().map((e) => e.label), ['b', 'c']);
});

test('activity: since_seq and who narrow the trail, and are validated', async () => {
  const { d, activity, tools } = live(CHIPS);
  d.humanEvent(d.el('[data-pagecue-id="desk_work"]'), 'click');
  activity.note('Separate builds per processor');
  await tools.read_page.execute({});
  const all = (await tools.read_activity.execute({})).entries;
  assert.deepEqual(all.map((e) => e.who), ['input', 'site', 'agent']);

  const after1 = await tools.read_activity.execute({ since_seq: all[0].seq });
  assert.deepEqual(after1.entries.map((e) => e.seq), [all[1].seq, all[2].seq]);
  const inputs = await tools.read_activity.execute({ who: 'input' });
  assert.deepEqual(inputs.entries.map((e) => e.who), ['input']);
  const both = await tools.read_activity.execute({ since_seq: all[0].seq, who: 'agent' });
  assert.deepEqual(both.entries.map((e) => e.label), ['read_page']);

  const bad = await tools.read_activity.execute({ since_seq: -1 });
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /since_seq/);
  const badWho = await tools.read_activity.execute({ who: 'somebody' });
  assert.equal(badWho.ok, false);
  assert.match(badWho.error.hint, /input, agent, site/);
});

test('activity: read_page carries the same choices and a one-line summary', async () => {
  const { d, activity, tools } = live(`${CHIPS}
    <h2>Delivery</h2><label for="speed">Speed</label>
    <select id="speed"><option value="std">Standard</option><option value="fast">Next day</option></select>`);
  chipHandler(d);
  let page = (await tools.read_page.execute({})).page;
  assert.deepEqual(page.activity, { input_actions: 0, last_input_action: null, attestation: 'none' });
  assert.equal(page.choices.desk_work.value, 'not pressed');
  assert.equal(page.choices.speed.value, 'std');
  assert.equal(page.choices.speed.chosen, 'Standard');

  d.humanEvent(d.el('[data-pagecue-id="desk_work"]'), 'click');
  activity.settle();
  page = (await tools.read_page.execute({})).page;
  assert.equal(page.choices.desk_work.value, 'pressed');
  assert.deepEqual(page.activity, {
    input_actions: 1,
    last_input_action: { kind: 'click', target: 'desk_work', label: 'Work desk', state: 'pressed' },
    attestation: 'none',
  });
  assert.deepEqual(page.choices, (await tools.read_activity.execute({})).choices, 'one source for both');
});

test('activity: turning it off removes both tools and the two read_page blocks together', async () => {
  const d = mountDom(CHIPS);
  d.body._rect = { left: 0, top: 0, width: 1000, height: 2000 };
  const adapter = mkDomAdapter({ root: d.body, container: d.body });
  const registry = createRegistry(adapter);
  const off = byName(createTools(adapter, registry));
  assert.equal(off.__list.length, 9);
  assert.equal(off.read_activity, undefined);
  const page = (await off.read_page.execute({})).page;
  assert.equal('choices' in page, false);
  assert.equal('activity' in page, false);
  assert.equal(off.await_activity, undefined);
  // And with it on, both trail tools are there and declare themselves read-only.
  const on = byName(createTools(adapter, registry, createActivity({ adapter, root: d.body })));
  assert.equal(on.__list.length, 11);
  assert.equal(on.read_activity.annotations.readOnlyHint, true);
  assert.equal(on.await_activity.annotations.readOnlyHint, true);
  // Waiting is not idempotent: the same call at two moments answers differently.
  assert.equal(on.await_activity.annotations.idempotentHint, false);
});

test('activity: the wording a person reads names the author and the action', () => {
  const rows = [
    { who: 'input', kind: 'click', target: 'desk_work', label: 'Work desk', state: 'pressed' },
    { who: 'input', kind: 'edit', target: 'idea', label: 'Your idea', value: '20 chars' },
    { who: 'input', kind: 'change', target: 'speed', label: 'Speed', value: 'fast', state: 'Next day' },
    { who: 'agent', kind: 'tool', target: 'nm', label: 'circle' },
    { who: 'site', kind: 'note', target: 'gate', label: 'Separate builds per processor' },
  ];
  // Never "you": the page cannot know that the reader is who moved the mouse.
  assert.deepEqual(rows.map(whoLabel), ['on the page', 'on the page', 'on the page', 'assistant', 'this page']);
  assert.deepEqual(rows.map(describeEntry), [
    'clicked Work desk — pressed',
    'typed in Your idea — 20 chars',
    'chose Next day in Speed',
    'called circle',
    'noted “Separate builds per processor”',
  ]);
  assert.equal(describeRow(rows[0]), 'on the page clicked Work desk — pressed');
  assert.equal(describeEntry(null), '');
});

test('activity: read_activity\'s description claims only what the browser can tell us', () => {
  const d = mountDom(CHIPS);
  d.body._rect = { left: 0, top: 0, width: 1000, height: 2000 };
  const adapter = mkDomAdapter({ root: d.body, container: d.body });
  const tools = byName(createTools(adapter, createRegistry(adapter), createActivity({ adapter, root: d.body })));
  const { description } = tools.read_activity;

  // The claim this guard exists to keep out. isTrusted is true for WebDriver
  // and CDP input as well as for a person, so any wording that reads an entry
  // back as a person's act is false, however it is phrased.
  for (const overclaim of [
    /\bhumans?\b/i,
    /\bvisitors?\b/i,
    /\breal input\b/i,
    /synthetic events are never recorded/i,
    /\b(made|done|typed|clicked|chosen) by (a |the )?(person|people|someone)\b/i,
    /\bproof that a person\b/i,
  ]) {
    assert.ok(!overclaim.test(description), `description must not claim ${overclaim}`);
  }
  // And it must still say the two true things, in as many words.
  assert.match(description, /cannot tell a person at the keyboard from an agent driving the browser/);
  assert.match(description, /not proof of a person/);
  assert.match(description, /current choices/);
  assert.ok(description.split(/\s+/).length <= 90, 'the description stays short enough to be read');
  assert.equal(tools.read_activity.annotations.readOnlyHint, true);
});

test('activity: every reader carries attestation "none" and says why', async () => {
  const { d, activity, tools } = live(CHIPS);
  d.humanEvent(d.el('[data-pagecue-id="desk_work"]'), 'click');

  const out = await tools.read_activity.execute({});
  assert.equal(out.attestation, 'none', 'the result states its own attestation, not just the docs');
  assert.equal(out.attestation_note, ATTESTATION_NOTE);
  assert.match(out.attestation_note, /cannot prove who dispatched an input event/);
  assert.match(out.attestation_note, /automation drivers do too/);
  // read_page's one-line block says the same thing, so an agent that never
  // calls read_activity cannot read input_actions as a count of a person.
  const page = (await tools.read_page.execute({})).page;
  assert.equal(page.activity.attestation, 'none');
  assert.equal(page.activity.input_actions, 1);
  // The visitor reads the identical sentence off the strip.
  assert.equal(activity.attestationNote, ATTESTATION_NOTE);
});

test('activity: toolTargets keeps only ids the page actually has', () => {
  const known = (id) => ['nm', 'email', 'sec_main'].includes(id);
  assert.deepEqual(toolTargets({ target: 'nm' }, known), ['nm']);
  assert.deepEqual(toolTargets({ from: 'nm', to: 'email' }, known), ['nm', 'email']);
  assert.deepEqual(toolTargets({ targets: ['nm', 'nm', 'email'] }, known), ['nm', 'email']);
  assert.deepEqual(toolTargets({ section: 'sec_main' }, known), ['sec_main']);
  assert.deepEqual(toolTargets({ target: 'invented' }, known), []);
  assert.deepEqual(toolTargets(null, known), []);
});

test('activity: collectChoices needs no page for the form half of it', () => {
  const adapter = {
    fields: () => [
      { id: 'speed', kind: 'field', type: 'select', label: 'Speed', options: [{ value: 'std', label: 'Standard' }] },
      { id: 'nm', kind: 'field', type: 'text', label: 'Full name' },
      { id: 'pin', kind: 'field', type: 'select', label: 'PIN', readMask: true, options: [] },
      { id: 'lm_go', kind: 'landmark', role: 'button', label: 'Go' },
    ],
    read: (id) => ({ value: id === 'speed' ? 'std' : '', filled: true, errors: [] }),
  };
  const out = collectChoices(adapter, null);
  assert.deepEqual(Object.keys(out), ['speed']);
  assert.deepEqual(out.speed, { label: 'Speed', value: 'std', kind: 'select', chosen: 'Standard' });
});

// ------------------------------------------------- await_activity (long poll)
//
// The page cannot signal an agent, so the subscription is a tool call held
// open. These pin the three things that make such a call safe to loop on: it
// never sleeps through something that already happened, its cursor never
// re-delivers, and it always answers.

test('await: rows already newer than the cursor come back without waiting', async () => {
  const { d, activity, tools } = live(CHIPS);
  d.humanEvent(d.el('[data-pagecue-id="desk_work"]'), 'click');
  assert.equal(activity.entries().length, 1);
  const r = await tools.await_activity.execute({ since_seq: 0, timeout_seconds: 25 });
  assert.equal(r.ok, true);
  assert.equal(r.timed_out, false);
  assert.equal(r.entries.length, 1);
  assert.equal(r.next_seq, 1);
});

test('await: a row that arrives while waiting wakes the call', async () => {
  const { d, activity, tools } = live(CHIPS);
  const p = tools.await_activity.execute({ since_seq: 0, timeout_seconds: 5 });
  activity.note('the build finished');
  const r = await p;
  assert.equal(r.timed_out, false);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].who, 'site');
  assert.equal(r.next_seq, 1);
});

test('await: nothing happening still answers, and the cursor does not move', async () => {
  const { tools } = live(CHIPS);
  const r = await tools.await_activity.execute({ since_seq: 7, timeout_seconds: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.timed_out, true);
  assert.deepEqual(r.entries, []);
  assert.equal(r.next_seq, 7, 'a timeout must not advance the caller past rows it never saw');
});

test('await: the cursor counts filtered-out rows, so a who filter cannot re-deliver', async () => {
  const { d, activity, tools } = live(CHIPS);
  activity.note('a site row');                                    // seq 1, who 'site'
  d.humanEvent(d.el('[data-pagecue-id="desk_work"]'), 'click');     // seq 2, who 'input'
  const r = await tools.await_activity.execute({ since_seq: 0, who: 'input', timeout_seconds: 1 });
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].who, 'input');
  assert.equal(r.next_seq, 2, 'the skipped site row is behind the cursor, not waiting to come back');
});

test('await: a timed-out call lets go of the buffer', async () => {
  const { activity, tools } = live(CHIPS);
  const r = await tools.await_activity.execute({ since_seq: 0, timeout_seconds: 1 });
  assert.equal(r.timed_out, true);
  // If the subscriber or the timer had outlived the call, this would throw or
  // resolve a settled promise; the buffer must simply take the row.
  activity.note('after the wait ended');
  assert.equal(activity.entries().length, 1, 'the wait itself left no row behind');
});

test('await: polling in a loop does not wake on its own footprints', async () => {
  const { tools } = live(CHIPS);
  const first = await tools.await_activity.execute({ since_seq: 0, timeout_seconds: 1 });
  assert.equal(first.timed_out, true);
  // If the first wait had written an agent row, this one would return it at
  // once and the agent's loop would spin instead of blocking.
  const second = await tools.await_activity.execute({ since_seq: first.next_seq, timeout_seconds: 1 });
  assert.equal(second.timed_out, true);
  assert.deepEqual(second.entries, []);
});

test('await: its arguments are checked, and the timeout is capped below the browser cap', async () => {
  const { tools } = live(CHIPS);
  assert.equal((await tools.await_activity.execute({})).ok, false, 'since_seq is required');
  assert.equal((await tools.await_activity.execute({ since_seq: -1 })).ok, false);
  assert.equal((await tools.await_activity.execute({ since_seq: 1.5 })).ok, false);
  assert.equal((await tools.await_activity.execute({ since_seq: 0, who: 'human' })).ok, false, '"human" is the label we removed');
  const tooLong = await tools.await_activity.execute({ since_seq: 0, timeout_seconds: 30 });
  assert.equal(tooLong.ok, false, "30s is Chrome's own cap; ours must resolve first");
  assert.match(tooLong.error.message, /1 to 25/);
});

test('await: the schema stops short of the browser timeout it has to beat', () => {
  const { tools } = live(CHIPS);
  assert.equal(tools.await_activity.inputSchema.properties.timeout_seconds.maximum, 25);
  assert.deepEqual(tools.await_activity.inputSchema.required, ['since_seq']);
});

test('await: waiting carries the same attestation as reading', async () => {
  const { activity, tools } = live(CHIPS);
  activity.note('x');
  const r = await tools.await_activity.execute({ since_seq: 0, timeout_seconds: 1 });
  assert.equal(r.attestation, 'none');
  assert.equal(r.attestation_note, ATTESTATION_NOTE);
  assert.ok(r.choices, 'live state travels with the rows so they can be checked against it');
});

// ------------------------------------------------------- composeHandoff
//
// The sentence the visitor hands their agent. It is a template because it has
// to agree with read_activity by construction, not by luck.

test('handoff: slots take the label the page gave the option, not the raw value', () => {
  const choices = {
    desk: { label: 'Desk', value: 'pm', chosen: 'Evening', kind: 'select' },
  };
  assert.equal(
    composeHandoff('I picked {desk}. Set up my desktop.', choices),
    'I picked Evening. Set up my desktop.',
  );
});

test('handoff: an unfilled slot drops its sentence and keeps the rest', () => {
  const out = composeHandoff('I picked {desk} and {time}. Set up my desktop.', { desk: { chosen: 'Work desk' } });
  assert.equal(out, 'Set up my desktop.', 'a half-true sentence is worse than a short one');
});

test('handoff: an unmade choice does not read as a made one', () => {
  for (const v of ['false', 'not pressed', 'unchecked', 'not selected', '', null]) {
    const out = composeHandoff('I chose {c}. Go on.', { c: { value: v } });
    assert.equal(out, 'Go on.', `"${v}" is not a choice a person made`);
  }
});

test('handoff: a pressed chip stands for its own label, an unpressed one for nothing', () => {
  const choices = {
    desk_work: { label: 'Work desk', value: 'pressed', kind: 'button' },
    desk_personal: { label: 'Personal desk', value: 'not pressed', kind: 'button' },
  };
  assert.equal(resolveSlotValue(choices, 'desk_work'), 'Work desk');
  assert.equal(resolveSlotValue(choices, 'desk_personal'), '', '"pressed" must never surface as the words a visitor chose');
  assert.equal(
    composeHandoff('I picked {desk_work|desk_personal}. Set it up.', choices),
    'I picked Work desk. Set it up.',
  );
});

test('handoff: a chip group with nothing on drops its sentence', () => {
  const none = {
    desk_work: { label: 'Work desk', value: 'not pressed', kind: 'button' },
    desk_personal: { label: 'Personal desk', value: 'not pressed', kind: 'button' },
  };
  assert.equal(composeHandoff('I picked {desk_work|desk_personal}. Set it up.', none), 'Set it up.');
});

test('handoff: no template and no choices produce nothing rather than a husk', () => {
  assert.equal(composeHandoff('', {}), '');
  assert.equal(composeHandoff('   ', {}), '');
  assert.equal(composeHandoff('I picked {desk}.', {}), '');
  assert.equal(composeHandoff(null, {}), '');
});

test('handoff: sentences split on their terminators and keep them', () => {
  assert.deepEqual(splitSentences('One. Two! Three?'), ['One.', 'Two!', 'Three?']);
  assert.deepEqual(splitSentences('No terminator'), ['No terminator']);
  assert.deepEqual(splitSentences(''), []);
});

test('handoff: the same choices always compose the same sentence', () => {
  const choices = { desk: { chosen: 'Work desk' }, time: { chosen: 'Evening' } };
  const t = 'I picked {desk} and {time}. Set up my desktop using this page\'s tools.';
  assert.equal(composeHandoff(t, choices), composeHandoff(t, choices));
  assert.equal(composeHandoff(t, choices), "I picked Work desk and Evening. Set up my desktop using this page's tools.");
});


// --------------------------------------------- tools that are visible but shut
//
// Absence tells an agent something a rendered page cannot, but it is ambiguous:
// a missing tool could be a closed step, a page still loading, or a policy. So
// the tool stays in the list and refuses with a reason. These pin the one
// property that keeps that from being an empty claim -- it must actually refuse.

const gateTool = () => ([{
  name: 'unlock_download',
  title: 'Get the installer',
  description: 'Return the installer link.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  execute: () => ({ ok: true, url: 'https://example.test/canvas.dmg' }),
}]);

test('availability: an unconditional tool is untouched', async () => {
  const [t] = withAvailability(gateTool(), () => null);
  assert.equal((await t.execute({})).ok, true);
  assert.equal(t.describeNow(), 'Return the installer link.');
});

test('availability: a closed tool refuses, and says what would open it', async () => {
  let open = false;
  const [t] = withAvailability(gateTool(), () => (open ? null : {
    available: false, reason: 'We need to know which Mac you have.', unblocked_by: 'choose_mac',
  }));
  const shut = await t.execute({});
  assert.equal(shut.ok, false);
  assert.equal(shut.available, false);
  assert.equal(shut.reason, 'We need to know which Mac you have.');
  assert.equal(shut.unblocked_by, 'choose_mac');
  assert.equal(shut.url, undefined, 'a refusal must not leak the thing it is refusing');
  // ...and the same page, once the condition is met, simply works.
  open = true;
  assert.equal((await t.execute({})).ok, true);
});

test('availability: the state is in the description, so the list carries it', () => {
  const [t] = withAvailability(gateTool(), () => ({
    available: false, reason: 'Pick your Mac first.', unblocked_by: 'choose_mac',
  }));
  assert.match(t.describeNow(), /NOT AVAILABLE RIGHT NOW: Pick your Mac first\./);
  assert.match(t.describeNow(), /Available once you use "choose_mac"\./);
  assert.ok(t.describeNow().startsWith('Return the installer link.'), 'the tool still says what it is for');
});

test('availability: a note needs no remedy, and no state means no note', () => {
  assert.equal(availabilityNote(null), '');
  assert.equal(availabilityNote({ reason: 'Sold out.' }), ' NOT AVAILABLE RIGHT NOW: Sold out.');
});

test('availability: a resolver that throws leaves the tool open rather than stuck', async () => {
  const [t] = withAvailability(gateTool(), () => { throw new Error('bad predicate'); });
  assert.equal(availabilityOf(() => { throw new Error('x'); }, 'n'), null);
  assert.equal((await t.execute({})).ok, true, 'our bug must not become the visitor\'s locked door');
});

test('availability: anything but an explicit false is available', () => {
  for (const state of [null, undefined, {}, { available: true }, 'no', 0]) {
    assert.equal(availabilityOf(() => state, 'n'), null);
  }
});

test('registerLive: re-registers only when the description actually changes', () => {
  const mc = fakeMc();
  let open = false;
  const tools = withAvailability(gateTool(), () => (open ? null : { available: false, reason: 'Pick your Mac first.' }));
  withGlobals({ doc: { modelContext: mc }, nav: {} }, () => {
    const live = registerLive(tools, { prefix: '', resolve: () => null });
    assert.equal(live.registered, true);
    assert.match(mc.registered.get('unlock_download').description, /NOT AVAILABLE/);

    assert.deepEqual(live.sync().changed, [], 'nothing changed, so nothing is re-registered');

    open = true;
    const after = live.sync();
    assert.equal(after.changed.length, 1);
    assert.equal(after.changed[0].closed, false, 'the state comes from the resolver, not from our own wording');
    assert.equal(mc.registered.get('unlock_download').description, 'Return the installer link.');
    assert.equal(mc.registered.size, 1, 'replacing must not leave the closed copy behind');
  });
});

test('registerLive: with no modelContext it reports none and syncs harmlessly', () => {
  withGlobals({ doc: {}, nav: {} }, () => {
    const live = registerLive(gateTool(), {});
    assert.equal(live.registered, false);
    assert.equal(live.surface, 'none');
    assert.deepEqual(live.sync().changed, []);
  });
});


await Promise.all(pending);

// ---------------------------------------------------------------- summary
console.log(`\n${passed} passed, ${failures.length} failed, ${passed + failures.length} total`);
if (failures.length) {
  console.log('\nfailed:');
  for (const f of failures) console.log(`  - ${f.name}`);
  process.exit(1);
}
