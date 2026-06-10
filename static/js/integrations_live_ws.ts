/** Shared WebSocket client for `/api/integrations/ws/live` (one connection, many subscribers). */

import type { ApiCallOptions } from './api.js';

type ApiCallFn = (url: string, options?: ApiCallOptions) => Promise<Response>;

export interface IntegrationsLiveEntityUpdate {
    entity_id?: string;
    state?: unknown;
    attributes?: Record<string, unknown>;
    unit?: string;
    available?: boolean;
    name?: string;
}

export interface IntegrationsLiveSubscriber {
    id: string;
    isActive: () => boolean;
    onItems: (items: IntegrationsLiveEntityUpdate[], isSnapshot: boolean) => void;
    onRemoved: (entityIds: string[]) => void;
}

interface IntegrationsLiveWsDeps {
    apiCall: ApiCallFn;
}

interface LiveWsPayload {
    type?: string;
    items?: IntegrationsLiveEntityUpdate[];
    entity_ids?: string[];
}

let _deps: IntegrationsLiveWsDeps | null = null;
const _subscribers = new Map<string, IntegrationsLiveSubscriber>();
let _ws: WebSocket | null = null;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _pingTimer: ReturnType<typeof setInterval> | null = null;
let _backoff = 1000;

function _anyActive(): boolean {
    for (const sub of _subscribers.values()) {
        try {
            if (sub.isActive()) return true;
        } catch {
            // ignore broken guard
        }
    }
    return false;
}

async function _fetchToken(): Promise<string | null> {
    if (!_deps) return null;
    try {
        const res = await _deps.apiCall('/api/token/sse', { method: 'POST' });
        if (!res?.ok) return null;
        const data = await res.json().catch(() => ({})) as { sse_token?: string };
        return data?.sse_token || null;
    } catch {
        return null;
    }
}

function _clearTimers(): void {
    if (_reconnectTimer) {
        clearTimeout(_reconnectTimer);
        _reconnectTimer = null;
    }
    if (_pingTimer) {
        clearInterval(_pingTimer);
        _pingTimer = null;
    }
}

export function initIntegrationsLiveWs(deps: IntegrationsLiveWsDeps): void {
    _deps = deps;
}

export function subscribeIntegrationsLive(subscriber: IntegrationsLiveSubscriber): () => void {
    _subscribers.set(subscriber.id, subscriber);
    if (_anyActive()) void connectIntegrationsLive();
    return () => {
        _subscribers.delete(subscriber.id);
        if (!_anyActive()) disconnectIntegrationsLive();
    };
}

export function disconnectIntegrationsLive(): void {
    _clearTimers();
    if (_ws) {
        try { _ws.onclose = null; } catch { /* ignore */ }
        try { _ws.close(); } catch { /* ignore */ }
        _ws = null;
    }
}

function _scheduleReconnect(): void {
    if (!_anyActive()) return;
    if (_reconnectTimer) return;
    const delay = Math.min(_backoff, 15000);
    _backoff = Math.min(_backoff * 2, 15000);
    _reconnectTimer = setTimeout(() => {
        _reconnectTimer = null;
        void connectIntegrationsLive();
    }, delay);
}

export async function connectIntegrationsLive(): Promise<void> {
    if (!_deps) return;
    if (!_anyActive()) {
        disconnectIntegrationsLive();
        return;
    }
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;

    const token = await _fetchToken();
    if (!token) {
        _scheduleReconnect();
        return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/api/integrations/ws/live?token=${encodeURIComponent(token)}`;
    let socket: WebSocket;
    try {
        socket = new WebSocket(url);
    } catch {
        _scheduleReconnect();
        return;
    }
    _ws = socket;

    socket.onopen = () => {
        _backoff = 1000;
        if (_pingTimer) clearInterval(_pingTimer);
        _pingTimer = setInterval(() => {
            if (!_anyActive()) {
                disconnectIntegrationsLive();
                return;
            }
            try { socket.send('ping'); } catch { /* ignore */ }
        }, 25000);
    };

    socket.onmessage = (ev) => {
        let payload: LiveWsPayload | null = null;
        try { payload = JSON.parse(String(ev.data)) as LiveWsPayload; } catch { return; }
        if (!payload?.type) return;
        const items = Array.isArray(payload.items) ? payload.items : [];
        const removed = Array.isArray(payload.entity_ids) ? payload.entity_ids.map(String) : [];
        for (const sub of _subscribers.values()) {
            if (!sub.isActive()) continue;
            try {
                if (payload.type === 'snapshot' || payload.type === 'diff') {
                    sub.onItems(items, payload.type === 'snapshot');
                } else if (payload.type === 'removed') {
                    sub.onRemoved(removed);
                }
            } catch (err) {
                console.warn('[integrations-live-ws] subscriber failed', sub.id, err);
            }
        }
    };

    socket.onclose = () => {
        if (_pingTimer) {
            clearInterval(_pingTimer);
            _pingTimer = null;
        }
        _ws = null;
        _scheduleReconnect();
    };

    socket.onerror = () => {
        try { socket.close(); } catch { /* ignore */ }
    };
}

export function refreshIntegrationsLiveConnection(): void {
    if (_anyActive()) void connectIntegrationsLive();
    else disconnectIntegrationsLive();
}
