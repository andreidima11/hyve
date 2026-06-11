/**
 * Apps page — shared mutable state.
 */
import type { AddonCatalogEntry } from '../types/features_apps.js';

export const appsState = {
    currentLogSlug: null as string | null,
    pollTimer: null as ReturnType<typeof setInterval> | null,
    openSlug: null as string | null,
    addonUiSlug: null as string | null,
    addonsCache: [] as AddonCatalogEntry[],
};

