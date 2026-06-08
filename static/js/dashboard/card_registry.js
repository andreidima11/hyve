// Hyve dashboard — card registry.
//
// Widget renderers live in ./cards/renderers.js and register via
// ./cards/register.js (called once from dashboard.js). Climate cards keep
// their own deps module (climate.js). Use registerCard() to add new types or
// override bundled renderers from custom code.

const _registry = new Map();

export function registerCard(spec) {
    if (!spec || typeof spec !== 'object') return;
    const type = String(spec.type || '').trim();
    if (!type) return;
    _registry.set(type, {
        type,
        render: typeof spec.render === 'function' ? spec.render : null,
        update: typeof spec.update === 'function' ? spec.update : null,
        defaults: spec.defaults && typeof spec.defaults === 'object' ? spec.defaults : {},
    });
}

export function getCard(type) {
    return _registry.get(String(type || '')) || null;
}

export function hasCard(type) {
    return _registry.has(String(type || ''));
}

export function listCardTypes() {
    return Array.from(_registry.keys());
}

export function _debugRegistry() {
    return Array.from(_registry.entries()).map(([k, v]) => ({
        type: k,
        hasRender: !!v.render,
        hasUpdate: !!v.update,
    }));
}
