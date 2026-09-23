// pagecue/src/activity.js -- the page's own record of what has happened on it.
//
// Every other module in pagecue answers "what is on this page". This one answers
// "what has been DONE to it, and by whom". Three authors share one buffer and
// every row is labelled with which of them wrote it:
//
//   who: 'input'  dispatched by the browser to the page -- a person at the
//                 keyboard, or an agent driving the browser. The page cannot
//                 tell those two apart and this label does not claim to.
//   who: 'agent'  the visitor's agent, through a WebMCP tool call. This one IS
//                 attributable: the call came through our own instrumentation.
//   who: 'site'   the page itself, through pagecue.note()
//
// WHAT THE 'input' LABEL GUARANTEES, AND WHAT IT DOES NOT. Every listener below
// rejects an event whose isTrusted is not exactly true, so element.click() and
// dispatchEvent() write nothing here: PAGE SCRIPT cannot forge a row. That is
// the whole of it. isTrusted separates page script from browser-dispatched
// input; it does not separate a person from automation, because WebDriver and
// CDP input arrive with isTrusted true as well. So every reader carries
// attestation: 'none' (see ATTESTATION_NOTE), and the buffer earns its keep by
// being cross-checkable against `choices` and against what the agent itself
// observed -- not by proving who was at the keyboard.
//
// WHAT VALUES ARE KEPT. A choice is a small, closed set the page itself
// authored, so the chosen option is recorded in full. Free typing is the
// visitor's own words, so only its LENGTH is recorded. Anything the adapter
// masks -- passwords, card numbers, one-time codes -- is not recorded at all,
// not even that it was touched.
//
// The upper half of this file is DOM-free, so the buffer, the filters and the
// wording can be exercised in plain Node. Only createActivity() needs a page.

import { isLandmark, readMasked } from './tools.js';

// A page-long trail is not the point; the last stretch of it is. Fifty rows is
// several minutes of real clicking and still a small payload.
export const MAX_ENTRIES = 50;
export const MAX_CHOICES = 40;
export const NOTE_MAX = 120;

// Two edits of the same field a second apart are one action, not two rows.
// Coalescing on the way in is what makes "the final value" true of typing
// without a timer that a page could unload before it fires.
export const COALESCE_MS = 800;

export const WHO = Object.freeze(['input', 'agent', 'site']);
export const WHO_LABEL = Object.freeze({ input: 'on the page', agent: 'assistant', site: 'this page' });

// The honesty field every reader carries. 'none' is not a placeholder for a
// stronger value we have yet to build: no page can do better, because the
// browser does not tell a page who dispatched an input event.
export const ATTESTATION = 'none';
export const ATTESTATION_NOTE = 'The page cannot prove who dispatched an input event — only that it '
  + 'came from the browser rather than from page script, which automation drivers do too. Entries can be '
  + 'cross-checked against the choices block returned here and against what the agent itself observed.';

// The field types that hold a choice from a closed set the page authored.
export const CHOICE_TYPES = new Set(['select', 'radio', 'checkbox', 'checkbox-group']);

// The tools that only READ the trail, and so never write to it. See toolCall().
export const SELF_READS = new Set(['read_activity', 'await_activity']);

const START = Date.now();
function defaultNow() {
  if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
    return Math.round(performance.now());
  }
  return Date.now() - START;
}

// ------------------------------------------------------------------ the buffer

