/**
 * Schema-driven "Add card" entry point (replaces legacy picker modal).
 */

import { openDashboardPanelCreator } from './panel_modal.js';
import type { DashboardAddPickerDeps } from '../types/dashboard.js';

let _deps: DashboardAddPickerDeps | null = null;

function deps(): DashboardAddPickerDeps {
    if (!_deps) throw new Error('Dashboard add picker not initialized');
    return _deps;
}

export function initDashboardAddPicker(depsIn: DashboardAddPickerDeps): void {
    _deps = depsIn;
}

export async function openDashboardAddPicker(): Promise<void> {
    const d = deps();
    if (!d.requireDashboardEditAccess()) return;
    d.closeDashboardMenu();
    await d.ensureHyveviewEntitySeed();
    const result = await d.hvOpenEditor({ mode: 'add' });
    if (!result) return;
    await d.saveDashboardWidgetFromEditor(result, { editingId: null, original: null });
}

export function closeDashboardAddPicker(): void {
    const modal = document.getElementById('dashboard-add-picker-modal');
    if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
}

export async function pickDashboardAddType(kind: string, _id: string): Promise<void> {
    closeDashboardAddPicker();
    if (kind === 'panel') {
        openDashboardPanelCreator();
        return;
    }
    return openDashboardAddPicker();
}
