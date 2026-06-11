export const BUILDER_PRESET = 'preset';
export const BUILDER_TRANSFORM = 'transform';
export const BUILDER_EXPRESSION = 'expression';
export const VIEW_FORM = 'form';
export const VIEW_YAML = 'yaml';
export const derivedState = {
    builder: BUILDER_PRESET,
    view: VIEW_FORM,
    editingId: null,
    candidates: [],
    selectedInputs: new Set(),
    previewTimer: null,
    yamlTouched: false,
};
export function $(id) {
    return document.getElementById(id);
}
export function $input(id) {
    return document.getElementById(id);
}
export function $select(id) {
    return document.getElementById(id);
}
export function $textarea(id) {
    return document.getElementById(id);
}
