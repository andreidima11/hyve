/**
 * Hyveview schema editor bridge — add/edit/delete dashboard widgets via hvOpenEditor.
 */

import { apiCall } from '../api.js';
import { showToast } from '../utils.js';
import * as HVBridge from '/static/hyveview/bridge.js';
import { hvOpenEditor } from './hyveview_setup.js';
import {
    DEFAULT_CAMERA_INTERVAL,
    SECTION_COLS,
} from './constants.js';
import { dashApiError, dashboardPageQuery } from './helpers.js';
import type {
    DashboardCache,
    DashboardVisibilityConfig,
    DashboardWidget,
    DashboardWidgetEditorBridgeDeps,
} from '../types/dashboard.js';
import type { HyveEntity } from '../types/entity.js';

interface EditorEntityRef {
    entity_id: string;
    title?: string;
    subtitle?: string;
    unique_id?: string;
}

interface EditorCard {
    id?: string;
    type: string;
    entity: string | null;
    layout: { col: number; row: number };
    config: Record<string, unknown>;
    visibility: DashboardVisibilityConfig | null;
}

interface EditorResult {
    type?: string;
    config?: Record<string, unknown>;
    layout?: { col?: number; row?: number };
    visibility?: DashboardVisibilityConfig;
    __deleted?: boolean;
}

let _deps: DashboardWidgetEditorBridgeDeps | null = null;

function deps(): DashboardWidgetEditorBridgeDeps {
    if (!_deps) throw new Error('Dashboard widget editor bridge not initialized');
    return _deps;
}

export function initDashboardWidgetEditorBridge(depsIn: DashboardWidgetEditorBridgeDeps) {
    _deps = depsIn;
}

function slug(value: unknown) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'section';
}

export async function ensureHyveviewEntitySeed() {
    const d = deps();
    const cache = d.getDashboardCache();
    if (!Array.isArray(cache.available_entities) || !cache.available_entities.length) {
        try { await d.refreshAvailableEntities(); } catch { /* non-fatal */ }
    }
    const seed = (cache.available_entities || []).map(e => ({
        entity_id: e.entity_id,
        friendly_name: e.name || e.friendly_name || e.entity_id,
        source: e.source || '',
        attributes: e.attributes || {},
        state: e.state ?? null,
        unit: e.unit || '',
    }));
    try {
        const mod = await import('/static/hyveview/core/store.js');
        if (mod && typeof mod.seedEntities === 'function') mod.seedEntities(seed);
    } catch { /* offline ok */ }
}

