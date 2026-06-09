/** Map Settings → Integrări slug to entity ``source`` values in snapshots. */

export function entitySourcesForIntegration(slug: string): string[] {
    const key = String(slug || '').trim().toLowerCase();
    if (!key) return [];
    if (key === 'mosquitto') return ['mosquitto', 'zigbee2mqtt'];
    return [key];
}

export function entityMatchesIntegration(entitySource: string, slug: string): boolean {
    const src = String(entitySource || '').trim().toLowerCase();
    return entitySourcesForIntegration(slug).includes(src);
}

export function integrationSlugsMatch(left: string, right: string): boolean {
    const a = String(left || '').trim().toLowerCase();
    const b = String(right || '').trim().toLowerCase();
    if (!a || !b) return false;
    if (a === b) return true;
    const sources = new Set(entitySourcesForIntegration(a));
    return sources.has(b);
}
