/**
 * Lazy singleton facade for the per-page YAML editor.
 */

import { createDashboardYamlEditor } from './yaml_editor.js';
import type { DashboardYamlBridgeDeps } from '../types/dashboard.js';

let _deps: DashboardYamlBridgeDeps | null = null;
let _editor: ReturnType<typeof createDashboardYamlEditor> | null = null;

function deps(): DashboardYamlBridgeDeps {
    if (!_deps) throw new Error('Dashboard YAML bridge not initialized');
    return _deps;
}

export function initDashboardYamlBridge(depsIn: DashboardYamlBridgeDeps): void {
    _deps = depsIn;
}

function ensureYamlEditor(): ReturnType<typeof createDashboardYamlEditor> {
    if (_editor) return _editor;
    const d = deps();
    _editor = createDashboardYamlEditor({
        apiCall: d.apiCall,
        t: d.t,
        showToast: d.showToast,
        getActivePageId: d.getActivePageId,
        getActivePageName: d.getActivePageName,
        reloadDashboard: d.loadDashboard,
    });
    return _editor;
}

export async function openDashboardYamlEditor(): Promise<void> {
    const d = deps();
    if (!d.requireDashboardEditAccess()) return;
    return ensureYamlEditor().openDashboardYamlEditor();
}

export function closeDashboardYamlEditor(): void {
    return ensureYamlEditor().closeDashboardYamlEditor();
}

export async function reloadDashboardYaml(): Promise<void> {
    return ensureYamlEditor().reloadDashboardYaml();
}

export async function saveDashboardYaml(): Promise<void> {
    return ensureYamlEditor().saveDashboardYaml();
}
