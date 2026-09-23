// pagecue/demo/meridian/adapter.js -- the DOM-free half of the demo's pagecue
// adapter: what the fields are, what they hold, what is wrong with them.
// ui.js layers the geometry hooks (rectOf, sectionRect, railX, onParked) on
// top of this; the tests use it on its own, in Node, with no browser.

export function formHooks(store, writer) {
  return {
    fields: () => store.form.sections.flatMap((sec) => sec.fields.map((f) => ({
      id: f.id, label: f.label, type: f.type,
      required: !!f.required, protected: !!f.protected,
      section: sec.id, sectionLabel: sec.label,
      ...(f.hint ? { hint: f.hint } : {}), ...(f.options ? { options: f.options } : {}),
    }))),

    read: (id) => ({
      value: store.get(id) ?? '',
      filled: store.isFilled(id),
      errors: store.errorsFor(id).map((e) => ({ code: e.code, message: e.message })),
    }),

    sections: () => store.form.sections.map((s) => ({
      id: s.id, label: s.label, protected: !!s.protected, collapsed: store.isCollapsed(s.id),
    })),

    setCollapsed: (id, val) => store.setCollapsed(id, val),

    // The human bridge. pagecue exposes this to the Accept button on a suggestion
    // chip and to nothing else.
    commit: (id, value) => writer.commit(id, value),

    title: () => store.form.title,
    today: () => store.today(),
    onChange: (cb) => store.subscribe(cb),
  };
}
