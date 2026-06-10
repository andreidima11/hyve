/** Hyveview schema-driven editor modal types. */

export interface HyveviewEditorCard {
    id?: string;
    type: string;
    entity?: string | null;
    layout?: { col?: number; row?: number };
    config?: Record<string, unknown>;
    visibility?: HyveviewVisibilityConfig | null;
}

export interface HyveviewVisibilityCondition {
    entity_id?: string;
    op?: string;
    value?: string;
}

export interface HyveviewVisibilityConfig {
    enabled?: boolean;
    logic?: 'and' | 'or' | string;
    conditions?: HyveviewVisibilityCondition[];
}

export interface HyveviewEditorOpenOptions {
    mode?: 'add' | 'edit';
    card?: HyveviewEditorCard | null;
}

export interface HyveviewEditorSaveResult {
    id?: string;
    type: string;
    entity: string | null;
    layout: { col: number; row: number };
    config: Record<string, unknown>;
    visibility: HyveviewVisibilityConfig | null;
}

export interface HyveviewEditorDeleteResult {
    __deleted: true;
}

export type HyveviewEditorResult =
    | HyveviewEditorSaveResult
    | HyveviewEditorDeleteResult
    | null;
