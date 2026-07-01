/**
 * Shared light capability detection + color picker helpers (Devices + Integrations).
 */

import { commitIntegrationControl } from './integrations/event_bindings.js';
import { commitSmarthomeLightControl } from './smarthome/event_bindings.js';

export type LightControlFlags = {
    hasBrightness: boolean;
    hasColor: boolean;
    hasColorTemp: boolean;
    brightnessScale: number;
    brightnessValue: number;
    colorTempMin: number;
    colorTempMax: number;
    colorTempValue: number;
    colorHex: string;
};

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function clampByte(v: number): string {
    return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
}

const COLOR_PRESETS = [
    '#ffffff', '#ffd6aa', '#ff4444', '#ff8800', '#ffee00',
    '#44cc44', '#00cccc', '#4488ff', '#aa44ff', '#ff44aa',
];

export function hexToHsv(hex: string): { h: number; s: number; v: number } {
    let raw = hex.replace('#', '').trim().toLowerCase();
    if (raw.length === 3) raw = raw.split('').map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}$/.test(raw)) return { h: 0, s: 0, v: 100 };
    const r = parseInt(raw.slice(0, 2), 16) / 255;
    const g = parseInt(raw.slice(2, 4), 16) / 255;
    const b = parseInt(raw.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    const v = max * 100;
    const s = max === 0 ? 0 : (d / max) * 100;
    if (d !== 0) {
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
        else if (max === g) h = ((b - r) / d + 2) * 60;
        else h = ((r - g) / d + 4) * 60;
    }
    return { h: Math.round(h), s: Math.round(s), v: Math.round(v) };
}

