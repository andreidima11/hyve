/**
 * Schema-driven Add/Edit modal for Hyveview cards.
 *
 * Single entry point: `openEditor({ mode, card })`.
 *   - mode = 'add'  → step 1 is the card-type picker; step 2 is the form
 *                     populated with the card's `getStubConfig()`.
 *   - mode = 'edit' → straight to step 2, populated with the existing
 *                     card.config. The save button writes back, and a
 *                     delete button is shown.
 *
 * Returns a promise resolving to either:
 *   - null  (cancelled)
 *   - { id?, type, entity, layout, config }  (for add or edit)
 *   - { __deleted: true }  (when the user deleted the card in edit mode)
 *
 * Visual design intentionally reuses the global `.dashboard-modal-card glass`
 * shell + Tailwind utility classes used by the other dashboard modals so the
 * Add/Edit dialog matches their look (rounded panel, glass blur, accent
 * primary button, ghost secondary). Editor-specific layout (card picker grid,
 * form field labels) lives in the injected stylesheet below.
 */
import { HyveviewRegistry } from '../core/registry.js';
import { renderSchemaForm } from '../core/schema.js';
import { t } from '../../js/lang/index.js';
let _activeResolve = null;
let _backdrop = null;
let _cssInjected = false;
const PANEL_CLASS = 'dashboard-modal-card glass rounded-3xl border border-white/10 shadow-2xl';
const PANEL_CLASS_XL = 'dashboard-modal-card dashboard-modal-card--xl glass rounded-3xl border border-white/10 shadow-2xl';
const HEADER_CLASS = 'flex items-center justify-between gap-3 px-4 sm:px-5 py-4 border-b border-white/10';
const TITLE_CLASS = 'text-base font-semibold text-white';
const CLOSE_CLASS = 'app-modal-close touch-manipulation';
const BODY_CLASS = 'p-4 sm:p-5 space-y-4 overflow-y-auto';
const FOOTER_CLASS = 'flex items-center justify-between gap-2 px-4 sm:px-5 py-4 border-t border-white/10';
const BTN_PRIMARY = 'px-4 py-2 rounded-xl text-sm font-bold bg-accent text-bg-main hover:bg-accent-hover transition-colors';
const BTN_GHOST = 'px-4 py-2 rounded-xl text-sm font-bold text-slate-400 hover:bg-white/5 transition-colors';
const BTN_DANGER = 'px-4 py-2 rounded-xl text-sm font-bold text-red-400 hover:bg-red-500/10 transition-colors';
const BTN_SOFT = 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/5 hover:bg-white/10 text-slate-200 border border-white/10 transition-colors';
function _must(root, sel) {
    return root.querySelector(sel);
}
function _entityFromConfig(config) {
    const raw = config.entity ?? config.entity_id ?? null;
    return raw == null || raw === '' ? null : String(raw);
}
function _ensureCss() {
    if (_cssInjected)
        return;
    _cssInjected = true;
    const css = `
    .hv-field-icon-row {
      display: flex; align-items: center; gap: 0.5rem;
    }
    .hv-field-icon-row input { flex: 1 1 auto; min-width: 0; }
    .hv-field-icon-preview {
      display: inline-flex; align-items: center; justify-content: center;
      width: 2.25rem; height: 2.25rem; flex-shrink: 0;
      border-radius: 0.625rem;
      background: var(--surface-card, rgba(255,255,255,0.06));
      border: 1px solid var(--border-medium, rgba(255,255,255,0.1));
      color: var(--accent, #38bdf8);
      font-size: 1rem;
    }

    .hv-card-picker { display: grid; grid-template-columns: 1fr; gap: 8px; }
    @media (min-width: 640px) { .hv-card-picker { grid-template-columns: 1fr 1fr; } }
    .hv-card-pick {
      text-align: left; padding: 12px 14px; border-radius: 12px;
      border: 1px solid var(--border-medium, rgba(255,255,255,0.08));
      background: var(--surface-card, rgba(255,255,255,0.03));
      color: var(--text-primary, #e2e8f0);
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease, transform 80ms ease;
    }
    .hv-card-pick:hover { background: var(--surface-card-hover, rgba(255,255,255,0.08)); border-color: var(--accent-border, rgba(255,255,255,0.18)); }
    .hv-card-pick .name { font-weight: 600; margin-bottom: 4px; color: var(--text-primary, #f1f5f9); }
    .hv-card-pick .desc { font-size: 0.8rem; color: var(--text-secondary, #94a3b8); }

    .hv-field { margin-bottom: 12px; display: flex; flex-direction: column; gap: 6px; }
    .hv-field > label { font-size: 0.6875rem; line-height: 1; letter-spacing: 0.15em; text-transform: uppercase; color: var(--text-tertiary, #64748b); }
    .hv-field input:not([type="checkbox"]):not([type="radio"]):not([type="color"]):not([type="range"]),
    .hv-field select,
    .hv-field textarea {
      width: 100%;
      padding: 0.625rem 0.75rem;
      border-radius: 0.75rem;
      border: 1px solid var(--border-medium, rgba(255,255,255,0.1));
      background: var(--surface-input, var(--surface-2, rgba(255,255,255,0.06)));
      color: var(--text-primary, #e2e8f0);
      font: inherit;
      outline: none;
      transition: border-color 120ms ease, box-shadow 120ms ease;
    }
    .hv-field input:focus, .hv-field select:focus, .hv-field textarea:focus {
      border-color: var(--accent, #38bdf8);
      box-shadow: 0 0 0 3px var(--accent-soft, rgba(56,189,248,0.18));
    }
    .hv-field input[type="checkbox"] { accent-color: var(--accent, #38bdf8); }
    .hv-field input[type="color"] { padding: 2px; height: 32px; width: 60px; border-radius: 8px; }
    .hv-field-hint { font-size: 0.75rem; color: var(--text-secondary, #94a3b8); }

    .hv-details {
      border: 1px solid var(--border-medium, rgba(255,255,255,0.08));
      border-radius: 0.875rem;
      background: var(--surface-2, var(--overlay-4, rgba(255,255,255,0.02)));
      overflow: hidden;
    }
    .hv-details > summary {
      cursor: pointer;
      padding: 0.625rem 0.875rem;
      list-style: none;
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--text-secondary, #94a3b8);
      display: flex; align-items: center; gap: 0.5rem;
    }
    .hv-details > summary::-webkit-details-marker { display: none; }
    .hv-details > summary::before {
      content: "›";
      display: inline-block;
      transition: transform 120ms ease;
      color: var(--text-tertiary, #64748b);
    }
    .hv-details[open] > summary::before { transform: rotate(90deg); }
    .hv-details > .hv-details-body { padding: 0.25rem 0.875rem 0.875rem; }

    .hv-field--inline {
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0.55rem 0.7rem;
      border-radius: 0.75rem;
      border: 1px solid var(--border-medium, rgba(255,255,255,0.08));
      background: var(--surface-2, var(--overlay-4, rgba(255,255,255,0.02)));
    }
    .hv-field--inline > label {
      flex: 1;
      text-transform: none;
      letter-spacing: 0;
      font-size: 0.8125rem;
      color: var(--text-primary, #e2e8f0);
      margin: 0;
    }
    .hv-field--inline > input[type="checkbox"] {
      width: 1rem;
      height: 1rem;
      flex-shrink: 0;
    }

    .hv-multi-entity {
      display: flex;
      flex-direction: column;
      gap: 0.55rem;
      padding: 0.65rem;
      border-radius: 0.875rem;
      border: 1px solid var(--border-medium, rgba(255,255,255,0.1));
      background: var(--surface-1, rgba(255,255,255,0.04));
    }
    .hv-multi-entity__head {
      display: grid;
      grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) 2rem;
      gap: 0.5rem;
      padding: 0 0.35rem;
      font-size: 0.625rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-tertiary, #64748b);
    }
    .hv-multi-entity__list {
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
    }
    .hv-multi-entity-row {
      display: grid;
      grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) 2rem;
      gap: 0.5rem;
      align-items: center;
      padding: 0.55rem;
      border-radius: 0.7rem;
      background: var(--surface-2, var(--overlay-4, rgba(255,255,255,0.03)));
      border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
    }
    .hv-multi-entity-row input,
    .hv-multi-entity-row select {
      width: 100%;
      min-width: 0;
      padding: 0.5rem 0.6rem;
      border-radius: 0.6rem;
      border: 1px solid var(--border-medium, rgba(255,255,255,0.1));
      background: var(--surface-input, var(--surface-2, rgba(255,255,255,0.06)));
      color: var(--text-primary, #e2e8f0);
      font: inherit;
      font-size: 0.8125rem;
    }
    .hv-multi-entity__remove {
      width: 2rem;
      height: 2rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 0.55rem;
      border: 1px solid var(--border-subtle, rgba(255,255,255,0.08));
      background: var(--overlay-4, rgba(255,255,255,0.04));
      color: var(--danger, #f87171);
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease;
    }
    .hv-multi-entity__remove:hover {
      background: var(--danger-bg, rgba(248, 113, 113, 0.12));
      border-color: var(--danger-soft, rgba(248, 113, 113, 0.28));
    }
    .hv-multi-entity__add {
      align-self: flex-start;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.45rem 0.75rem;
      border-radius: 0.65rem;
      border: 1px dashed var(--border-medium, rgba(255,255,255,0.14));
      background: var(--surface-2, var(--overlay-3, rgba(255,255,255,0.03)));
      color: var(--text-secondary, #94a3b8);
      font-size: 0.75rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
    }
    .hv-multi-entity__add:hover {
      background: var(--overlay-6, rgba(255,255,255,0.06));
      border-color: var(--accent-border, rgba(56,189,248,0.35));
      color: var(--text-primary, #e2e8f0);
    }
    @media (max-width: 520px) {
      .hv-multi-entity__head { display: none; }
      .hv-multi-entity-row {
        grid-template-columns: 1fr;
        gap: 0.4rem;
      }
      .hv-multi-entity__remove {
        justify-self: end;
      }
    }

    /* ===== HA-style grid size picker (clone of ha-grid-size-picker) ===== */
    .hv-size { display: flex; flex-direction: column; gap: 12px; }
    .hv-size-hint { font-size: 0.75rem; color: var(--text-secondary, #94a3b8); margin: 0; }
    .hv-size-preview {
      position: relative;
      display: grid;
      gap: 4px;
      width: 100%;
      max-width: 360px;
      padding: 4px;
      border-radius: 12px;
      background: var(--surface-input, rgba(2,6,23,0.5));
      border: 1px solid var(--border-medium, rgba(255,255,255,0.08));
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
    }
    .hv-size-cell {
      aspect-ratio: 1 / 1;
      border-radius: 5px;
      background: var(--surface-card, rgba(255,255,255,0.04));
      transition: background 90ms ease;
      pointer-events: none;
    }
    .hv-size-cell[data-on="true"] { background: var(--accent-soft, rgba(56,189,248,0.18)); }
    .hv-size-handle {
      position: absolute;
      box-sizing: border-box;
      top: 4px; left: 4px;
      border-radius: 8px;
      background: var(--accent-soft, rgba(56,189,248,0.28));
      border: 2px solid var(--accent, #38bdf8);
      box-shadow: 0 6px 18px rgba(56,189,248,0.25);
      transition: width 120ms ease, height 120ms ease;
      pointer-events: none;
      display: flex; align-items: flex-end; justify-content: flex-end;
    }
    .hv-size-handle::after {
      content: "";
      width: 12px; height: 12px;
      margin: 3px;
      border-radius: 3px;
      background: var(--accent, #38bdf8);
      box-shadow: 0 0 0 3px rgba(2,6,23,0.55);
    }
    .hv-size-preview[data-dragging="true"] .hv-size-handle { transition: none; }
    .hv-size-readout { display: flex; align-items: baseline; gap: 8px; font-size: 0.875rem; font-weight: 700; color: var(--text-primary, #f1f5f9); }
    .hv-size-readout small { font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-tertiary, #64748b); }
    .hv-size-presets { display: flex; flex-wrap: wrap; gap: 6px; }
    .hv-size-preset {
      padding: 4px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: 600;
      border: 1px solid var(--border-medium, rgba(255,255,255,0.1));
      background: var(--surface-card, rgba(255,255,255,0.03));
      color: var(--text-secondary, #94a3b8); cursor: pointer;
      transition: background 100ms ease, color 100ms ease, border-color 100ms ease;
    }
    .hv-size-preset:hover { background: var(--surface-card-hover, rgba(255,255,255,0.08)); color: var(--text-primary, #e2e8f0); }
    .hv-size-preset[data-active="true"] { background: var(--accent, #38bdf8); border-color: var(--accent, #38bdf8); color: var(--bg-main, #020617); }
  `;
    const style = document.createElement('style');
    style.dataset.hyveviewEditor = 'true';
    style.textContent = css;
    document.head.appendChild(style);
}
function _close(result) {
    if (_backdrop) {
        _backdrop.remove();
        _backdrop = null;
    }
    if (_activeResolve) {
        const r = _activeResolve;
        _activeResolve = null;
        r(result);
    }
}
export function openEditor({ mode = 'add', card = null } = {}) {
    return new Promise((resolve) => {
        _ensureCss();
        if (_activeResolve)
            _close(null);
        _activeResolve = resolve;
        _backdrop = document.createElement('div');
        _backdrop.className = 'modal-overlay app-modal fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4';
        _backdrop.addEventListener('click', (e) => { if (e.target === _backdrop)
            _close(null); });
        const panel = document.createElement('div');
        panel.className = PANEL_CLASS;
        _backdrop.appendChild(panel);
        document.body.appendChild(_backdrop);
        if (mode === 'edit' && card) {
            _renderForm(panel, { mode: 'edit', card });
        }
        else {
            _renderPicker(panel);
        }
    });
}
function _renderPicker(panel) {
    panel.className = PANEL_CLASS_XL;
    panel.innerHTML = `
    <div class="${HEADER_CLASS}">
      <h3 class="${TITLE_CLASS}">Adaugă card</h3>
      <button type="button" class="${CLOSE_CLASS}" data-role="close" aria-label="Close"><i class="fas fa-xmark"></i></button>
    </div>
    <div class="${BODY_CLASS}">
      <p class="hv-editor-hint">Alege un tip de card:</p>
      <div class="hv-card-picker" data-role="picker"></div>
    </div>
  `;
    _must(panel, '[data-role=close]').addEventListener('click', () => _close(null));
    const picker = _must(panel, '[data-role=picker]');
    for (const meta of HyveviewRegistry.list()) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hv-card-pick';
        btn.innerHTML = `
      <div class="name">${meta.icon ? meta.icon + ' ' : ''}${meta.name}</div>
      <div class="desc">${meta.description || ''}</div>`;
        btn.addEventListener('click', () => {
            const stub = HyveviewRegistry.stub(meta.type, '');
            const newCard = {
                type: meta.type,
                entity: _entityFromConfig(stub),
                layout: { col: 4, row: 2 },
                config: stub,
            };
            panel.className = PANEL_CLASS;
            _renderForm(panel, { mode: 'add', card: newCard });
        });
        picker.appendChild(btn);
    }
}
function _renderVisibilityEditor(host, initial) {
    // initial: { enabled: bool, logic: 'and'|'or', conditions: [{entity_id, op, value}] } | null
    const state = {
        enabled: !!(initial && initial.enabled),
        logic: (initial && initial.logic) || 'and',
        conditions: (initial && Array.isArray(initial.conditions)) ? initial.conditions.map(c => ({ ...c })) : [],
    };
    host.innerHTML = `
    <label class="hv-field" style="flex-direction:row;align-items:center;gap:8px;">
      <input type="checkbox" data-role="vis-enabled" ${state.enabled ? 'checked' : ''}/>
      <span style="text-transform:none;letter-spacing:0;font-size:0.8125rem;color:var(--text-primary,#e2e8f0);">Activează regulile de vizibilitate</span>
    </label>
    <div data-role="vis-body" style="${state.enabled ? '' : 'display:none;'}">
      <div class="hv-field">
        <label>Logică</label>
        <select data-role="vis-logic">
          <option value="and"${state.logic === 'and' ? ' selected' : ''}>AND (toate condițiile)</option>
          <option value="or"${state.logic === 'or' ? ' selected' : ''}>OR (orice condiție)</option>
        </select>
      </div>
      <div data-role="vis-conds"></div>
      <button type="button" class="${BTN_SOFT}" data-role="vis-add"><i class="fas fa-plus mr-1"></i>Adaugă condiție</button>
    </div>
  `;
    const body = _must(host, '[data-role=vis-body]');
    const condsHost = _must(host, '[data-role=vis-conds]');
    _must(host, '[data-role=vis-enabled]').addEventListener('change', (e) => {
        state.enabled = e.target.checked;
        body.style.display = state.enabled ? '' : 'none';
    });
    _must(host, '[data-role=vis-logic]').addEventListener('change', (e) => {
        state.logic = e.target.value;
    });
    const _renderConds = () => {
        condsHost.innerHTML = '';
        state.conditions.forEach((cond, idx) => {
            const row = document.createElement('div');
            row.className = 'hv-multi-entity-row';
            const ent = document.createElement('input');
            ent.type = 'text';
            ent.placeholder = t('hyveview.visibility_entity_id');
            ent.value = cond.entity_id || '';
            ent.addEventListener('input', () => { state.conditions[idx].entity_id = ent.value.trim(); });
            const op = document.createElement('select');
            for (const o of [['eq', '='], ['ne', '≠'], ['gt', '>'], ['lt', '<'], ['in', '∈']]) {
                const opt = document.createElement('option');
                opt.value = o[0];
                opt.textContent = o[1];
                if ((cond.op || 'eq') === o[0])
                    opt.selected = true;
                op.appendChild(opt);
            }
            op.addEventListener('change', () => { state.conditions[idx].op = op.value; });
            const val = document.createElement('input');
            val.type = 'text';
            val.placeholder = t('hyveview.visibility_value');
            val.value = cond.value != null ? String(cond.value) : '';
            val.addEventListener('input', () => { state.conditions[idx].value = val.value; });
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'app-modal-close touch-manipulation';
            del.style.cssText = 'width:2rem;height:2rem;border-radius:0.5rem;';
            del.innerHTML = '<i class="fas fa-xmark"></i>';
            del.addEventListener('click', () => { state.conditions.splice(idx, 1); _renderConds(); });
            row.append(ent, op, val, del);
            condsHost.appendChild(row);
        });
    };
    _must(host, '[data-role=vis-add]').addEventListener('click', () => {
        state.conditions.push({ entity_id: '', op: 'eq', value: '' });
        _renderConds();
    });
    _renderConds();
    return {
        read() {
            if (!state.enabled)
                return null;
            const conds = state.conditions
                .filter(c => c.entity_id)
                .map(c => ({ entity_id: c.entity_id, op: c.op || 'eq', value: String(c.value ?? '') }));
            return { enabled: true, logic: state.logic, conditions: conds };
        },
    };
}
// ── HA-style grid size picker ───────────────────────────────────────
// Clones Home Assistant's `ha-grid-size-picker`: a clickable/draggable grid
// preview where you size the card by dragging its bottom-right corner. The
// chosen size is mirrored into hidden `layout-col` / `layout-row` inputs that
// the save handler already reads, so no other code needs to change.
const HV_SIZE_COLS = 4; // section grid width (4-col section layout, max col_span)
const HV_SIZE_ROWS = 6; // visible rows in the picker
function _wireSizePicker(panel) {
    const preview = panel.querySelector('[data-role=size-preview]');
    const handle = panel.querySelector('[data-role=size-handle]');
    const readout = panel.querySelector('[data-role=size-readout]');
    const colInput = panel.querySelector('[data-role=layout-col]');
    const rowInput = panel.querySelector('[data-role=layout-row]');
    const presets = panel.querySelectorAll('[data-role=size-presets] .hv-size-preset');
    if (!preview || !handle || !colInput || !rowInput)
        return;
    preview.style.gridTemplateColumns = `repeat(${HV_SIZE_COLS}, 1fr)`;
    preview.style.gridTemplateRows = `repeat(${HV_SIZE_ROWS}, 1fr)`;
    const cells = [];
    for (let r = 1; r <= HV_SIZE_ROWS; r++) {
        for (let c = 1; c <= HV_SIZE_COLS; c++) {
            const cell = document.createElement('div');
            cell.className = 'hv-size-cell';
            cell.dataset.c = String(c);
            cell.dataset.r = String(r);
            preview.appendChild(cell);
            cells.push(cell);
        }
    }
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    let col = clamp(parseInt(colInput.value, 10) || 1, 1, HV_SIZE_COLS);
    let row = clamp(parseInt(rowInput.value, 10) || 2, 1, HV_SIZE_ROWS);
    const paint = () => {
        // Resize the highlighted handle to span col×row of the grid (minus padding).
        const rect = preview.getBoundingClientRect();
        const pad = 4;
        const gap = 4;
        const innerW = rect.width - pad * 2;
        const innerH = rect.height - pad * 2;
        const cellW = (innerW - gap * (HV_SIZE_COLS - 1)) / HV_SIZE_COLS;
        const cellH = (innerH - gap * (HV_SIZE_ROWS - 1)) / HV_SIZE_ROWS;
        handle.style.width = `${cellW * col + gap * (col - 1)}px`;
        handle.style.height = `${cellH * row + gap * (row - 1)}px`;
        cells.forEach((cell) => {
            const on = (+(cell.dataset.c || 0) <= col) && (+(cell.dataset.r || 0) <= row);
            cell.dataset.on = on ? 'true' : 'false';
        });
        if (readout)
            readout.textContent = `${col} × ${row}`;
        colInput.value = String(col);
        rowInput.value = String(row);
        presets.forEach((node) => {
            const b = node;
            b.dataset.active = (+(b.dataset.cols || 0) === col && +(b.dataset.rows || 0) === row) ? 'true' : 'false';
        });
    };
    const sizeFromPoint = (clientX, clientY) => {
        const rect = preview.getBoundingClientRect();
        const pad = 4;
        const c = clamp(Math.ceil(((clientX - rect.left - pad) / (rect.width - pad * 2)) * HV_SIZE_COLS), 1, HV_SIZE_COLS);
        const r = clamp(Math.ceil(((clientY - rect.top - pad) / (rect.height - pad * 2)) * HV_SIZE_ROWS), 1, HV_SIZE_ROWS);
        col = c;
        row = r;
        paint();
    };
    let dragging = false;
    const onDown = (e) => {
        dragging = true;
        preview.dataset.dragging = 'true';
        try {
            preview.setPointerCapture(e.pointerId);
        }
        catch (_) { }
        sizeFromPoint(e.clientX, e.clientY);
        e.preventDefault();
    };
    const onMove = (e) => { if (dragging) {
        sizeFromPoint(e.clientX, e.clientY);
        e.preventDefault();
    } };
    const onUp = () => { dragging = false; preview.removeAttribute('data-dragging'); };
    preview.addEventListener('pointerdown', onDown);
    preview.addEventListener('pointermove', onMove);
    preview.addEventListener('pointerup', onUp);
    preview.addEventListener('pointercancel', onUp);
    presets.forEach((node) => {
        const b = node;
        b.addEventListener('click', () => {
            col = clamp(+b.dataset.cols || 4, 1, HV_SIZE_COLS);
            row = clamp(+b.dataset.rows || 2, 1, HV_SIZE_ROWS);
            paint();
        });
    });
    // Initial paint once layout settles (size depends on rendered width).
    paint();
    requestAnimationFrame(paint);
}
function _renderForm(panel, { mode, card }) {
    const schema = HyveviewRegistry.schema(card.type);
    const meta = HyveviewRegistry.get(card.type)?.meta || {};
    const title = mode === 'add' ? `Adaugă ${meta.name || card.type}` : `Editează ${meta.name || card.type}`;
    panel.innerHTML = `
    <div class="${HEADER_CLASS}">
      <h3 class="${TITLE_CLASS}">${title}</h3>
      <button type="button" class="${CLOSE_CLASS}" data-role="close" aria-label="Close"><i class="fas fa-xmark"></i></button>
    </div>
    <div class="${BODY_CLASS}">
      <div data-role="form"></div>
      <details class="hv-details" open>
        <summary>Dimensiune</summary>
        <div class="hv-details-body">
          <div class="hv-size" data-role="size">
            <p class="hv-size-hint">Trage de colț peste grilă ca să stabilești cât spațiu ocupă cardul.</p>
            <div class="hv-size-preview" data-role="size-preview">
              <div class="hv-size-handle" data-role="size-handle"></div>
            </div>
            <div class="hv-size-readout"><span data-role="size-readout">1 × 2</span><small>coloane × rânduri</small></div>
            <div class="hv-size-presets" data-role="size-presets">
              <button type="button" class="hv-size-preset" data-cols="1" data-rows="1">Mic</button>
              <button type="button" class="hv-size-preset" data-cols="2" data-rows="2">Mediu</button>
              <button type="button" class="hv-size-preset" data-cols="2" data-rows="3">Înalt</button>
              <button type="button" class="hv-size-preset" data-cols="4" data-rows="2">Lat</button>
              <button type="button" class="hv-size-preset" data-cols="4" data-rows="4">Plin</button>
            </div>
            <input type="hidden" data-role="layout-col" value="${card.layout?.col || 4}" />
            <input type="hidden" data-role="layout-row" value="${card.layout?.row || 2}" />
          </div>
        </div>
      </details>
      <details class="hv-details">
        <summary>Vizibilitate</summary>
        <div class="hv-details-body" data-role="visibility"></div>
      </details>
    </div>
    <div class="${FOOTER_CLASS}">
      ${mode === 'edit' ? `<button type="button" class="${BTN_DANGER}" data-role="delete"><i class="fas fa-trash mr-1"></i>Șterge</button>` : '<span></span>'}
      <div class="ml-auto flex items-center gap-2">
        <button type="button" class="${BTN_GHOST}" data-role="cancel">Cancel</button>
        <button type="button" class="${BTN_PRIMARY}" data-role="save">${mode === 'edit' ? 'Salvează' : 'Adaugă'}</button>
      </div>
    </div>
  `;
    _must(panel, '[data-role=close]').addEventListener('click', () => _close(null));
    _must(panel, '[data-role=cancel]').addEventListener('click', () => _close(null));
    _wireSizePicker(panel);
    const formHost = _must(panel, '[data-role=form]');
    let form = null;
    if (schema) {
        form = renderSchemaForm(formHost, schema, card.config || {});
    }
    else {
        formHost.innerHTML = `<em class="hv-editor-hint">Acest tip de card nu are un editor schematic.</em>`;
    }
    const visEditor = _renderVisibilityEditor(_must(panel, '[data-role=visibility]'), card.visibility || null);
    if (mode === 'edit') {
        _must(panel, '[data-role=delete]').addEventListener('click', () => {
            if (confirm('Ștergi acest card?'))
                _close({ __deleted: true });
        });
    }
    _must(panel, '[data-role=save]').addEventListener('click', () => {
        let config = card.config || {};
        if (form) {
            const v = form.validate();
            if (!v.ok) {
                alert(v.errors.join('\n'));
                return;
            }
            config = form.read();
        }
        const col = Number(_must(panel, '[data-role=layout-col]').value) || 4;
        const row = Number(_must(panel, '[data-role=layout-row]').value) || 2;
        const result = {
            id: card.id,
            type: card.type,
            entity: _entityFromConfig(config),
            layout: { col, row },
            config,
            visibility: visEditor.read(),
        };
        _close(result);
    });
}
