/** Dashboard card catalog from `/api/dashboard/catalog`. */
let _cache = null;
export async function loadDashboardCardCatalog(apiCall, force = false) {
    if (_cache && !force)
        return _cache;
    try {
        const res = await apiCall('/api/dashboard/catalog');
        if (!res.ok)
            throw new Error('Catalog indisponibil');
        const data = await res.json().catch(() => ({}));
        _cache = Array.isArray(data.cards) ? data.cards : [];
    }
    catch {
        _cache = [];
    }
    return _cache;
}
export function getDashboardCardCatalog() {
    return Array.isArray(_cache) ? _cache : [];
}
export function getDashboardCardMeta(type) {
    const id = String(type || '').trim();
    const cards = getDashboardCardCatalog();
    return cards.find((card) => card && card.id === id) || {};
}
export function dashboardCardIcon(card) {
    if (card.icon)
        return card.icon;
    const map = {
        button: 'fas fa-toggle-on',
        switch: 'fas fa-toggle-on',
        info: 'fas fa-circle-info',
        weather: 'fas fa-cloud-sun',
        weather_rich: 'fas fa-cloud-sun-rain',
        label: 'fas fa-heading',
        scene: 'fas fa-wand-magic-sparkles',
        tile: 'fas fa-square',
        light: 'fas fa-lightbulb',
        sensor: 'fas fa-gauge-simple-high',
        climate: 'fas fa-temperature-half',
        gauge: 'fas fa-gauge-high',
        lock: 'fas fa-lock',
        vacuum: 'fas fa-robot',
        fusion_solar: 'fas fa-solar-panel',
        picture: 'fas fa-images',
    };
    return map[String(card.renderer || '')] || map[String(card.id || '')] || 'fas fa-square-plus';
}
export function dashboardDefaultRowsForType(type) {
    const renderer = String(getDashboardCardMeta(type).renderer || type || '').toLowerCase();
    if (renderer === 'climate')
        return 2;
    if (renderer === 'weather_rich')
        return 3;
    if (renderer === 'fusion_solar')
        return 2;
    if (renderer === 'gauge')
        return 2;
    if (renderer === 'camera' || renderer === 'picture')
        return 3;
    return 1;
}
export function dashboardEditorRenderer(type, { editingRenderer = '' } = {}) {
    const renderer = String(getDashboardCardMeta(type).renderer || type || '').trim().toLowerCase();
    if (editingRenderer === 'camera')
        return 'camera';
    return renderer || 'button';
}