function hsvToHex(h: number, s: number, v: number): string {
    const hue = ((h % 360) + 360) % 360;
    const sat = Math.max(0, Math.min(100, s)) / 100;
    const val = Math.max(0, Math.min(100, v)) / 100;
    const c = val * sat;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = val - c;
    let r = 0; let g = 0; let b = 0;
    if (hue < 60) { r = c; g = x; }
    else if (hue < 120) { r = x; g = c; }
    else if (hue < 180) { g = c; b = x; }
    else if (hue < 240) { g = x; b = c; }
    else if (hue < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return `#${clampByte((r + m) * 255)}${clampByte((g + m) * 255)}${clampByte((b + m) * 255)}`;
}

export function lightColorToHex(attrs: Record<string, unknown>): string {
    const color = attrs.color ?? attrs.color_xy ?? attrs.color_hs;
    if (!color || typeof color !== 'object') return '#ffffff';
    const c = color as Record<string, unknown>;
    if (typeof c.hex === 'string') {
        const hex = c.hex.trim();
        if (/^#[0-9a-f]{6}$/i.test(hex)) return hex.toLowerCase();
        if (/^[0-9a-f]{6}$/i.test(hex)) return `#${hex.toLowerCase()}`;
    }
    if (typeof c.rgb === 'string') {
        const parts = c.rgb.split(',').map((p) => Number(p.trim()));
        if (parts.length >= 3 && parts.every(Number.isFinite)) {
            return `#${clampByte(parts[0])}${clampByte(parts[1])}${clampByte(parts[2])}`;
        }
    }
    const r = Number(c.r);
    const g = Number(c.g);
    const b = Number(c.b);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        return `#${clampByte(r)}${clampByte(g)}${clampByte(b)}`;
    }
    const hue = Number(c.hue ?? c.h);
    const sat = Number(c.saturation ?? c.s);
    const val = Number(c.brightness ?? c.v ?? c.b);
    if (Number.isFinite(hue) && Number.isFinite(sat)) {
        return hsvToHex(hue, sat, Number.isFinite(val) ? val : 100);
    }
    return '#ffffff';
}

const COLOR_MODES = new Set([
    'rgb', 'xy', 'hs', 'rgbw', 'rgbww', 'hs_color', 'rgb_color', 'rgbw_color', 'rgbww_color',
]);

export function lightHasColor(attrs: Record<string, unknown>, caps: Record<string, unknown>): boolean {
    if (caps.color) return true;
    if (attrs.color != null || attrs.color_xy != null || attrs.color_hs != null) return true;
    const modes = caps.supported_color_modes;
    if (Array.isArray(modes)) {
        return modes.some((m) => COLOR_MODES.has(String(m).toLowerCase()));
    }
    return false;
}

export function lightHasColorTemp(attrs: Record<string, unknown>, caps: Record<string, unknown>): boolean {
    if (caps.color_temp) return true;
    if (attrs.color_temp != null) return true;
    const modes = caps.supported_color_modes;
    if (Array.isArray(modes)) {
        return modes.some((m) => String(m).toLowerCase() === 'color_temp');
    }
    return false;
}

export function lightBrightnessScale(caps: Record<string, unknown>): number {
    if (caps.brightness_scale != null) return Number(caps.brightness_scale) || 254;
    const brRange = caps.brightness_range;
    if (Array.isArray(brRange) && brRange.length >= 2) return Number(brRange[1]) || 254;
    return 254;
}

export type LightCtrlAttrsFn = (
    slug: string,
    eid: string,
    action: string,
    payload?: Record<string, unknown> | null,
    opts?: { stop?: boolean },
) => string;

export type HyColorPickerLabels = {
    color: string;
    hue: string;
};

export function renderHyColorPickerMarkup(
    hex: string,
    hiddenAttrs: string,
    esc: (s: string) => string,
    escAttr: (s: string) => string,
    labels: HyColorPickerLabels,
    options?: { compact?: boolean },
): string {
    const { h, s, v } = hexToHsv(hex);
    const safeHex = escAttr(/^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : '#ffffff');
    const compact = options?.compact ?? false;
    const presets = COLOR_PRESETS.map((preset) => (
        `<button type="button" class="hy-color-picker__preset" data-hy-color-preset="${escAttr(preset)}"
            style="--hy-preset-color:${escAttr(preset)}" title="${escAttr(preset)}" aria-label="${escAttr(preset)}"
            data-entity-stop="1"></button>`
    )).join('');
    return `
    <div class="hy-color-picker${compact ? ' hy-color-picker--compact' : ''}" data-hy-color-picker
         data-hy-h="${h}" data-hy-s="${s}" data-hy-v="${v}" style="--hy-picker-hue:${h}">
        <div class="hy-color-picker__head">
            <div class="hy-color-picker__preview" data-hy-color-preview style="background:${safeHex}"></div>
            <div class="hy-color-picker__meta">
                <span class="hy-color-picker__label">${esc(labels.color)}</span>
                <span class="hy-color-picker__hex mono" data-hy-color-hex>${esc(safeHex)}</span>
            </div>
        </div>
        <div class="hy-color-picker__sb" data-hy-color-sb data-entity-stop="1"
             role="slider" aria-label="${escAttr(labels.color)}" aria-valuemin="0" aria-valuemax="100"
             aria-valuenow="${s}" tabindex="0">
            <span class="hy-color-picker__sb-cursor" data-hy-color-cursor
                  style="left:${s}%;top:${100 - v}%"></span>
        </div>
        <div class="hy-color-picker__hue-row">
            <span class="hy-color-picker__slider-label">${esc(labels.hue)}</span>
            <input type="range" min="0" max="360" step="1" value="${h}"
                   class="cfg-range hy-color-picker__hue w-full" data-hy-color-hue data-entity-stop="1">
        </div>
        <div class="hy-color-picker__presets" data-entity-stop="1">${presets}</div>
        <input type="hidden" class="hy-color-picker__value" data-hy-color-value value="${safeHex}" ${hiddenAttrs}>
    </div>`;
}

let _colorPickerBound = false;
let _dragSb: HTMLElement | null = null;

function _pickerHsv(picker: HTMLElement): { h: number; s: number; v: number } {
    return {
        h: Number(picker.dataset.hyH) || 0,
        s: Number(picker.dataset.hyS) || 0,
        v: Number(picker.dataset.hyV) || 100,
    };
}

function _setPickerHsv(picker: HTMLElement, h: number, s: number, v: number): void {
    picker.dataset.hyH = String(h);
    picker.dataset.hyS = String(s);
    picker.dataset.hyV = String(v);
    picker.style.setProperty('--hy-picker-hue', String(h));
}

function _syncColorPicker(picker: HTMLElement, dispatchChange: boolean): void {
    const { h, s, v } = _pickerHsv(picker);
    const hex = hsvToHex(h, s, v);
    const preview = picker.querySelector('[data-hy-color-preview]') as HTMLElement | null;
    const hexLabel = picker.querySelector('[data-hy-color-hex]') as HTMLElement | null;
    const cursor = picker.querySelector('[data-hy-color-cursor]') as HTMLElement | null;
    const hidden = picker.querySelector('[data-hy-color-value]') as HTMLInputElement | null;
    const hueInput = picker.querySelector('[data-hy-color-hue]') as HTMLInputElement | null;
    const sb = picker.querySelector('[data-hy-color-sb]') as HTMLElement | null;
    if (preview) preview.style.background = hex;
    if (hexLabel) hexLabel.textContent = hex;
    if (cursor) {
        cursor.style.left = `${s}%`;
        cursor.style.top = `${100 - v}%`;
    }
    if (hueInput && Number(hueInput.value) !== h) hueInput.value = String(h);
    if (sb) sb.setAttribute('aria-valuenow', String(s));
    if (hidden) {
        hidden.value = hex;
        if (dispatchChange) {
            _commitColorControl(hidden);
        }
    }
}

function _commitColorControl(hidden: HTMLInputElement): void {
    if (hidden.dataset.dashWidgetId) {
        const widgetId = String(hidden.dataset.dashWidgetId || '').trim();
        const hex = String(hidden.value || '').trim();
        if (widgetId && hex) {
            void import('./dashboard/widget_actions.js').then((mod) => {
                mod.sendLightColor(widgetId, hex);
            });
        }
        return;
    }
    if (hidden.dataset.smarthomeLightInput) {
        commitSmarthomeLightControl(hidden);
        return;
    }
    if (hidden.dataset.intInput === 'color') {
        commitIntegrationControl(hidden);
    }
}

function _sbFromPointer(sb: HTMLElement, clientX: number, clientY: number): { s: number; v: number } {
    const rect = sb.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    return { s: Math.round(x * 100), v: Math.round((1 - y) * 100) };
}

function _applySbPointer(sb: HTMLElement, clientX: number, clientY: number, dispatchChange: boolean): void {
    const picker = sb.closest('[data-hy-color-picker]');
    if (!(picker instanceof HTMLElement)) return;
    const { s, v } = _sbFromPointer(sb, clientX, clientY);
    const { h } = _pickerHsv(picker);
    _setPickerHsv(picker, h, s, v);
    _syncColorPicker(picker, dispatchChange);
}

export function initHyColorPickerBindings(): void {
    if (_colorPickerBound) return;
    _colorPickerBound = true;

    document.addEventListener('input', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || !target.matches('[data-hy-color-hue]')) return;
        const picker = target.closest('[data-hy-color-picker]');
        if (!(picker instanceof HTMLElement)) return;
        const { s, v } = _pickerHsv(picker);
        _setPickerHsv(picker, Number(target.value) || 0, s, v);
        _syncColorPicker(picker, false);
    }, false);

    document.addEventListener('change', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || !target.matches('[data-hy-color-hue]')) return;
        const picker = target.closest('[data-hy-color-picker]');
        if (!(picker instanceof HTMLElement)) return;
        const { s, v } = _pickerHsv(picker);
        _setPickerHsv(picker, Number(target.value) || 0, s, v);
        _syncColorPicker(picker, true);
    }, false);

    document.addEventListener('pointerdown', (event) => {
        const sb = (event.target as Element).closest('[data-hy-color-sb]');
        if (!(sb instanceof HTMLElement)) return;
        _dragSb = sb;
        sb.setPointerCapture(event.pointerId);
        _applySbPointer(sb, event.clientX, event.clientY, false);
        event.preventDefault();
    }, false);

    document.addEventListener('pointermove', (event) => {
        if (!_dragSb) return;
        _applySbPointer(_dragSb, event.clientX, event.clientY, false);
    }, false);

    const endSbDrag = (event: PointerEvent): void => {
        if (!_dragSb) return;
        try { _dragSb.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
        _applySbPointer(_dragSb, event.clientX, event.clientY, true);
        _dragSb = null;
    };
    document.addEventListener('pointerup', endSbDrag, false);
    document.addEventListener('pointercancel', endSbDrag, false);

    document.addEventListener('click', (event) => {
        const preset = (event.target as Element).closest('[data-hy-color-preset]');
        if (!(preset instanceof HTMLButtonElement)) return;
        const picker = preset.closest('[data-hy-color-picker]');
        if (!(picker instanceof HTMLElement)) return;
        const hex = preset.dataset.hyColorPreset || '#ffffff';
        const { h, s, v } = hexToHsv(hex);
        _setPickerHsv(picker, h, s, v);
        _syncColorPicker(picker, true);
        event.stopPropagation();
    }, false);
}

