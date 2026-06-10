/** Apps / add-ons page types. */

export type AddonColorKey =
    | 'cyan' | 'blue' | 'purple' | 'fuchsia' | 'amber' | 'red'
    | 'green' | 'emerald' | 'slate' | 'indigo' | 'rose';

export interface AddonWebUiConfig {
    ingress?: boolean;
    url_key?: string;
    host?: string;
    host_key?: string;
    protocol?: string;
    protocol_key?: string;
    port?: number | string;
    port_key?: string;
    path?: string;
}

export interface AddonState {
    installed?: boolean;
    enabled?: boolean;
    watchdog?: boolean;
    version?: string;
    config?: Record<string, unknown>;
}

export interface AddonConfigFieldOption {
    value?: string;
    label?: string;
}

export interface AddonConfigField {
    key?: string;
    label?: string;
    description?: string;
    placeholder?: string;
    type?: string;
    default?: unknown;
    detect?: string;
    options?: Array<string | AddonConfigFieldOption>;
}

export interface AddonCatalogEntry {
    slug: string;
    name: string;
    description?: string;
    long_description?: string;
    icon?: string;
    color?: AddonColorKey | string;
    image?: string;
    version?: string;
    start_command?: string;
    update_available?: boolean;
    config_schema?: AddonConfigField[];
    web_ui?: AddonWebUiConfig;
    state?: AddonState;
}

export interface AddonProcessStatus {
    status?: 'running' | 'exited' | 'stopped' | string;
    pid?: number | string;
    uptime?: number;
}

export type AddonProcessStatusMap = Record<string, AddonProcessStatus>;

export interface AddonPreflightCheck {
    ok?: boolean;
    name?: string;
    detail?: string;
    fix?: string;
}

export interface AddonSerialPort {
    path: string;
}
