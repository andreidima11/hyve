/**
 * Register bundled dashboard card renderers with card_registry.js.
 */

import { registerCard } from '../card_registry.js';
import { renderClimateCard } from '../climate.js';
import {
    renderCameraCard,
    renderHyveviewShell,
    renderLabelCard,
    renderPictureCard,
} from './renderers.js';
import {
    updateGaugeCard,
    updateLabelCard,
    updateSensorCard,
    updateTileCard,
} from './updates.js';
import type { DashboardWidget } from '../../types/dashboard.js';
import type { CardRenderCtx } from './renderers.js';

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
] as const;

const _SHELL_UPDATES: Partial<Record<(typeof _SHELL_TYPES)[number], typeof updateSensorCard>> = {
    sensor: updateSensorCard,
    gauge: updateGaugeCard,
};

export function registerDashboardCards(): void {
    if (_registered) return;
    _registered = true;

    registerCard({ type: 'label', render: (w, ctx) => renderLabelCard(w, ctx as CardRenderCtx), update: updateLabelCard });
    registerCard({ type: 'climate', render: (widget: DashboardWidget) => renderClimateCard(widget) });
    registerCard({ type: 'camera', render: (w, ctx) => renderCameraCard(w, ctx as CardRenderCtx) });
    registerCard({ type: 'picture', render: (w, ctx) => renderPictureCard(w, ctx as CardRenderCtx) });

    _SHELL_TYPES.forEach((type) => {
        registerCard({
            type,
            render: (w, ctx) => renderHyveviewShell(w, ctx as CardRenderCtx),
            update: _SHELL_UPDATES[type] || undefined,
        });
    });

    const tileRender = (widget: DashboardWidget, ctx?: unknown) => renderHyveviewShell(widget, ctx as CardRenderCtx, { interactive: true });
    const infoRender = (widget: DashboardWidget, ctx?: unknown) => renderHyveviewShell(widget, ctx as CardRenderCtx, { interactive: false });

    registerCard({ type: 'tile', render: tileRender, update: updateTileCard });
    registerCard({ type: 'button', render: tileRender, update: updateTileCard });
    registerCard({ type: 'switch', render: tileRender, update: updateTileCard });
    registerCard({ type: 'scene', render: tileRender, update: updateTileCard });
    registerCard({ type: 'info', render: infoRender, update: updateTileCard });
}

export { cameraWidgetEntities } from './renderers.js';