function widgetToEditorCard(widget: DashboardWidget): EditorCard {
    const type = String(widget.type || 'entity');
    const rawCol = Number(widget.col_span);
    const col = Math.min(Math.max(Number.isFinite(rawCol) ? rawCol : SECTION_COLS, 1), SECTION_COLS);
    const row = Math.min(Math.max(Number(widget.row_span) || 2, 1), 12);

    const widgetConfig = widget.config && typeof widget.config === 'object'
        ? widget.config as Record<string, unknown>
        : {};

    const cfg: Record<string, unknown> = {
        title: widget.title || '',
        icon: widget.icon || widgetConfig.icon || '',
        color: widget.color || '',
        switch_style: !!widget.switch_style,
        show_background: !!widget.show_background,
        entity_name: widget.entity_name || '',
    };
    if (type !== 'label') cfg.entity_id = widget.entity_id || '';
    if (type === 'camera') {
        cfg.entity = widget.entity_id || '';
        const raw = widgetConfig.camera_mode || 'snapshot';
        cfg.mode = raw === 'live' ? 'live' : 'snapshot';
        cfg.interval = Number(widgetConfig.interval) || DEFAULT_CAMERA_INTERVAL;
        cfg.default_audio = !!widgetConfig.default_audio;
        cfg.default_microphone = !!widgetConfig.default_microphone;
        cfg.autoplay = widgetConfig.autoplay !== false;
        cfg.preload = !!widgetConfig.preload;
        cfg.preload_scope = widgetConfig.preload_scope === 'all' ? 'all' : 'adjacent';
        const ents = widgetConfig.entities || [];
        cfg.entities = (Array.isArray(ents) ? ents : []).map((e) => typeof e === 'string'
            ? { entity_id: e, title: '', subtitle: '' }
            : { entity_id: (e as EditorEntityRef).entity_id || '', title: (e as EditorEntityRef).title || '', subtitle: (e as EditorEntityRef).subtitle || '' }
        ).filter((e: EditorEntityRef) => e.entity_id);
        if (!(cfg.entities as EditorEntityRef[]).length && widget.entity_id) {
            cfg.entities = [{ entity_id: widget.entity_id, title: widget.title || '', subtitle: '' }];
        }
    }
    if (type === 'picture') {
        cfg.sources = Array.isArray(widgetConfig.sources) ? widgetConfig.sources : [];
        if (!(cfg.sources as unknown[]).length && widget.entity_id && widget.entity_id.startsWith('image.')) {
            cfg.sources = [{ type: 'entity', value: widget.entity_id }];
        }
        cfg.interval = Number(widgetConfig.interval) || 15;
    }
    if (type === 'climate') {
        const ents = widgetConfig.entities || widgetConfig.entity_ids || [];
        cfg.entities = (Array.isArray(ents) ? ents : []).map(e => typeof e === 'string'
            ? { entity_id: e, title: '', subtitle: '' }
            : { entity_id: (e as EditorEntityRef).entity_id, title: (e as EditorEntityRef).title || '', subtitle: (e as EditorEntityRef).subtitle || '' });
    }
    if (type === 'fusion_solar') {
        const cfgIn = widgetConfig;
        const powerEnts = Array.isArray(cfgIn.power_entities) ? cfgIn.power_entities : [];
        cfg.power_entities = powerEnts.length
            ? powerEnts.map((e) => typeof e === 'string'
                ? { entity_id: e, title: '', subtitle: '' }
                : { entity_id: (e as EditorEntityRef).entity_id || '', title: (e as EditorEntityRef).title || '', subtitle: (e as EditorEntityRef).subtitle || '' })
            : (widget.entity_id ? [{ entity_id: widget.entity_id, title: '', subtitle: '' }] : []);
        cfg.entity_load = cfgIn.entity_load || '';
        cfg.entity_grid = cfgIn.entity_grid || '';
        cfg.entity_grid_export = cfgIn.entity_grid_export || '';
        cfg.entity_grid_import = cfgIn.entity_grid_import || '';
        cfg.entity_daily = cfgIn.entity_daily || '';
        cfg.entity_monthly = cfgIn.entity_monthly || '';
        cfg.entity_yearly = cfgIn.entity_yearly || '';
        cfg.entity_feed_in = cfgIn.entity_feed_in || '';
        cfg.entity_consumption = cfgIn.entity_consumption || '';
        cfg.capacity_kw = cfgIn.capacity_kw ?? '';
    }
    if (widgetConfig.interactions && typeof widgetConfig.interactions === 'object') {
        cfg.interactions = widgetConfig.interactions;
    }

    return {
        id: widget.id,
        type,
        entity: widget.entity_id || null,
        layout: { col, row },
        config: cfg,
        visibility: (widget.visibility as DashboardVisibilityConfig) || null,
    };
}

function lookupDashboardEntity(entityId: string, cache: DashboardCache): HyveEntity | null {
    const id = String(entityId || '').trim();
    if (!id) return null;
    const list = cache?.available_entities || [];
    return list.find((e) => e?.entity_id === id)
        || list.find((e) => e?.unique_id === id)
        || null;
}

function enrichEntityRecords(records: EditorEntityRef[], cache: DashboardCache): EditorEntityRef[] {
    return (records || []).map((row) => {
        const ent = lookupDashboardEntity(row.entity_id, cache);
        const out = { ...row };
        if (ent?.entity_id) out.entity_id = ent.entity_id;
        if (ent?.unique_id) out.unique_id = ent.unique_id;
        return out;
    }).filter((row) => row.entity_id);
}

function attachEntityRef(body: Record<string, unknown>, cache: DashboardCache) {
    const ent = lookupDashboardEntity(String(body.entity_id || ''), cache);
    if (ent?.unique_id) body.unique_id = ent.unique_id;
    else delete body.unique_id;
    if (ent?.entity_id) body.entity_id = ent.entity_id;
}

