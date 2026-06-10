/** Ambient browser globals used across Hyve frontend modules. */

export {};

declare global {
    const DOMPurify: {
        sanitize(html: string): string;
    };

    const marked: {
        use: (options: Record<string, unknown>) => void;
        parse: (text: string) => string;
    } | undefined;

    const hljs: {
        highlightElement: (el: Element) => void;
        highlightAuto: (text: string) => { value: string; language?: string };
        getLanguage: (lang: string) => unknown;
        lineNumbersBlock: (el: Element, opts?: { singleLine?: boolean }) => void | Promise<void>;
    };

    interface Window {
        __cacheBust?: string;
        __appVersion?: string;
        __previewIntegrationNumberValue?: (entityId: string, value: string, unit: string) => void;
        __dashboardLiveTabWatch?: boolean;
        __hyveDashLog?: Array<{ t: string; tag: string; info?: unknown }>;
        __hyveDashDebug?: { enabled: boolean; log: () => unknown[] };
        __hyveSourceFaviconError?: (img: HTMLImageElement) => void | Promise<void>;
        __saveNativeAuthToken?: (token: string) => void;
        bootHyve?: () => void | Promise<void>;
        sendMessage?: (...args: unknown[]) => unknown;
        HVBridge?: typeof import('/static/hyveview/bridge.js');
        openHyveviewEditor?: (options: Record<string, unknown>) => Promise<unknown>;
        __hyveCameraTimer?: ReturnType<typeof setInterval> | null;
        __hyvePlayNotificationCue?: () => void;
        __chatExports?: { sendMessage?: (optionalMessage?: string) => void | Promise<void> };
        __onAndroidKeyboard?: (kbHeight: number) => void;
        webkitAudioContext?: typeof AudioContext;
        __HYVE_THEME_REGISTRY__?: {
            themeOptions?: Array<{ id: string; selector: string; label: string; preview: string[] }>;
            resolveTheme?: (themeId: string) => { id: string; selector: string; label: string; preview: string[] };
            getStoredThemeId?: () => string;
            getStoredThemeSelector?: () => string;
        };
        __hyveShowNotification?: (title: string, message: string, sessionId?: string) => void;
        __pendingHyveNotification?: { title: string; message: string; sessionId?: string };
        __hyveCameraFrameReady?: (img: HTMLImageElement) => void;
        __hyveCameraFrameFailed?: (img: HTMLImageElement, fallbackSrc?: string) => void;
        saveAppConfig?: () => void;
        __setNativeSystemBarColor?: (color: string) => void;
        ace?: {
            edit(el: HTMLElement): import('./utils.js').HyveAceEditor;
        };
        __HYVE_NATIVE_APP?: boolean;
        __setNativeWsServiceEnabled?: (enabled: boolean) => void;
        __getNativeWsServiceStatus?: () => boolean | null | undefined;
        currentUser?: { is_admin?: boolean; [key: string]: unknown };
        _authToken?: string;
        CodeMirror?: {
            fromTextArea: (
                ta: HTMLTextAreaElement,
                opts: Record<string, unknown>,
            ) => {
                getValue(): string;
                setValue(text: string): void;
                refresh(): void;
                setSize(width: string, height: string): void;
            };
        };
    }

    interface EntityStateChangedDetail {
        entity_id?: string;
        state?: string | number | null;
        raw?: unknown;
        attributes_delta?: Record<string, unknown>;
        type?: string;
    }

    interface CustomEventMap {
        'entity-state-changed': CustomEvent<EntityStateChangedDetail>;
        'entity-discovery-refresh': CustomEvent;
        'entity-bridge-status': CustomEvent<Record<string, unknown>>;
        'tts:ended': CustomEvent<{ voiceLoop?: boolean }>;
    }
}

declare global {
    interface WindowEventMap extends CustomEventMap {}
}
