// pagecue/src/tools.js -- the agent's entire surface. Note what is NOT here:
// no set_value, no submit, no way to touch the page. The agent reads the live
// page through an adapter and draws on the overlay; the human does the work.
//
// The authority seam is enforced *inside this module*, not by its caller:
// createTools() immediately narrows whatever adapter it is handed down to
// readView() -- fields / read / sections / expandSection -- and closes over
// that narrowed object alone. An adapter's commit() (the human "accept a
// suggestion" bridge) is therefore unreachable from every tool, from every
// tool's closure, and from anything importable here.
//
// The adapter's target list holds two kinds of record: 'field' (an input the
// human can type into) and 'landmark' (a heading, button, link, image, row --
// anything the agent may want to point at). Every DRAWING tool takes either.
// suggest_value takes fields only, and only fields that do not refuse writes.

import { PROTECTED_MASK } from './adapter-hooks.js';

const S = (props, required) => ({ type: 'object', properties: props, required, additionalProperties: false });
const T = (desc) => ({ type: 'string', description: desc + ' Use a target id from read_page -- a form field id, or a landmark id from the landmarks list.' });
const F = (desc) => ({ type: 'string', description: desc + ' Must be a form field id from read_page; landmarks are not accepted.' });

// How much of the page's furniture read_page is willing to describe. Landmarks
// are cheap to produce and expensive to read, so the payload is capped and each
// one's text is a teaser, not a transcript.
const MAX_LANDMARKS = 40;
const LANDMARK_TEXT = 90;

// A read-only projection of an adapter. Deliberately not a spread or a proxy:
// every capability is listed by hand, so a new adapter method cannot leak in.
export function readView(adapter) {
  return Object.freeze({
    fields: () => adapter.fields(),
    read: (id) => adapter.read(id),
    sections: () => adapter.sections(),
    // Expansion only -- the tool cannot collapse, and cannot pass any other value.
    expandSection: (id) => (typeof adapter.setCollapsed === 'function' ? !!adapter.setCollapsed(id, false) : false),
    title: () => (typeof adapter.title === 'function' ? adapter.title() : ''),
    today: () => (typeof adapter.today === 'function' ? adapter.today() : ''),
  });
}

// Two independent protections, both defaulting off, both tolerant of the legacy
// single `protected` boolean. Read them through here, never off the raw record.
export const isLandmark = (t) => !!t && t.kind === 'landmark';
export const readMasked = (t) => !!t && (t.readMask === undefined ? !!t.protected : !!t.readMask);
export const writeRefused = (t) => !!t && (isLandmark(t) || (t.writeRefuse === undefined ? !!t.protected : !!t.writeRefuse));

// The read_page payload: the page as the human currently sees it, plus the
// agent's own active ink. Built from the adapter alone, so it is page-agnostic.
//
// `activity` is optional and supplied by pagecue.init(); when it is absent (a
// host that turned the trail off, or a direct snapshot() call) the two blocks
// it owns are simply not there rather than present and empty.
export function snapshot(adapter, registry, activity) {
  const sections = adapter.sections();
  const bySection = new Map(sections.map((s) => [s.id, []]));
  const extras = [];
  const landmarks = [];
  let requiredTotal = 0, requiredFilled = 0, errorCount = 0, landmarksSeen = 0;

  for (const t of adapter.fields()) {
    if (isLandmark(t)) {
      landmarksSeen++;
      if (landmarks.length >= MAX_LANDMARKS) continue;
      landmarks.push({
        id: t.id, role: t.role || 'text', label: t.label || t.id,
        ...(t.section ? { section: t.section } : {}),
        ...(t.href ? { href: t.href } : {}),
        // A teaser only: enough to recognise the element, never the page's prose.
        ...(t.text && t.text !== t.label ? { text: String(t.text).slice(0, LANDMARK_TEXT) } : {}),
      });
      continue;
    }
    const r = adapter.read(t.id) || {};
    if (t.required) { requiredTotal++; if (r.filled) requiredFilled++; }
    errorCount += (r.errors || []).length;
    const masked = readMasked(t);
    const entry = {
      id: t.id, label: t.label, type: t.type,
      required: !!t.required,
      // Legacy shorthand kept for existing consumers: masked AND unsuggestible.
      protected: masked && writeRefused(t),
      read_masked: masked, suggestions_refused: writeRefused(t),
      // Belt and braces: the adapter masks, and the seam masks again. A tier-1
      // adapter that forgets still cannot leak a card number through read_page.
      value: masked ? (r.filled ? PROTECTED_MASK : '') : (r.value ?? ''),
      filled: !!r.filled, errors: r.errors || [],
      ...(t.hint ? { hint: t.hint } : {}),
      ...(t.options ? { options: t.options } : {}),
      ...(t.group ? { group: t.group } : {}),
    };
    if (!bySection.has(t.section)) { bySection.set(t.section, []); extras.push(t.section); }
    bySection.get(t.section).push(entry);
  }

  const known = new Map(sections.map((s) => [s.id, s]));
  const order = [...sections.map((s) => s.id), ...extras];
  return {
    title: adapter.title() || '',
    today: adapter.today() || '',
    sections: order.map((id) => {
      const s = known.get(id) || { id, label: id };
      return { id, label: s.label, protected: !!s.protected, collapsed: !!s.collapsed, fields: bySection.get(id) || [] };
    }),
    landmarks,
    ...(landmarksSeen > landmarks.length
      ? { landmarks_omitted: landmarksSeen - landmarks.length, landmarks_note: `${landmarksSeen - landmarks.length} more landmarks not listed; the ones above are the page's main furniture.` }
      : {}),
    progress: { required_filled: requiredFilled, required_total: requiredTotal, error_count: errorCount },
    ...(activity ? { choices: activity.choices(), activity: activity.summary() } : {}),
    your_ink: registry.summary(),
  };
}

