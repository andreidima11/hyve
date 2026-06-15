/** App boot helpers — DOM/query coercion for bootstrap code. */

import type { ConfigFormElement } from '../types/features_config.js';
import type { DelegatedHandler } from '../types/app.js';

export function _errMsg(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err ?? '');
}

export function _appEl(id: string): ConfigFormElement | null {
    return document.getElementById(id) as ConfigFormElement | null;
}

export function _bindHandler<A extends unknown[]>(fn: (...args: A) => unknown): DelegatedHandler {
    return (...args: unknown[]) => fn(...(args as A));
}

export function _str(v: unknown): string {
    return v == null ? '' : String(v);
}

export function _num(v: unknown, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}
