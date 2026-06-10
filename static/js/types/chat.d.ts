/** Chat UI message, stream session, and history types. */

export type ChatMessageRole = 'user' | 'ai' | 'reminder' | 'automation';

export interface AppendMessageOptions {
    imageDataUrl?: string | null;
    documentFileName?: string | null;
    profileName?: string;
    timestamp?: string | number;
}

export interface ChatResponseStats {
    elapsed?: number;
    charCount?: number;
    thinkingTime?: number;
    generationTime?: number;
    completionTokens?: number | null;
    promptTokens?: number | null;
    totalTokens?: number | null;
    model?: string;
    modelId?: string;
    tools?: Array<{ type?: string; label?: string }>;
}

export interface ChatToolCall {
    function?: { name?: string };
}

export interface ChatSessionMessage {
    role?: string;
    content?: string;
    notification?: boolean;
    timestamp?: string | number;
    thinking?: string;
    profile_color?: string;
    model_name?: string;
    model_id?: string;
    response_stats?: {
        elapsed?: number;
        thinkingTime?: number;
        generationTime?: number;
        completionTokens?: number;
        promptTokens?: number;
        totalTokens?: number;
    };
    search_sources?: unknown[];
    forge_preview?: string;
    forge_preview_language?: string;
    tool_calls?: ChatToolCall[];
}

export interface ChatSessionResponse {
    id?: string;
    title?: string;
    created_at?: string;
    messages?: ChatSessionMessage[];
}

export interface ChatStreamSessionOpts {
    aiBubbleId: string;
    newSessionId: string | null;
    hasImage: boolean;
    applyBubbleGlow: (color: string) => void;
    onResendMessage: (msg: string) => void | Promise<void>;
}

export interface StreamMetrics {
    completion_tokens: number | null;
    prompt_tokens: number | null;
    total_tokens: number | null;
}

export interface ShellCardSuggest {
    suggest: true;
    command?: string;
    reason?: string;
}

export interface ShellCardRequest {
    requested_but_denied: true;
    command?: string;
}

export interface ShellCardDone {
    command?: string;
    exit_code?: number;
    output_preview?: string;
}

export type ShellCard = ShellCardSuggest | ShellCardRequest | ShellCardDone;

export interface ProposalCard {
    type?: string;
    path?: string;
    content?: string;
    preview?: string;
    diff_preview?: string;
}

export interface ForgePreviewState {
    content: string;
    language: string;
    done: boolean;
}

export interface SseQueueItem {
    eventType: string;
    data: string;
}
