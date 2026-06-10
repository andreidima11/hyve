/** Hyveview ambient globals. */

import type { HyveviewStoreApi } from './store.js';

export {};

declare global {
    interface Window {
        __cacheBust?: string;
        HyveviewStore?: HyveviewStoreApi;
        HyveviewRegistry?: import('./registry.js').HyveviewRegistryApi;
    }
}