export function createTools(rawAdapter, registry, activity = null) {
  const adapter = readView(rawAdapter);
  const ok = (extra = {}) => ({ ok: true, ...extra });
  const err = (message, hint) => ({ ok: false, error: { message, ...(hint ? { hint } : {}) } });
  const targetMap = () => new Map(adapter.fields().map((t) => [t.id, t]));
  const ink = (kind, spec) => {
    const r = registry.add(kind, spec);
    // registry.js speaks the old tool name in its own error strings; this module
    // owns the agent-facing vocabulary, so translate on the way out.
    if (r.error) return err(String(r.error));
    return ok({ ink_id: r.id, note: 'Drawn on the page. It will fade if the human resolves what it points at.' });
  };

  const tools = [
    {
      name: 'read_page',
      title: 'Read the live page and its form draft',
      description: 'Read the page as the human currently sees it. Returns every form field with its id, label, current (unsaved) value, hint text, allowed options, radio/checkbox group, validation errors and protection flags; the sections they sit in; and a landmarks list of the page furniture you may also point at — headings, buttons, links, images, regions and rows, each with an id and role. ALWAYS call this before drawing — every drawing tool takes ids from here, and ids you invent are refused. Fields marked read_masked show only filled/empty and their value is hidden from you. Fields marked suggestions_refused (payout details, signature, terms) will refuse suggest_value; you may still point at them and explain what belongs there.',
      inputSchema: S({}, []),
      execute: () => ok({ page: snapshot(adapter, registry, activity) }),
    },
    {
      name: 'point_at',
      title: 'Draw an arrow pointing at a target',
      description: 'Draw a hand-drawn arrow from the page margin to any target — a form field, or a landmark such as a heading, button, link or table row — with a short handwritten note at its tail. Use this to direct the human’s attention: "start here", "this is where your policy number goes", "press this when you are done". Set fade_when_filled=true for "fill this in" pointers so the arrow disappears once they do it (fields only; landmarks never fill).',
      inputSchema: S({
        target: T('The target to point at.'),
        note: { type: 'string', description: 'Short handwritten note shown at the arrow tail, max ~60 chars.' },
        fade_when_filled: { type: 'boolean', description: 'Auto-fade the arrow once the field is validly filled. Default false.' },
      }, ['target', 'note']),
      execute: (i) => ink('point', { fields: [i.target], note: String(i.note).slice(0, 80), fadeWhenFilled: !!i.fade_when_filled }),
    },
    {
      name: 'circle',
      title: 'Circle a target',
      description: 'Draw a marker-style circle around any target — a form field, or a landmark such as a heading, button, price or row. tone="error" (red) for something wrong — it fades automatically when the field becomes valid; tone="attention" (blue) for emphasis; tone="praise" (green) to mark something done well. Prefer circle over point_at when the thing is already on screen and the human just needs to look at it.',
      inputSchema: S({
        target: T('The target to circle.'),
        tone: { type: 'string', enum: ['error', 'attention', 'praise'], description: 'error=red auto-fades when fixed, attention=blue, praise=green.' },
        note: { type: 'string', description: 'Optional short note next to the circle.' },
      }, ['target', 'tone']),
      execute: (i) => ink('circle', { fields: [i.target], tone: i.tone, note: i.note ? String(i.note).slice(0, 80) : '' }),
    },
    {
      name: 'link',
      title: 'Draw an arrow linking two targets',
      description: 'Draw a curved arrow from one target to another with a label on it. Either end may be a form field or a landmark. Use it to show that two things disagree or depend on each other: dates out of order, a total that must equal a sum, a checkbox that gates a button, a heading that explains a field.',
      inputSchema: S({
        from: T('Arrow starts at this target.'),
        to: T('Arrow points at this target.'),
        label: { type: 'string', description: 'Short label on the arrow, e.g. "must be after this", max ~50 chars.' },
      }, ['from', 'to', 'label']),
      execute: (i) => i.from === i.to ? err('from and to must be different targets')
        : ink('link', { fields: [i.from, i.to], label: String(i.label).slice(0, 60) }),
    },
    {
      name: 'suggest_value',
      title: 'PageCue a suggested value next to a field',
      description: 'Write a suggested value in the margin next to a FORM FIELD, with your reasoning. You CANNOT enter it — the human sees an Accept button and decides. Fields only: landmarks (headings, buttons, links) have no value and are refused. Fields marked suggestions_refused in read_page (payout, signature, consent) are also refused: those the human must fill unaided. Use it for computable things: totals, dates, reformatted policy numbers.',
      inputSchema: S({
        field: F('The field the suggestion is for.'),
        value: { type: 'string', description: 'The suggested value, exactly as it would be typed.' },
        why: { type: 'string', description: 'One short line of reasoning shown with the suggestion.' },
      }, ['field', 'value', 'why']),
      execute: (i) => {
        // Fields-only, enforced HERE rather than left to the ink registry: the
        // landmark path is new, and a refusal has to teach as well as refuse.
        const t = targetMap().get(i.field);
        if (!t) return err(`Unknown field "${i.field}". Call read_page to see valid field ids.`);
        if (isLandmark(t)) {
          return err(`"${t.id}" is a landmark (${t.role} "${t.label}"), not a form field. It has no value to fill, so suggest_value cannot apply to it. Draw attention to it with point_at or circle instead, or link it to the field it explains.`);
        }
        if (writeRefused(t)) {
          return err(`"${t.id}" (${t.label}) is a write-protected field. The agent may not supply values for identity, payment, signature or consent fields — you can point at it with point_at or circle and explain what belongs there, but the human must fill it themselves.`);
        }
        return ink('suggest', { fields: [i.field], value: String(i.value), why: String(i.why).slice(0, 90) });
      },
    },
    {
      name: 'mark_skip',
      title: 'Cross-hatch a section to skip',
      description: 'Hatch out a whole section the human does not need to fill, with a reason tag. Example: if no emergency repairs were done, or a section does not apply to this claim type.',
      inputSchema: S({
        section: { type: 'string', description: 'Section id from read_page, e.g. "sec_items".' },
        reason: { type: 'string', description: 'Short reason shown on the hatching, max ~60 chars.' },
      }, ['section', 'reason']),
      execute: (i) => ink('skip', { fields: [], section: i.section, reason: String(i.reason).slice(0, 80) }),
    },
    {
      name: 'guide_path',
      title: 'Draw a numbered route through the page',
      description: 'Draw numbered step markers (1, 2, 3...) beside a sequence of targets, connected by a dotted line — a route through what is left to do, in the order you recommend. Targets may be form fields or landmarks, so a route can end on the Submit button or start at a heading. Field steps get ticked off visually as they are validly filled. Use 2-6 targets; one path at a time (drawing a new one is fine, but clear the old one first).',
      inputSchema: S({
        targets: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 6, description: 'Target ids from read_page, in recommended order.' },
        note: { type: 'string', description: 'Optional caption for the route.' },
      }, ['targets']),
      execute: (i) => ink('path', { fields: i.targets || [], note: i.note ? String(i.note).slice(0, 80) : '' }),
    },
    {
      name: 'reveal_section',
      title: 'Expand a collapsed section',
      description: 'Expand a collapsed page section so the human can see what you are about to point at. Purely visual; changes nothing in the form.',
      inputSchema: S({ section: { type: 'string', description: 'Section id to expand.' } }, ['section']),
      execute: (i) => adapter.expandSection(i.section) ? ok() : err(`Unknown section "${i.section}"`),
    },
    {
      name: 'clear_ink',
      title: 'Erase your ink',
      description: 'Erase your annotations. Pass ink_ids to erase specific ones (ids are in read_page under your_ink), or omit to erase everything you have drawn.',
      inputSchema: S({
        ink_ids: { type: 'array', items: { type: 'string' }, description: 'Specific ink ids; omit for all.' },
      }, []),
      execute: (i = {}) => ok({ cleared: registry.clear(i.ink_ids) }),
    },
  ];

  // The tenth tool exists only when the host kept the activity trail on. A tool
  // that would answer "nothing was recorded" on every call is worse than an
  // absent one: the agent reads the empty answer as a fact about the visitor.
  if (activity) {
    tools.push({
      name: 'read_activity',
      title: 'Read what has happened on this page',
      description:
        'An ordered record of what has happened on this page: input events the browser dispatched to it '
        + '(who "input"), this page\'s own notes ("site"), and your earlier tool calls ("agent"). Page script '
        + 'cannot write an "input" row — only browser-dispatched input can — but the page cannot tell a '
        + 'person at the keyboard from an agent driving the browser, so "input" is not proof of a person. '
        + 'The page\'s current choices come back with it, so entries can be checked against live state. Read-only.',
      inputSchema: S({
        since_seq: { type: 'integer', minimum: 0, description: 'Only entries after this seq number. Omit for the whole trail.' },
        who: { type: 'string', enum: ['input', 'agent', 'site'], description: 'Only entries by this author. Omit for all three.' },
      }, []),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      execute: (i = {}) => {
        const filter = {};
        if (i.since_seq !== undefined && i.since_seq !== null) {
          if (typeof i.since_seq !== 'number' || !Number.isInteger(i.since_seq) || i.since_seq < 0) {
            return err('"since_seq" must be a whole number of 0 or more when given.', 'Use the seq of the last entry you already read.');
          }
          filter.since_seq = i.since_seq;
        }
        if (i.who !== undefined && i.who !== null) {
          if (typeof i.who !== 'string' || !['input', 'agent', 'site'].includes(i.who)) {
            return err(`Unknown who "${i.who}".`, 'Allowed: input, agent, site — or omit it for all three.');
          }
          filter.who = i.who;
        }
        // The attestation travels WITH the rows, not only in the description: a
        // reader that skims the schema still meets the caveat in the payload.
        return ok({
          entries: activity.entries(filter),
          choices: activity.choices(),
          attestation: activity.attestation,
          attestation_note: activity.attestationNote,
        });
      },
    });

    // The eleventh tool turns the same buffer into a subscription. WebMCP gives a
    // page no way to signal an agent -- requestUserInteraction() was removed and
    // nothing replaced it -- so the only channel that stays open between them is a
    // tool call the page has not answered yet. Holding one open until something
    // happens is a long poll, and it is the whole of what a page can offer. The
    // agent calling this in a loop IS the subscription; nothing here keeps it
    // looping, and nothing should.
    //
    // THE CEILING IS 30 SECONDS AND IT IS NOT OURS. Chrome's built-in actor arms a
    // browser-side timer on every script tool call and on expiry fails the call
    // WITHOUT cancelling the page's promise -- it orphans it. So our own timeout
    // has to fire first and resolve cleanly, or each window leaks a pending
    // promise for the life of the tab. WAIT_MAX_S sits below that with room to
    // spare. An in-page or extension agent reaches tools by a different path that
    // arms no timer at all, so this cap costs those callers one extra round trip
    // and nothing else.
    //
    // ALREADY-PENDING ROWS RETURN AT ONCE. Waiting when the buffer already holds
    // something newer than the caller's cursor would drop whatever arrived
    // between two calls, which is the one bug a subscription may not have.
    const WAIT_DEFAULT_S = 20;
    const WAIT_MAX_S = 25;

    tools.push({
      name: 'await_activity',
      title: 'Wait for the next thing to happen on this page',
      description:
        'Blocks until something new is recorded on this page, then returns it — the same entries '
        + 'read_activity returns, with the same caveat that an "input" row is not proof of a person. '
        + 'Pass the "next_seq" from your last call as "since_seq" and nothing is missed between calls. '
        + 'Returns immediately if something already happened since that point. If nothing happens before '
        + 'the timeout it returns "timed_out": true with no entries, and you may call again to keep '
        + 'waiting. Read-only: waiting changes nothing on the page.',
      inputSchema: S({
        since_seq: { type: 'integer', minimum: 0, description: 'Return entries after this seq. Use "next_seq" from your previous call; 0 to start from the whole trail.' },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: WAIT_MAX_S, description: `How long to wait before giving up and answering anyway. Default ${WAIT_DEFAULT_S}, maximum ${WAIT_MAX_S}.` },
        who: { type: 'string', enum: ['input', 'agent', 'site'], description: 'Only wake for entries by this author. Omit for all three.' },
      }, ['since_seq']),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      execute: (i = {}) => {
        if (typeof i.since_seq !== 'number' || !Number.isInteger(i.since_seq) || i.since_seq < 0) {
          return err('"since_seq" is required and must be a whole number of 0 or more.', 'Pass 0 to start, then the "next_seq" from each answer.');
        }
        const filter = { since_seq: i.since_seq };
        if (i.who !== undefined && i.who !== null) {
          if (typeof i.who !== 'string' || !['input', 'agent', 'site'].includes(i.who)) {
            return err(`Unknown who "${i.who}".`, 'Allowed: input, agent, site — or omit it for all three.');
          }
          filter.who = i.who;
        }
        let waitS = WAIT_DEFAULT_S;
        if (i.timeout_seconds !== undefined && i.timeout_seconds !== null) {
          if (typeof i.timeout_seconds !== 'number' || !Number.isInteger(i.timeout_seconds) || i.timeout_seconds < 1 || i.timeout_seconds > WAIT_MAX_S) {
            return err(`"timeout_seconds" must be a whole number from 1 to ${WAIT_MAX_S} when given.`, `Omit it for ${WAIT_DEFAULT_S}.`);
          }
          waitS = i.timeout_seconds;
        }

        // The cursor to hand back is the newest seq in the WHOLE buffer, not the
        // newest that survived the `who` filter. Reporting the filtered one would
        // re-deliver every skipped row on the next call.
        const cursor = () => {
          const all = activity.entries({});
          const top = all.length ? all[all.length - 1].seq : 0;
          return Math.max(top, i.since_seq);
        };
        const answer = (entries, timed_out) => ok({
          entries,
          next_seq: cursor(),
          timed_out,
          choices: activity.choices(),
          attestation: activity.attestation,
          attestation_note: activity.attestationNote,
        });

        const ready = activity.entries(filter);
        if (ready.length) return answer(ready, false);

        return new Promise((resolve) => {
          let settled = false;
          let timer = null;
          let unsub = null;
          const finish = (entries, timed_out) => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearTimeout(timer);
            if (unsub) unsub();
            resolve(answer(entries, timed_out));
          };
          timer = setTimeout(() => finish([], true), waitS * 1000);
          unsub = activity.subscribe(() => {
            const rows = activity.entries(filter);
            if (rows.length) finish(rows, false);
          });
        });
      },
    });
  }

  return tools;
}

