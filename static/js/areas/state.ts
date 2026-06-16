/**
 * Areas UI — shared types and state.
 */
import type { HyveEntity } from '../types/entity.js';

export interface HyveArea {
    id: string;
    name?: string;
    aliases?: string[];
    synced?: boolean;
    icon?: string;
    floor?: string;
    extra_entities?: string[];
}

export interface AreaEditorState {
    mode: 'create' | 'edit';
    areaId: string | null;
    synced: boolean;
    entities: string[];
}
export type AreaEntityRef = HyveEntity & {
    friendly_name?: string;
    area?: string;
};

export const areaState = {
    areasCache: [] as HyveArea[],
    listFilter: '',
    allEntitiesCache: [] as AreaEntityRef[],
    entitiesCacheTime: 0,
    editorState: {
        mode: 'create' as 'create' | 'edit',
        areaId: null as string | null,
        synced: false,
        entities: [] as string[],
    },
    pickerSelected: new Set<string>(),
    pickerFilter: '',
};

