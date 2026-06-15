/**
 * Shared add-on config field render + collect (Apps detail + Hub modal).
 */
import { escapeHtml } from '../utils.js';

export interface AddonFieldSchema {
    key?: string;
    label?: string;
    description?: string;
    placeholder?: string;
    type?: string;
    default?: unknown;
    options?: Array<string | { value?: string; label?: string }>;
    detect?: string;
}

export function collectAddonConfig(root: ParentNode): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    root.querySelectorAll('[data-addon-config], [data-addon-key]').forEach((field) => {
        const el = field as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        const key = el.dataset.addonConfig || el.dataset.addonKey;
        if (!key) return;
        if (el.type === 'checkbox') {
            body[key] = !!(el as HTMLInputElement).checked;
            return;
        }
        if (el.type === 'number') {
            const raw = `${el.value || ''}`.trim();
            body[key] = raw === '' ? '' : Number(raw);
            return;
        }
        body[key] = `${el.value || ''}`.trim();
    });
    return body;
}

export function resolveAddonConfigValue(
    field: AddonFieldSchema,
    cfg: Record<string, unknown>,
    suggestions?: Record<string, unknown>,
): unknown {
    const key = field.key || '';
    const val = cfg[key];
    if (val !== undefined && val !== null && `${val}`.trim() !== '') {
        return val;
    }
    if (key === 'origin_url') {
        const suggested = suggestions?.origin_url;
        if (suggested !== undefined && suggested !== null && `${suggested}`.trim() !== '') {
            return suggested;
        }
    }
    return field.default ?? '';
}

export function renderAddonConfigField(
    field: AddonFieldSchema,
    value: unknown,
    isAdmin: boolean,
    attr = 'data-addon-config',
): string {
    const key = field.key || '';
    const label = field.label || key;
    const desc = field.description || '';
    const placeholder = field.placeholder || '';
    const type = (field.type || 'text').toLowerCase();
    const safeValue = value ?? field.default ?? '';
    const disabled = isAdmin ? '' : 'disabled';
    const wideClass = type === 'textarea' ? 'sm:col-span-2' : '';
    const attrName = attr === 'data-addon-key' ? 'data-addon-key' : 'data-addon-config';

    if (type === 'checkbox' || type === 'boolean') {
        return `
        <label class="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 flex items-start gap-3 cursor-pointer ${wideClass}">
            <input type="checkbox" ${attrName}="${escapeHtml(key)}" ${safeValue ? 'checked' : ''} ${disabled}
                class="mt-0.5 rounded border-white/10 bg-slate-900 text-accent focus:ring-accent/40">
            <span class="min-w-0">
                <span class="block text-sm text-white">${escapeHtml(label)}</span>
                ${desc ? `<span class="block text-[11px] text-slate-500 mt-1">${escapeHtml(desc)}</span>` : ''}
            </span>
        </label>`;
    }

    if (type === 'select' && Array.isArray(field.options)) {
        const options = field.options.map((opt) => {
            const option = typeof opt === 'object' ? opt : { value: opt, label: opt };
            const val = `${option.value ?? option.label ?? ''}`;
            const selected = `${safeValue}` === val ? 'selected' : '';
            return `<option value="${escapeHtml(val)}" ${selected}>${escapeHtml(option.label ?? val)}</option>`;
        }).join('');
        return `
        <label class="block space-y-1.5 ${wideClass}">
            <span class="text-xs font-semibold text-slate-300">${escapeHtml(label)}</span>
            <select ${attrName}="${escapeHtml(key)}" ${disabled}
                class="w-full rounded-xl border border-white/[0.06] bg-slate-950/80 px-3 py-2.5 text-sm text-white outline-none focus:border-accent/40">
                ${options}
            </select>
            ${desc ? `<p class="text-[11px] text-slate-500">${escapeHtml(desc)}</p>` : ''}
        </label>`;
    }

    if (type === 'textarea') {
        return `
        <label class="block space-y-1.5 ${wideClass}">
            <span class="text-xs font-semibold text-slate-300">${escapeHtml(label)}</span>
            <textarea ${attrName}="${escapeHtml(key)}" placeholder="${escapeHtml(placeholder)}" ${disabled}
                class="w-full min-h-[96px] rounded-xl border border-white/[0.06] bg-slate-950/80 px-3 py-2.5 text-sm text-white outline-none focus:border-accent/40 font-mono text-[12px]">${escapeHtml(String(safeValue))}</textarea>
            ${desc ? `<p class="text-[11px] text-slate-500">${escapeHtml(desc)}</p>` : ''}
        </label>`;
    }

    const inputType = ['number', 'password', 'url'].includes(type) ? type : 'text';
    return `
    <label class="block space-y-1.5 ${wideClass}">
        <span class="text-xs font-semibold text-slate-300">${escapeHtml(label)}</span>
        <input type="${escapeHtml(inputType)}" ${attrName}="${escapeHtml(key)}" value="${escapeHtml(String(safeValue))}" placeholder="${escapeHtml(placeholder)}" ${disabled}
            class="w-full rounded-xl border border-white/[0.06] bg-slate-950/80 px-3 py-2.5 text-sm text-white outline-none focus:border-accent/40${inputType === 'password' ? '' : ' font-mono text-[12px]'}">
        ${desc ? `<p class="text-[11px] text-slate-500">${escapeHtml(desc)}</p>` : ''}
    </label>`;
}
