/**
 * Memory UI facade.
 */
import { memoryState } from './memory/state.js';
/** @deprecated use memoryState.cache */
export const memCache = memoryState.cache;
export { memoryState } from './memory/state.js';
export { loadMemory, loadMemoryEvents, memLogPrevPage, memLogNextPage, toggleMemLogDetails, clearMemoryLog, runConsolidationNow, getExtractionExamples, renderExtractionExamples, addExtractionExample, removeExtractionExample, loadReminders, deleteReminder, openMementoEdit, closeMementoEdit, saveMementoEdit, updateMementoBulkCount, toggleAllMemento, deleteMementoBulk, toggleMemLogTypeDropdown, setMemLogType, switchMemorySubtab, renderMemoryTable, toggleAllMem, updateMemBulkCount, deleteMemBulk, changeMemPage, filterMemory, updateMemory, } from './memory/page.js';
