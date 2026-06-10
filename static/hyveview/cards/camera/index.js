import { registerCardPackage } from '../../core/card-package.js';
import { HyveviewCameraCard } from './card.js';
import { ensureCardStylesheet } from '../../core/card-styles.js';
const SHARED = '/static/hyveview/cards/shared/shell.css';
export function register() {
    ensureCardStylesheet(SHARED);
    registerCardPackage({
        type: 'camera',
        element: HyveviewCameraCard,
        styles: [`/static/hyveview/cards/camera/styles.css`],
        shell: { kind: 'camera' },
    });
}
