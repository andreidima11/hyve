/**
 * Register a Hyveview card as a self-contained package (JS + CSS + shell metadata).
 * Mirrors Home Assistant custom card layout: one folder, one manifest, co-located styles.
 */

import * as HVBridge from '../bridge.js';
import { ensureCardStylesheets } from './card-styles.js';

/**
 * @param {object} pkg
 * @param {string} pkg.type Card type id (fusion_solar, tile, …)
 * @param {typeof HTMLElement} pkg.element Custom element class
 * @param {string[]} [pkg.styles] Stylesheet URLs under /static or /custom_components
 * @param {object} [pkg.shell] Article wrapper hints for the dashboard grid
 * @param {object} [pkg.meta] Picker metadata override
 * @param {object} [pkg.schema] Editor schema override
 * @param {Function} [pkg.getStubConfig]
 * @param {boolean} [pkg.hidden]
 * @param {string} [pkg.tagName]
 */
export function registerCardPackage(pkg) {
  if (!pkg?.type || !pkg.element) {
    throw new Error('registerCardPackage: type and element required');
  }
  ensureCardStylesheets(pkg.styles || []);
  HVBridge.registerCard(pkg.type, pkg.element, {
    tagName: pkg.tagName,
    meta: pkg.meta,
    schema: pkg.schema,
    getStubConfig: pkg.getStubConfig,
    hidden: pkg.hidden,
    shell: pkg.shell || pkg.element.shell || null,
  });
}
