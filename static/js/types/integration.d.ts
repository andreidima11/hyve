/** Integration UI event-handler and control payloads. */

export type ControlPayload =
    | Record<string, unknown>
    | { brightness: number }
    | { value: number | string }
    | null;

export interface IntegrationEventHandlers {
    controlIntegrationEntity?: (
        slug: string,
        entityId: string,
        cmd: string,
        el: HTMLElement,
        payload: ControlPayload,
    ) => void | Promise<void>;
    openIntegrationEntityCard?: (encoded: string) => void;
    openIntegrationDeviceModal?: (idx: number, slug: string) => void;
    renameIntegrationDevice?: (
        slug: string,
        deviceId: string,
        deviceName: string,
    ) => void | Promise<void>;
    [key: string]: unknown;
}

export type SmarthomeEventHandlers = Record<string, (...args: unknown[]) => unknown>;

/** Generic delegated UI handler map (chat, planner, config, etc.). */
export type DelegatedEventHandlers = Record<string, (...args: unknown[]) => unknown>;

export interface EntityStateChangedDetail {
    entity_id?: string;
    state?: string | number | null;
    raw?: unknown;
    attributes_delta?: Record<string, unknown>;
    type?: string;
}
