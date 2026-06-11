/** Dashboard live WS + optimistic control shapes. */

import type { ApiCallOptions } from '../api.js';

export interface DashboardLiveWsDeps {
    apiCall: (url: string, options?: ApiCallOptions) => Promise<Response>;
    dashDebug: (tag: string, info?: unknown) => void;
    DASH_DEBUG_ENABLED: boolean;
    onLiveItems: (items: unknown[], isSnapshot: boolean) => void;
    onLiveRemoved: (entityIds: string[]) => void;
}

export interface PendingControlEntry {
    widgetId?: string;
    entityId?: string;
    nextState?: string | number | boolean | null;
    startedAt?: number;
    [key: string]: unknown;
}

export interface OptimisticGuardEntry {
    state?: string | number | boolean | null;
    until?: number;
}

export interface CameraStreamElement extends Element {
    pauseStream?: () => void;
    resumeStream?: () => void;
}

export interface DashboardPrefs {
    layout_mode: string;
    show_unavailable: boolean;
    filter_mode: string;
}

export interface DashboardMeta {
    title: string;
    subtitle: string;
}

export interface DashActionContext {
    event: Event;
    el: Element;
    widgetId: string;
    panelId: string;
    pageId: string;
    entityId: string;
    mode: string;
    delta: number;
    climateMode: string;
    slideIndex: number;
    action: string;
    field: string;
}

export type DashboardEventHandlers = Record<
    string,
    (ctx: DashActionContext) => void | Promise<void>
>;

export interface DashboardWidgetActionDeps {
    apiCall: (url: string, options?: import('../api.js').ApiCallOptions) => Promise<Response>;
    t: (key: string, params?: Record<string, unknown>) => string;
    showToast: (message: string, type?: string) => void;
    findWidget: (id: string) => Record<string, unknown> | null;
    tryFastPathForEntities: (ids: string[]) => boolean;
    renderDashboard: () => void;
}

export interface DashboardEditingStateDeps {
    abortDashboardPageNavigation: () => void;
    setDashboardRefreshIndicator: (on: boolean) => void;
    setEditMode: (on: boolean) => void;
    setCurrentEditorId: (id: string | null) => void;
    closeDashboardMenu: () => void;
    closeDashboardAddModal: () => void;
    closeDashboardPageModal: () => void;
    closeDashboardWidgetEditor: () => void;
    renderDashboard: () => void;
}

export interface DashboardPullRefreshDeps {
    loadDashboard: () => Promise<void>;
    selectDashboardPage: (pageId: string) => Promise<void>;
    setRefreshIndicator: (on: boolean) => void;
    showToast: (message: string, type?: string) => void;
    t: (key: string, params?: Record<string, unknown>) => string;
    getCurrentPageId: () => string;
    getEditMode: () => boolean;
}

export interface DashboardVisibilityCondition {
    condition?: string;
    type?: string;
    media?: string;
    value?: string;
    entity_id?: string;
    op?: string;
}

export interface DashboardVisibilityConfig {
    enabled?: boolean;
    logic?: string;
    conditions?: DashboardVisibilityCondition[];
}

export interface DashboardPanel {
    id?: string;
    title?: string;
    size?: string;
    icon?: string;
    pages?: unknown[];
    show_pagination?: boolean;
    widgets?: DashboardWidget[];
    kind?: string;
    visible?: boolean;
    visibility?: DashboardVisibilityConfig;
    background?: { color?: string; opacity?: number };
    [key: string]: unknown;
}

export interface DashboardWidget {
    id?: string;
    entity_id?: string;
    source?: string;
    current_state?: string | number | null;
    attributes?: Record<string, unknown>;
    entities?: DashboardWidget[];
    visible?: boolean;
    visibility?: DashboardVisibilityConfig;
    [key: string]: unknown;
}