// Native WebMCP registration (feature-detected; the app works without it).
//
// The API moved from navigator.modelContext to document.modelContext; Chrome
// 150 deprecates the old name but keeps it as an alias, and older origin-trial
// builds only have the old one. A page that wants to be callable on both has
// to look in both places, so this is where that lookup lives -- once, named,
// and reported back so a lab page can log WHICH surface it found.
export function findModelContext() {
  const d = (typeof document !== 'undefined' && document) ? document.modelContext : null;
  if (d && typeof d.registerTool === 'function') return { surface: 'document', mc: d };
  const n = (typeof navigator !== 'undefined' && navigator) ? navigator.modelContext : null;
  if (n && typeof n.registerTool === 'function') return { surface: 'navigator', mc: n };
  return { surface: 'none', mc: null };
}

// registerNative(tools, { prefix }) -> { registered, surface, names }
//
// `prefix` exists so a host page can put its OWN tools on the same surface
// through the same helper without borrowing pagecue's namespace: pagecue registers
// `pagecue.point_at`, a lab page registers a bare `personalize`.
export function registerNative(tools, { prefix = 'pagecue.' } = {}) {
  const { surface, mc } = findModelContext();
  if (!mc) return { registered: false, surface, names: [] };
  const names = [];
  for (const t of tools) {
    const name = `${prefix}${t.name}`;
    mc.registerTool({
      name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations || { readOnlyHint: t.name === 'read_page' },
      execute: async (input) => t.execute(input || {}),
    });
    names.push(name);
  }
  return { registered: true, surface, names };
}

