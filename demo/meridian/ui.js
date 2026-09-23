// pagecue/demo/meridian/ui.js -- the demo app's own view layer.
//
// It renders the claim form (built once, never re-rendered, so focus survives)
// and hands pagecue a hooks adapter: where each field is on screen, what it
// currently holds, and how to hear about changes. The ink layer itself is not
// this file's business any more -- src/overlay.js draws it.

import { formHooks } from './adapter.js';

export function buildForm(store, writer) {
  const page = document.getElementById('page');
  page.innerHTML = '';

  const head = el('div', 'form-head');
  head.innerHTML = `<h1>${store.form.title}</h1><div class="head-row"><span id="progress"></span><button id="clear-ink" class="ghost-btn" title="Erase everything the agent has drawn">erase agent ink</button></div>`;
  page.appendChild(head);

  const secBody = new Map(), secHead = new Map(), inputEl = new Map(), errEl = new Map(), fieldEl = new Map();

  for (const sec of store.form.sections) {
    const s = el('section', 'sec' + (sec.protected ? ' protected' : ''));
    const h = el('div', 'sec-head');
    h.innerHTML = `<span class="chev">▾</span><span class="sec-label">${sec.label}</span>` +
      (sec.protected ? `<span class="lock" title="The agent cannot read or suggest values here">🔒 agent locked out</span>` : '');
    const b = el('div', 'sec-body');
    h.onclick = () => store.setCollapsed(sec.id, !store.isCollapsed(sec.id));
    for (const f of sec.fields) {
      const w = el('div', 'field' + (f.type === 'checkbox' ? ' check' : ''));
      w.dataset.field = f.id;
      const lab = el('label'); lab.textContent = f.label; lab.htmlFor = 'in_' + f.id;
      let inp;
      if (f.type === 'textarea') { inp = document.createElement('textarea'); inp.rows = 3; }
      else if (f.type === 'select') {
        inp = document.createElement('select');
        for (const o of f.options) { const op = document.createElement('option'); op.value = o; op.textContent = o ? o.replace(/_/g, ' ') : '— select —'; inp.appendChild(op); }
      } else { inp = document.createElement('input'); inp.type = f.type === 'checkbox' ? 'checkbox' : f.type; }
      inp.id = 'in_' + f.id;
      inp.addEventListener('input', () => writer.setValue(f.id, f.type === 'checkbox' ? inp.checked : inp.value));
      const e = el('div', 'ferr');
      if (f.type === 'checkbox') { w.append(inp, lab, e); } else { w.append(lab, inp, e); }
      if (f.hint) { const hint = el('div', 'fhint'); hint.textContent = f.hint; w.insertBefore(hint, e); }
      b.appendChild(w);
      inputEl.set(f.id, inp); errEl.set(f.id, e); fieldEl.set(f.id, w);
    }
    s.append(h, b); page.appendChild(s);
    secBody.set(sec.id, b); secHead.set(sec.id, h);
  }

  // ---------- geometry, in the coordinate space of #page ----------
  const pageRect = () => page.getBoundingClientRect();
  const rel = (r) => { const p = pageRect(); return { x: r.left - p.left, y: r.top - p.top, w: r.width, h: r.height }; };

  // ---------- host-side refresh (errors, progress, collapse chrome) ----------
  function refreshErrors() {
    const errs = store.errors();
    const by = new Map();
    for (const e of errs) { if (!by.has(e.field)) by.set(e.field, e.message); }
    for (const [id, w] of fieldEl) {
      const msg = by.get(id);
      const showable = msg && (store.get(id) !== undefined || !msg.includes('required'));
      w.classList.toggle('invalid', !!showable);
      errEl.get(id).textContent = showable ? msg : '';
    }
  }
  function refreshProgress() {
    let total = 0, filled = 0;
    for (const [, f] of store.fields) { if (f.required) { total++; if (store.isFilled(f.id)) filled++; } }
    const n = store.errors().length;
    document.getElementById('progress').textContent =
      `${filled}/${total} required · ${n} issue${n === 1 ? '' : 's'}`;
  }
  function refreshChrome() {
    for (const sec of store.form.sections) {
      const c = store.isCollapsed(sec.id);
      secBody.get(sec.id).classList.toggle('collapsed', c);
      secHead.get(sec.id).querySelector('.chev').textContent = c ? '▸' : '▾';
    }
  }
  function syncInput(field) {
    const inp = inputEl.get(field);
    const f = store.fields.get(field);
    if (!inp || !f) return;
    const v = store.get(field);
    if (f.type === 'checkbox') { if (inp.checked !== (v === true)) inp.checked = v === true; }
    else if (inp.value !== String(v ?? '')) inp.value = String(v ?? '');
  }

  // Subscribed BEFORE pagecue is initialised, so the DOM is already up to date by
  // the time the overlay measures rects.
  store.subscribe((ev) => {
    if (ev.type === 'value') syncInput(ev.field);
    refreshErrors(); refreshProgress(); refreshChrome();
  });
  refreshErrors(); refreshProgress(); refreshChrome();

  // ---------- the pagecue adapter ----------
  // Field/value/validation hooks come from adapter.js (DOM-free, unit-tested);
  // this file only adds the geometry.
  const hooks = {
    ...formHooks(store, writer),

    rectOf(id) {
      const f = store.fields.get(id);
      if (!f || store.isCollapsed(f.sectionId)) return null;
      const inp = inputEl.get(id);
      return inp ? rel(inp.getBoundingClientRect()) : null;
    },
    sectionRect: (id) => (store.isCollapsed(id) || !secBody.has(id) ? null : rel(secBody.get(id).getBoundingClientRect())),
    railX: () => pageRect().width - 265,

    onParked(counts) {
      for (const sec of store.form.sections) {
        const h = secHead.get(sec.id);
        let badge = h.querySelector('.pagecue-parked');
        const n = counts.get(sec.id) || 0;
        if (!n) { if (badge) badge.remove(); continue; }
        if (!badge) { badge = el('span', 'pagecue-parked'); h.appendChild(badge); }
        badge.textContent = `✎ ${n} note${n > 1 ? 's' : ''} inside`;
      }
    },
  };

  return { page, hooks, inputEl };
}

function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
