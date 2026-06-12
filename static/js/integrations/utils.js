import { ACTIVE_STATES } from '../entity_constants.js';
import { t, translateApiDetail } from '../lang/index.js';
/** Resolve FastAPI ``error_detail`` payloads or plain API error bodies to text. */
export function integrationApiError(detail, fallbackKey = 'integrations.action_failed') {
    return translateApiDetail(detail) || t(fallbackKey);
}
export function errMsg(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}
export function inputVal(el) {
    return String(el?.value ?? '');
}
export function intEl(id) {
    return document.getElementById(id);
}
export function isActiveState(state) {
    return ACTIVE_STATES.includes(state);
}
export function integrationSlugCandidates(slug) {
    const raw = String(slug || '').trim();
    if (!raw)
        return [];
    const dash = raw.replace(/_/g, '-');
    const under = raw.replace(/-/g, '_');
    return Array.from(new Set([raw, dash, under]));
}
export function findIntegrationCheckbox(slug) {
    for (const candidate of integrationSlugCandidates(slug)) {
        const ids = [`${candidate}_enabled`, `integrations-${candidate}-enabled`, `${candidate}Enabled`];
        for (const id of ids) {
            const el = intEl(id);
            if (el && el.type === 'checkbox')
                return el;
        }
    }
    return null;
}
