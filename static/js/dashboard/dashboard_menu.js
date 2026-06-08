/**
 * Dashboard overflow menu — open/close and viewport positioning.
 */

/** @type {object | null} */
let _deps = null;
let _listenersBound = false;

function deps() {
    if (!_deps) throw new Error('Dashboard menu not initialized');
    return _deps;
}

export function initDashboardMenu(depsIn) {
    _deps = depsIn;
    if (_listenersBound) return;
    _listenersBound = true;

    document.addEventListener('click', (event) => {
        const d = deps();
        d.closeDashboardClimateModeMenus();
        const menu = document.getElementById('dashboard-more-menu');
        const wrap = menu?.parentElement;
        if (!menu || menu.classList.contains('hidden')) return;
        if (wrap && !wrap.contains(event.target)) {
            closeDashboardMenu();
        }
    });

    window.addEventListener('resize', () => {
        positionDashboardMenu();
    });
}

function positionDashboardMenu() {
    const menu = document.getElementById('dashboard-more-menu');
    if (!menu || menu.classList.contains('hidden')) return;

    menu.style.transform = 'translateX(0)';
    const padding = 8;
    const rect = menu.getBoundingClientRect();

    if (rect.right > window.innerWidth - padding) {
        const shift = rect.right - (window.innerWidth - padding);
        menu.style.transform = `translateX(-${shift}px)`;
        return;
    }
    if (rect.left < padding) {
        const shift = padding - rect.left;
        menu.style.transform = `translateX(${shift}px)`;
    }
}

function setDashboardMenuOpen(open) {
    const menu = document.getElementById('dashboard-more-menu');
    const btn = document.getElementById('dashboard-menu-button');
    if (!menu) return;
    menu.classList.toggle('hidden', !open);
    if (btn) btn.classList.toggle('is-open', !!open);
    if (open) requestAnimationFrame(positionDashboardMenu);
}

export function toggleDashboardMenu() {
    const menu = document.getElementById('dashboard-more-menu');
    if (!menu) return;
    setDashboardMenuOpen(menu.classList.contains('hidden'));
}

export function closeDashboardMenu() {
    setDashboardMenuOpen(false);
}
