/** Dashboard live entity WebSocket transport + camera stream pause/resume. */
export function createDashboardLiveWs(deps) {
    const { apiCall, dashDebug, DASH_DEBUG_ENABLED, onLiveItems, onLiveRemoved, } = deps;
    let ws = null;
    let reconnectTimer = null;
    let pingTimer = null;
    let backoff = 1000;
    async function fetchToken() {
        try {
            const res = await apiCall('/api/token/sse', { method: 'POST' });
            if (!res.ok)
                return null;
            const data = await res.json().catch(() => ({}));
            return data?.sse_token || null;
        }
        catch {
            return null;
        }
    }
    function isDashboardViewVisible() {
        const view = document.getElementById('view-dashboard');
        return !!(view && !view.classList.contains('hidden'));
    }
    function pauseCameraStreams() {
        try {
            document.querySelectorAll('hv-camera-carousel, hv-camera-stream, hyve-camera-live-player').forEach((el) => {
                try {
                    el.pauseStream?.();
                }
                catch { /* ignore */ }
            });
        }
        catch { /* ignore */ }
    }
    function resumeCameraStreams() {
        try {
            document.querySelectorAll('hv-camera-carousel, hv-camera-stream, hyve-camera-live-player').forEach((el) => {
                try {
                    el.resumeStream?.();
                }
                catch { /* ignore */ }
            });
        }
        catch { /* ignore */ }
    }
    function disconnectDashboardLive() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
        }
        if (ws) {
            try {
                ws.onclose = null;
            }
            catch { /* ignore */ }
            try {
                ws.close();
            }
            catch { /* ignore */ }
            ws = null;
        }
        pauseCameraStreams();
    }
    function resumeDashboardCameras() {
        resumeCameraStreams();
    }
    function scheduleReconnect(connect) {
        const view = document.getElementById('view-dashboard');
        if (!view || view.classList.contains('hidden'))
            return;
        if (reconnectTimer)
            return;
        const delay = Math.min(backoff, 15000);
        backoff = Math.min(backoff * 2, 15000);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, delay);
    }
    async function connectDashboardLive() {
        const view = document.getElementById('view-dashboard');
        if (!view || view.classList.contains('hidden')) {
            disconnectDashboardLive();
            return;
        }
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))
            return;
        const token = await fetchToken();
        if (!token) {
            scheduleReconnect(() => { void connectDashboardLive(); });
            return;
        }
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const url = `${proto}://${window.location.host}/api/dashboard/ws/live?token=${encodeURIComponent(token)}`;
        let socket;
        try {
            socket = new WebSocket(url);
        }
        catch {
            scheduleReconnect(() => { void connectDashboardLive(); });
            return;
        }
        ws = socket;
        socket.onopen = () => {
            backoff = 1000;
            dashDebug('ws.open', { url: url.replace(/token=[^&]+/, 'token=***') });
            if (pingTimer)
                clearInterval(pingTimer);
            pingTimer = setInterval(() => {
                const v = document.getElementById('view-dashboard');
                if (!v || v.classList.contains('hidden')) {
                    disconnectDashboardLive();
                    return;
                }
                try {
                    socket.send('ping');
                }
                catch { /* ignore */ }
            }, 25000);
        };
        socket.onmessage = (ev) => {
            let payload = null;
            try {
                payload = JSON.parse(String(ev.data));
            }
            catch {
                return;
            }
            if (!payload?.type)
                return;
            if (payload.type === 'snapshot' || payload.type === 'diff') {
                const items = Array.isArray(payload.items) ? payload.items : [];
                if (DASH_DEBUG_ENABLED) {
                    const sample = items.filter((it) => /releu_dormitor/.test(String(it?.entity_id || '')));
                    dashDebug(`ws.${payload.type}`, {
                        count: items.length,
                        dormitor: sample.map((it) => {
                            const row = it;
                            return { id: row.entity_id, s: row.state };
                        }),
                    });
                }
                onLiveItems(items, payload.type === 'snapshot');
            }
            else if (payload.type === 'removed') {
                onLiveRemoved(Array.isArray(payload.entity_ids) ? payload.entity_ids.map(String) : []);
            }
        };
        socket.onclose = (ev) => {
            dashDebug('ws.close', { code: ev?.code, reason: ev?.reason });
            if (pingTimer) {
                clearInterval(pingTimer);
                pingTimer = null;
            }
            ws = null;
            scheduleReconnect(() => { void connectDashboardLive(); });
        };
        socket.onerror = () => {
            dashDebug('ws.error', 'error');
            try {
                socket.close();
            }
            catch { /* ignore */ }
        };
    }
    function onDashboardForeground() {
        if (!isDashboardViewVisible())
            return;
        void connectDashboardLive();
        resumeDashboardCameras();
    }
    function initTabWatch() {
        if (typeof window === 'undefined' || window.__dashboardLiveTabWatch)
            return;
        window.__dashboardLiveTabWatch = true;
        document.addEventListener('visibilitychange', () => {
            if (document.hidden)
                disconnectDashboardLive();
            else
                onDashboardForeground();
        });
        window.addEventListener('pageshow', () => {
            if (!document.hidden)
                onDashboardForeground();
        });
        window.addEventListener('focus', () => {
            if (!document.hidden)
                onDashboardForeground();
        });
    }
    return {
        connectDashboardLive,
        disconnectDashboardLive,
        resumeDashboardCameras,
        initTabWatch,
    };
}
