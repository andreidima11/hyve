/** Hyveview card registration, schema, and custom element types. */

import type { HyveviewWidget } from './widget.js';

export interface HyveviewCardMeta {
    name?: string;
    description?: string;
    icon?: string;
    [key: string]: unknown;
}

export interface HyveviewSchemaSelectOption {
    value: string;
    label?: string;
}

export interface HyveviewSchemaField {
    key: string;
    label?: string;
    type?: string;
    default?: unknown;
    required?: boolean;
    placeholder?: string;
    hint?: string;
    inline?: boolean;
    min?: number;
    max?: number;
    step?: number;
    domains?: string[];
    options?: HyveviewSchemaSelectOption[];
    addLabel?: string;
}

export interface HyveviewCardSchema {
    fields?: HyveviewSchemaField[];
}

export interface HyveviewCardShell {
    [key: string]: unknown;
}

export type HyveviewStubConfigFn = (entityId?: string) => Record<string, unknown>;

export interface HyveviewCardClass extends CustomElementConstructor {
    schema?: HyveviewCardSchema;
    meta?: HyveviewCardMeta;
    shell?: HyveviewCardShell;
    getStubConfig?: HyveviewStubConfigFn;
}

export interface RegisterCardOptions {
    tagName?: string;
    meta?: HyveviewCardMeta;
    schema?: HyveviewCardSchema;
    getStubConfig?: HyveviewStubConfigFn;
    hidden?: boolean;
    shell?: HyveviewCardShell | null;
}

export interface HyveviewCardSpec {
    schema: HyveviewCardSchema | null;
    meta: HyveviewCardMeta;
    getStubConfig: HyveviewStubConfigFn | null;
    hidden: boolean;
    shell: HyveviewCardShell | null;
}

export interface HyveviewRegistryEntry {
    tagName: string;
    ElementClass: HyveviewCardClass;
    opts: RegisterCardOptions;
    spec: HyveviewCardSpec;
}

export interface HyveviewCardSpecPublic {
    type: string;
    tagName: string;
    schema: HyveviewCardSchema | null;
    meta: HyveviewCardMeta;
    getStubConfig: HyveviewStubConfigFn | null;
    hidden?: boolean;
    shell?: HyveviewCardShell | null;
}

export interface HyveviewCardPackage {
    type: string;
    element: HyveviewCardClass;
    styles?: string[];
    shell?: HyveviewCardShell | null;
    meta?: HyveviewCardMeta;
    schema?: HyveviewCardSchema;
    getStubConfig?: HyveviewStubConfigFn;
    hidden?: boolean;
    tagName?: string;
}

export interface HyveviewCardElement extends HTMLElement {
    __hvWidget?: HyveviewWidget;
    setConfig?(config: unknown): void;
    setState?(state: unknown): void;
}

export interface HyveviewEntityState {
    entity_id: string;
    friendly_name?: string;
    name?: string;
    state?: string | number | null;
    attributes?: Record<string, unknown>;
    unit?: string;
    [key: string]: unknown;
}

export interface HyveviewSchemaFormApi {
    read(): Record<string, unknown>;
    validate(): { ok: boolean; errors: string[] };
}

export interface HyveviewMultiEntityRow {
    entity_id: string;
    unique_id: string;
    title: string;
    subtitle: string;
}

export interface HyveviewMultiEntityInput extends HTMLDivElement {
    __hvReadMulti?: () => HyveviewMultiEntityRow[];
}
