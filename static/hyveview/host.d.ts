/** Hyveview host shim — dashboard publishes helpers via setHost(). */

export function setHost(partial: Record<string, unknown>): void;

export function widgetTitle(
    widget: unknown,
    fallbacks?: { entityName?: string; entityId?: string },
): string;

export const host: Record<string, unknown>;
