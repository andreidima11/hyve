export interface SessionSummary {
    id?: string;
    title?: string;
}

export interface SessionDetail extends SessionSummary {
    messages?: unknown[];
}
