"""
WebSocket notifications router.
Handles real-time push notifications via persistent WebSocket connection.
Clients connect when app opens, receive instant notifications when reminders trigger.
"""
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query, Depends, Request
import core.auth as auth
import core.models as models
import core.database as database
import json
from core.logger import log_line, log_detail
from typing import Set, Dict

router = APIRouter()

# Manager pentru WebSocket connections per user
class NotificationManager:
    def __init__(self):
        self.active_connections: Dict[str, Set[WebSocket]] = {}
    
    async def connect(self, user_id: str, websocket: WebSocket):
        """Store WebSocket connection for user."""
        await websocket.accept()
        if user_id not in self.active_connections:
            self.active_connections[user_id] = set()
        self.active_connections[user_id].add(websocket)
        log_line("success", "✅", "WS_CONNECT", f"User {user_id} connected. Total connections: {len(self.active_connections[user_id])}")
    
    async def disconnect(self, user_id: str, websocket: WebSocket):
        """Remove WebSocket connection."""
        if user_id in self.active_connections:
            self.active_connections[user_id].discard(websocket)
            if not self.active_connections[user_id]:
                del self.active_connections[user_id]
        log_line("websocket", "❌", "WS_DISCONNECT", f"User {user_id} disconnected. Remaining: {self.get_status()}")
    
    async def broadcast_to_user(self, user_id: str, message: dict):
        """Send notification to all connected clients of a user."""
        if user_id not in self.active_connections:
            log_line("websocket", "📵", "WS_BROADCAST", f"No connections for {user_id}. Active: {self.get_status()}")
            return False
        
        sent_count = 0
        disconnected = set()
        for websocket in self.active_connections[user_id]:
            try:
                await websocket.send_json(message)
                sent_count += 1
            except Exception as e:
                log_line("error", "⚠️", "WS_SEND_ERROR", f"User {user_id}: {e}")
                disconnected.add(websocket)
        
        # Clean up dead connections
        for ws in disconnected:
            await self.disconnect(user_id, ws)
        
        log_line("websocket", "📤", "WS_BROADCAST", f"Sent to {sent_count} client(s) of {user_id}")
        return sent_count > 0
    
    def has_active_connection(self, user_id: str) -> bool:
        """Check if user has at least one active WebSocket connection."""
        return user_id in self.active_connections and bool(self.active_connections[user_id])
    
    def get_status(self) -> str:
        """Return human-readable status of all connections."""
        if not self.active_connections:
            return "No active connections"
        parts = [f"{uid}: {len(conns)}" for uid, conns in self.active_connections.items()]
        return ", ".join(parts)

manager = NotificationManager()


@router.websocket("/ws/notifications")
async def websocket_notifications(websocket: WebSocket, token: str = Query(None)):
    """
    WebSocket endpoint for real-time notifications.
    
    Client connects with: ws://server/ws/notifications?token=<jwt_token>
    
    Receives messages like:
    {
        "type": "reminder",
        "message": "Take a break!",
        "timestamp": 1609459200
    }
    """
    
    # Authenticate via single-use SSE exchange token only.
    if not token:
        await websocket.close(code=1008, reason="No token provided")
        return

    user = auth.authenticate_ws_token(token)
    if not user:
        await websocket.close(code=1008, reason="Invalid token")
        return
    username = user.username
    user_id = f"user_{user.id}"

    # Connect and listen
    await manager.connect(user_id, websocket)
    log_line("websocket", "📡", "WS_OPEN", f"WebSocket opened for {user_id} (username={username})")
    
    try:
        while True:
            # Keep connection alive, receive heartbeat/ping from client
            data = await websocket.receive_text()
            
            # Handle ping/pong for keepalive
            if data == "ping":
                await websocket.send_json({"type": "pong"})
            elif data.startswith("ping:"):
                msg_id = data.split(":", 1)[1]
                await websocket.send_json({"type": "pong", "echo": msg_id})
    
    except WebSocketDisconnect:
        await manager.disconnect(user_id, websocket)
    except Exception as e:
        log_line("websocket", "⚠️", "WS_ERROR", f"User {user_id}: {e}")
        try:
            await manager.disconnect(user_id, websocket)
        except Exception:
            pass  # Best-effort cleanup after prior error


