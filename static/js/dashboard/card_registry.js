// Hyve dashboard — card registry (Pas 3 al refactor-ului).
//
// Scop: să avem un singur loc unde se înregistrează tipuri de carduri
// (button, switch, climate, etc.), astfel încât rendererele să poată fi
// mutate aici progresiv din dashboard.js, file by file, fără un big-bang.
//
// Folosire (când un renderer va fi migrat aici):
//
//   import { registerCard } from './dashboard/card_registry.js';
//
//   registerCard({
//       type: 'button',
//       // Returnează HTML pentru cardul complet (sau un DocumentFragment).
//       render(widget, ctx) { ... },
//       // Update-uri incrementale când vine un nou state pe WS, fără
//       // re-render complet — ctx.cardEl este nodul .hyve-dashboard-card.
//       update(widget, state, ctx) { ... },
//       // Schema pentru validare (când vom face validare YAML-side):
//       defaults: { size: 'sm', config: {} },
//   });
//
// Cardurile rămase încă în dashboard.js continuă să funcționeze prin
// fallback-ul de mai jos până sunt migrate aici. Module extrase: constants.js,
// helpers.js, widget_actions.js; vezi și debug.js, hyveview_setup.js,
// yaml_editor.js, pull_refresh.js, live_ws.js, entity_patch.js.

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

// Optional: export the raw map (read-only) for debug tooling.
export function _debugRegistry() {
    return Array.from(_registry.entries()).map(([k, v]) => ({
        type: k,
        hasRender: !!v.render,
        hasUpdate: !!v.update,
    }));
}
