/**
 * Hyveview card registration for the dashboard grid.
 * Side-effect module: call once from dashboard.js after imports resolve.
 */

import * as HVBridge from '/static/hyveview/bridge.js';
import { setHost as HVSetHost } from '/static/hyveview/host.js';
import { loadBundledCardPackages, loadCustomCardPackages } from '/static/hyveview/cards/loader.js';
import { openEditor as hvOpenEditor } from '/static/hyveview/editor/modal.js';

export { HVBridge, HVSetHost, hvOpenEditor };

export function registerHyveviewDashboardCards(widgetEntityIdsResolver) {
  loadBundledCardPackages();
  loadCustomCardPackages().catch(() => {});

  if (typeof widgetEntityIdsResolver === 'function') {
    HVBridge.setWidgetEntityIdsResolver(widgetEntityIdsResolver);
  }

  window.HVBridge = HVBridge;
  window.openHyveviewEditor = hvOpenEditor;
}
