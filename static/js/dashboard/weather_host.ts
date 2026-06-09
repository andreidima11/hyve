/**
 * Weather icon/variant helpers published to Hyveview via HVSetHost.
 */

export function weatherVariant(cond: unknown): string {
    const c = String(cond || '').toLowerCase();
    if (c.includes('storm') || c.includes('thunder') || c.includes('furtună') || c.includes('furtuna')) return 'storm';
    if (c.includes('snow') || c.includes('zăpad') || c.includes('zapad')) return 'snow';
    if (c.includes('rain') || c.includes('ploaie') || c.includes('shower') || c.includes('drizzle') || c.includes('burniță') || c.includes('burnita')) return 'rain';
    if (c.includes('fog') || c.includes('mist') || c.includes('ceață') || c.includes('ceata')) return 'fog';
    if (c.includes('partly') || c.includes('parțial') || c.includes('partial')) return 'partly';
    if (c.includes('cloud') || c.includes('înnorat') || c.includes('innorat') || c.includes('overcast')) return 'cloud';
    if (c.includes('clear') || c.includes('senin') || c.includes('sunny')) return 'clear';
    return 'clear';
}

export function weatherIsNight(attrs: Record<string, unknown> | null | undefined): boolean {
    if (attrs && (attrs.is_night === true || attrs.is_day === false)) return true;
    if (attrs && (attrs.is_night === false || attrs.is_day === true)) return false;
    const h = new Date().getHours();
    return h < 6 || h >= 20;
}

export function weatherIcon(cond: unknown, isNight = false): string {
    const c = String(cond || '').toLowerCase();
    if (c.includes('clear') || c.includes('senin') || c.includes('sunny')) return isNight ? 'fas fa-moon' : 'fas fa-sun';
    if (c.includes('partly') || c.includes('parțial') || c.includes('partial')) return isNight ? 'fas fa-cloud-moon' : 'fas fa-cloud-sun';
    if (c.includes('cloud') || c.includes('înnorat') || c.includes('innorat')) return 'fas fa-cloud';
    if (c.includes('rain') || c.includes('ploaie') || c.includes('shower')) return 'fas fa-cloud-showers-heavy';
    if (c.includes('snow') || c.includes('zăpad') || c.includes('zapad')) return 'fas fa-snowflake';
    if (c.includes('storm') || c.includes('thunder') || c.includes('furtună') || c.includes('furtuna')) return 'fas fa-bolt';
    if (c.includes('fog') || c.includes('mist') || c.includes('ceață') || c.includes('ceata')) return 'fas fa-smog';
    return isNight ? 'fas fa-cloud-moon' : 'fas fa-cloud-sun';
}
