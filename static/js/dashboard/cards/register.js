/**
 * Register bundled dashboard card renderers with card_registry.js.
 */
import { registerCard } from '../card_registry.js';
import { renderClimateCard } from '../climate.js';
import { renderCameraCard, renderHyveviewShell, renderLabelCard, renderPictureCard, } from './renderers.js';
import { updateGaugeCard, updateLabelCard, updateSensorCard, updateTileCard, } from './updates.js';
if (typeof window !== 'undefined' && window.__hyveCameraTimer) {
    clearInterval(window.__hyveCameraTimer);
    window.__hyveCameraTimer = null;
}
let _registered = false;
const _SHELL_TYPES = [
    'light',
    'sensor',
    'gauge',
    'lock',
    'vacuum',
    'weather',
    'weather_rich',
    'fusion_solar',
];
const _SHELL_UPDATES = {
    sensor: updateSensorCard,
    gauge: updateGaugeCard,
};
export function registerDashboardCards() {
    if (_registered)
        return;
    _registered = true;
    registerCard({ type: 'label', render: (w, ctx) => renderLabelCard(w, ctx), update: updateLabelCard });
    registerCard({ type: 'climate', render: (widget) => renderClimateCard(widget) });
    registerCard({ type: 'camera', render: (w, ctx) => renderCameraCard(w, ctx) });
    registerCard({ type: 'picture', render: (w, ctx) => renderPictureCard(w, ctx) });
    _SHELL_TYPES.forEach((type) => {
        registerCard({
            type,
            render: (w, ctx) => renderHyveviewShell(w, ctx),
            update: _SHELL_UPDATES[type] || undefined,
        });
    });
    const tileRender = (widget, ctx) => renderHyveviewShell(widget, ctx, { interactive: true });
    const infoRender = (widget, ctx) => renderHyveviewShell(widget, ctx, { interactive: false });
    registerCard({ type: 'tile', render: tileRender, update: updateTileCard });
    registerCard({ type: 'button', render: tileRender, update: updateTileCard });
    registerCard({ type: 'switch', render: tileRender, update: updateTileCard });
    registerCard({ type: 'scene', render: tileRender, update: updateTileCard });
    registerCard({ type: 'info', render: infoRender, update: updateTileCard });
}
export { cameraWidgetEntities } from './renderers.js';
