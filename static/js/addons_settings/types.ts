export interface AddonColorScheme {
    bg: string;
    text: string;
    border: string;
    btnBg: string;
    btnHover: string;
    btnText: string;
    btnBorder: string;
}

export interface AddonState {
    installed?: boolean;
    enabled?: boolean;
    config?: Record<string, unknown>;
    watchdog?: boolean;
}

export interface AddonConfigField {
    key: string;
    label?: string;
    description?: string;
    placeholder?: string;
    type?: string;
    default?: unknown;
}

export interface AddonRecord {
    slug: string;
    name?: string;
    description?: string;
    version?: string;
    color?: string;
    icon?: string;
    state?: AddonState;
    config_schema?: AddonConfigField[];
    config_suggestions?: Record<string, unknown>;
    integration_key?: string;
    start_command?: {
        command?: string;
        args?: string[];
        description?: string;
    };
}

export interface AddonUpdateRow {
    slug: string;
    name?: string;
    color?: string;
    icon?: string;
    image?: string;
    current?: string;
    latest?: string;
    update_available?: boolean;
    release_notes?: string;
    release_url?: string;
    github_repo?: string;
}

export interface HyveUpdateStatus {
    current?: string;
    latest?: string;
    tag?: string;
    update_available?: boolean;
    release_url?: string;
    release_notes?: string;
    checked_at?: string | null;
    error?: { key?: string; params?: Record<string, unknown> } | null;
    git_available?: boolean;
    github_repo?: string;
    github_token_configured?: boolean;
    prerequisites?: {
        npm_available?: boolean;
        frontend_dist_ready?: boolean;
        frontend_build_required?: boolean;
        frontend_build_commands?: string;
    };
}
