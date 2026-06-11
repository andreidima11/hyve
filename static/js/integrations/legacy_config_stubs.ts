/**
 * No-op exports for removed integration config UI (0.9.1).
 * Keeps older cached app.js module graphs loading after upgrades.
 */
export function renderCctvCameras(_cameras: unknown[]): void {}

export function copyAssistOllamaUserUrl(): void {}

export function copyAssistKey(): void {}

export async function regenerateAssistKey(): Promise<void> {}
