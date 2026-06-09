/** Entity id alias helpers — Z2M expose vs HA MQTT discovery naming. */
export function entityIdVariants(entityId) {
    const raw = String(entityId || '').trim();
    if (!raw)
        return [];
    const dot = raw.indexOf('.');
    if (dot < 0)
        return [raw];
    const domain = raw.slice(0, dot);
    const objectId = raw.slice(dot + 1);
    const variants = [raw];
    const stateMatch = objectId.match(/^(.+)_state_(l\d+)$/i);
    if (stateMatch) {
        variants.push(`${domain}.${stateMatch[1]}_${stateMatch[2]}`);
    }
    else {
        const endpointMatch = objectId.match(/^(.+)_(l\d+)$/i);
        if (endpointMatch) {
            variants.push(`${domain}.${endpointMatch[1]}_state_${endpointMatch[2]}`);
        }
    }
    return [...new Set(variants.filter(Boolean))];
}
export function findEntityById(items, entityId) {
    const list = Array.isArray(items) ? items : [];
    for (const variant of entityIdVariants(entityId)) {
        const hit = list.find((item) => item?.entity_id === variant || item?.unique_id === variant);
        if (hit)
            return hit;
    }
    return null;
}
export function updatesGetWithAliases(updates, entityId) {
    if (!updates || entityId == null)
        return null;
    for (const variant of entityIdVariants(entityId)) {
        const hit = updates.get(variant);
        if (hit)
            return hit;
    }
    return null;
}
export function updatesHasWithAliases(updates, entityId) {
    return Boolean(updatesGetWithAliases(updates, entityId));
}
