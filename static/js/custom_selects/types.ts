export interface PortaledSelectMenu extends HTMLDivElement {
    __placeholder?: Comment | null;
    __ownerDd?: GenericCustomSelectElement | null;
}

export interface GenericCustomSelectElement extends HTMLElement {
    __portaledMenu?: PortaledSelectMenu | null;
}

export interface UpgradableNativeSelect extends HTMLSelectElement {
    _optObserver?: MutationObserver;
}
