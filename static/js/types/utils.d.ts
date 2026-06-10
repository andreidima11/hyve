/** Shared utility helpers (toast, sources, code editor). */

export type ToastType = 'info' | 'success' | 'error' | 'warn';

export interface ChatSourceInput {
    url?: string;
    link?: string;
    domain?: string;
    title?: string;
    snippet?: string;
}

export interface NormalizedSource {
    url: string;
    domain: string;
    title: string;
    snippet: string;
}

export interface CodeEditorSetupOptions {
    textareaId: string;
    mode?: string;
}

export interface HyveAceEditor {
    session: {
        setMode(mode: string): void;
        setUseWorker(v: boolean): void;
        setTabSize(n: number): void;
        setUseSoftTabs(v: boolean): void;
        setUseWrapMode(v: boolean): void;
        on(event: string, cb: () => void): void;
    };
    getSession(): HyveAceEditor['session'];
    setTheme(theme: string): void;
    resize(force?: boolean): void;
    setValue(value: string, cursor: number): void;
    getValue(): string;
    setOptions(opts: Record<string, unknown>): void;
    setShowPrintMargin(v: boolean): void;
    setHighlightActiveLine(v: boolean): void;
}

export interface HyveAceModule {
    edit(el: HTMLElement): HyveAceEditor;
}

declare global {
    interface HTMLElement {
        _savedParentScroll?: number;
    }
}

export {};