async def send_reminder_via_websocket(user_id: str, message: str, notification_id: str = None, session_id: str = None, notification_type: str = "reminder") -> bool:
    """
    Send reminder/automation to user via WebSocket if connected.
    Returns True if sent, False if no active connection.
    
    Notification format includes session_id so frontend knows which session
    the notification was saved to (for persistence and reload).
    """
    import time
    notification = {
        "type": notification_type,
        "title": "Hyve",
        "message": message,
        "notification_id": notification_id or f"notif_{user_id}_{int(time.time())}",
        "session_id": session_id,
        "timestamp": int(time.time())
    }
    success = await manager.broadcast_to_user(user_id, notification)
    
    if success:
        log_line("websocket", "📤", "REMINDER_WS", f"Sent to {user_id}: {message[:80]}")
        log_detail("notifications", "REMINDER_WS_SENT", user_id=user_id)
    else:
        log_line("websocket", "📵", "REMINDER_WS_NO_CONNECTION", f"No active connection for {user_id}")
        log_detail("notifications", "REMINDER_WS_NO_CONNECTION", user_id=user_id)
    
    return success


# --- DIAGNOSTIC / TEST ENDPOINTS ---

@router.get("/api/notifications/ws-status")
async def ws_status(current_user: models.User = Depends(auth.get_current_user)):
    """Check WebSocket connection status for current user."""
    user_id = f"user_{current_user.id}"
    has_conn = manager.has_active_connection(user_id)
    conn_count = len(manager.active_connections.get(user_id, set()))
    payload = {
        "user_id": user_id,
        "username": current_user.username,
        "connected": has_conn,
        "connection_count": conn_count,
    }
    if current_user.is_admin:
        payload["all_connections"] = manager.get_status()
    return payload


@router.post("/api/notifications/test")
async def test_notification(current_user: models.User = Depends(auth.get_current_user)):
    """Send a test notification to verify WebSocket delivery works."""
    user_id = f"user_{current_user.id}"
    log_line("websocket", "🧪", "TEST_NOTIF", f"Test notification for {user_id} ({current_user.username})")
    
    import time
    test_id = f"test_ws_{int(time.time())}"
    success = await send_reminder_via_websocket(
        user_id,
        "🧪 Test WebSocket notification",
        notification_id=test_id,
        notification_type="reminder",
    )
    
    return {
        "user_id": user_id, 
        "delivered_via_ws": success,
        "active_connections": manager.get_status()
    }


@router.post("/api/notifications/test-channel")
async def test_notification_channel(request: Request, current_user: models.User = Depends(auth.get_current_user)):
    """Send a test notification on a specific transport channel.
    Body: { "transport": "websocket" | "firebase" }
    """
    import time
    import core.push_fcm as push_fcm

    try:
        body = await request.json()
    except Exception:
        body = {}

    user_id = f"user_{current_user.id}"
    transport = str(body.get("transport", "websocket")).lower()
    log_line("websocket", "🧪", "TEST_CHANNEL", f"Test {transport} for {user_id} ({current_user.username})")

    result = {"transport": transport, "delivered": False, "detail": ""}

    if transport == "websocket":
        test_msg = "🧪 Test notificare WebSocket"
        try:
            ws_ok = await send_reminder_via_websocket(
                user_id, test_msg,
                notification_id=f"test_ws_{int(time.time())}",
                notification_type="reminder",
            )
            result["delivered"] = bool(ws_ok)
            if not ws_ok:
                result["detail"] = "no_ws_connection"
        except Exception as e:
            log_line("error", "⚠️", "TEST_WS", str(e))
            result["detail"] = str(e)

    elif transport == "firebase":
        test_msg = "🧪 Test notificare FCM"
        if not push_fcm.is_fcm_enabled():
            result["detail"] = "fcm_disabled"
            return result
        try:
            sent = push_fcm.send_push_notification(
                user_id=user_id, title="Hyve", message=test_msg,
                notification_id=f"test_fcm_{int(time.time())}",
                notification_type="reminder",
            )
            result["delivered"] = int(sent or 0) > 0
            result["sent_count"] = int(sent or 0)
            if not result["delivered"]:
                result["detail"] = "no_devices"
        except Exception as e:
            log_line("error", "⚠️", "TEST_FCM", str(e))
            result["detail"] = str(e)
    else:
        result["detail"] = "unknown_transport"

    return result
