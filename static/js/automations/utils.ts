import type { ConfigFormElement } from '../types/features_config.js';

export function errMsg(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

export function inputVal(el: Element | null | undefined): string {
    return String((el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)?.value ?? '');
}

export function autoEl(id: string): ConfigFormElement | null {
    return document.getElementById(id) as ConfigFormElement | null;
}
