/** Type declarations for Hyveview ↔ dashboard bridge (runtime: bridge.js). */

export function effectiveCardType(widget: unknown): string | undefined;

export function setWidgetEntityIdsResolver(fn: (widget: unknown) => string[]): void;

export function registerCard(
    type: string,
    ElementClass: CustomElementConstructor,
    options?: { tagName?: string; render?: unknown },
): void;

export function isRegistered(type: string): boolean;

export function renderCardOuter(widget: unknown, outerHtmlParts: unknown): string;

export function renderCardElement(widget: unknown): string;

export function configureMounted(
    rootElement: Element,
    widgetById: (id: string) => unknown,
    options?: { bootstrapStates?: (el: Element, widget: unknown) => void },
): void;

export function patchEntityStates(
    updatesByEntityId: Map<string, unknown>,
    widgetById: (id: string) => unknown,
): Set<string>;

export function getCardSpec(type: string): { shell?: Record<string, unknown> } | null | undefined;