export function renderLightControlsMarkup(
    entity: { entity_id?: unknown; state?: unknown; attributes?: unknown },
    slug: string,
    ctrlAttrs: LightCtrlAttrsFn,
    esc: (s: string) => string,
    escAttr: (s: string) => string,
    labels: { brightness: string; color: string; color_temp: string; hue: string },
    options?: { compact?: boolean },
): string {
    const eid = String(entity.entity_id || '');
    if (!eid) return '';
    const isOn = String(entity.state || '').toLowerCase() === 'on';
    const flags = resolveLightControlFlags(entity, isOn);
    if (!flags.hasBrightness && !flags.hasColor && !flags.hasColorTemp) return '';

    const compact = options?.compact ?? false;
    const sectionClass = compact
        ? 'pt-2 border-t border-theme-subtle first:pt-0 first:border-t-0'
        : 'mt-3 pt-3 border-t border-theme-subtle';
    const parts: string[] = [];

    if (flags.hasBrightness) {
        const pct = Math.round((flags.brightnessValue / flags.brightnessScale) * 100);
        parts.push(`
        <div class="${sectionClass}">
            <div class="flex items-center justify-between text-[11px] text-slate-400 mb-1.5">
                <span>${esc(labels.brightness)}</span>
                <span class="mono text-slate-200">${pct}%</span>
            </div>
            <input type="range" min="0" max="${flags.brightnessScale}" step="1" value="${flags.brightnessValue}"
                   class="cfg-range w-full"
                   ${ctrlAttrs(slug, eid, 'set_brightness', null, { stop: true })} data-int-input="brightness" data-entity-stop="1">
        </div>`);
    }
    if (flags.hasColor) {
        parts.push(`
        <div class="${sectionClass}" data-int-light-controls="1">
            ${renderHyColorPickerMarkup(
                flags.colorHex,
                `${ctrlAttrs(slug, eid, 'set', null, { stop: true })} data-int-input="color" data-entity-stop="1"`,
                esc,
                escAttr,
                { color: labels.color, hue: labels.hue },
                { compact },
            )}
        </div>`);
    }
    if (flags.hasColorTemp) {
        parts.push(`
        <div class="${sectionClass}">
            <div class="flex items-center justify-between text-[11px] text-slate-400 mb-1.5">
                <span>${esc(labels.color_temp)}</span>
                <span class="mono text-slate-200" data-int-light-ct-label="${escAttr(eid)}">${flags.colorTempValue}</span>
            </div>
            <input type="range" min="${flags.colorTempMin}" max="${flags.colorTempMax}" step="1" value="${flags.colorTempValue}"
                   class="cfg-range w-full"
                   ${ctrlAttrs(slug, eid, 'set_color_temp', null, { stop: true })} data-int-input="color_temp" data-entity-stop="1">
        </div>`);
    }
    return parts.join('');
}

