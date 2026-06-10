/** Widget payload passed from dashboard into Hyveview card elements. */

import type { HyveviewEntityState } from './card.js';
import type { HyveviewWidget } from './widget.js';

export type CardWidget = HyveviewWidget & Record<string, unknown>;

export type { HyveviewEntityState };