export function unregisterNative(tools, { prefix = 'pagecue.' } = {}) {
  const { mc } = findModelContext();
  if (!mc || typeof mc.unregisterTool !== 'function') return false;
  for (const t of tools) { try { mc.unregisterTool(`${prefix}${t.name}`); } catch { /* best effort */ } }
  return true;
}

// Wrap every tool's execute so a host can observe calls -- name, input, result,
// duration -- without reaching inside any tool and without a tool knowing it is
// watched. The observer runs AFTER the call and cannot change the result.
//
// It also closes the last hole in "tools never throw": if an execute does throw
// (a pagecue bug, not an agent error) the throw is turned into the same
// {ok:false,error} shape every other refusal uses, so the agent still gets an
// answer it can read, and the observer still sees the call.
// withResultHint(tools, hint) -- attach a page-level nudge to every ok result.
//
// A host sometimes needs to say something to the agent that belongs to no
// single tool: "when you are done here, do this". Putting it in every tool's
// DESCRIPTION changes what the agent reads before it decides to call anything,
// which is a different intervention entirely. The only other channel a tool has
// is what it RETURNS, so this rides there: each successful result grows one
// extra field, `when_done`, carrying the host's sentence verbatim.
//
// Refusals are deliberately left alone. An agent that just got an error is
// being told what went wrong, and a second, unrelated instruction stapled to
// that is noise at exactly the moment the agent can least afford it.
//
// Wrap BEFORE instrumentTools, so a host's observer logs the result the agent
// actually received rather than the one the tool wrote.
export function withResultHint(tools, hint) {
  const text = typeof hint === 'string' ? hint.trim() : '';
  if (!text) return tools;
  for (const t of tools) {
    const inner = t.execute;
    t.execute = async (input) => {
      const result = await inner(input);
      if (!result || typeof result !== 'object' || Array.isArray(result) || result.ok === false) return result;
      return { ...result, when_done: text };
    };
  }
  return tools;
}