function editorResultToWidgetBody(
    result: EditorResult,
    { existingWidget = null }: { existingWidget?: DashboardWidget | null } = {},
): Record<string, unknown> {
    const d = deps();
    const cache = d.getDashboardCache();
    const type = result.type || 'entity';
    const cfg = result.config || {};
    const col = Math.min(Math.max(Number(result.layout?.col) || SECTION_COLS, 1), SECTION_COLS);
    const row = Math.min(Math.max(Number(result.layout?.row) || 2, 1), 12);

    let entityId: string;
    if (type === 'label') {
        const baseTitle = String(cfg.title || cfg.entity_name || 'section');
        entityId = existingWidget?.entity_id || `label.${slug(baseTitle)}`;
    } else if (type === 'climate') {
        const entities = Array.isArray(cfg.entities) ? cfg.entities : [];
        const first = entities[0];
        entityId = (typeof first === 'string' ? first : (first as EditorEntityRef)?.entity_id) || '';
    } else if (type === 'camera') {
        const entities = Array.isArray(cfg.entities) ? cfg.entities : [];
        const first = entities[0];
        entityId = (typeof first === 'string' ? first : (first as EditorEntityRef)?.entity_id) || String(cfg.entity || cfg.entity_id || '').trim();
    } else if (type === 'picture') {
        const sources = Array.isArray(cfg.sources) ? cfg.sources as Array<{ type?: string; value?: string }> : [];
        const firstEnt = sources.find(s => s.type === 'entity');
        entityId = firstEnt ? String(firstEnt.value || '') : (existingWidget?.entity_id || `picture.gallery_${Date.now()}`);
    } else if (type === 'fusion_solar') {
        const powerRecords = (Array.isArray(cfg.power_entities) ? cfg.power_entities : [])
            .map((e) => typeof e === 'string'
                ? { entity_id: e, title: '', subtitle: '' }
                : { entity_id: (e as EditorEntityRef).entity_id || '', title: (e as EditorEntityRef).title || '', subtitle: (e as EditorEntityRef).subtitle || '' })
            .filter((e: EditorEntityRef) => e.entity_id);
        entityId = powerRecords[0]?.entity_id || String(cfg.entity_id || cfg.entity || '').trim();
    } else {
        entityId = String(cfg.entity_id || cfg.entity || '').trim();
    }

    let source = existingWidget?.source || '';
    if (!source) {
        if (type === 'label') source = 'manual';
        else {
            const ent = (cache.available_entities || []).find(e => e.entity_id === entityId);
            source = ent?.source || 'zigbee2mqtt';
        }
    }

    const body: Record<string, unknown> = {
        type,
        entity_id: entityId,
        entity_name: String(cfg.entity_name || cfg.title || entityId || '').trim(),
        title: String(cfg.title || '').trim(),
        icon: String(cfg.icon || '').trim(),
        source,
        size: existingWidget?.size || 'md',
        favorite: !!existingWidget?.favorite,
        show_background: type === 'label' ? !!cfg.show_background : false,
        switch_style: (type === 'button' || type === 'switch') ? !!cfg.switch_style : false,
        col_span: col,
        row_span: row,
    };
    if (type === 'entity' && entityId) {
        const ent = (cache.available_entities || []).find(e => e.entity_id === entityId);
        const resolved = HVBridge.resolveEntityEffectiveType({
            entity_id: entityId,
            domain: ent?.domain || entityId.split('.')[0],
            switch_style: false,
        });
        body.switch_style = resolved.switchStyle;
    }
    if (cfg.color) body.color = cfg.color;
    if (type === 'climate') {
        const records = enrichEntityRecords(
            (Array.isArray(cfg.entities) ? cfg.entities : []).map(e =>
                typeof e === 'string'
                    ? { entity_id: e }
                    : { entity_id: (e as EditorEntityRef).entity_id, title: (e as EditorEntityRef).title || '', subtitle: (e as EditorEntityRef).subtitle || '', unique_id: (e as EditorEntityRef).unique_id || '' }
            ),
            cache,
        );
        body.config = { entities: records, entity_ids: records.map(r => r.entity_id) };
    }
    if (type === 'camera') {
        const cameraMode = (cfg.mode || cfg.camera_mode || 'snapshot') === 'live' ? 'live' : 'snapshots';
        const interval = Number(cfg.interval) || DEFAULT_CAMERA_INTERVAL;
        const records = enrichEntityRecords(
            (Array.isArray(cfg.entities) ? cfg.entities : []).map((e) =>
                typeof e === 'string'
                    ? { entity_id: e, title: '', subtitle: '' }
                    : { entity_id: (e as EditorEntityRef).entity_id, title: (e as EditorEntityRef).title || '', subtitle: (e as EditorEntityRef).subtitle || '', unique_id: (e as EditorEntityRef).unique_id || '' }
            ),
            cache,
        );
        if (!records.length && entityId) {
            records.push({ entity_id: entityId, title: String(cfg.title || ''), subtitle: '' });
        }
        body.config = {
            ...(body.config as Record<string, unknown> || {}),
            camera_mode: cameraMode,
            interval,
            entities: records,
            entity_ids: records.map((r) => r.entity_id),
            autoplay: cfg.autoplay !== false,
            default_audio: !!cfg.default_audio,
            default_microphone: !!cfg.default_microphone,
            preload: !!cfg.preload,
            preload_scope: cfg.preload_scope === 'all' ? 'all' : 'adjacent',
        };
        if (records[0]?.title && !Object.prototype.hasOwnProperty.call(cfg, 'title')) body.title = records[0].title;
    }
    if (type === 'picture') {
        const sources = Array.isArray(cfg.sources) ? (cfg.sources as Array<{ type?: string; value?: string }>).filter(s => s && s.value) : [];
        const interval = Number(cfg.interval) || 15;
        body.config = { ...(body.config as Record<string, unknown> || {}), sources, interval };
        const firstEntity = sources.find(s => s.type === 'entity');
        if (firstEntity) body.entity_id = firstEntity.value;
        else if (!body.entity_id) body.entity_id = `picture.gallery_${Date.now()}`;
    }
    if (type === 'fusion_solar') {
        const powerRecords = (Array.isArray(cfg.power_entities) ? cfg.power_entities : [])
            .map((e) => typeof e === 'string'
                ? { entity_id: e, title: '', subtitle: '' }
                : { entity_id: (e as EditorEntityRef).entity_id || '', title: (e as EditorEntityRef).title || '', subtitle: (e as EditorEntityRef).subtitle || '' })
            .filter((e: EditorEntityRef) => e.entity_id);
        const powerId = powerRecords[0]?.entity_id || String(body.entity_id || '');
        const slotKeys = [
            'entity_load', 'entity_grid', 'entity_grid_export', 'entity_grid_import',
            'entity_daily', 'entity_monthly', 'entity_yearly', 'entity_feed_in', 'entity_consumption',
        ] as const;
        const slotCfg: Record<string, string> = {};
        slotKeys.forEach((k) => {
            const v = String(cfg[k] || '').trim();
            if (v) slotCfg[k] = v;
        });
        body.config = {
            ...(body.config as Record<string, unknown> || {}),
            power_entities: powerRecords,
            ...slotCfg,
            capacity_kw: cfg.capacity_kw === '' || cfg.capacity_kw == null ? undefined : Number(cfg.capacity_kw),
        };
        body.config = {
            ...(body.config as Record<string, unknown>),
            entity_ids: HVBridge.cardTypeEntityIds({
                entity_id: powerId,
                config: body.config as Record<string, unknown>,
                type: 'fusion_solar',
                renderer: 'fusion_solar',
            }),
        };
        if (!body.source || body.source === 'zigbee2mqtt') {
            const ent = (cache.available_entities || []).find(e => e.entity_id === powerId);
            if (ent?.source) body.source = ent.source;
        }
    }
    if (result.visibility) body.visibility = result.visibility;
    if (cfg.interactions && typeof cfg.interactions === 'object') {
        body.config = { ...(body.config as Record<string, unknown> || {}), interactions: cfg.interactions };
    }
    if (body.entity_id !== existingWidget?.entity_id) {
        attachEntityRef(body, cache);
    } else if (existingWidget?.unique_id) {
        body.unique_id = existingWidget.unique_id;
    }
    return body;
}