export interface DashboardCache {
    widgets: DashboardWidget[];
    available_entities: import('./entity.js').HyveEntity[];
    preferences: DashboardPrefs;
    title: string;
    subtitle: string;
    pages: Array<Record<string, unknown>>;
    panels: DashboardPanel[];
    page_id: string | null;
    current_page_id: string | null;
    default_page_id?: string | null;
    icon: string;
    columns: number;
    cached_at?: number;
}

export interface DashboardVisibilityDeps {
    getEditMode: () => boolean;
    renderDashboard: () => void;
}

export interface DashboardContextDeps {
    getCache: () => DashboardCache;
    getCurrentPageId: () => string | null;
    getCurrentEditorId: () => string | null;
    apiCall: (url: string, options?: ApiCallOptions) => Promise<Response>;
}

export interface NotificationTimerHandle {
    stop?: () => void;
    setEnabled?: (enabled: boolean) => void;
}

export type ThinkingMode = 'auto' | 'think' | 'no_think';

export interface StartupStatusResponse {
    ready?: boolean;
    pending?: string[];
    pending_labels?: string[];
}

export interface DashboardWidgetLocateResult {
    container: DashboardWidget[];
    index: number;
    panel?: DashboardPanel;
    panelIndex?: number;
    page?: Record<string, unknown>;
    pageIndex?: number;
}

export interface DashboardWidgetStoreDeps {
    getCache: () => DashboardCache;
    getCurrentPageId: () => string | null;
    renderDashboard: () => void;
    readDashboardSectionFallback: () => Promise<Record<string, unknown>>;
    writeDashboardSectionFallback: (section: Record<string, unknown>) => Promise<void>;
}

export interface DashboardPagesNavDeps {
    getDashboardCache: () => DashboardCache;
    getCurrentPageId: () => string | null;
    setCurrentPageId: (id: string | null) => void;
    setDashboardPages: (pages: Array<Record<string, unknown>>) => void;
    readDashboardViewCache: () => DashboardCache | null;
    selectDashboardPage: (pageId: string) => void | Promise<void>;
    switchTab: (tab: string, options?: { syncHash?: boolean }) => void;
    closeSidebar: () => void;
    isSidebarOpen?: () => boolean;
    escape: (value: unknown) => string;
    iconClass: (spec: unknown) => string;
}

export interface DashboardCardMeta {
    id?: string;
    renderer?: string;
    icon?: string;
    [key: string]: unknown;
}

export interface RememberCredentialsPayload {
    u?: string;
    t?: string;
    rt?: string;
    p?: string;
}

export interface UserProfileResponse {
    username?: string;
    phones?: string[];
    [key: string]: unknown;
}

export interface TokenResponse {
    access_token: string;
    refresh_token?: string;
}

export interface DashboardCardUpdateContext {
    getEditMode: () => boolean;
    widgetRenderer: (widget: DashboardWidget) => string;
    stateOn: (state: string) => boolean;
    controlVisuallyPending: (widgetId?: string) => boolean;
}

export type DashboardCardUpdateFn = (
    widget: DashboardWidget,
    updates: Map<string, unknown>,
    articleEl: HTMLElement,
    ctx: DashboardCardUpdateContext,
    entityIds: string[],
) => boolean;

export interface DashboardCardRegistration {
    type: string;
    render?: ((widget: DashboardWidget, ctx?: unknown, opts?: Record<string, unknown>) => string) | null;
    update?: DashboardCardUpdateFn | null;
    defaults?: Record<string, unknown>;
}

export interface DashboardCardRegistryPatchOpts {
    widgetRenderer: (widget: DashboardWidget) => string;
    buildCtx: (renderer: string) => DashboardCardUpdateContext;
    widgetEntityIds: (widget: DashboardWidget) => string[];
    widgetArticleEl: (widgetId: string) => HTMLElement | null;
    touchedWidgetIds?: Set<string> | string[];
}

export interface DashboardAddPickerDeps {
    requireDashboardEditAccess: () => boolean;
    closeDashboardMenu: () => void;
    ensureHyveviewEntitySeed: () => void | Promise<void>;
    hvOpenEditor: (options: Record<string, unknown>) => Promise<unknown>;
    saveDashboardWidgetFromEditor: (
        result: unknown,
        opts?: { editingId?: string | null; original?: unknown },
    ) => void | Promise<void>;
}

