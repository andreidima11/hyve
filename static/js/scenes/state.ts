/**
 * Scenes UI — shared state and constants.
 */
import type {
    SceneEntityCatalogItem,
    SceneEntry,
    SceneService,
    SceneSummary,
} from '../types/scenes.js';

export const _MAX_ENTRIES = 64;
export const _SERVICE_VALUES: SceneService[] = ['turn_on', 'turn_off', 'toggle'];
export interface SceneEditorState {
    mode: 'create' | 'edit';
    sceneId: string | null;
    entries: SceneEntry[];
    entityPickerTargetIdx: number;
}

export const sceneState = {
    scenesCache: [] as SceneSummary[],
    entityCatalog: [] as SceneEntityCatalogItem[],
    entityCatalogLoaded: false,
    editorState: {
        mode: 'create' as 'create' | 'edit',
        sceneId: null as string | null,
        entries: [] as SceneEntry[],
        entityPickerTargetIdx: -1,
    },
};

