/** Shared IANA timezone list for setup and settings. */

export const COMMON_TIMEZONES = [
    'Europe/Bucharest',
    'Europe/London',
    'Europe/Berlin',
    'Europe/Paris',
    'Europe/Madrid',
    'Europe/Rome',
    'Europe/Athens',
    'Europe/Helsinki',
    'Europe/Warsaw',
    'Europe/Chisinau',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Toronto',
    'Asia/Dubai',
    'Asia/Singapore',
    'Asia/Tokyo',
    'Australia/Sydney',
    'UTC',
] as const;

export function detectBrowserTimezone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
        return '';
    }
}

/** Fill a `<select>` with common timezones plus detected / saved values. */
export function populateTimezoneSelect(
    select: HTMLSelectElement | null,
    preferred?: string,
): void {
    if (!select) return;
    const detected = detectBrowserTimezone();
    const values = new Set<string>(COMMON_TIMEZONES);
    if (detected) values.add(detected);
    const pref = String(preferred || '').trim();
    if (pref) values.add(pref);

    select.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '—';
    select.appendChild(empty);

    for (const tz of [...values].sort()) {
        const opt = document.createElement('option');
        opt.value = tz;
        opt.textContent = tz;
        select.appendChild(opt);
    }

    const pick = pref || detected || 'Europe/Bucharest';
    if ([...select.options].some((o) => o.value === pick)) {
        select.value = pick;
    } else if (pref === '') {
        select.value = '';
    }
}