export interface DashboardPanelDeleteDeps {
    requireDashboardEditAccess: () => boolean;
    showConfirm: (message: string) => boolean | Promise<boolean>;
    t: (key: string, params?: Record<string, unknown>) => string;
    getCurrentPageId: () => string | null;
    refreshAvailableEntities: (opts?: Record<string, unknown>) => void | Promise<unknown>;
    renderDashboard: () => void;
    showToast: (message: string, type?: string) => void;
}

export interface DashboardStandalonePanelDeps {
    getCache: () => DashboardCache;
}

export interface DashboardWidgetDeleteDeps {
    requireDashboardEditAccess: () => boolean;
    showConfirm: (message: string) => boolean | Promise<boolean>;
    t: (key: string, params?: Record<string, unknown>) => string;
    loadDashboard: () => Promise<void>;
    showToast: (message: string, type?: string) => void;
    readDashboardSectionFallback: () => Promise<{ widgets?: DashboardWidget[] }>;
    writeDashboardSectionFallback: (section: { widgets?: DashboardWidget[] }) => Promise<void>;
}

export interface DashboardYamlBridgeDeps {
    apiCall: (url: string, options?: ApiCallOptions) => Promise<Response>;
    t: (key: string, params?: Record<string, unknown>) => string;
    showToast: (message: string, type?: string) => void;
    getActivePageId: () => string | null;
    getActivePageName: () => string;
    loadDashboard: () => Promise<void>;
    requireDashboardEditAccess: () => boolean;
}

export interface DashboardPageSelectDeps {
    setCurrentPageId: (id: string) => void;
    getCurrentPageId: () => string | null;
    setHashForPage: (pageId: string) => void;
    getCache: () => DashboardCache;
    setCache: (cache: DashboardCache) => void;
    renderDashboard: () => void;
    setDashboardRefreshIndicator: (on: boolean) => void;
    refreshAvailableEntities: (opts?: { includeEntities?: boolean }) => Promise<unknown>;
    withDashboardTimeout: <T>(promise: Promise<T>, ms: number, message: string) => Promise<T>;
    t: (key: string, params?: Record<string, unknown>) => string;
    showToast: (message: string, type?: string) => void;
}

export interface DashboardCustomSelectState {
    wrap: HTMLDivElement;
    button: HTMLButtonElement;
    value: HTMLSpanElement;
    menu: HTMLDivElement;
}

export interface DashboardWidgetCardsDeps {
    getCache: () => DashboardCache;
    getEditMode: () => boolean;
    withoutEditMode: <T>(fn: () => T) => T;
    widgetRenderer: (widget: DashboardWidget) => string;
    dashboardDefaultRowsForType: (type: string) => number;
    escapeHtml: (value: unknown) => string;
    stateOn: (state: string) => boolean;
    controlVisuallyPending: (widgetId?: string) => boolean;
    HVBridge: { renderCardElement: (widget: DashboardWidget) => string };
    t: (key: string, params?: Record<string, unknown>) => string;
}

export interface DashboardWidgetSpan {
    col: number;
    row: number;
    colStart: number | null;
    rowStart: number | null;
}

export type { DashboardDragResizeDeps } from './drag_resize.js';

export interface DashboardRenderDeps {
    getCache: () => DashboardCache;
    getEditMode: () => boolean;
    syncPreferenceControls: () => void;
    updateStats: () => void;
    renderDashboardPagesList: () => void;
    isStandalonePanel: (panel: DashboardPanel) => boolean;
    filteredWidgets: () => DashboardWidget[];
    escapeHtml: (value: unknown) => string;
    t: (key: string, params?: Record<string, unknown>) => string;
    iconClass: (spec: unknown) => string;
    enhanceSparklines: () => void;
    configureHyveviewMounted: (root: Element) => void;
    resumeDashboardCameras: () => void;
}

