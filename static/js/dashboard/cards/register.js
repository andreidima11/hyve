/**
 * Register bundled dashboard card renderers with card_registry.js.
 */

import { registerCard } from '../card_registry.js';
import { renderClimateCard } from '../climate.js';
import {
    renderCameraCard,
    renderFusionSolarCard,
    renderGaugeCard,
    renderLabelCard,
    renderLightCard,
    renderLockCard,
    renderPictureCard,
    renderSensorCard,
    renderTileCard,
    renderVacuumCard,
    renderWeatherRichCard,
    renderWeatherSimpleCard,
} from './renderers.js';
import {
    updateGaugeCard,
    updateLabelCard,
    updateSensorCard,
    updateTileCard,
} from './updates.js';

if (typeof window !== 'undefined' && window.__hyveCameraTimer) {
    clearInterval(window.__hyveCameraTimer);
    window.__hyveCameraTimer = null;
}

let _registered = false;

export function registerDashboardCards() {
    if (_registered) return;
    _registered = true;

    registerCard({ type: 'label', render: renderLabelCard, update: updateLabelCard });
    registerCard({ type: 'light', render: renderLightCard });
    registerCard({ type: 'sensor', render: renderSensorCard, update: updateSensorCard });
    registerCard({ type: 'gauge', render: renderGaugeCard, update: updateGaugeCard });
    registerCard({ type: 'lock', render: renderLockCard });
    registerCard({ type: 'vacuum', render: renderVacuumCard });
    registerCard({ type: 'weather', render: renderWeatherSimpleCard });
    registerCard({ type: 'weather_rich', render: renderWeatherRichCard });
    registerCard({ type: 'fusion_solar', render: renderFusionSolarCard });
    registerCard({ type: 'camera', render: renderCameraCard });
    registerCard({ type: 'picture', render: renderPictureCard });
    registerCard({ type: 'climate', render: (widget) => renderClimateCard(widget) });

    const tileInteractive = (widget, ctx) => renderTileCard(widget, ctx, { interactive: true });
    const tileStatic = (widget, ctx) => renderTileCard(widget, ctx, { interactive: false });

    registerCard({ type: 'tile', render: tileInteractive, update: updateTileCard });
    registerCard({ type: 'button', render: tileInteractive, update: updateTileCard });
    registerCard({ type: 'switch', render: tileInteractive, update: updateTileCard });
    registerCard({ type: 'scene', render: tileInteractive, update: updateTileCard });
    registerCard({ type: 'info', render: tileStatic, update: updateTileCard });
}

export { cameraWidgetEntities } from './renderers.js';
