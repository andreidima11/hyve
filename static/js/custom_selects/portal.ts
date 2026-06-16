/**
 * Portal custom-select menus to document.body (escapes overflow:hidden modals).
 */
import type { PortaledSelectMenu } from './types.js';

const MENU_Z = 9999;

export function positionPortaledSelectMenu(
    anchorButton: HTMLElement,
    menu: HTMLElement,
): void {
    const r = anchorButton.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.left = `${Math.round(r.left)}px`;
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    menu.style.right = 'auto';
    menu.style.width = `${Math.round(r.width)}px`;
    menu.style.minWidth = `${Math.round(r.width)}px`;
    menu.style.zIndex = String(MENU_Z);
    const mh = menu.offsetHeight;
    if (r.bottom + 6 + mh > window.innerHeight && r.top - 6 - mh > 0) {
        menu.style.top = `${Math.round(r.top - 6 - mh)}px`;
    }
}

export function portalSelectMenu(
    owner: HTMLElement,
    menu: PortaledSelectMenu,
    portaledClass = 'dashboard-custom-select__menu--portaled',
): void {
    if (menu.parentElement !== document.body) {
        const ph = document.createComment('cselect-menu');
        menu.__placeholder = ph;
        menu.__ownerDd = owner;
        menu.parentElement!.insertBefore(ph, menu);
        document.body.appendChild(menu);
    }
    if (portaledClass) menu.classList.add(portaledClass);
    if (portaledClass === 'dashboard-custom-select__menu--portaled') {
        menu.style.display = 'grid';
        menu.style.gap = '3px';
    }
}

export function restorePortaledSelectMenu(
    owner: HTMLElement,
    menu: PortaledSelectMenu | null | undefined,
    portaledClass = 'dashboard-custom-select__menu--portaled',
): void {
    if (!menu) return;
    if (portaledClass) menu.classList.remove(portaledClass);
    menu.style.display = '';
    menu.style.position = '';
    menu.style.left = '';
    menu.style.top = '';
    menu.style.right = '';
    menu.style.width = '';
    menu.style.minWidth = '';
    menu.style.zIndex = '';
    menu.style.gap = '';
    if (menu.__placeholder?.parentElement) {
        menu.__placeholder.parentElement.insertBefore(menu, menu.__placeholder);
        menu.__placeholder.remove();
    }
    menu.__placeholder = null;
    if (menu.__ownerDd === owner) menu.__ownerDd = null;
}

export function bindPortaledSelectMenuReposition(
    ownerSelector: string,
    getMenu: (owner: HTMLElement) => HTMLElement | null | undefined,
): () => void {
    const reposition = () => {
        document.querySelectorAll(`${ownerSelector}[data-open="true"]`).forEach((owner) => {
            const el = owner as HTMLElement;
            const menu = getMenu(el);
            const btn = el.querySelector('[data-hy-picker-toggle], .dashboard-custom-select__button');
            if (menu && btn instanceof HTMLElement) positionPortaledSelectMenu(btn, menu);
        });
    };
    window.addEventListener('resize', reposition);
    document.addEventListener('scroll', reposition, true);
    return reposition;
}
