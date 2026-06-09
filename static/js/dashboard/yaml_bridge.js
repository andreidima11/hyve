/**
 * Lazy singleton facade for the per-page YAML editor.
 */
import { createDashboardYamlEditor } from './yaml_editor.js';
let _deps = null;
let _editor = null;
function deps() {
    if (!_deps)
        throw new Error('Dashboard YAML bridge not initialized');
    return _deps;
}
export function initDashboardYamlBridge(depsIn) {
    _deps = depsIn;
}
function ensureYamlEditor() {
    if (_editor)
        return _editor;
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
export async function openDashboardYamlEditor() {
    const d = deps();
    if (!d.requireDashboardEditAccess())
        return;
    return ensureYamlEditor().openDashboardYamlEditor();
}
export function closeDashboardYamlEditor() {
    return ensureYamlEditor().closeDashboardYamlEditor();
}
export async function reloadDashboardYaml() {
    return ensureYamlEditor().reloadDashboardYaml();
}
export async function saveDashboardYaml() {
    return ensureYamlEditor().saveDashboardYaml();
}
