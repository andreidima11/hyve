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

if (typeof window !== 'undefined' && window.__hyveCameraTimer) {
    clearInterval(window.__hyveCameraTimer);
    window.__hyveCameraTimer = null;
}

let _registered = false;

export function registerDashboardCards() {
    if (_registered) return;
    _registered = true;

    registerCard({ type: 'label', render: renderLabelCard });
    registerCard({ type: 'light', render: renderLightCard });
    registerCard({ type: 'sensor', render: renderSensorCard });
    registerCard({ type: 'gauge', render: renderGaugeCard });
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

    registerCard({ type: 'tile', render: tileInteractive });
    registerCard({ type: 'button', render: tileInteractive });
    registerCard({ type: 'switch', render: tileInteractive });
    registerCard({ type: 'scene', render: tileInteractive });
    registerCard({ type: 'info', render: tileStatic });
}

export { cameraWidgetEntities } from './renderers.js';
