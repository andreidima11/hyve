/** Hyveview entity store (runtime: store.js). */

import type { HyveviewStoreApi } from '../types/store.js';
import type { HyveviewEntityState } from '../types/card.js';
import type { EntityChangeCallback, EntityStateCallback, UnsubscribeFn } from '../types/store.js';

export function connect(): Promise<boolean>;
export function getState(entityId: string): HyveviewEntityState | null;
export function subscribe(entityId: string, cb: EntityStateCallback): UnsubscribeFn;
export function subscribeAll(cb: EntityChangeCallback): UnsubscribeFn;
export function listEntities(): HyveviewEntityState[];
export function seedEntities(items: HyveviewEntityState[] | null | undefined): void;

export const HyveviewStore: HyveviewStoreApi;
