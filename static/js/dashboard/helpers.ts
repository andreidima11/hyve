/** Small dashboard helpers shared across modules. */

import { t, translateApiDetail } from '../lang/index.js';

export function dashApiError(detail: unknown, fallbackKey: string): string {
    return translateApiDetail(detail) || t(fallbackKey);
}

export function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function stateOn(state: unknown): boolean {
    const value = String(state || '').toLowerCase();
    return ['on', 'open', 'playing', 'unlocked', 'heat', 'cool', 'home'].includes(value);
}
