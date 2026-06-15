/** DOMContentLoaded orchestration. */

import { initShellPreBindings, initShellPostBindings } from './shell_boot.js';
import { initDelegatedBindings } from './delegated.js';
import { initChatInputBindings } from './chat_inputs.js';

export function initDomReadyBindings(): void {
    initShellPreBindings();
    initDelegatedBindings();
    initShellPostBindings();
    initChatInputBindings();
}
