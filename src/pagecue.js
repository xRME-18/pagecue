// pagecue/src/pagecue.js -- public entry.
//
// A website installs pagecue as one script. It gets an ink layer over its own
// page plus a standard guide-tool surface on document.modelContext that the
// visitor's own agent can call. The agent can draw; it cannot write the page.
//
// CANONICAL INSTALL -- an external module file, because Vite (and any dev
// server that rewrites bare imports) returns 500 for a /public import made
// from an INLINE module script:
//
//   <script type="module" src="/pagecue/src/init.js"></script>
//
// The inline shorthand still works on a plain static server:
//
//   <script type="module">
//     import { init } from '/pagecue/src/pagecue.js';
//     init();
//   </script>
//
// ---------------------------------------------------------------------------
// init(options?) -> { registry, adapter, tools, dispose() }
//
//   options.adapter    custom adapter object (tier 2/3); omit -> tier 1 DOM scan
//   options.protected  extra selectors or field ids to mark protected (tier 1)
//   options.ignore     array of selectors pagecue must not scan or target at all
//                      (devtools panels, third-party widgets, your own chrome)
//   options.root       scan scope and overlay container; default document.body
//   options.styleNonce CSP nonce supplied by the host for injected styles
//   options.onToolCall observer called after EVERY tool call with
//                      { name, input, result, durationMs }. Cannot change the
//                      result; a throw in it is caught and warned. This is the
//                      hook a host uses to log or instrument the agent surface.
//   options.resultHint one sentence appended to every SUCCESSFUL tool result as
//                      a `when_done` field -- a page-level nudge to the agent
//                      that belongs to no single tool ("before you finish,
//                      ..."). Refusals never carry it. Off unless set.
//   options.activity   ON by default: the page keeps a labelled trail of what
//                      happened on it (see activity.js), exposes it to the
//                      agent as read_activity and to the visitor as a small
//                      strip in the bottom-left corner. `false` turns off the
//                      recorder, the tool and the strip together.
//   options.note       one sentence recorded on that trail as who:'site' the
//                      moment pagecue starts, e.g. a fact the page wants on the
//                      record. Same thing as calling pagecue.note() yourself.
//
// The returned object carries `note(text, { target })` -- the page's own way to
// put a line on the trail -- and `activity`, the trail itself.
//
// The returned object carries `surface`: 'document' | 'navigator' | 'none' --
// which modelContext object the tools actually landed on, or none at all.
//
// ---------------------------------------------------------------------------
// THE ADAPTER INTERFACE
//
// An adapter is the only thing that knows what a "target" is on this site.
// Everything else in pagecue -- the registry, the overlay, the tools -- is
// written against this and nothing else.
//
//   REQUIRED
//     fields()            -> target records, of two kinds:
//       { id, kind: 'field', label, type, required, readMask, writeRefuse,
//         section, sectionLabel, hint?, options?: [{value,label}], group? }
//       { id, kind: 'landmark', role, label, text?, section?, sectionLabel?, href? }
//                            landmark role is one of
//                            heading|button|link|text|image|region|row.
//                            readMask: never show the value to the agent.
//                            writeRefuse: refuse suggest_value on it.
//                            They are INDEPENDENT; the legacy boolean
//                            `protected` sets both and is still honoured.
//     read(id)            -> { value, filled, errors: [{code, message}] }
//                            FIELDS ONLY. value MUST be masked when readMask is
//                            set; createHooksAdapter enforces this even if you
//                            forget, and tools.js masks again at the seam.
//     onChange(cb)        -> unsubscribe. cb receives
//                              { type: 'value', field, humanEdit }  value edited
//                              { type: 'layout', section }          geometry moved
//                              { type: 'dom' }                      anchors changed
//                            This one callback drives both ink lifecycle and redraw.
//
//   GEOMETRY (required for anything to actually be drawn)
//     rectOf(id)          -> { x, y, w, h } relative to the overlay container,
//                            or null when the anchor is hidden or gone.
//                            Resolves BOTH fields and landmarks.
//     sectionRect(id)     -> the same for a whole section (mark_skip hatching)
//     sections()          -> [{ id, label, protected, collapsed }]
//                            derived from fields() if omitted
//
//   OPTIONAL
//     setCollapsed(id, b) -> expand/collapse a section; reveal_section needs it
//     setIgnore(list)     -> handed options.ignore so a host that owns its own
//                            DOM can honour the selectors itself
//     commit(id, value)   -> THE ONLY WRITE PATH IN PAGECUE. Called exclusively
//                            from a suggestion chip's Accept button, i.e. by a
//                            human click. tools.js is handed a narrowed view of
//                            the adapter (see readView) that does not contain it,
//                            so no tool can reach it, now or after any refactor.
//     railX()             -> x of the margin rail notes hang off
//     onParked(counts)    -> Map<sectionId, n> of ink parked on collapsed
//                            sections, so the host can badge its headers
//     title(), today()    -> strings echoed back in read_page
//     dispose()           -> torn down by pagecue.dispose()
// ---------------------------------------------------------------------------

import { createRegistry } from './registry.js';
import { createOverlay, createActivityStrip } from './overlay.js';
import { createActivity } from './activity.js';
import { createTools, registerNative, unregisterNative, instrumentTools, withResultHint } from './tools.js';
import { createDomAdapter } from './adapter-dom.js';
import { createHooksAdapter } from './adapter-hooks.js';

