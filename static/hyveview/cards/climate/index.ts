import { registerCardPackage } from '../../core/card-package.js';
import { HyveviewClimateCard } from './card.js';
import { ensureCardStylesheet } from '../../core/card-styles.js';

const SHARED = '/static/hyveview/cards/shared/shell.css';

export function register() {
  ensureCardStylesheet(SHARED);
  registerCardPackage({
    type: 'climate',
    element: HyveviewClimateCard,
    styles: [`/static/hyveview/cards/climate/styles.css`],
    shell: { kind: 'climate' },
  });
}
