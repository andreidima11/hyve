/**
 * Config form DOM helpers.
 */
import type { ConfigFormElement } from '../types/features_config.js';
import { t } from '../lang/index.js';

export function cfgField(id: string): ConfigFormElement | null {
    return document.getElementById(id) as ConfigFormElement | null;
}

export function cfgNode(id: string): HTMLElement | null {
    return document.getElementById(id);
}

export function cfgVal(id: string): string {
    return cfgField(id)?.value ?? '';
}

export function errMsg(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

export function integrationSlugCandidates(slug: string): string[] {
    const raw = String(slug || '').trim();
    if (!raw) return [];
    const dash = raw.replace(/_/g, '-');
    const under = raw.replace(/-/g, '_');
    return Array.from(new Set([raw, dash, under]));
}

export function findIntegrationCheckbox(slug: string): ConfigFormElement | null {
    for (const candidate of integrationSlugCandidates(slug)) {
        const ids = [`${candidate}_enabled`, `integrations-${candidate}-enabled`, `${candidate}Enabled`];
        for (const id of ids) {
            const el = cfgField(id);
            if (el && el.type === 'checkbox') return el;
        }
    }
    return null;
}

export function formatHealthError(detail: unknown): string {
    const raw = String(detail || '').trim();
    const low = raw.toLowerCase();
    if (!raw) return t('hy.addon_health_no_response');
    if (low === 'not_running') return t('hy.addon_health_not_running');
    if (low === 'no_port_configured') return t('hy.addon_health_no_port');
    if (low.includes('connection refused') || low.includes('errno 61')) return t('hy.addon_health_connection_refused');
    if (low.includes('timed out') || low.includes('timeout')) return t('hy.addon_health_timeout');
    return raw;
}