export async function saveDashboardWidgetFromEditor(
    result: unknown,
    { editingId = null, original = null }: { editingId?: string | null; original?: DashboardWidget | null } = {},
) {
    const d = deps();
    const body = editorResultToWidgetBody(result as EditorResult, { existingWidget: original });
    const entitylessTypes = ['label', 'picture'];
    if (!entitylessTypes.includes(String(body.type)) && !body.entity_id) {
        showToast(d.t('dashboard.entity_required') || 'Pick an entity', 'warning');
        return;
    }
    const pageQS = dashboardPageQuery(d.getCurrentPageId());

    if (editingId) {
        try {
            const res = await apiCall(`/api/dashboard/widgets/${encodeURIComponent(editingId)}${pageQS}`, {
                method: 'PATCH', body,
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(dashApiError(err.detail, 'dashboard.card_update_error'));
            }
            await d.loadDashboard();
            showToast(d.t('dashboard.card_updated') || 'Card actualizat', 'success');
        } catch (e) {
            showToast(e instanceof Error ? e.message : d.t('dashboard.card_update_error'), 'error');
        }
        return;
    }

    try {
        const res = await apiCall(`/api/dashboard/widgets${pageQS}`, { method: 'POST', body });
        if (res.ok) {
            await d.loadDashboard();
            showToast(d.t('dashboard.card_added') || 'Card adăugat', 'success');
            return;
        }
        if (res.status !== 404) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiError(err.detail, 'dashboard.save_widget_failed'));
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        showToast(msg || d.t('dashboard.save_widget_failed') || 'Could not save widget', 'error');
        return;
    }

    try {
        const section = await d.readDashboardSectionFallback();
        const panels = Array.isArray(section.panels) ? section.panels : [];
        if (panels.length > 0) {
            showToast(d.t('dashboard.save_widget_failed') || 'Could not save widget', 'error');
            return;
        }
        section.widgets = section.widgets || [];
        section.widgets.push({
            id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            ...body,
        });
        await d.writeDashboardSectionFallback(section);
        await d.loadDashboard();
        showToast(d.t('dashboard.card_added') || 'Card added', 'success');
    } catch (e) {
        showToast(e instanceof Error ? e.message : (d.t('dashboard.save_error') || 'Save error'), 'error');
    }
}

