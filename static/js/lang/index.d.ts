/** Type declarations for the i18n module (sources remain plain JS). */

export declare const LANGUAGES: Record<string, Record<string, unknown>>;
export declare const AVAILABLE_LANGUAGES: Array<{ code: string; nameKey: string }>;

export declare function mergeComponentTranslations(payload: Record<string, unknown>): void;
export declare function loadComponentTranslations(lang: string): Promise<void>;
export declare function t(key: string, params?: Record<string, unknown>): string;
export declare function translateApiDetail(detail: unknown): string;
export declare function integrationApiMessage(payload: Record<string, unknown> | null | undefined): string;
export declare function tState(rawState: unknown): string;
export declare function tVacuumStatus(statusAttr: unknown, genericState: unknown): string;
export declare function tLawnMowerStatus(statusAttr: unknown, genericState: unknown): string;
export declare function tRaw(key: string): unknown;
export declare function getLanguage(): string;
export declare function getAvailableLanguages(): Array<{ code: string; label: string }>;
export declare function setLanguage(lang: string): void;
export declare function initI18n(initialLang?: string): void;
export declare function applyTranslations(root?: ParentNode): void;
