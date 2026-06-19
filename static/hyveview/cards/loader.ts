/**
 * Load bundled Hyveview card packages and optional community drop-ins.
 */

import { register as registerEntity } from './entity/index.js';
import { register as registerLabel } from './label/index.js';
import { register as registerSensor } from './sensor/index.js';
import { register as registerTile } from './tile/index.js';
import { register as registerLight } from './light/index.js';
import { register as registerGauge } from './gauge/index.js';
import { register as registerNumber } from './number/index.js';
import { register as registerSelect } from './select/index.js';
import { register as registerLock } from './lock/index.js';
import { register as registerWeather } from './weather/index.js';
import { register as registerWeatherRich } from './weather_rich/index.js';
import { register as registerClimate } from './climate/index.js';
import { register as registerCamera } from './camera/index.js';
import { register as registerPicture } from './picture/index.js';
import { register as registerVacuum } from './vacuum/index.js';
import { register as registerLawnMower } from './lawn_mower/index.js';
import { register as registerFusionSolar } from './fusion_solar/index.js';
import { apiCall } from '../../js/api.js';
import { ensureCardStylesheet } from '../core/card-styles.js';

const SHARED_SHELL = '/static/hyveview/cards/shared/shell.css';

type CardRegisterFn = () => void;

const _BUNDLED: CardRegisterFn[] = [
    registerEntity,
    registerLabel,
    registerSensor,
    registerTile,
    registerLight,
    registerGauge,
    registerNumber,
    registerSelect,
    registerLock,
    registerWeather,
    registerWeatherRich,
    registerClimate,
    registerCamera,
    registerPicture,
    registerVacuum,
    registerLawnMower,
    registerFusionSolar,
];

let _bundledLoaded = false;
let _customPromise: Promise<void> | null = null;

export function loadBundledCardPackages(): void {
    if (_bundledLoaded) return;
    _bundledLoaded = true;
    ensureCardStylesheet(SHARED_SHELL);
    _BUNDLED.forEach((fn) => fn());
}

export async function loadCustomCardPackages(): Promise<void> {
    if (_customPromise) return _customPromise;
    _customPromise = (async () => {
        let res: Response;
        try {
            res = await apiCall('/api/dashboard/card-packages');
        } catch {
            return;
        }
        if (!res?.ok) return;
        let data: { custom?: Array<{ entry?: string; id?: string }> };
        try {
            data = await res.json() as { custom?: Array<{ entry?: string; id?: string }> };
        } catch {
            return;
        }
        const packages = Array.isArray(data?.custom) ? data.custom : [];
        for (const pkg of packages) {
            const entry = String(pkg?.entry || '').trim();
            if (!entry) continue;
            try {
                const mod = await import(entry) as { register?: () => void };
                if (typeof mod.register === 'function') mod.register();
            } catch (err) {
                console.warn('[hyveview] custom card load failed:', pkg?.id || entry, err);
            }
        }
    })();
    return _customPromise;
}

export async function loadAllCardPackages(): Promise<void> {
    loadBundledCardPackages();
    await loadCustomCardPackages();
}