export { createRegistry } from './registry.js';
export { createOverlay, createActivityStrip } from './overlay.js';
export {
  createActivity, createActivityLog, collectChoices, toolTargets, describeEntry, describeRow, whoLabel,
  MAX_ENTRIES, COALESCE_MS, CHOICE_TYPES, WHO, WHO_LABEL, ATTESTATION, ATTESTATION_NOTE,
} from './activity.js';
export { createTools, readView, snapshot, registerNative, unregisterNative, findModelContext, instrumentTools, withResultHint, isLandmark, readMasked, writeRefused } from './tools.js';
export { createDomAdapter } from './adapter-dom.js';
export { createHooksAdapter, PROTECTED_MASK, LANDMARK_ROLES } from './adapter-hooks.js';
export * as ink from './ink-engine.js';

// The human bridge. Exported so it can be unit-tested, and written so that it
// needs BOTH the registry and the adapter passed in explicitly -- there is no
// ambient path from a tool to this function.
export function acceptSuggestion(registry, adapter, inkId) {
  const ink = registry.get(inkId);
  if (!ink || ink.kind !== 'suggest' || ink.status !== 'active') return false;
  if (typeof adapter.commit !== 'function') return false;
  // Commit BEFORE resolving: commit legitimately refuses (an option value that
  // matches nothing, a malformed date), and resolving first would erase the chip
  // while writing nothing. Safe to order this way because the adapter reports its
  // own writes as humanEdit:false, so settle() will not dismiss the chip first.
  if (adapter.commit(ink.fields[0], ink.value) === false) return false;
  registry.resolve(inkId, 'adopted');
  return true;
}

export function init(options = {}) {
  const container = options.root || document.body;
  const ignore = options.ignore || [];
  const adapter = options.adapter
    ? createHooksAdapter(options.adapter, { ignore })
    : createDomAdapter({ root: container, container, protectedList: options.protected || [], ignore });

  const registry = createRegistry(adapter);

  // Cheap memo of the section/target topology, dropped on every adapter event.
  let collapsed = null, byId = null;
  const invalidate = () => { collapsed = null; byId = null; };
  const collapsedIds = () => (collapsed ??= new Set(adapter.sections().filter((s) => s.collapsed).map((s) => s.id)));
  const targets = () => (byId ??= new Map(adapter.fields().map((f) => [f.id, f])));
  const sectionOf = (id) => (targets().get(id) || {}).section;
  const isField = (id) => { const t = targets().get(id); return !!t && t.kind !== 'landmark'; };

  const overlay = createOverlay({
    container, registry,
    rectOf: (id) => adapter.rectOf(id),
    sectionRect: (id) => adapter.sectionRect(id),
    isParked: (id) => { const s = sectionOf(id); return s && collapsedIds().has(s) ? s : null; },
    railX: () => (typeof adapter.railX === 'function'
      ? adapter.railX()
      : container.getBoundingClientRect().width - 265),
    // Landmarks have no value state at all, so they never read as filled and
    // never carry errors -- ink on them is manual-lifecycle by construction.
    stateOf: (id) => {
      if (!isField(id)) return { filled: false, errors: [] };
      const r = adapter.read(id) || {};
      return { filled: !!r.filled, errors: r.errors || [] };
    },
    onAccept: (i) => acceptSuggestion(registry, adapter, i.id),
    onDismiss: (i) => registry.resolve(i.id, 'dismissed'),
    onParked: (counts) => { if (typeof adapter.onParked === 'function') adapter.onParked(counts); },
    styleNonce: options.styleNonce || '',
  });

  const unsubscribe = adapter.onChange((ev = {}) => {
    invalidate();
    if (ev.type === 'value' && ev.field) registry.settle(ev.field, { humanEdit: ev.humanEdit !== false });
    overlay.schedule();
  });

  // The page's own record of what happened on it. Built BEFORE the tools,
  // because read_activity reads it and read_page carries a summary of it.
  const activity = options.activity === false ? null : createActivity({ adapter, root: container });
  const strip = activity ? createActivityStrip({ container, activity, styleNonce: options.styleNonce || '' }) : null;
  if (activity && options.note) activity.note(options.note);

  // Instrument before native registration so the host's observer sees
  // every call through the WebMCP tool surface.
  // resultHint is applied INSIDE the instrumentation, so the observer records
  // the result the agent actually saw, hint included.
  //
  // The activity trail rides on the SAME observer rather than on a hook of its
  // own, so an agent's row on the trail and the host's own log are written from
  // one call site and cannot disagree about what was called.
  const observe = (call) => {
    if (activity) {
      try { activity.toolCall(call); }
      catch (e) { console.warn('[pagecue] could not record a tool call on the activity trail:', e); }
    }
    if (typeof options.onToolCall === 'function') options.onToolCall(call);
  };
  const tools = instrumentTools(
    withResultHint(createTools(adapter, registry, activity), options.resultHint),
    (activity || typeof options.onToolCall === 'function') ? observe : undefined,
  );
  const native = registerNative(tools);
  let disposed = false;

  return {
    registry, adapter, tools, activity,
    surface: native.surface,
    // The page's own voice on the trail. A no-op when activity is off, so a
    // host may call it unconditionally.
    note: (text, opts) => (activity ? activity.note(text, opts) : null),
    dispose() {
      if (disposed) return;
      disposed = true;
      overlay.dispose();
      if (strip) strip.dispose();
      if (activity) activity.dispose();
      unsubscribe();
      unregisterNative(tools);
      if (typeof adapter.dispose === 'function') adapter.dispose();
    },
  };
}
