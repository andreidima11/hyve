/** User notifications panel and WebSocket payload types. */

export type NotificationFilter =
    | 'all'
    | 'unread'
    | 'reminder'
    | 'automation'
    | 'system'
    | 'archived';

export interface NotificationSuggestedAction {
    tool?: string;
    label?: string;
    args?: { url?: string };
}

export interface NotificationItem {
    id: string;
    title?: string;
    body?: string;
    category?: string;
    severity?: string;
    action_url?: string;
    created_at?: string;
    read_at?: string | null;
    archived_at?: string | null;
    payload?: {
        suggested_actions?: NotificationSuggestedAction[];
    };
}

export interface NotificationListResponse {
    items?: NotificationItem[];
    total?: number;
    unread_count?: number;
}

export interface NotificationCountResponse {
    unread_count?: number;
}

export interface NotificationMutationResponse {
    unread_count?: number;
    deleted?: number;
}

export interface NotificationWsPayload {
    event?: string;
    type?: string;
    unread_count?: number;
    notification?: NotificationItem & { body?: string };
    notification_id?: string;
    message?: string;
}

export interface HyveNotificationWebSocket extends WebSocket {
    _pingInterval?: ReturnType<typeof setInterval>;
}

export interface NotificationsController {
    stop: () => void;
    setEnabled: (enabled: boolean) => void;
    isEnabled: () => boolean;
}
