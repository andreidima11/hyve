/** Main shell UI (tabs, sidebar, config sections, log stream). */

export interface SwitchTabOptions {
    syncHash?: boolean;
}

export interface StandaloneActivePanel {
    panel: HTMLElement;
    parent: HTMLElement | null;
}

export type SidebarGestureMode = 'open' | 'close' | null;
