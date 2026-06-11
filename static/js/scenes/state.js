export const _MAX_ENTRIES = 64;
export const _SERVICE_VALUES = ['turn_on', 'turn_off', 'toggle'];
export const sceneState = {
    scenesCache: [],
    entityCatalog: [],
    entityCatalogLoaded: false,
    editorState: {
        mode: 'create',
        sceneId: null,
        entries: [],
        entityPickerTargetIdx: -1,
    },
};