// ------------------------------------------------- tools that say "not yet"
//
// A tool that vanishes when its moment has passed tells an agent something no
// rendered page does: what is missing is read on every observation, whereas a
// person only notices a button that disappeared if they happened to be looking
// at it. Registration is therefore the page's state channel, and the only part
// of the WebMCP surface that cannot lie -- the spec tells clients to distrust
// tool annotations, but an unregistered tool simply cannot be called, so the
// declaration and the capability are the same object.
//
// Absence has one defect: it is ambiguous. An agent that cannot find
// `unlock_download` cannot tell whether the step is closed, the page has not
// finished loading, or a policy removed it. So the useful shape is not absence
// but a REFUSAL WITH A REASON: the tool keeps its place in the list, so the
// agent still learns the action exists here, and calling it answers why it
// cannot run now and what would change that.
//
// What keeps this from collapsing back into an advisory hint is that the tool
// must actually refuse. A page that says "unavailable" and then runs anyway has
// spent nothing, and its list is worth nothing. Here the check runs at the seam
// every call passes through, so the description cannot drift from the behaviour.
//
// `resolve(name)` returns nothing when a tool is unconditional, or
// { available: false, reason, unblocked_by } when it is not. `unblocked_by`
// names the tool or the on-page choice that would open it, so the refusal is
// something to act on rather than a wall.
export function availabilityOf(resolve, name) {
  if (typeof resolve !== 'function') return null;
  let state = null;
  try { state = resolve(name); }
  catch (e) {
    console.warn(`[pagecue] the availability check for "${name}" threw; treating it as available:`, e && e.message);
    return null;
  }
  if (!state || typeof state !== 'object' || state.available !== false) return null;
  return {
    available: false,
    reason: String(state.reason || 'This is not available right now.'),
    ...(state.unblocked_by ? { unblocked_by: String(state.unblocked_by) } : {}),
  };
}

