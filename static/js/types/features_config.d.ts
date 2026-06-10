/** Settings / config page types. */

export interface ModelSubLlm {
    provider?: string;
    target_url?: string;
    model_name?: string;
    api_key?: string;
    timeout?: number;
    respond_directly?: boolean;
}

export interface ModelProfile {
    id: string;
    name: string;
    provider?: string;
    target_url?: string;
    model_name?: string;
    api_key?: string;
    temperature?: number;
    timeout?: number;
    context_length?: number;
    color?: string;
    visible_in_selector?: boolean;
    aux_llm_enabled?: boolean;
    aux_llm?: ModelSubLlm;
    coder_enabled?: boolean;
    coder?: ModelSubLlm;
    vision_enabled?: boolean;
    vision_llm?: ModelSubLlm;
    embed_enabled?: boolean;
    librarian?: { model_name?: string };
    persona_override?: string;
    capability_reasoning?: boolean;
    capability_tool_calling?: boolean;
    capability_vision?: boolean;
    [key: string]: unknown;
}

export interface ModelProfilesResponse {
    profiles?: ModelProfile[];
    active_id?: string;
    default_profile_id?: string;
    auto_router_stats?: { local?: number; api?: number };
}

export interface SaveConfigOptions {
    silent?: boolean;
    event?: Event;
}

/** Config DOM nodes — most ids are inputs/selects/textareas/buttons. */
export interface ConfigFormElement extends HTMLElement {
    value: string;
    checked?: boolean;
    disabled?: boolean;
    type?: string;
}

export type CfgFieldEl = ConfigFormElement;
