// Small DOM + feedback helpers shared by every view. Page data is untrusted, so text is always
// set via textContent / DOM nodes, never innerHTML.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && !k.includes('-') && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
// replaceChildren() that skips null/false (the native one renders them as text).
export const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
export const plural = (n, word, many = word + 's') => `${n.toLocaleString()} ${n === 1 ? word : many}`;

// ---------- toast ----------
let toastTimer;
export function toast(msg, kind = '', sticky = false) {
  const el = $('#toast');
  clearTimeout(toastTimer);
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  if (!sticky) toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 8000 : 4000);
}

// ---------- long-running jobs with progress + stop ----------
let current = null;
export const busy = () => !!current;

export async function runJob(label, fn) {
  if (current) { toast('Another job is running — stop it first.', 'error'); return undefined; }
  const ctrl = new AbortController();
  current = ctrl;
  const bar = $('#job');
  const text = $('#job-text');
  const fill = $('#job-fill');
  text.textContent = label;
  fill.style.width = '0%';
  fill.classList.add('indeterminate');
  bar.hidden = false;
  document.body.classList.add('is-busy');
  const progress = (msg, done, total) => {
    text.textContent = msg;
    if (total) {
      fill.classList.remove('indeterminate');
      fill.style.width = `${Math.round((done / total) * 100)}%`;
    }
  };
  try {
    return await fn(ctrl.signal, progress);
  } catch (e) {
    if (ctrl.signal.aborted || e?.name === 'AbortError') toast('Stopped.');
    else { console.error(e); toast(e?.message || String(e), 'error'); }
    return undefined;
  } finally {
    current = null;
    bar.hidden = true;
    document.body.classList.remove('is-busy');
  }
}

export function stopJob() {
  current?.abort(new DOMException('Stopped', 'AbortError'));
}

// ---------- modal form ----------
// fields: [{ name, label, type: 'text'|'textarea'|'select'|'number'|'checkbox'|'multiselect', value, options:[{value,label}], placeholder }]
export function formDialog({ title, text, fields = [], submit = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'dialog' });
    const inputs = {};
    const form = h('form', { method: 'dialog' },
      h('h3', {}, title),
      text ? h('p', { class: 'hint' }, text) : null,
      fields.map((f) => {
        let input;
        if (f.type === 'textarea') input = h('textarea', { rows: f.rows || 4, placeholder: f.placeholder || '', value: f.value ?? '' });
        else if (f.type === 'select') input = h('select', {}, f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value }, o.label)));
        else if (f.type === 'multiselect') {
          input = h('div', { class: 'checks' }, f.options.map((o) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: o.value, checked: (f.value || []).includes(o.value) }), o.label)));
        } else if (f.type === 'checkbox') input = h('input', { type: 'checkbox', checked: !!f.value });
        else input = h('input', { type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || '' });
        inputs[f.name] = { f, input };
        return f.type === 'checkbox'
          ? h('label', { class: 'check' }, input, f.label)
          : h('label', { class: 'field' }, f.label, input);
      }),
      h('div', { class: 'row end' },
        h('button', { type: 'button', class: 'btn secondary', onclick: () => { dlg.close(); resolve(null); } }, 'Cancel'),
        h('button', { type: 'submit', class: `btn ${danger ? 'danger' : 'primary'}` }, submit)));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const out = {};
      for (const [name, { f, input }] of Object.entries(inputs)) {
        if (f.type === 'checkbox') out[name] = input.checked;
        else if (f.type === 'multiselect') out[name] = [...input.querySelectorAll('input:checked')].map((i) => i.value);
        else if (f.type === 'number') out[name] = Number(input.value);
        else out[name] = input.value;
      }
      dlg.close();
      resolve(out);
    });
    dlg.addEventListener('close', () => { dlg.remove(); resolve(null); });
    dlg.append(form);
    document.body.append(dlg);
    dlg.showModal();
    form.querySelector('input:not([type=checkbox]),textarea,select')?.focus();
  });
}

export const confirmDialog = (title, text, submit = 'Delete') => formDialog({ title, text, submit, danger: true }).then((r) => r !== null);

// ---------- popover menu ----------
export function menu(anchor, items) {
  document.querySelector('.menu')?.remove();
  const r = anchor.getBoundingClientRect();
  const m = h('div', { class: 'menu', role: 'menu' },
    items.filter(Boolean).map((it) => (it === '-' ? h('hr') : h('button', {
      type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '', disabled: it.disabled,
      onclick: () => { m.remove(); it.run(); },
    }, it.label))));
  m.style.top = `${r.bottom + window.scrollY + 4}px`;
  m.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 220))}px`;
  document.body.append(m);
  setTimeout(() => document.addEventListener('click', function close(e) {
    if (!m.contains(e.target)) { m.remove(); document.removeEventListener('click', close); }
  }), 0);
}

// Tiny markdown → DOM (bold, code, bullets, headings) for Claude answers.
export function markdown(md) {
  const wrap = h('div', { class: 'md' });
  const inline = (s) => {
    const out = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0;
    for (const m of s.matchAll(re)) {
      out.push(s.slice(last, m.index));
      out.push(m[0].startsWith('**') ? h('strong', {}, m[0].slice(2, -2)) : h('code', {}, m[0].slice(1, -1)));
      last = m.index + m[0].length;
    }
    out.push(s.slice(last));
    return out;
  };
  let list = null;
  for (const line of md.split('\n')) {
    const bullet = line.match(/^\s*[-*]\s+(.*)/);
    if (bullet) {
      if (!list) { list = h('ul'); wrap.append(list); }
      list.append(h('li', {}, inline(bullet[1])));
      continue;
    }
    list = null;
    const head = line.match(/^#{1,4}\s+(.*)/);
    if (head) wrap.append(h('h4', {}, inline(head[1])));
    else if (line.trim()) wrap.append(h('p', {}, inline(line)));
  }
  return wrap;
}
