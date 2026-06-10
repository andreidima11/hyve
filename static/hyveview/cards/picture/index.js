import { registerCardPackage } from '../../core/card-package.js';
import { HyveviewPictureCard } from './card.js';
import { ensureCardStylesheet } from '../../core/card-styles.js';
const SHARED = '/static/hyveview/cards/shared/shell.css';
export function register() {
    ensureCardStylesheet(SHARED);
    registerCardPackage({
        type: 'picture',
        element: HyveviewPictureCard,
        styles: [],
        shell: { kind: 'picture' },
    });
}
