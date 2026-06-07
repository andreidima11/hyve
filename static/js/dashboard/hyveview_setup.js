/**
 * Hyveview card registration for the dashboard grid.
 * Side-effect module: call once from dashboard.js after imports resolve.
 */

// IMPORTANT: bare path — must match `hyveview/core/registry.js` import so the
// editor picker and dashboard grid share one card registry (no ?v= here).
import * as HVBridge from '/static/hyveview/bridge.js';
import { setHost as HVSetHost } from '/static/hyveview/host.js';
import { HyveviewLabelCard } from '/static/hyveview/cards/label.js';
import { HyveviewSensorCard } from '/static/hyveview/cards/sensor.js';
import { HyveviewTileCard } from '/static/hyveview/cards/tile.js';
import { HyveviewLightCard } from '/static/hyveview/cards/light.js';
import { HyveviewGaugeCard } from '/static/hyveview/cards/gauge.js';
import { HyveviewLockCard } from '/static/hyveview/cards/lock.js';
import { HyveviewWeatherSimpleCard } from '/static/hyveview/cards/weather_simple.js';
import { HyveviewWeatherRichCard } from '/static/hyveview/cards/weather_rich.js';
import { HyveviewClimateCard } from '/static/hyveview/cards/climate.js';
import { HyveviewCameraCard } from '/static/hyveview/cards/camera.js';
import { HyveviewPictureCard } from '/static/hyveview/cards/picture.js';
import { HyveviewVacuumCard } from '/static/hyveview/cards/vacuum.js';
import { HyveviewFusionSolarCard } from '/static/hyveview/cards/fusion_solar.js';
import { openEditor as hvOpenEditor } from '/static/hyveview/editor/modal.js';

export { HVBridge, HVSetHost, hvOpenEditor };

export function registerHyveviewDashboardCards(widgetEntityIdsResolver) {
    HVBridge.registerCard('label', HyveviewLabelCard);
    HVBridge.registerCard('sensor', HyveviewSensorCard);
    HVBridge.registerCard('tile', HyveviewTileCard, {
        meta: { name: 'Tile', description: 'Generic clickable tile.', icon: '🔘' },
    });
    HVBridge.registerCard('button', HyveviewTileCard, {
        meta: { name: 'Button', description: 'Tap-to-trigger button for any entity.', icon: '🟢' },
        getStubConfig: (eid) => ({ entity_id: eid || '', title: '', icon: '', color: '', switch_style: false }),
    });
    HVBridge.registerCard('switch', HyveviewTileCard, {
        meta: { name: 'Switch', description: 'Toggle switch (on/off) with a slider thumb.', icon: '🎚️' },
        getStubConfig: (eid) => ({ entity_id: eid || '', title: '', icon: '', color: '', switch_style: true }),
    });
    HVBridge.registerCard('scene', HyveviewTileCard, {
        meta: { name: 'Scene', description: 'One-shot scene activator.', icon: '🎬' },
        getStubConfig: (eid) => ({ entity_id: eid || '', title: '', icon: '', color: '', switch_style: false }),
    });
    HVBridge.registerCard('info', HyveviewTileCard, {
        meta: { name: 'Info', description: 'Read-only info tile (no controls).', icon: 'ℹ️' },
        getStubConfig: (eid) => ({ entity_id: eid || '', title: '', icon: '', color: '', switch_style: false }),
    });
    HVBridge.registerCard('light', HyveviewLightCard);
    HVBridge.registerCard('gauge', HyveviewGaugeCard);
    HVBridge.registerCard('lock', HyveviewLockCard);
    HVBridge.registerCard('weather', HyveviewWeatherSimpleCard);
    HVBridge.registerCard('weather_rich', HyveviewWeatherRichCard);
    HVBridge.registerCard('climate', HyveviewClimateCard);
    HVBridge.registerCard('camera', HyveviewCameraCard);
    HVBridge.registerCard('picture', HyveviewPictureCard);
    HVBridge.registerCard('vacuum', HyveviewVacuumCard);
    HVBridge.registerCard('fusion_solar', HyveviewFusionSolarCard);

    if (typeof widgetEntityIdsResolver === 'function') {
        HVBridge.setWidgetEntityIdsResolver(widgetEntityIdsResolver);
    }

    window.HVBridge = HVBridge;
    window.openHyveviewEditor = hvOpenEditor;
}
