/**
 * Dashboard overflow menu — open/close and viewport positioning.
 */

interface DashboardMenuDeps {
    closeDashboardClimateModeMenus: () => void;
}

let _deps: DashboardMenuDeps | null = null;
let _listenersBound = false;

function deps(): DashboardMenuDeps {
    if (!_deps) throw new Error('Dashboard menu not initialized');
    return _deps;
}

function _bindDashboardMenuButton(): void {
    const btn = document.getElementById('dashboard-menu-button');
    if (!btn || btn.dataset.menuBound === '1') return;
    btn.dataset.menuBound = '1';
    btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleDashboardMenu();
    });
}

export function initDashboardMenu(depsIn: DashboardMenuDeps): void {
    _deps = depsIn;
    if (_listenersBound) return;
    _listenersBound = true;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _bindDashboardMenuButton, { once: true });
    } else {
        _bindDashboardMenuButton();
    }

    document.addEventListener('click', (event) => {
        const d = deps();
        d.closeDashboardClimateModeMenus();
        const menu = document.getElementById('dashboard-more-menu');
        const wrap = menu?.parentElement;
        const btn = document.getElementById('dashboard-menu-button');
        if (!menu || menu.classList.contains('hidden')) return;
        if (btn && event.target instanceof Node && btn.contains(event.target)) return;
        if (wrap && event.target instanceof Node && !wrap.contains(event.target)) {
            closeDashboardMenu();
        }
    });

    window.addEventListener('resize', () => {
        positionDashboardMenu();
    });
}

function positionDashboardMenu(): void {
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

function setDashboardMenuOpen(open: boolean): void {
    const menu = document.getElementById('dashboard-more-menu');
    const btn = document.getElementById('dashboard-menu-button');
    if (!menu) return;
    menu.classList.toggle('hidden', !open);
    if (btn) btn.classList.toggle('is-open', !!open);
    if (open) requestAnimationFrame(positionDashboardMenu);
}

export function toggleDashboardMenu(): void {
    const menu = document.getElementById('dashboard-more-menu');
    if (!menu) return;
    setDashboardMenuOpen(menu.classList.contains('hidden'));
}

export function closeDashboardMenu(): void {
    setDashboardMenuOpen(false);
}