export interface DashboardEntityPickerDeps {
    getCache: () => DashboardCache;
    escapeHtml: (value: unknown) => string;
    t: (key: string, params?: Record<string, unknown>) => string;
    entityIcon: (domain: unknown) => string;
    addClimateEntityId?: (entityId: string) => void;
    renderDashboardAddPreview?: () => void;
}

export interface DashboardPageModalDeps {
    requireDashboardEditAccess: () => boolean;
    getDashboardCache: () => DashboardCache;
    getCurrentPageId: () => string | null;
    setCurrentPageId: (id: string) => void;
    closeDashboardMenu: () => void;
    syncPreferenceControls: () => void;
    renderDashboardPagesList: () => void;
    selectDashboardPage: (pageId: string) => void | Promise<void>;
    loadDashboard: () => Promise<void>;
    abortPendingLoad: () => void;
    t: (key: string, params?: Record<string, unknown>) => string;
}

export interface DashboardWidgetToggleDeps {
    getCache: () => DashboardCache;
    getEditMode: () => boolean;
    controlPending: (widgetId: string) => boolean;
    findWidget: (widgetId: string) => DashboardWidget | null | undefined;
    getCurrentPageId: () => string | null;
    getActivePageId: () => string;
    dashboardIntentAction: (widget: DashboardWidget, nextState: string) => string;
    tryFastPathForEntities: (entityIds: string[]) => boolean;
    renderDashboard: () => void;
    t: (key: string, params?: Record<string, unknown>) => string;
}

export interface DashboardLoaderDeps {
    getDashboardCache: () => DashboardCache;
    setDashboardCache: (cache: DashboardCache) => void;
    getCurrentPageId: () => string | null;
    setCurrentPageId: (id: string | null) => void;
    isControllableDomain: (domain: string) => boolean;
    isInfoDomain: (domain: string) => boolean;
    renderCachedDashboardIfEmpty: () => boolean;
    renderDashboard: () => void;
    applyDashboardEditAccess: () => void;
    canEditDashboard: () => boolean;
    getEditMode: () => boolean;
    resetDashboardEditingState: () => void;
    resumeDashboardCameras: () => void;
    connectDashboardLive: () => void;
    configureHyveviewMounted: (root: Element) => void;
    updateDashboardEntityOptions: () => void;
    setEntitySelectState: (message: string, error?: boolean) => void;
    escapeHtml: (text: string) => string;
    t: (key: string, params?: Record<string, unknown>) => string;
}

export interface DashboardPanelModalDeps {
    requireDashboardEditAccess: () => boolean;
    getDashboardCache: () => DashboardCache;
    getCurrentPageId: () => string | null;
    refreshAvailableEntities: (options?: { includeEntities?: boolean; signal?: AbortSignal | null }) => Promise<unknown>;
    renderDashboard: () => void;
    closeDashboardMenu: () => void;
    t: (key: string, params?: Record<string, unknown>) => string;
    showToast: (message: string, type?: string) => void;
}

export interface DashboardPreferencesDeps {
    getCache: () => DashboardCache;
    getCurrentPageId: () => string | null;
    getEditMode: () => boolean;
    setEditMode: (on: boolean) => void;
    requireDashboardEditAccess: () => boolean;
    resolveCurrentDashboardPageId: () => void | string;
    closeDashboardMenu: () => void;
    renderDashboard: () => void;
    readDashboardSectionFallback: () => Promise<Record<string, unknown>>;
    writeDashboardSectionFallback: (section: Record<string, unknown>) => Promise<void>;
    t: (key: string, params?: Record<string, unknown>) => string;
}

export interface DashboardWidgetAddEditorDeps {
    getDashboardCache: () => DashboardCache;
    getAvailableEntity: (entityId: string) => import('./entity.js').HyveEntity | null;
    renderWidgetCardForPreview: (widget: DashboardWidget) => string;
    climateEntityRecordsForSave: () => Array<{ entity_id: string; title?: string; subtitle?: string; [key: string]: unknown }>;
    t: (key: string, params?: Record<string, unknown>) => string;
}

