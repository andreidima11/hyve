/**
 * Memory UI — shared state and constants.
 */
import type { MemoryExtractionExample, MemoryFact } from '../types/memory.js';

export const MEM_LOG_PAGE_SIZE = 12;
export const MEM_PER_PAGE = 12;

export const memoryState = {
    cache: [] as MemoryFact[],
    page: 1,
    logOffset: 0,
    logTotal: 0,
    extractionExamples: [] as MemoryExtractionExample[],
};

export const memoryUiState = {
    memLogTypeDropdownBound: false,
};

