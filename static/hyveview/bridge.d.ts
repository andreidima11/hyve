/** Type declarations for Hyveview ↔ dashboard bridge (runtime: bridge.js). */

import type { HyveviewCardClass, HyveviewCardSpecPublic, RegisterCardOptions } from './types/card.js';
import type { HyveviewWidget, WidgetEntityIdsResolver } from './types/widget.js';

export function effectiveCardType(widget: HyveviewWidget | null | undefined): string;

export function setWidgetEntityIdsResolver(fn: WidgetEntityIdsResolver | null): void;

export function registerCard(
    type: string,
    ElementClass: HyveviewCardClass,
    options?: RegisterCardOptions,
): void;

export function isRegistered(type: string): boolean;

export function renderCardElement(widget: HyveviewWidget | null | undefined): string;

export function configureMounted(
    root: ParentNode | null | undefined,
    widgetById: (id: string) => unknown,
    options?: { bootstrapStates?: (el: Element, widget: unknown) => void },
): void;

export function patchEntityStates(
    updatesByEntityId: Map<string, unknown>,
    widgetById: (id: string) => unknown,
): Set<string>;

export function registeredTypes(): string[];

export function getCardSpec(type: string): HyveviewCardSpecPublic | null;

export function listCards(options?: { includeHidden?: boolean }): HyveviewCardSpecPublic[];
