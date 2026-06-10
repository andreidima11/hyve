/** Dashboard widget shapes consumed by Hyveview cards and bridge. */

export interface HyveviewWidgetEntityRef {
    entity_id?: string;
    unique_id?: string;
    title?: string;
    subtitle?: string;
    [key: string]: unknown;
}

export interface HyveviewWidgetSpan {
    row?: number;
    col?: number;
}

export interface HyveviewWidget {
    id?: string;
    type?: string;
    renderer?: string;
    entity_id?: string;
    unique_id?: string;
    icon?: string;
    config?: Record<string, unknown>;
    entities?: HyveviewWidgetEntityRef[];
    [key: string]: unknown;
}

export type WidgetByIdFn = (id: string) => unknown;

export type WidgetEntityIdsResolver = (widget: HyveviewWidget | null | undefined) => string[];
