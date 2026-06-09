import { registerCardPackage } from '../../core/card-package.js';
import { HyveviewGaugeCard } from './card.js';
import { ensureCardStylesheet } from '../../core/card-styles.js';

const SHARED = '/static/hyveview/cards/shared/shell.css';

export function register() {
  ensureCardStylesheet(SHARED);
  registerCardPackage({
    type: 'gauge',
    element: HyveviewGaugeCard,
    styles: [],
    shell: {
      articleClass: 'hyve-dashboard-card--gauge',
      clickable: false,
      trackUnavailable: true,
    },
  });
}
