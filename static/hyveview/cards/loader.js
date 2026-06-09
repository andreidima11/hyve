/**
 * Load bundled Hyveview card packages (one folder per card) and optional
 * community drop-ins from custom_components/cards/.
 */

import { register as registerLabel } from './label/index.js';
import { register as registerSensor } from './sensor/index.js';
import { register as registerTile } from './tile/index.js';
import { register as registerLight } from './light/index.js';
import { register as registerGauge } from './gauge/index.js';
import { register as registerLock } from './lock/index.js';
import { register as registerWeather } from './weather/index.js';
import { register as registerWeatherRich } from './weather_rich/index.js';
import { register as registerClimate } from './climate/index.js';
import { register as registerCamera } from './camera/index.js';
import { register as registerPicture } from './picture/index.js';
import { register as registerVacuum } from './vacuum/index.js';
import { register as registerFusionSolar } from './fusion_solar/index.js';
import { ensureCardStylesheet } from '../core/card-styles.js';

const SHARED_SHELL = '/static/hyveview/cards/shared/shell.css';

const _BUNDLED = [
  registerLabel,
  registerSensor,
  registerTile,
  registerLight,
  registerGauge,
  registerLock,
  registerWeather,
  registerWeatherRich,
  registerClimate,
  registerCamera,
  registerPicture,
  registerVacuum,
  registerFusionSolar,
];

let _bundledLoaded = false;
let _customPromise = null;

/** Register all bundled card packages (sync — safe before first dashboard render). */
export function loadBundledCardPackages() {
  if (_bundledLoaded) return;
  _bundledLoaded = true;
  ensureCardStylesheet(SHARED_SHELL);
  _BUNDLED.forEach((fn) => fn());
}

/**
 * Fetch and register community card packages. Non-fatal if the API is unavailable.
 * @returns {Promise<void>}
 */
export async function loadCustomCardPackages() {
  if (_customPromise) return _customPromise;
  _customPromise = (async () => {
    let res;
    try {
      res = await fetch('/api/dashboard/card-packages', { credentials: 'same-origin' });
    } catch (_) {
      return;
    }
    if (!res?.ok) return;
    let data;
    try {
      data = await res.json();
    } catch (_) {
      return;
    }
    const packages = Array.isArray(data?.custom) ? data.custom : [];
    for (const pkg of packages) {
      const entry = String(pkg?.entry || '').trim();
      if (!entry) continue;
      try {
        const mod = await import(entry);
        if (typeof mod.register === 'function') mod.register();
      } catch (err) {
        console.warn('[hyveview] custom card load failed:', pkg?.id || entry, err);
      }
    }
  })();
  return _customPromise;
}

/** Bundled + custom (await custom before editor/picker if needed). */
export async function loadAllCardPackages() {
  loadBundledCardPackages();
  await loadCustomCardPackages();
}