async function deleteDashboardWidgetSilent(widgetId: string) {
    const d = deps();
    const pageQS = dashboardPageQuery(d.getCurrentPageId());
    try {
        const res = await apiCall(`/api/dashboard/widgets/${encodeURIComponent(widgetId)}${pageQS}`, { method: 'DELETE' });
        if (res.ok) {
            await d.loadDashboard();
            showToast(d.t('dashboard.widget_deleted') || 'Widget deleted', 'success');
            return;
        }
        if (res.status !== 404) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiError(err.detail, 'dashboard.delete_widget_failed'));
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        if (msg.includes(d.t('dashboard.delete_widget_failed'))) {
            showToast(msg, 'error');
            return;
        }
    }
    try {
        const section = await d.readDashboardSectionFallback();
        const panels = Array.isArray(section.panels) ? section.panels : [];
        if (panels.length > 0) {
            showToast(d.t('dashboard.widget_delete_error') || 'Could not delete widget', 'error');
            return;
        }
        section.widgets = (section.widgets || []).filter(it => it.id !== widgetId);
        await d.writeDashboardSectionFallback(section);
        await d.loadDashboard();
        showToast(d.t('dashboard.widget_deleted') || 'Widget deleted', 'success');
    } catch (e) {
        showToast(e instanceof Error ? e.message : (d.t('dashboard.widget_delete_error') || 'Could not delete widget'), 'error');
    }
}

export async function openDashboardWidgetEditor(widgetId: string) {
    const d = deps();
    if (!d.requireDashboardEditAccess()) return;
    const widget = d.findWidget(widgetId);
    if (!widget) {
        showToast(d.t('dashboard.card_not_found') || 'Card not found', 'error');
        return;
    }
    await ensureHyveviewEntitySeed();
    const card = widgetToEditorCard(widget);
    const result = await hvOpenEditor({ mode: 'edit', card }) as EditorResult | null;
    if (!result) return;
    if (result.__deleted) {
        await deleteDashboardWidgetSilent(widgetId);
        return;
    }
    await saveDashboardWidgetFromEditor(result, { editingId: widgetId, original: widget });
}
