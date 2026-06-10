/** Hyveview host shim — dashboard publishes helpers via setHost(). */

import type { HyveviewHostApi, WidgetTitleFallbacks } from './types/host.js';

export function setHost(partial: Partial<HyveviewHostApi> | null | undefined): void;

export function widgetTitle(widget: unknown, fallbacks?: WidgetTitleFallbacks): string;

export const host: HyveviewHostApi;
