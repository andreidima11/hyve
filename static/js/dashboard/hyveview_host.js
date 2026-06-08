/**
 * Publish shared render helpers to Hyveview card classes (avoids circular imports).
 */

export function publishDashboardHyveviewHost(HVSetHost, deps) {
    HVSetHost(deps);
}
