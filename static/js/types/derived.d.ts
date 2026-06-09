/** Derived entity (template sensor) builder types. */

export interface DerivedCandidate {
    entity_id: string;
    state?: string | number | null;
    unit?: string;
}

export interface DerivedFormulaBase {
    type: string;
    inputs?: string[];
}

export interface DerivedExpressionFormula extends DerivedFormulaBase {
    type: 'expression';
    expression?: string;
    inputs: [];
}

export interface DerivedTransformFormula extends DerivedFormulaBase {
    type: 'transform';
    inputs: string[];
    filter?: string;
    scale?: number;
    offset?: number;
}

export interface DerivedPresetFormula extends DerivedFormulaBase {
    type: string;
    inputs: string[];
}

export type DerivedFormula =
    | DerivedExpressionFormula
    | DerivedTransformFormula
    | DerivedPresetFormula;

export interface DerivedEntry {
    entity_id?: string;
    name?: string;
    value_type?: string;
    unit?: string;
    selected?: boolean;
    formula?: DerivedFormula;
}

export interface DerivedPreviewResolved {
    value_type: string;
    unit: string;
    formula: DerivedFormula;
}

export interface DerivedModalEl extends HTMLElement {
    __wired?: boolean;
}
