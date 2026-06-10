/** Hyveview registry facade types. */

import type {
    HyveviewCardClass,
    HyveviewCardMeta,
    HyveviewCardSchema,
} from './card.js';

export interface HyveviewRegistryCardInfo {
    type: string;
    name: string;
    description: string;
    icon: string;
}

export interface HyveviewRegistryGetResult {
    tag: string;
    ElementClass: HyveviewCardClass | null;
    meta: HyveviewCardMeta;
}

export interface HyveviewRegistryApi {
    define(type: string, ElementClass: HyveviewCardClass, meta?: HyveviewCardMeta): void;
    has(type: string): boolean;
    get(type: string): HyveviewRegistryGetResult | null;
    create(type: string): HTMLElement;
    list(): HyveviewRegistryCardInfo[];
    schema(type: string): HyveviewCardSchema | null;
    stub(type: string, entityId: string): Record<string, unknown>;
}
