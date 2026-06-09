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
}

export interface DashboardVisibilityCondition {
    condition?: string;
    type?: string;
    media?: string;
    value?: string;
}

export interface DashboardVisibilityConfig {
    enabled?: boolean;
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
