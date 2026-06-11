export const areaState = {
    areasCache: [],
    allEntitiesCache: [],
    entitiesCacheTime: 0,
    editorState: {
        mode: 'create',
        areaId: null,
        synced: false,
        entities: [],
    },
    pickerSelected: new Set(),
    pickerFilter: '',
};
