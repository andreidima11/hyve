/**
 * Legacy per-widget editor modal (visual + YAML tabs). Superseded by Hyveview schema editor.
 */

import { apiCall } from '../api.js';
import { getCodeEditorValue, refreshCodeEditor, showToast } from '../utils.js';
import { dashApiError } from './helpers.js';
import { readDashboardVisibilityConfig } from './widget_add_editor.js';
import { resolveEntityMatch } from './entity_picker.js';
import type { DashboardWidget, DashboardWidgetLegacyEditDeps } from '../types/dashboard.js';
import type { HyveEntity } from '../types/entity.js';

let _deps: DashboardWidgetLegacyEditDeps | null = null;
let _editorMode: 'visual' | 'yaml' = 'visual';

function deps(): DashboardWidgetLegacyEditDeps {
    if (!_deps) throw new Error('Dashboard widget legacy edit not initialized');
    return _deps;
}

export function initDashboardWidgetLegacyEdit(depsIn: DashboardWidgetLegacyEditDeps): void {
    _deps = depsIn;
}

function slug(value: unknown): string {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'section';
}

function parseWidgetYaml(raw: string, fallback: Record<string, unknown> = {}): Record<string, unknown> {
    const patch = { ...fallback };
    String(raw || '').split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const match = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
        if (!match) return;
        const [, key, valueRaw] = match;
        let value = valueRaw.trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key === 'favorite' || key === 'show_background' || key === 'switch_style') {
            patch[key] = value.toLowerCase() === 'true';
        } else {
            patch[key] = value;
        }
    });
    return patch;
}

function normalizeLocalWidgetPatch(
    widget: DashboardWidget,
    patch: Record<string, unknown>,
): DashboardWidget {
    const updated = { ...(widget || {}), ...(patch || {}) } as DashboardWidget;
    updated.type = ['switch', 'info', 'button', 'label', 'climate', 'camera', 'picture', 'weather', 'weather_rich', 'gauge', 'fusion_solar'].includes(String(updated.type))
        ? updated.type
        : 'button';
    updated.size = ['sm', 'md', 'wide'].includes(String(updated.size)) ? updated.size : 'md';
    const noDefaultTitleTypes = new Set(['weather', 'weather_rich', 'fusion_solar']);
    updated.title = Object.prototype.hasOwnProperty.call(updated, 'title')
        ? String(updated.title ?? '').trim()
        : (noDefaultTitleTypes.has(String(updated.type))
            ? ''
            : String(updated.entity_name || updated.entity_id || 'Card').trim());
    updated.entity_name = updated.type === 'label'
        ? String(updated.entity_name || '').trim()
        : String(updated.entity_name || updated.title || updated.entity_id || '').trim();
    updated.entity_id = String(updated.entity_id || `label.${slug(updated.title || updated.entity_name || 'section')}`).trim();
    updated.source = String(updated.source || 'zigbee2mqtt').trim();
    updated.icon = String(updated.icon || '').trim();
    updated.favorite = Boolean(updated.favorite);
    updated.show_background = Boolean(updated.show_background);
    updated.switch_style = Boolean(updated.switch_style || updated.type === 'switch');
    return updated;
}

export function closeDashboardWidgetEditor(): void {
    // Legacy closer — schema editor closes itself.
}

export function setDashboardWidgetEditorMode(mode = 'visual'): void {
    _editorMode = mode === 'yaml' ? 'yaml' : 'visual';
    const visual = document.getElementById('dashboard-widget-editor-visual');
    const yaml = document.getElementById('dashboard-widget-editor-yaml-wrap');
    const visualTab = document.getElementById('dashboard-widget-editor-visual-tab');
    const yamlTab = document.getElementById('dashboard-widget-editor-yaml-tab');

    if (visual) visual.classList.toggle('hidden', _editorMode !== 'visual');
    if (yaml) yaml.classList.toggle('hidden', _editorMode !== 'yaml');
    if (visualTab) {
        visualTab.classList.toggle('bg-accent', _editorMode === 'visual');
        visualTab.classList.toggle('text-bg-main', _editorMode === 'visual');
        visualTab.classList.toggle('bg-white/5', _editorMode !== 'visual');
        visualTab.classList.toggle('text-slate-200', _editorMode !== 'visual');
    }
    if (yamlTab) {
        yamlTab.classList.toggle('bg-accent', _editorMode === 'yaml');
        yamlTab.classList.toggle('text-bg-main', _editorMode === 'yaml');
        yamlTab.classList.toggle('bg-white/5', _editorMode !== 'yaml');
        yamlTab.classList.toggle('text-slate-200', _editorMode !== 'yaml');
    }
    if (_editorMode === 'yaml') refreshCodeEditor('dashboard-widget-editor-yaml');
}

export async function saveDashboardWidgetEdit(): Promise<void> {
    const d = deps();
    if (!d.requireDashboardEditAccess()) return;
    const editorId = d.getCurrentEditorId();
    if (!editorId) return;

    let patch: Record<string, unknown> = {};
    if (_editorMode === 'yaml') {
        patch = parseWidgetYaml(getCodeEditorValue('dashboard-widget-editor-yaml') || '', {});
    } else {
        const type = (document.getElementById('dashboard-edit-widget-type') as HTMLSelectElement | null)?.value || 'button';
        const title = (document.getElementById('dashboard-edit-widget-title') as HTMLInputElement | null)?.value || '';
        const subtitle = (document.getElementById('dashboard-edit-widget-subtitle') as HTMLInputElement | null)?.value || '';
        const size = (document.getElementById('dashboard-edit-widget-size') as HTMLSelectElement | null)?.value || 'md';
        const showBackground = (document.getElementById('dashboard-edit-widget-label-bg') as HTMLInputElement | null)?.checked;
        const switchStyle = (document.getElementById('dashboard-edit-widget-switch-style') as HTMLInputElement | null)?.checked;
        const entityInput = document.getElementById('dashboard-edit-entity-select') as HTMLInputElement | null;
        const selected = resolveEntityMatch(entityInput, type) as HyveEntity | null;

        if (type !== 'label' && !selected) {
            showToast(d.t('dashboard.pick_entity'), 'warning');
            return;
        }

        patch = {
            type,
            title: title.trim(),
            entity_name: type === 'label' ? subtitle.trim() : subtitle.trim(),
            size,
            entity_id: type === 'label' ? `label.${slug(title || subtitle || 'section')}` : selected!.entity_id,
            source: type === 'label' ? 'manual' : (selected?.source || 'zigbee2mqtt'),
            show_background: type === 'label' ? !!showBackground : false,
            switch_style: type === 'button' ? !!switchStyle : false,
        };
        const visibility = readDashboardVisibilityConfig();
        if (visibility) patch.visibility = visibility;
    }

    try {
        const res = await apiCall(`/api/dashboard/widgets/${encodeURIComponent(editorId)}`, {
            method: 'PATCH',
            body: patch,
        });
        if (!res.ok && res.status !== 404) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiError(err.detail, 'dashboard.card_update_error'));
        }

        const section = await d.readDashboardSectionFallback();
        section.widgets = (section.widgets || []).map((item) => (
            item.id === editorId ? normalizeLocalWidgetPatch(item, patch) : item
        ));
        await d.writeDashboardSectionFallback(section);
        closeDashboardWidgetEditor();
        await d.loadDashboard();
        showToast(d.t('dashboard.card_updated'), 'success');
    } catch (e) {
        const message = e instanceof Error ? e.message : d.t('dashboard.card_update_error');
        showToast(message, 'error');
    }
}
