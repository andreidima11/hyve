/** Hyveview in-memory entity store (live feed via dashboard bridge). */

import type { HyveviewEntityState } from '../types/card.js';
import type {
    EntityChangeCallback,
    EntityStateCallback,
    HyveviewStoreApi,
    UnsubscribeFn,
} from '../types/store.js';

export function applySnapshot(items: HyveviewEntityState[] | null | undefined): void;
export function applyDiff(items: HyveviewEntityState[] | null | undefined): void;
export function applyRemoved(ids: string[] | null | undefined): void;
export function getState(entityId: string): HyveviewEntityState | null;
export function subscribe(entityId: string, cb: EntityStateCallback): UnsubscribeFn;
export function subscribeAll(cb: EntityChangeCallback): UnsubscribeFn;
export function listEntities(): HyveviewEntityState[];
export function seedEntities(items: HyveviewEntityState[] | null | undefined): void;
export const HyveviewStore: HyveviewStoreApi;
