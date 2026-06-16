/**
 * Schema-driven form renderer.
 */

import { listEntities } from './store.js';
import { normalizeIconClass } from '../../js/icon_utils.js';
import { attachIconPicker } from '../../js/icon_picker.js';
import { upgradeNativeSelects, initGenericCustomSelects } from '../../js/features_custom_selects.js';
import type {
    HyveviewCardSchema,
    HyveviewEntityState,
    HyveviewMultiEntityInput,
    HyveviewMultiEntityRow,
    HyveviewSchemaField,
    HyveviewSchemaFormApi,
} from '../types/card.js';

interface FieldInputEntry {
    input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HyveviewMultiEntityInput;
    field: HyveviewSchemaField;
}

export function renderSchemaForm(
    container: HTMLElement,
    schema: HyveviewCardSchema | null | undefined,
    initialValues: Record<string, unknown> = {},
): HyveviewSchemaFormApi {
    container.innerHTML = '';
    const inputs = new Map<string, FieldInputEntry>();
    const fields = (schema && schema.fields) || [];

    for (const f of fields) {
        const wrap = document.createElement('div');
        wrap.className = 'hv-field';
        const label = document.createElement('label');
        label.textContent = f.label || f.key;
        wrap.appendChild(label);

        let input: FieldInputEntry['input'];
        const value = initialValues[f.key] !== undefined ? initialValues[f.key] : f.default;

        if (f.type === 'select') {
            input = document.createElement('select');
            for (const opt of (f.options || [])) {
                const o = document.createElement('option');
                o.value = opt.value;
                o.textContent = opt.label || opt.value;
                input.appendChild(o);
            }
            if (value !== undefined) input.value = String(value);
        } else if (f.type === 'entity') {
            input = document.createElement('select');
            const all = listEntities();
            const domains = f.domains;
            const matches = domains && domains.length
                ? all.filter((e) => domains.some((d) => (e.entity_id || '').startsWith(`${d}.`)))
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
            if (value && !matches.some((e) => e.entity_id === value)) {
                const o = document.createElement('option');
                o.value = String(value);
                o.textContent = `${value} (offline)`;
                input.appendChild(o);
            }
            if (value !== undefined) input.value = String(value);
        } else if (f.type === 'number') {
            const numInput = document.createElement('input');
            numInput.type = 'number';
            if (f.min !== undefined) numInput.min = String(f.min);
            if (f.max !== undefined) numInput.max = String(f.max);
            if (f.step !== undefined) numInput.step = String(f.step);
            if (value !== undefined && value !== null) numInput.value = String(value);
            input = numInput;
        } else if (f.type === 'boolean') {
            if (f.inline) wrap.classList.add('hv-field--inline');
            const boolInput = document.createElement('input');
            boolInput.type = 'checkbox';
            boolInput.checked = !!value;
            input = boolInput;
        } else if (f.type === 'textarea') {
            const textInput = document.createElement('textarea');
            textInput.rows = 4;
            if (value !== undefined && value !== null) textInput.value = String(value);
            input = textInput;
        } else if (f.type === 'icon') {
            const row = document.createElement('div');
            row.className = 'hv-field-icon-row';
            const iconInput = document.createElement('input');
            iconInput.type = 'text';
            iconInput.placeholder = f.placeholder || 'fa-bolt sau mdi:home';
            iconInput.setAttribute('data-icon-picker', 'true');
            if (value !== undefined && value !== null) iconInput.value = String(value);
            input = iconInput;
            const preview = document.createElement('span');
            preview.className = 'hv-field-icon-preview';
            const _refreshPreview = () => {
                const spec = String(iconInput.value || '').trim();
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
            iconInput.addEventListener('input', _refreshPreview);
            row.appendChild(iconInput);
            row.appendChild(preview);
            attachIconPicker(iconInput);
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
            const colorInput = document.createElement('input');
            colorInput.type = 'color';
            if (value !== undefined && value !== null && value !== '') colorInput.value = String(value);
            input = colorInput;
        } else if (f.type === 'multi_entity') {
            const multi = document.createElement('div') as HyveviewMultiEntityInput;
            multi.className = 'hv-multi-entity';
            input = multi;
            const initial = Array.isArray(value) ? value as HyveviewMultiEntityRow[] : [];
            const allEntities = listEntities();
            const domains = f.domains;
            const matches = domains && domains.length
                ? allEntities.filter((e) => domains.some((d) => (e.entity_id || '').startsWith(`${d}.`)))
                : allEntities;
            matches.sort((a, b) => (a.entity_id || '').localeCompare(b.entity_id || ''));
            const _rows: HyveviewMultiEntityRow[] = [];
            const _renderRows = () => {
                multi.innerHTML = '';
                const head = document.createElement('div');
                head.className = 'hv-multi-entity__head';
                head.innerHTML = '<span>Entitate</span><span>Titlu</span><span>Subtitlu</span><span></span>';
                multi.appendChild(head);
                const list = document.createElement('div');
                list.className = 'hv-multi-entity__list';
                multi.appendChild(list);
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
                    if (row.entity_id && !matches.some((e) => e.entity_id === row.entity_id)) {
                        const o = document.createElement('option'); o.value = row.entity_id; o.textContent = `${row.entity_id} (offline)`; sel.appendChild(o);
                    }
                    sel.value = row.entity_id || '';
                    sel.addEventListener('change', () => {
                        _rows[idx].entity_id = sel.value;
                        const ent = matches.find((e) => e.entity_id === sel.value);
                        _rows[idx].unique_id = (ent as HyveviewEntityState & { unique_id?: string })?.unique_id || '';
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
                multi.appendChild(add);
            };
            initial.forEach((e) => _rows.push({
                entity_id: e.entity_id || '',
                unique_id: e.unique_id || '',
                title: e.title || '',
                subtitle: e.subtitle || '',
            }));
            if (_rows.length === 0) _rows.push({ entity_id: '', unique_id: '', title: '', subtitle: '' });
            _renderRows();
            multi.__hvReadMulti = () => _rows.filter((r) => r.entity_id).map((r) => ({ ...r }));
        } else {
            const textInput = document.createElement('input');
            textInput.type = 'text';
            if (f.placeholder) textInput.placeholder = f.placeholder;
            if (value !== undefined && value !== null) textInput.value = String(value);
            input = textInput;
        }

        wrap.appendChild(input);
        if (f.hint) {
            const h = document.createElement('div');
            h.className = 'hv-field-hint';
            h.textContent = f.hint;
            wrap.appendChild(h);
        }
        container.appendChild(wrap);
        inputs.set(f.key, { input, field: f });
    }

    try {
        upgradeNativeSelects(container);
        initGenericCustomSelects(container);
    } catch (_) {}

    function read(): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for (const [key, { input, field }] of inputs) {
            if (field.type === 'number') {
                const v = (input as HTMLInputElement).value;
                out[key] = v === '' ? null : Number(v);
            } else if (field.type === 'boolean') {
                out[key] = (input as HTMLInputElement).checked;
            } else if (field.type === 'multi_entity') {
                const multi = input as HyveviewMultiEntityInput;
                out[key] = multi.__hvReadMulti ? multi.__hvReadMulti() : [];
            } else {
                out[key] = (input as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
            }
        }
        return out;
    }

    function validate(): { ok: boolean; errors: string[] } {
        const errors: string[] = [];
        for (const [key, { input, field }] of inputs) {
            if (field.required) {
                let v: string | boolean | null | undefined;
                if (field.type === 'boolean') v = (input as HTMLInputElement).checked;
                else if (field.type === 'multi_entity') {
                    const multi = input as HyveviewMultiEntityInput;
                    v = (multi.__hvReadMulti ? multi.__hvReadMulti() : []).length ? '1' : '';
                } else v = (input as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
                if (v === '' || v === null || v === undefined) errors.push(`${field.label || key} is required`);
            }
        }
        return { ok: errors.length === 0, errors };
    }

    return { read, validate };
}
