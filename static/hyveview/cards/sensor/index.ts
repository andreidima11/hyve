import { registerCardPackage } from '../../core/card-package.js';
import { HyveviewSensorCard } from './card.js';
import { ensureCardStylesheet } from '../../core/card-styles.js';

const SHARED = '/static/hyveview/cards/shared/shell.css';

export function register() {
  ensureCardStylesheet(SHARED);
  registerCardPackage({
    type: 'sensor',
    hidden: true,
    element: HyveviewSensorCard,
    styles: [`/static/hyveview/cards/sensor/styles.css`],
    shell: {
      articleClass: 'hyve-dashboard-card--sensor',
      clickable: false,
      trackUnavailable: true,
    },
  });
}