// The sentence appended to a description while a tool is closed. It goes in the
// LIST, which is the point: an agent reading the page's tools learns the state
// without spending a call to find out.
export function availabilityNote(state) {
  if (!state) return '';
  const remedy = state.unblocked_by ? ` Available once you use "${state.unblocked_by}".` : '';
  return ` NOT AVAILABLE RIGHT NOW: ${state.reason}${remedy}`;
}

export function withAvailability(tools, resolve) {
  if (typeof resolve !== 'function') return tools;
  for (const t of tools) {
    const inner = t.execute;
    t.execute = async (input) => {
      const state = availabilityOf(resolve, t.name);
      if (!state) return inner(input);
      // A refusal, not a throw: the agent gets the same shape every other
      // declined call uses, plus the two fields that make it actionable.
      return {
        ok: false,
        error: { message: state.reason, ...(state.unblocked_by ? { hint: `Use "${state.unblocked_by}" first.` } : {}) },
        available: false,
        reason: state.reason,
        ...(state.unblocked_by ? { unblocked_by: state.unblocked_by } : {}),
      };
    };
    // The description the registry should carry right now, recomputed rather
    // than stored, so it can never be stale relative to the check above.
    t.describeNow = () => `${t.description}${availabilityNote(availabilityOf(resolve, t.name))}`;
  }
  return tools;
}

