/** Memory UI shapes (/api/memory). */

export interface MemoryFact {
    id: string;
    document: string;
    timestamp?: number;
    metadata?: { timestamp?: number; [key: string]: unknown };
}

export interface MemoryLogEvent {
    ts?: number | string;
    event_type?: string;
    summary?: string;
    details?: unknown;
}

export interface MemoryEventsResponse {
    events?: MemoryLogEvent[];
    total?: number;
}

export interface MemoryExtractionExample {
    input?: string;
    output?: string[];
}

export interface MemoryConsolidationResult {
    merged?: number;
    deleted_ids?: string[];
}
