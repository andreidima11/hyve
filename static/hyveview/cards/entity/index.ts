import { registerCardPackage } from '../../core/card-package.js';
import { HyveviewEntityCard } from './card.js';
import { ensureCardStylesheet } from '../../core/card-styles.js';

const SHARED = '/static/hyveview/cards/shared/shell.css';

export function register() {
  ensureCardStylesheet(SHARED);
  registerCardPackage({
    type: 'entity',
    element: HyveviewEntityCard,
    styles: [],
    meta: HyveviewEntityCard.meta,
    schema: HyveviewEntityCard.schema,
    getStubConfig: HyveviewEntityCard.getStubConfig,
    shell: {
      articleClass: 'hyve-dashboard-card',
      clickable: 'tile',
    },
  });
}