export interface DashboardWidgetAddModalDeps {
    requireDashboardEditAccess: () => boolean;
    closeDashboardMenu: () => void;
    closeDashboardWidgetEditor: () => void;
    getCurrentPageId: () => string | null;
    getCurrentEditorId: () => string | null;
    clearCurrentEditorId: () => void;
    getAvailableEntity: (entityId: string) => import('./entity.js').HyveEntity | null;
    dashboardEditorRenderer: (type: string) => string;
    dashboardDefaultRowsForType: (type: string) => number;
    loadDashboardCardCatalog: () => Promise<unknown>;
    refreshAvailableEntities: () => Promise<unknown>;
    loadDashboard: () => Promise<void>;
    readDashboardSectionFallback: () => Promise<{ widgets?: DashboardWidget[]; [key: string]: unknown }>;
    writeDashboardSectionFallback: (section: Record<string, unknown>) => Promise<void>;
    clearDashboardClimateEntitySelection: () => void;
    climateEntityRecordsForSave: () => Array<{ entity_id: string; [key: string]: unknown }>;
    renderDashboardClimateEntityChips: () => void;
    t: (key: string, params?: Record<string, unknown>) => string;
}

export interface DashboardWidgetEditorBridgeDeps {
    requireDashboardEditAccess: () => boolean;
    findWidget: (widgetId: string) => DashboardWidget | null | undefined;
    getDashboardCache: () => DashboardCache;
    getCurrentPageId: () => string | null;
    refreshAvailableEntities: () => Promise<unknown>;
    loadDashboard: () => Promise<void>;
    readDashboardSectionFallback: () => Promise<{ widgets?: DashboardWidget[]; [key: string]: unknown }>;
    writeDashboardSectionFallback: (section: Record<string, unknown>) => Promise<void>;
    t: (key: string, params?: Record<string, unknown>) => string;
}

export interface DashboardLiveBridgeDeps {
    HVBridge: {
        configureMounted?: (
            root: Element,
            widgetById: (id: string) => unknown,
            options?: { bootstrapStates?: (el: Element, widget: unknown) => void },
        ) => void;
        patchEntityStates?: (
            updates: Map<string, unknown>,
            widgetById: (id: string) => DashboardWidget | null | undefined,
        ) => Set<string>;
    };
    getCache: () => DashboardCache;
    climateConfiguredIds: (widget: DashboardWidget) => string[];
    cameraWidgetEntities: (widget: DashboardWidget) => Array<{ entity_id: string }>;
    widgetRenderer: (widget: DashboardWidget) => string;
    widgetById: (id: string) => DashboardWidget | null | undefined;
    renderDashboard: () => void;
}

export interface DashboardEntityPatcherDeps {
    HVBridge: {
        configureMounted?: (
            root: Element,
            widgetById: (id: string) => unknown,
            options?: { bootstrapStates?: (el: Element, widget: unknown) => void },
        ) => void;
        patchEntityStates?: (
            updates: Map<string, unknown>,
            widgetById: (id: string) => DashboardWidget | null | undefined,
        ) => Set<string>;
    };
    getCache: () => DashboardCache;
    shouldHoldOptimisticState: (entityId: string, state: unknown) => boolean;
    pendingForEntity: (entityId: string) => { widgetId?: string } | null | undefined;
    clearPendingControl: (widgetId: string) => void;
    climateConfiguredIds: (widget: DashboardWidget) => string[];
    cameraWidgetEntities: (widget: DashboardWidget) => Array<{ entity_id: string }>;
    widgetRenderer: (widget: DashboardWidget) => string;
    widgetById: (id: string) => DashboardWidget | null | undefined;
    renderDashboard: () => void;
}

