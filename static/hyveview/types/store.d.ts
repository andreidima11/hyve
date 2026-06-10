/** Hyveview entity store types. */

import type { HyveviewEntityState } from './card.js';

export type EntityStateCallback = (state: HyveviewEntityState | null) => void;
export type EntityChangeCallback = (entityId: string, state: HyveviewEntityState | null) => void;
export type UnsubscribeFn = () => void;

export interface HyveviewStoreApi {
    getState(entityId: string): HyveviewEntityState | null;
    subscribe(entityId: string, cb: EntityStateCallback): UnsubscribeFn;
    subscribeAll(cb: EntityChangeCallback): UnsubscribeFn;
    listEntities(): HyveviewEntityState[];
    seedEntities(items: HyveviewEntityState[] | null | undefined): void;
    applySnapshot(items: HyveviewEntityState[] | null | undefined): void;
    applyDiff(items: HyveviewEntityState[] | null | undefined): void;
    applyRemoved(ids: string[] | null | undefined): void;
}
