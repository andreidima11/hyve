import type { ConfigFormElement } from '../types/features_config.js';
import { ACTIVE_STATES } from '../entity_constants.js';

export function errMsg(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

export function inputVal(el: Element | null | undefined): string {
    return String((el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)?.value ?? '');
}

export function intEl(id: string): ConfigFormElement | null {
    return document.getElementById(id) as ConfigFormElement | null;
}

export function isActiveState(state: string): boolean {
    return (ACTIVE_STATES as readonly string[]).includes(state);
}

export function integrationSlugCandidates(slug: string) {
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
            const el = intEl(id);
            if (el && el.type === 'checkbox') return el;
        }
    }
    return null;
}
