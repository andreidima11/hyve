/** Delegated bindings — compose domain init hooks. */

import { initChatDelegatedBindings } from './chat.js';
import { initPlannerDelegatedBindings } from './planner.js';
import { initSkillsDelegatedBindings } from './skills.js';
import { initUserDelegatedBindings } from './user.js';
import { initConfigDelegatedBindings } from './config.js';
import { initMemoryDelegatedBindings } from './memory.js';
import { initShellDelegatedBindings } from './shell.js';
import { initSmarthomeDelegatedBindings } from './smarthome.js';
import { initIntegrationsDelegatedBindings } from './integrations.js';

export function initDelegatedBindings(): void {
    initChatDelegatedBindings();
    initPlannerDelegatedBindings();
    initSkillsDelegatedBindings();
    initUserDelegatedBindings();
    initConfigDelegatedBindings();
    initMemoryDelegatedBindings();
    initShellDelegatedBindings();
    initSmarthomeDelegatedBindings();
    initIntegrationsDelegatedBindings();
}