// createActivityLog() -> a ring buffer of entries, plus the two filters the
// tool offers. Knows nothing about a page, an adapter or an event.
export function createActivityLog({ max = MAX_ENTRIES, now = defaultNow } = {}) {
  const rows = [];
  const subs = new Set();
  let seq = 0;

  const emit = () => {
    for (const fn of [...subs]) {
      try { fn(); } catch (e) { console.warn('[pagecue] an activity listener threw (the entry is still recorded):', e); }
    }
  };

  const assign = (entry, key, value) => {
    if (value === undefined || value === null || value === '') delete entry[key];
    else entry[key] = value;
  };

  function add(rec = {}) {
    const entry = {
      seq: ++seq,
      t: now(),
      who: WHO.includes(rec.who) ? rec.who : 'site',
      kind: String(rec.kind || 'action'),
      target: rec.target || null,
      label: String(rec.label || ''),
    };
    assign(entry, 'value', rec.value);
    assign(entry, 'state', rec.state);
    if (Array.isArray(rec.targets) && rec.targets.length > 1) entry.targets = [...rec.targets];
    rows.push(entry);
    while (rows.length > max) rows.shift();
    emit();
    return entry;
  }

  // Merge changes into an entry already in the buffer. A key given as null or
  // undefined is REMOVED, so a re-read that finds no state leaves no stale one.
  function patch(entry, changes = {}) {
    if (!entry || !rows.includes(entry)) return entry || null;
    if (changes.kind) entry.kind = String(changes.kind);
    if (changes.label) entry.label = String(changes.label);
    if (typeof changes.t === 'number') entry.t = changes.t;
    if ('value' in changes) assign(entry, 'value', changes.value);
    if ('state' in changes) assign(entry, 'state', changes.state);
    emit();
    return entry;
  }

  function list({ since_seq, who } = {}) {
    let out = rows;
    if (typeof since_seq === 'number') out = out.filter((e) => e.seq > since_seq);
    if (who) out = out.filter((e) => e.who === who);
    return out.map((e) => ({ ...e }));
  }

  return {
    add,
    patch,
    list,
    now,
    // The live object, not a copy: patch() needs identity, and the recorder is
    // the only caller.
    last: () => rows[rows.length - 1] || null,
    size: () => rows.length,
    holds: (entry) => rows.includes(entry),
    clear: () => { rows.length = 0; emit(); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

// ------------------------------------------------------------------ handoff

// The page has no way to speak to an agent. requestUserInteraction() was
// removed from WebMCP and nothing replaced it, so a page that wants an agent to
// act cannot ask; it can only be asked. The visitor is the one channel that
// still works -- they read a sentence, they hand it over, and the agent hears
// it from the person it already trusts rather than from a stranger's DOM.
//
// WHY THIS IS A TEMPLATE AND NOT A MODEL. The sentence and the trail have to
// come from ONE source or the cross-check we offer is theatre: an agent that
// compares what the visitor pasted against read_activity must find them
// agreeing by construction, not by luck. A generated sentence could paraphrase,
// reorder or invent a preference and we would have manufactured the mismatch
// ourselves. Deterministic also means the same clicks always yield the same
// words, so an agent that has seen this page before can rely on the shape.
//
// A slot is {pagecue-id}. It is filled with the LABEL the page gave the chosen
// option ("Evening", never "pm"). Sentences are the unit of collapse: a
// sentence holding a slot the visitor has not filled is dropped whole, so
// someone who has chosen nothing still gets a shorter sentence that is true,
// rather than a blank or the word "undefined".
export const HANDOFF_SLOT = /\{([^{}]+)\}/g;

// A chip group is one choice spread over several elements, so a slot may name
// alternatives with "|" -- {desk_work|desk_personal} is "which desk", and it
// resolves to the LABEL of whichever one is currently on. A select is the
// simple case, one id, resolving to the chosen option's label.
export const HANDOFF_ALT = '|';

// What a toggled landmark reports instead of a value. A pressed chip stands
// for its own label ("Work desk"); an unpressed one stands for nothing, and
// must never read as a choice the visitor made.
const STATE_ON = new Set(['pressed', 'selected', 'checked', 'true', 'on', 'yes']);
const STATE_OFF = new Set(['', 'false', 'not pressed', 'unchecked', 'not selected', 'off', 'no']);

export function resolveSlotValue(choices, id) {
  const c = choices && choices[id];
  if (!c) return '';
  // `chosen` is the label the page itself gave the selected option, so it wins
  // outright: it exists only when something was in fact selected.
  if (c.chosen) return String(c.chosen).trim();
  const raw = c.value === undefined || c.value === null ? '' : String(c.value).trim();
  if (STATE_OFF.has(raw.toLowerCase())) return '';
  if (STATE_ON.has(raw.toLowerCase())) return String(c.label || '').trim();
  return raw;
}

export function composeHandoff(template, choices = {}) {
  if (typeof template !== 'string' || !template.trim()) return '';
  const slot = (spec) => {
    for (const id of String(spec).split(HANDOFF_ALT)) {
      const v = resolveSlotValue(choices, id.trim());
      if (v) return v;
    }
    return '';
  };
  const kept = [];
  for (const sentence of splitSentences(template)) {
    let missing = false;
    const filled = sentence.replace(HANDOFF_SLOT, (_, spec) => {
      const v = slot(spec);
      if (!v) { missing = true; return ''; }
      return v;
    });
    if (!missing) kept.push(filled.trim());
  }
  return kept.join(' ').replace(/\s+/g, ' ').trim();
}

// Sentences, keeping their terminator. Deliberately dumb: the templates are
// ours, they are two sentences long, and a real tokeniser here would be a
// dependency bought to solve a problem we do not have.
export function splitSentences(text) {
  const out = String(text).match(/[^.!?]+[.!?]*/g);
  return out ? out.map((s) => s.trim()).filter(Boolean) : [];
}

// ------------------------------------------------------------------ pure parts

// Which target ids a tool call named. Written against the tool schemas in
// tools.js and the site tools beside them, and every id is checked against the
// live page, so a made-up argument never becomes a row.
const TARGET_KEYS = ['target', 'field', 'from', 'to', 'section', 'gave_up_at'];
export function toolTargets(input, known) {
  const src = input && typeof input === 'object' ? input : {};
  const out = [];
  const push = (v) => {
    if (typeof v !== 'string' || !v) return;
    if (out.includes(v)) return;
    if (typeof known === 'function' && !known(v)) return;
    out.push(v);
  };
  for (const k of TARGET_KEYS) push(src[k]);
  if (Array.isArray(src.targets)) for (const v of src.targets) push(v);
  return out;
}

// The label the page gave an option, so a row reads "Evening" rather than "pm".
export function optionLabel(record, value) {
  const opts = (record && record.options) || [];
  const hit = opts.find((o) => String(o.value) === String(value));
  return hit ? hit.label : '';
}

// collectChoices(adapter, ariaStateOf) -> { <pagecue id>: {label, value, kind, chosen?} }
//
// Every element on the page that currently holds a choice: the form's own
// selects, radios and checkboxes straight off the adapter, plus whatever the
// page marks up as a chosen state with aria-pressed or aria-selected, which
// ariaStateOf resolves for the caller (it is the one part that needs a page).
export function collectChoices(adapter, ariaStateOf) {
  const out = {};
  let n = 0;
  for (const t of adapter.fields()) {
    if (n >= MAX_CHOICES) break;
    if (isLandmark(t)) {
      const s = typeof ariaStateOf === 'function' ? ariaStateOf(t) : null;
      if (!s) continue;
      out[t.id] = { label: t.label || t.id, value: s.value, kind: s.kind };
      n++;
      continue;
    }
    if (!CHOICE_TYPES.has(t.type) || readMasked(t)) continue;
    const r = adapter.read(t.id) || {};
    const rec = { label: t.label || t.id, value: r.value ?? '', kind: t.type };
    const chosen = optionLabel(t, r.value);
    if (chosen) rec.chosen = chosen;
    out[t.id] = rec;
    n++;
  }
  return out;
}

// Who an entry is attributed to, in the words a visitor reads on the strip.
export const whoLabel = (e) => WHO_LABEL[e && e.who] || 'this page';

// What the entry says, WITHOUT the author -- the strip prints the author in its
// own column and would otherwise say it twice. describeRow() joins the two for
// anywhere that wants one string.
export function describeEntry(e) {
  if (!e) return '';
  const label = e.label || e.target || 'something on this page';
  if (e.who === 'agent') return `called ${label}${e.state === 'refused' ? ' (refused)' : ''}`;
  if (e.who === 'site') return `noted “${label}”`;
  if (e.kind === 'edit') return `typed in ${label}${e.value ? ` — ${e.value}` : ''}`;
  if (e.kind === 'change') return `chose ${e.state || e.value} in ${label}`;
  return `clicked ${label}${e.state ? ` — ${e.state}` : ''}`;
}

export const describeRow = (e) => (e ? `${whoLabel(e)} ${describeEntry(e)}` : '');

// ------------------------------------------------------------------ the recorder

const IGNORED = '[data-pagecue-ignore], [data-pagecue-overlay]';

// createActivity({ adapter, root }) -> the whole facade: the buffer, the input
// recorder attached to `root`, and the three readers the tool and the strip use.
export function createActivity({ adapter, root, log } = {}) {
  const buffer = log || createActivityLog();
  const scope = root || (typeof document !== 'undefined' ? document.body : null);

  // adapter.fields() is memoised by every adapter pagecue ships and it is what
  // stamps data-pagecue-id onto the page, so it is called first and freshly on
  // every resolution rather than cached here and left to go stale.
  const targetMap = () => new Map(adapter.fields().map((f) => [f.id, f]));
  const knownId = (id) => adapter.fields().some((f) => f.id === id)
    || adapter.sections().some((s) => s.id === id);

  function elementFor(id) {
    if (!scope || typeof scope.querySelector !== 'function') return null;
    return scope.querySelector(`[data-pagecue-id="${id}"]`);
  }

  // The pagecue target a click landed on, or null. Only ids the adapter itself
  // knows count: everything else on the page is furniture the agent cannot
  // address anyway, and a row it cannot look up is a row it cannot use.
  function resolve(node) {
    if (!node || typeof node.closest !== 'function') return null;
    if (node.closest(IGNORED)) return null;
    const map = targetMap();
    for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
      const id = typeof n.getAttribute === 'function' ? n.getAttribute('data-pagecue-id') : null;
      if (id && map.has(id)) return { id, record: map.get(id), el: n };
    }
    return null;
  }

  const ariaOf = (el) => {
    if (!el || typeof el.getAttribute !== 'function') return null;
    const pressed = el.getAttribute('aria-pressed');
    if (pressed !== null) return { value: pressed === 'true' ? 'pressed' : 'not pressed', kind: 'button' };
    const selected = el.getAttribute('aria-selected');
    if (selected !== null) return { value: selected === 'true' ? 'selected' : 'not selected', kind: 'tab' };
    const checked = el.getAttribute('aria-checked');
    if (checked !== null) return { value: checked === 'true' ? 'checked' : 'unchecked', kind: 'checkbox' };
    return null;
  };

  const ariaStateOf = (record) => ariaOf(elementFor(record.id));

  // What a field holds right now, in the page's own words.
  function fieldState(record) {
    const r = adapter.read(record.id) || {};
    if (record.type === 'radio' || record.type === 'select') {
      return optionLabel(record, r.value) || (r.value ? String(r.value) : '');
    }
    if (record.type === 'checkbox') return r.value === true ? 'checked' : 'unchecked';
    if (record.type === 'checkbox-group') {
      const on = Array.isArray(r.value) ? r.value : [];
      return on.map((v) => optionLabel(record, v) || v).join(', ');
    }
    return '';
  }

  const stateFor = (hit) => {
    const aria = ariaOf(hit.el);
    if (aria) return aria.value;
    return isLandmark(hit.record) ? '' : fieldState(hit.record);
  };

  // Consecutive input events on the SAME target are one action. Typing lands
  // as one row carrying the final length; a click that also fires change lands
  // as one row carrying the resulting choice.
  function pushInput(rec) {
    const last = buffer.last();
    if (last && last.who === 'input' && last.target === rec.target && buffer.now() - last.t < COALESCE_MS) {
      return buffer.patch(last, { kind: rec.kind, value: rec.value, state: rec.state, t: buffer.now() });
    }
    return buffer.add({ ...rec, who: 'input' });
  }

  // A capture-phase listener runs BEFORE the page's own handler, so the state a
  // click leaves behind does not exist yet when the row is written. The row is
  // written in order anyway and its state is re-read on the next turn.
  const timers = new Set();
  const pendingReads = new Set();
  function later(fn) {
    pendingReads.add(fn);
    const id = setTimeout(() => { timers.delete(id); if (pendingReads.delete(fn)) fn(); }, 0);
    timers.add(id);
  }
  const settle = () => { for (const fn of [...pendingReads]) { pendingReads.delete(fn); fn(); } };

  // THE isTrusted FILTER, AND WHAT IT IS FOR. Keep it: it is the strongest
  // signal a page has, and it is false for element.click() and for any event a
  // script builds, so page script cannot write a row here. It is NOT a humanity
  // check. The W3C WebDriver spec requires driver-dispatched actions to be
  // indistinguishable from real user input (isTrusted true), and CDP's Input.*
  // domain dispatches the same way -- our own verification recorded a CDP
  // Input.dispatchMouseEvent click through this filter while element.click() was
  // correctly ignored. Never restore the claim that a row here means a person.
  function onClick(ev) {
    if (!ev || ev.isTrusted !== true) return;
    const hit = resolve(ev.target);
    if (!hit || readMasked(hit.record)) return;
    const entry = pushInput({
      kind: 'click', target: hit.id, label: hit.record.label || hit.id, state: stateFor(hit),
    });
    later(() => {
      if (!buffer.holds(entry)) return;
      const after = stateFor(hit);
      if (after && after !== entry.state) buffer.patch(entry, { state: after });
    });
  }

  function onEdit(ev) {
    if (!ev || ev.isTrusted !== true) return;
    const hit = resolve(ev.target);
    if (!hit || isLandmark(hit.record) || readMasked(hit.record)) return;
    const record = hit.record;
    const r = adapter.read(record.id) || {};
    if (CHOICE_TYPES.has(record.type)) {
      pushInput({
        kind: 'change', target: record.id, label: record.label || record.id,
        value: r.value, state: fieldState(record),
      });
      return;
    }
    // Free typing: the length and nothing else. The words belong to the visitor.
    const len = String(r.value ?? '').length;
    pushInput({ kind: 'edit', target: record.id, label: record.label || record.id, value: `${len} chars` });
  }

  if (scope && typeof scope.addEventListener === 'function') {
    scope.addEventListener('click', onClick, true);
    scope.addEventListener('input', onEdit, true);
    scope.addEventListener('change', onEdit, true);
  }

  // ---------------------------------------------------------------- writers

  // What the page itself wants on the record. Recorded as who:'site', so an
  // agent reading the buffer can tell it apart from an input event on the page.
  function note(text, { target } = {}) {
    const body = typeof text === 'string' ? text.trim().slice(0, NOTE_MAX) : '';
    if (!body) return null;
    const id = typeof target === 'string' && knownId(target) ? target : null;
    return buffer.add({ who: 'site', kind: 'note', target: id, label: body });
  }

  // Every tool call, from the same instrumentation the host's own observer
  // sees, so the agent's half of the trail cannot drift from what it did.
  //
  // The two tools that READ this buffer are left out of it. For read_activity
  // the reason is noise: a buffer whose rows are mostly reads of itself pushes
  // out the actions it exists to report. For await_activity the reason is
  // worse than noise -- a wait that recorded itself would leave a row that
  // instantly satisfies the NEXT wait, so an agent polling in a loop would
  // spin on its own footprints and never block. Waiting has to be invisible to
  // the thing it waits on.
  function toolCall(call = {}) {
    const name = typeof call.name === 'string' ? call.name : '';
    if (!name || SELF_READS.has(name)) return null;
    const targets = toolTargets(call.input, knownId);
    return buffer.add({
      who: 'agent', kind: 'tool', label: name,
      target: targets[0] || null, targets,
      state: call.result && call.result.ok === false ? 'refused' : '',
    });
  }

  // ---------------------------------------------------------------- readers

  const entries = (filter) => buffer.list(filter || {});
  const choices = () => collectChoices(adapter, ariaStateOf);

  // The one-line block read_page carries. It states its own attestation for the
  // same reason read_activity does: a count of input actions read without that
  // qualifier is a count a reader will take for a count of what a person did.
  function summary() {
    const inputs = buffer.list({ who: 'input' });
    const last = inputs[inputs.length - 1] || null;
    return {
      input_actions: inputs.length,
      last_input_action: last
        ? { kind: last.kind, target: last.target, label: last.label, state: last.state ?? null }
        : null,
      attestation: ATTESTATION,
    };
  }

  return {
    log: buffer,
    note, toolCall,
    entries, choices, summary,
    // Carried on the facade rather than imported by its two readers, so the
    // tool result and the visible strip cannot drift into different caveats.
    attestation: ATTESTATION,
    attestationNote: ATTESTATION_NOTE,
    describe: describeEntry,
    whoLabel,
    subscribe: (fn) => buffer.subscribe(fn),
    settle,
    dispose() {
      if (scope && typeof scope.removeEventListener === 'function') {
        scope.removeEventListener('click', onClick, true);
        scope.removeEventListener('input', onEdit, true);
        scope.removeEventListener('change', onEdit, true);
      }
      for (const id of timers) clearTimeout(id);
      timers.clear();
      pendingReads.clear();
    },
  };
}
