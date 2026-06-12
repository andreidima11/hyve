/** Entity control renderers (integration entity cards/modals). */

import type { HyveEntity } from './entity.js';

export type EntityRendererFn = (entity: HyveEntity, slug: string) => string;

export interface EntityRegistryUpdateContext {
    entity: HyveEntity;
    oldEntityId: string;
    newEntityId: string;
    uniqueId: string;
    entry: unknown;
}

export interface EntityRegistryEditorOptions {
    onUpdated?: (ctx: EntityRegistryUpdateContext) => void;
    toast?: boolean | 'false';
}

export interface EntityFriendlyNameUpdateContext {
    entity: HyveEntity;
    name: string;
}

export interface EntityFriendlyNameEditorOptions {
    onUpdated?: (ctx: EntityFriendlyNameUpdateContext) => void;
    toast?: boolean | 'false';
}