export interface DashboardWidgetLegacyEditDeps {
    requireDashboardEditAccess: () => boolean;
    getCurrentEditorId: () => string | null;
    readDashboardSectionFallback: () => Promise<{ widgets?: DashboardWidget[] }>;
    writeDashboardSectionFallback: (section: { widgets?: DashboardWidget[] }) => Promise<void>;
    loadDashboard: () => Promise<void>;
    t: (key: string, params?: Record<string, unknown>) => string;
}

export interface DashboardYamlEditorDeps {
    apiCall: (url: string, options?: ApiCallOptions) => Promise<Response>;
    t: (key: string, params?: Record<string, unknown>) => string;
    showToast: (message: string, type?: string) => void;
    getActivePageId: () => string | null;
    getActivePageName: () => string;
    reloadDashboard: () => Promise<void>;
}

export interface CodeMirrorEditor {
    getValue(): string;
    setValue(text: string): void;
    refresh(): void;
    setSize(width: string, height: string): void;
}

export interface CodeMirrorStatic {
    fromTextArea(
        ta: HTMLTextAreaElement,
        opts: Record<string, unknown>,
    ): CodeMirrorEditor;
}

export interface ClimateEntityRecord {
    entity_id: string;
    title?: string;
    subtitle?: string;
    [key: string]: unknown;
}

export interface ClimateHvacOption {
    value: string;
    label: string;
}

export interface ClimateEntityView extends DashboardWidget {
    entity_id: string;
    slide_title?: string;
    slide_subtitle?: string;
    entity_name?: string;
    current_state?: string | number | null;
    unit?: string;
    available?: boolean;
    controllable?: boolean;
}

export interface ClimateTrackElement extends HTMLElement {
    _hyveClimateAnimTimer?: ReturnType<typeof setTimeout> | null;
}

export interface ClimateCardMountElement extends HTMLElement {
    setActiveSlide?: (index: number, entity: ClimateEntityView | null) => void;
}

export interface ClimateSwipeState {
    widgetId: string;
    pointerId: number;
    x: number;
    y: number;
    index: number;
    total: number;
    width: number;
    track: ClimateTrackElement;
    moved: boolean;
}

export interface DashboardEntitySnapshotEntry {
    item: DashboardWidget;
    state?: string | number | null;
    attributes?: Record<string, unknown>;
    available?: boolean;
    availableEntity?: boolean;
}

export interface DashboardClimateDeps {
    getCache: () => DashboardCache;
    findWidget: (id: string) => DashboardWidget | null;
    renderDashboard: () => void;
    renderDashboardAddPreview: () => void;
    getEditMode: () => boolean;
    widgetDragAttrs: (widget: DashboardWidget) => string;
    widgetEditControls: (widget: DashboardWidget) => string;
    widgetSizeClass: (widget: DashboardWidget) => string;
    resolveEntityMatch: (input: HTMLInputElement | null, type?: string) => import('./entity.js').HyveEntity | null;
    apiCall: (url: string, options?: ApiCallOptions) => Promise<Response>;
    t: (key: string, params?: Record<string, unknown>) => string;
    showToast: (message: string, type?: string, duration?: number) => void;
    dashApiError: (detail: unknown, fallbackKey: string) => string;
    escapeHtml: (value: unknown) => string;
    stateOn: (state: string) => boolean;
    widgetTitle: (widget: unknown, fallbacks?: { entityId?: string; entityName?: string }) => string;
    HVBridge: { renderCardElement: (widget: DashboardWidget) => string };
    controlPending: (widgetId: string) => boolean;
    setPendingControl: (widgetId: string, data: PendingControlEntry) => void;
    deletePendingControl: (widgetId: string) => void;
    snapshotEntityState: (entityId: string) => DashboardEntitySnapshotEntry[];
    restoreEntitySnapshot: (snapshot: DashboardEntitySnapshotEntry[] | null | undefined) => void;
    patchEntityState: (entityId: string, state: string | number | null, attrsPatch?: Record<string, unknown> | null) => void;
    tryFastPathForEntities: (entityIds: string[]) => boolean;
    getCurrentPageId: () => string;
}
