/** Delegated DOM event-handler maps (config, memory, smarthome, chat, etc.). */

export type EventBindingHandler = (...args: unknown[]) => unknown;

/** Config hub / settings (`data-config-action`). */
export type ConfigEventHandlers = Record<string, EventBindingHandler | undefined>;

/** Intelligence / memory / automations (`data-memory-action`). */
export type MemoryEventHandlers = Record<string, EventBindingHandler | undefined>;

/** Smarthome + derived entities (`data-smarthome-action`). */
export type SmarthomeEventHandlers = Record<string, EventBindingHandler | undefined>;

/** Generic delegated handlers (chat, planner, shell, user, skills). */
export type DelegatedEventHandlers = Record<string, EventBindingHandler | undefined>;
