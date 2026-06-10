/**
 * HyveviewRegistry — thin editor-facing facade over the bridge.
 */

/// <reference path="../types/global.d.ts" />

import * as HVBridge from '../bridge.js';
import { t } from '../../js/lang/index.js';
import type { HyveviewRegistryApi } from '../types/registry.js';
import type { HyveviewCardClass, HyveviewCardMeta } from '../types/card.js';

export const HyveviewRegistry: HyveviewRegistryApi = {
    define(type: string, ElementClass: HyveviewCardClass, meta: HyveviewCardMeta = {}) {
        if (HVBridge.isRegistered(type)) return;
        HVBridge.registerCard(type, ElementClass, { meta });
    },

    has(type: string) { return HVBridge.isRegistered(type); },

    get(type: string) {
        const spec = HVBridge.getCardSpec(type);
        if (!spec) return null;
        return { tag: spec.tagName, ElementClass: null, meta: spec.meta };
    },

    create(type: string) {
        const spec = HVBridge.getCardSpec(type);
        if (!spec) {
            const fallback = document.createElement('div');
            fallback.className = 'hv-card';
            fallback.innerHTML = `<div class="hv-card-body">${t('hyveview.unknown_card_type', { type })}</div>`;
            return fallback;
        }
        return document.createElement(spec.tagName);
    },

    list() {
        return HVBridge.listCards().map(({ type, meta }) => ({
            type,
            name: meta.name || type,
            description: meta.description || '',
            icon: meta.icon || '',
        }));
    },

    schema(type: string) {
        return HVBridge.getCardSpec(type)?.schema || null;
    },

    stub(type: string, entityId: string) {
        const fn = HVBridge.getCardSpec(type)?.getStubConfig;
        return typeof fn === 'function' ? fn(entityId) : {};
    },
};

window.HyveviewRegistry = HyveviewRegistry;
