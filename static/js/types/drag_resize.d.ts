/** Dashboard drag, resize, and Sortable state shapes. */

import type { ApiCallOptions } from '../api.js';
import type {
    DashboardCache,
    DashboardPanel,
    DashboardWidget,
    DashboardWidgetSpan,
} from './dashboard.js';

export interface DashboardDragResizeDeps {
    getCache: () => DashboardCache;
    getCurrentPageId: () => string;
    getEditMode: () => boolean;
    findWidget: (id: string) => DashboardWidget | null;
    widgetSpan: (widget: DashboardWidget) => DashboardWidgetSpan;
    panelColSpan: (panel: DashboardPanel) => number;
    isStandalonePanel: (panel: DashboardPanel) => boolean;
    ensureStandalonePanelLocal: () => DashboardPanel;
    renderDashboard: () => void;
    loadDashboard: () => Promise<void>;
    readDashboardSectionFallback: () => Promise<Record<string, unknown>>;
    writeDashboardSectionFallback: (section: Record<string, unknown>) => Promise<void>;
    apiCall: (url: string, options?: ApiCallOptions) => Promise<Response>;
    t: (key: string, params?: Record<string, unknown>) => string;
    showToast: (message: string, type?: string) => void;
}

export interface DashboardGridGeometry {
    rect: DOMRect;
    colCount: number;
    colGap: number;
    rowGap: number;
    colWidth: number;
    rowHeight: number;
    padLeft: number;
    padTop: number;
}

export interface DashboardGridCell {
    col: number;
    visualCol: number;
    row: number;
}

export interface DashboardLayoutRect {
    id?: string;
    col: number;
    row: number;
    colSpan: number;
    rowSpan: number;
    itemKind?: string;
    itemId?: string;
}

export interface DashboardPanelSpan {
    col: number;
    row: number;
    colStart: number | null;
    rowStart: number | null;
}

export interface DashboardRootLayoutItem {
    kind: 'panel' | 'widget';
    id: string;
    key: string;
    raw: DashboardPanel | DashboardWidget;
}

export interface DashboardSortableState {
    widgetId: string;
    widget: DashboardWidget;
    card: HTMLElement;
    ghost: HTMLElement;
    span: DashboardWidgetSpan;
    sourceGrid: HTMLElement;
    sourcePanelId: string | null;
    targetGrid: HTMLElement;
    targetPanelId: string | null;
    targetCol: number;
    targetRow: number;
    startCol: number;
    startRow: number;
    pointerOffsetX: number;
    pointerOffsetY: number;
    moved: boolean;
}

export interface DashboardMoveState {
    widgetId: string;
    widget: DashboardWidget;
    card: HTMLElement;
    clone: HTMLElement;
    ghost: HTMLElement;
    span: DashboardWidgetSpan;
    sourceGrid: HTMLElement;
    sourcePanelId: string | null;
    targetGrid: HTMLElement;
    targetPanelId: string | null;
    targetCol: number;
    targetRow: number;
    startCol: number;
    startRow: number;
    pointerOffsetX: number;
    pointerOffsetY: number;
    cloneBaseLeft: number;
    cloneBaseTop: number;
    nextCloneX: number;
    nextCloneY: number;
    cloneFrame: number;
    pointerId: number;
    moved: boolean;
}

export interface DashboardPanelDragState {
    panelId: string;
    panel: DashboardPanel;
    sourceEl: HTMLElement;
    stack: HTMLElement;
    clone: HTMLElement;
    ghost: HTMLElement | null;
    singleColumn: boolean;
    span: DashboardPanelSpan;
    fromIndex: number;
    targetIndex: number;
    targetCol: number;
    targetRow: number;
    startCol: number;
    startRow: number;
    sourceHeight: number;
    dropBefore: HTMLElement | null;
    pointerId: number;
    pointerOffsetX: number;
    pointerOffsetY: number;
    cloneBaseLeft: number;
    cloneBaseTop: number;
    nextCloneX: number;
    nextCloneY: number;
    cloneFrame: number;
    moved: boolean;
    finalOrder?: string[];
}

export interface DashboardResizeState {
    widgetId: string;
    card: HTMLElement;
    tooltip: HTMLElement | null;
    startX: number;
    startY: number;
    colUnit: number;
    rowUnit: number;
    startCol: number;
    startRow: number;
    col: number;
    row: number;
    colStart: number | null;
    rowStart: number | null;
    maxCols: number;
    maxRows: number;
    lockCol: boolean;
    lockRow: boolean;
    pointerId: number;
}

export interface DashboardPanelDelay {
    cleanup: () => void;
    timer: ReturnType<typeof setTimeout>;
}

export interface SortableEvent {
    item: HTMLElement;
    from?: HTMLElement;
    originalEvent?: Event;
}

export interface DashboardSwapCandidate {
    widget: DashboardWidget;
    rect: DashboardLayoutRect;
    area: number;
}

export interface DashboardRootSwapCandidate {
    item: DashboardRootLayoutItem;
    rect: DashboardLayoutRect;
    area: number;
}

export interface DashboardPanelDropBest {
    panel: Element;
    index: number;
    rect: DOMRect;
    centerX: number;
    centerY: number;
    dist: number;
}

export type DashboardSpanInput = DashboardWidgetSpan | { col: number; row: number };

export type DashboardCardPosition = DashboardGridCell;

export type DashboardDragRect = DashboardLayoutRect;

export interface DashboardPanelLayoutItem {
    el: HTMLElement;
    panel: DashboardPanel;
    id: string | null;
    colSpan: number;
    rowSpan: number;
    index?: number;
    anchorCol?: number | null;
    anchorRow?: number | null;
}

export type DashboardTouchHoldDelay = DashboardPanelDelay;

export interface SortableInstance {
    destroy?: () => void;
}

export interface SortableOptions extends Record<string, unknown> {
    group?: { name: string; pull: boolean; put: boolean };
    draggable?: string;
    onStart?: (evt: SortableEvent) => void;
    onMove?: (evt: SortableEvent) => boolean | void;
    onEnd?: (evt: SortableEvent) => void | Promise<void>;
}

export interface SortableConstructor {
    new (el: HTMLElement, options?: SortableOptions): SortableInstance;
}
