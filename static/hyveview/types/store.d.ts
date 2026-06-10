/** Hyveview entity store types. */

import type { HyveviewEntityState } from './card.js';

export type EntityStateCallback = (state: HyveviewEntityState | null) => void;
export type EntityChangeCallback = (entityId: string, state: HyveviewEntityState | null) => void;
export type UnsubscribeFn = () => void;

export interface HyveviewStoreApi {
    connect(): Promise<boolean>;
    getState(entityId: string): HyveviewEntityState | null;
    subscribe(entityId: string, cb: EntityStateCallback): UnsubscribeFn;
    subscribeAll(cb: EntityChangeCallback): UnsubscribeFn;
    listEntities(): HyveviewEntityState[];
    seedEntities(items: HyveviewEntityState[] | null | undefined): void;
}

export interface HyveviewWsMessage {
    type?: string;
    items?: HyveviewEntityState[];
    entity_ids?: string[];
}
