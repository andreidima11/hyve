/**
 * Publish shared render helpers to Hyveview card classes (avoids circular imports).
 */

export function publishDashboardHyveviewHost(
    HVSetHost: (partial: Record<string, unknown>) => void,
    deps: Record<string, unknown>,
): void {
    HVSetHost(deps);
}