// registerLive(tools, { prefix, resolve }) -> { sync, surface, registered }
//
// Keeps the registry in step with the page. Re-registration is the only way to
// change a description an agent has already seen, and WebMCP has no
// unregisterTool in the spec -- removal rides on an AbortSignal handed in at
// registration -- so each tool keeps its own controller and gets a fresh one
// each time it is replaced. Both removal paths are attempted because the two
// shipping implementations do not agree on which exists, and which one worked
// is reported back rather than swallowed: the answer is a finding, not noise.
export function registerLive(tools, { prefix = '', resolve = null } = {}) {
  const { surface, mc } = findModelContext();
  if (!mc) return { registered: false, surface, sync: () => ({ changed: [], surface }), removal: 'none' };

  const controllers = new Map();
  const shown = new Map();
  let removal = 'unknown';

  const drop = (name) => {
    if (typeof mc.unregisterTool === 'function') {
      try { mc.unregisterTool(name); removal = 'unregisterTool'; return true; }
      catch (e) { console.warn(`[pagecue] unregisterTool("${name}") failed:`, e && e.message); }
    }
    const c = controllers.get(name);
    if (c) {
      try { c.abort(); removal = 'abort'; return true; }
      catch (e) { console.warn(`[pagecue] aborting "${name}" failed:`, e && e.message); }
    }
    removal = 'none';
    return false;
  };

  const put = (t, description) => {
    const name = `${prefix}${t.name}`;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    mc.registerTool({
      name,
      title: t.title,
      description,
      inputSchema: t.inputSchema,
      annotations: t.annotations || { readOnlyHint: t.name === 'read_page' },
      execute: async (input) => t.execute(input || {}),
    }, controller ? { signal: controller.signal } : undefined);
    if (controller) controllers.set(name, controller);
    shown.set(name, description);
  };

  function sync() {
    const changed = [];
    for (const t of tools) {
      const name = `${prefix}${t.name}`;
      const description = typeof t.describeNow === 'function' ? t.describeNow() : t.description;
      const before = shown.get(name);
      if (before === description) continue;
      if (before !== undefined) drop(name);
      try {
        put(t, description);
        // `closed` is read from the resolver, not sniffed back out of the
        // description, so a caller logging state never depends on our wording.
        changed.push({ name, closed: availabilityOf(resolve, t.name) !== null, description });
      } catch (e) {
        console.error(`[pagecue] could not register "${name}" with its current state:`, e);
      }
    }
    return { changed, surface, removal };
  }

  const first = sync();
  return { registered: true, surface, sync, removal: first.removal, names: [...shown.keys()] };
}

export function instrumentTools(tools, onCall) {
  if (typeof onCall !== 'function') return tools;
  for (const t of tools) {
    const inner = t.execute;
    t.execute = async (input) => {
      const started = Date.now();
      let result;
      try {
        result = await inner(input);
      } catch (e) {
        const message = e && e.message ? e.message : String(e);
        console.error(`[pagecue] tool "${t.name}" threw:`, e);
        result = { ok: false, error: { message: `Tool "${t.name}" failed internally: ${message}` } };
      }
      try {
        onCall({ name: t.name, input: input || {}, result, durationMs: Date.now() - started });
      } catch (e) {
        console.warn('[pagecue] tool-call observer threw (call itself was fine):', e);
      }
      return result;
    };
  }
  return tools;
}
