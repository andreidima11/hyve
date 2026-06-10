/**
 * Register a Hyveview card as a self-contained package (JS + CSS + shell metadata).
 */

import * as HVBridge from '../bridge.js';
import { ensureCardStylesheets } from './card-styles.js';
import type { HyveviewCardPackage } from '../types/card.js';

export function registerCardPackage(pkg: HyveviewCardPackage): void {
    if (!pkg?.type || !pkg.element) {
        throw new Error('registerCardPackage: type and element required');
    }
    ensureCardStylesheets(pkg.styles || []);
    HVBridge.registerCard(pkg.type, pkg.element, {
        tagName: pkg.tagName,
        meta: pkg.meta,
        schema: pkg.schema,
        getStubConfig: pkg.getStubConfig,
        widgetEntityIds: pkg.widgetEntityIds,
        hidden: pkg.hidden,
        shell: pkg.shell || pkg.element.shell || null,
    });
}
