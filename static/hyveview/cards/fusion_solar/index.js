import { registerCardPackage } from '../../core/card-package.js';
import { HyveviewFusionSolarCard } from './card.js';
import { ensureCardStylesheet } from '../../core/card-styles.js';

const SHARED = '/static/hyveview/cards/shared/shell.css';

export function register() {
  ensureCardStylesheet(SHARED);
  registerCardPackage({
    type: 'fusion_solar',
    element: HyveviewFusionSolarCard,
    styles: [`/static/hyveview/cards/fusion_solar/styles.css`],
    shell: {
      articleClass: 'hyve-dashboard-card--fusion-solar',
      clickable: false,
      spanCompact: { maxRow: 1, class: 'hyve-dashboard-card--fusion-solar-compact' },
    },
  });
}
