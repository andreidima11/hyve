/** Hyveview host shim — dashboard publishes helpers via setHost(). */

import type { HyveviewWidget } from './widget.js';

export interface HyveviewTrendEntry {
    value?: unknown;
    ts?: number;
}

export interface HyveviewHostApi {
    iconClass: (spec: unknown) => string;
    widgetIcon: (widget: HyveviewWidget | null | undefined) => string;
    entityIcon: (domain: string) => string;
    escape: (s: unknown) => string;
    enhanceSparklinesIn: (root: ParentNode) => void;
    trendCache: Map<string, HyveviewTrendEntry>;
    stateOn: (state: unknown) => boolean;
    entityIconForState: (domain: string, on: boolean) => string;
    controlVisuallyPending: (widgetId: string) => boolean;
    weatherIcon: (cond: unknown, isNight: boolean) => string;
    weatherVariant: (cond: unknown) => string;
    weatherIsNight: (attrs: unknown) => boolean;
    t?: (key: string, params?: Record<string, unknown>) => string;
    tVacuumStatus?: (status: unknown, state: string) => string;
}

export interface WidgetTitleFallbacks {
    entityName?: string;
    entityId?: string;
}