export function resolveLightControlFlags(
    entity: { state?: unknown; attributes?: unknown },
    isOn = String(entity.state || '').toLowerCase() === 'on',
): LightControlFlags {
    const attrs = asRecord(entity.attributes);
    const caps = asRecord(attrs.capabilities);
    const scale = lightBrightnessScale(caps);
    const rawBright = Number(attrs.brightness);
    const brightnessValue = Number.isFinite(rawBright) ? Math.max(0, Math.min(scale, rawBright)) : (isOn ? scale : 0);
    const ctRange = Array.isArray(caps.color_temp_range) ? caps.color_temp_range : [153, 500];
    const ctMin = Number(ctRange[0]) || 153;
    const ctMax = Number(ctRange[1]) || 500;
    const ctRaw = Number(attrs.color_temp);
    const colorTempValue = Number.isFinite(ctRaw) ? Math.max(ctMin, Math.min(ctMax, ctRaw)) : Math.round((ctMin + ctMax) / 2);
    return {
        hasBrightness: !!(
            caps.brightness || caps.brightness_command_topic || caps.brightness_range
            || (attrs.brightness != null && (caps.command_topic || caps.brightness_command_topic))
        ),
        hasColor: lightHasColor(attrs, caps),
        hasColorTemp: lightHasColorTemp(attrs, caps),
        brightnessScale: scale,
        brightnessValue,
        colorTempMin: ctMin,
        colorTempMax: ctMax,
        colorTempValue,
        colorHex: lightColorToHex(attrs),
    };
}
