// Derived entities — shared modal state and DOM helpers.
import type { DerivedCandidate } from '../types/derived.js';

export const BUILDER_PRESET = 'preset';
export const BUILDER_TRANSFORM = 'transform';
export const BUILDER_EXPRESSION = 'expression';
export const VIEW_FORM = 'form';
export const VIEW_YAML = 'yaml';
export type BuilderKind = typeof BUILDER_PRESET | typeof BUILDER_TRANSFORM | typeof BUILDER_EXPRESSION;
export type ViewKind = typeof VIEW_FORM | typeof VIEW_YAML;

export const derivedState = {
    builder: BUILDER_PRESET as BuilderKind,
    view: VIEW_FORM as ViewKind,
    editingId: null as string | null,
    candidates: [] as DerivedCandidate[],
    selectedInputs: new Set<string>(),
    previewTimer: null as ReturnType<typeof setTimeout> | null,
    yamlTouched: false,
};

export function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

export function $input(id: string): HTMLInputElement | null {
    return document.getElementById(id) as HTMLInputElement | null;
}

export function $select(id: string): HTMLSelectElement | null {
    return document.getElementById(id) as HTMLSelectElement | null;
}

export function $textarea(id: string): HTMLTextAreaElement | null {
    return document.getElementById(id) as HTMLTextAreaElement | null;
}
