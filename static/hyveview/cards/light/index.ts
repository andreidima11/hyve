import { registerCardPackage } from '../../core/card-package.js';
import { HyveviewLightCard } from './card.js';
import { ensureCardStylesheet } from '../../core/card-styles.js';

const SHARED = '/static/hyveview/cards/shared/shell.css';

export function register() {
  ensureCardStylesheet(SHARED);
  registerCardPackage({
    type: 'light',
    hidden: true,
    element: HyveviewLightCard,
    styles: [`/static/hyveview/cards/light/styles.css`],
    shell: {
      articleClass: 'hyve-dashboard-card--light',
      clickable: 'controllable',
      editModeFlag: true,
      trackUnavailable: true,
    },
  });
}
