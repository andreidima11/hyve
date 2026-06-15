/** Lazy-loaded feature module cache (derived, planner, apps, …). */

import { showToast } from '../utils.js';
import { t } from '../lang/index.js';
import type { LazyModuleLoader, LazyModuleRecord } from '../types/app.js';

const _lazyModulePromises = new Map<string, Promise<LazyModuleRecord>>();

function _lazyModule(key: string, importer: LazyModuleLoader): Promise<LazyModuleRecord> {
    if (!_lazyModulePromises.has(key)) {
        _lazyModulePromises.set(key, importer());
    }
    return _lazyModulePromises.get(key)!;
}

function _lazyAction(moduleLoader: LazyModuleLoader, exportName: string) {
    return async (...args: unknown[]) => {
        try {
            const module = await moduleLoader();
            const action = module[exportName];
            if (typeof action !== 'function') {
                throw new Error(`Missing lazy export: ${exportName}`);
            }
            return await (action as (...a: unknown[]) => unknown)(...args);
        } catch (err) {
            console.warn(`${exportName} lazy load failed`, err);
            showToast(t('app.function_load_error'), 'error');
            return undefined;
        }
    };
}

/** Static import paths so Vite emits hashed chunks under /static/dist/chunks/. */
const _loadDerivedModule = () => _lazyModule('derived', () => import('../features_derived.js') as Promise<LazyModuleRecord>);
const _loadPlannerModule = () => _lazyModule('planner', () => import('../planner.js') as Promise<LazyModuleRecord>);
const _loadAppsModule = () => _lazyModule('apps', () => import('../features_apps.js') as Promise<LazyModuleRecord>);
const _loadScenesModule = () => _lazyModule('scenes', () => import('../features_scenes.js') as Promise<LazyModuleRecord>);
const _loadAreasModule = () => _lazyModule('areas', () => import('../features_areas.js') as Promise<LazyModuleRecord>);

export {
    _lazyAction,
    _loadDerivedModule,
    _loadPlannerModule,
    _loadAppsModule,
    _loadScenesModule,
    _loadAreasModule,
};
