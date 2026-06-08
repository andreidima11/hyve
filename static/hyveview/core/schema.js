/**
 * Schema-driven form renderer.
 *
 * A card declares:
 *   static schema = {
 *     fields: [
 *       { key: 'title',  label: 'Title',  type: 'string', default: '' },
 *       { key: 'entity', label: 'Entity', type: 'entity', domains: ['camera'] },
 *       { key: 'mode',   label: 'Mode',   type: 'select', options: [
 *           { value: 'snapshot', label: 'Snapshot poll' },
 *           { value: 'mse',      label: 'Live (MSE)' },
 *       ], default: 'snapshot' },
 *       { key: 'interval', label: 'Refresh (s)', type: 'number', min: 1, default: 10 },
 *     ],
 *   };
 *
 * The renderer builds a form into the given container and returns:
 *   { read(): config, validate(): { ok, errors } }
 */

import { listEntities } from './store.js';
import { normalizeIconClass } from '../../js/icon_utils.js';
import { attachIconPicker } from '../../js/icon_picker.js';

export function renderSchemaForm(container, schema, initialValues = {}) {
  container.innerHTML = '';
  const inputs = new Map();
  const fields = (schema && schema.fields) || [];

  for (const f of fields) {
    const wrap = document.createElement('div');
    wrap.className = 'hv-field';
    const label = document.createElement('label');
    label.textContent = f.label || f.key;
    wrap.appendChild(label);

    let input;
    const value = initialValues[f.key] !== undefined ? initialValues[f.key] : f.default;

    if (f.type === 'select') {
      input = document.createElement('select');
      for (const opt of (f.options || [])) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label || opt.value;
        input.appendChild(o);
      }
      if (value !== undefined) input.value = value;
    } else if (f.type === 'entity') {
      input = document.createElement('select');
      const all = listEntities();
      const domains = f.domains;
      const matches = domains && domains.length
        ? all.filter(e => domains.some(d => (e.entity_id || '').startsWith(`${d}.`)))
        : all;
      matches.sort((a, b) => (a.entity_id || '').localeCompare(b.entity_id || ''));
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = '— select —';
      input.appendChild(blank);
      for (const e of matches) {
        const o = document.createElement('option');
        o.value = e.entity_id;
        o.textContent = `${e.entity_id}${e.friendly_name ? ` (${e.friendly_name})` : ''}`;
        input.appendChild(o);
      }
      // ensure current value is present even if not in the list (offline entity)
      if (value && !matches.some(e => e.entity_id === value)) {
        const o = document.createElement('option');
        o.value = value; o.textContent = `${value} (offline)`;
        input.appendChild(o);
      }
      if (value !== undefined) input.value = value;
    } else if (f.type === 'number') {
      input = document.createElement('input');
      input.type = 'number';
      if (f.min !== undefined) input.min = f.min;
      if (f.max !== undefined) input.max = f.max;
      if (f.step !== undefined) input.step = f.step;
      if (value !== undefined && value !== null) input.value = value;
    } else if (f.type === 'boolean') {
      if (f.inline) wrap.classList.add('hv-field--inline');
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!value;
    } else if (f.type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = 4;
      if (value !== undefined && value !== null) input.value = value;
    } else if (f.type === 'icon') {
      const row = document.createElement('div');
      row.className = 'hv-field-icon-row';
      input = document.createElement('input');
      input.type = 'text';
      input.placeholder = f.placeholder || 'fa-bolt sau mdi:home';
      input.setAttribute('data-icon-picker', 'true');
      if (value !== undefined && value !== null) input.value = value;
      const preview = document.createElement('span');
      preview.className = 'hv-field-icon-preview';
      const _refreshPreview = () => {
        const spec = String(input.value || '').trim();
        preview.innerHTML = '';
        preview.className = 'hv-field-icon-preview';
        if (!spec) return;
        const cls = normalizeIconClass(spec);
        if (cls.startsWith('mdi')) {
          const i = document.createElement('i');
          i.className = cls;
          preview.appendChild(i);
        } else if (cls.includes('fa-') || cls.includes(' fa-')) {
          const i = document.createElement('i');
          i.className = cls;
          preview.appendChild(i);
        } else {
          preview.textContent = spec;
        }
      };
      _refreshPreview();
      input.addEventListener('input', _refreshPreview);
      row.appendChild(input);
      row.appendChild(preview);
      attachIconPicker(input);
      wrap.appendChild(row);
      if (f.hint) {
        const h = document.createElement('div');
        h.className = 'hv-field-hint';
        h.textContent = f.hint;
        wrap.appendChild(h);
      } else {
        const h = document.createElement('div');
        h.className = 'hv-field-hint';
        h.textContent = 'Tastează fa- sau mdi: — sugestii la focus (ex. fa-lightbulb, mdi:power).';
        wrap.appendChild(h);
      }
      container.appendChild(wrap);
      inputs.set(f.key, { input, field: f });
      continue;
    } else if (f.type === 'color') {
      input = document.createElement('input');
      input.type = 'color';
      if (value !== undefined && value !== null && value !== '') input.value = value;
    } else if (f.type === 'multi_entity') {
      // Editable list of { entity_id, title, subtitle }.
      input = document.createElement('div');
      input.className = 'hv-multi-entity';
      const initial = Array.isArray(value) ? value : [];
      const allEntities = listEntities();
      const domains = f.domains;
      const matches = domains && domains.length
        ? allEntities.filter(e => domains.some(d => (e.entity_id || '').startsWith(`${d}.`)))
        : allEntities;
      matches.sort((a, b) => (a.entity_id || '').localeCompare(b.entity_id || ''));
      const _rows = [];
      const _renderRows = () => {
        input.innerHTML = '';
        const head = document.createElement('div');
        head.className = 'hv-multi-entity__head';
        head.innerHTML = '<span>Entitate</span><span>Titlu</span><span>Subtitlu</span><span></span>';
        input.appendChild(head);
        const list = document.createElement('div');
        list.className = 'hv-multi-entity__list';
        input.appendChild(list);
        _rows.forEach((row, idx) => {
          const r = document.createElement('div');
          r.className = 'hv-multi-entity-row';
          const sel = document.createElement('select');
          const blank = document.createElement('option'); blank.value = ''; blank.textContent = '— selectează —'; sel.appendChild(blank);
          for (const e of matches) {
            const o = document.createElement('option');
            o.value = e.entity_id;
            o.textContent = `${e.entity_id}${e.friendly_name ? ` (${e.friendly_name})` : ''}`;
            sel.appendChild(o);
          }
          if (row.entity_id && !matches.some(e => e.entity_id === row.entity_id)) {
            const o = document.createElement('option'); o.value = row.entity_id; o.textContent = `${row.entity_id} (offline)`; sel.appendChild(o);
          }
          sel.value = row.entity_id || '';
          sel.addEventListener('change', () => {
            _rows[idx].entity_id = sel.value;
            const ent = matches.find((e) => e.entity_id === sel.value);
            _rows[idx].unique_id = ent?.unique_id || '';
          });
          const title = document.createElement('input'); title.type = 'text'; title.placeholder = 'Titlu'; title.value = row.title || '';
          title.addEventListener('input', () => { _rows[idx].title = title.value; });
          const sub = document.createElement('input'); sub.type = 'text'; sub.placeholder = 'Subtitlu'; sub.value = row.subtitle || '';
          sub.addEventListener('input', () => { _rows[idx].subtitle = sub.value; });
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'hv-multi-entity__remove';
          del.title = 'Elimină';
          del.innerHTML = '<i class="fas fa-trash-can"></i>';
          del.addEventListener('click', () => { _rows.splice(idx, 1); _renderRows(); });
          r.append(sel, title, sub, del);
          list.appendChild(r);
        });
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'hv-multi-entity__add';
        const addLabel = f.addLabel || 'Adaugă entitate';
        add.innerHTML = `<i class="fas fa-plus"></i> ${addLabel}`;
        add.addEventListener('click', () => { _rows.push({ entity_id: '', unique_id: '', title: '', subtitle: '' }); _renderRows(); });
        input.appendChild(add);
      };
      initial.forEach(e => _rows.push({
        entity_id: e.entity_id || '',
        unique_id: e.unique_id || '',
        title: e.title || '',
        subtitle: e.subtitle || '',
      }));
      if (_rows.length === 0) _rows.push({ entity_id: '', unique_id: '', title: '', subtitle: '' });
      _renderRows();
      input.__hvReadMulti = () => _rows.filter(r => r.entity_id).map(r => ({ ...r }));
    } else {
      // string / fallback
      input = document.createElement('input');
      input.type = 'text';
      if (f.placeholder) input.placeholder = f.placeholder;
      if (value !== undefined && value !== null) input.value = value;
    }

    wrap.appendChild(input);
    if (input.__hvPreview) wrap.appendChild(input.__hvPreview);
    if (f.hint) {
      const h = document.createElement('div');
      h.className = 'hv-field-hint';
      h.textContent = f.hint;
      wrap.appendChild(h);
    }
    container.appendChild(wrap);
    inputs.set(f.key, { input, field: f });
  }

  function read() {
    const out = {};
    for (const [key, { input, field }] of inputs) {
      if (field.type === 'number') {
        const v = input.value;
        out[key] = v === '' ? null : Number(v);
      } else if (field.type === 'boolean') {
        out[key] = input.checked;
      } else if (field.type === 'multi_entity') {
        out[key] = input.__hvReadMulti ? input.__hvReadMulti() : [];
      } else {
        out[key] = input.value;
      }
    }
    return out;
  }

  function validate() {
    const errors = [];
    for (const [key, { input, field }] of inputs) {
      if (field.required) {
        let v;
        if (field.type === 'boolean') v = input.checked;
        else if (field.type === 'multi_entity') v = (input.__hvReadMulti ? input.__hvReadMulti() : []).length ? '1' : '';
        else v = input.value;
        if (v === '' || v === null || v === undefined) errors.push(`${field.label || key} is required`);
      }
    }
    return { ok: errors.length === 0, errors };
  }

  return { read, validate };
}
