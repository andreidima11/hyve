/**
 * Wire all dashboard submodules — called once from dashboard.js after card registration.
 */

import { wireDashboardBootstrap } from './wire/bootstrap.js';
import { wireDashboardRender } from './wire/render.js';
import { wireDashboardPages } from './wire/pages.js';
import { wireDashboardEvents } from './wire/events.js';
import { wireDashboardWidgets } from './wire/widgets.js';

export function wireDashboardModules() {
    wireDashboardBootstrap();
    wireDashboardRender();
    wireDashboardPages();
    wireDashboardWidgets();
    wireDashboardEvents();
}
