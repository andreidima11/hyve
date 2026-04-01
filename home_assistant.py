import asyncio
import httpx
import json
import os
import traceback
from typing import Optional
import settings as settings_mod
import logger as log_mod

CONFIG_FILE = "ha_entities.json"

# --- DEVICE LIST CACHE (avoids re-reading ha_entities.json + formatting on every request) ---
_device_list_cache: dict = {"text": "", "mtime": 0.0}

# --- SHARED ASYNC CLIENT (connection pooling for HA calls) ---
_ha_client: Optional[httpx.AsyncClient] = None
_ha_lock = asyncio.Lock()


async def _get_ha_client() -> httpx.AsyncClient:
    """Shared AsyncClient for Home Assistant API calls (lazy init, reused)."""
    global _ha_client
    if _ha_client is not None:
        return _ha_client
    async with _ha_lock:
        if _ha_client is not None:
            return _ha_client
        _ha_client = httpx.AsyncClient(
            timeout=10.0,
            limits=httpx.Limits(max_keepalive_connections=4, keepalive_expiry=30.0),
        )
    return _ha_client


async def close_ha_client() -> None:
    """Close the shared HA client (call on shutdown)."""
    global _ha_client
    async with _ha_lock:
        if _ha_client is not None:
            await _ha_client.aclose()
            _ha_client = None


# --- CORE API ---
async def fetch_ha_states():
    """Aduce stările brute direct din API-ul Home Assistant."""
    ha = settings_mod.CFG.get("home_assistant", {})
    if not ha.get("enabled"): 
        return []
    url = f"{ha['url']}/api/states"
    headers = {
        "Authorization": f"Bearer {ha['token']}", 
        "Content-Type": "application/json"
    }
    client = await _get_ha_client()
    try:
        resp = await client.get(url, headers=headers, timeout=5.0)
        return resp.json() if resp.status_code == 200 else []
    except Exception:
        log_mod.log_line("error", "❌", "HA API", traceback.format_exc())
        return []

async def call_service(domain, service, entity_id, service_data=None):
    """Execute an HA service call. Accepts optional service_data dict (brightness, color_temp, etc.). Returns dict with ok=True or error/status_code."""
    ha = settings_mod.CFG.get("home_assistant", {})
    if not ha.get("enabled"):
        return {"ok": False, "error": "Home Assistant disabled"}
    url = f"{ha['url']}/api/services/{domain}/{service}"
    headers = {"Authorization": f"Bearer {ha['token']}"}
    payload = {"entity_id": entity_id}
    if service_data and isinstance(service_data, dict):
        payload.update(service_data)
    client = await _get_ha_client()
    try:
        resp = await client.post(url, headers=headers, json=payload, timeout=5.0)
        if resp.status_code >= 400:
            body = (resp.text or "")[:200]
            log_mod.log_line("error", "❌", "Service Call", f"{resp.status_code} {body}")
            return {"ok": False, "error": body or f"HTTP {resp.status_code}", "status_code": resp.status_code}
        return {"ok": True}
    except Exception:
        log_mod.log_line("error", "❌", "Service Call", traceback.format_exc())
        return {"ok": False, "error": "exception"}


def call_services_sync(service_calls):
    """
    Execută mai multe apeluri HA într-o singură sesiune (un client HTTP). Returnează listă de bool (ok per comandă).
    service_calls: list of {"domain", "service", "entity_id", "service_data"(optional)}.
    """
    ha = settings_mod.CFG.get("home_assistant", {})
    if not ha.get("enabled"):
        return [False] * len(service_calls)
    base_url = ha["url"].rstrip("/")
    headers = {"Authorization": f"Bearer {ha['token']}"}
    results = []
    try:
        with httpx.Client() as client:
            for sc in service_calls:
                domain = sc.get("domain", "")
                service = sc.get("service", "")
                entity_id = sc.get("entity_id", "")
                if not domain or not service or not entity_id:
                    results.append(False)
                    continue
                url = f"{base_url}/api/services/{domain}/{service}"
                payload = {"entity_id": entity_id}
                svc_data = sc.get("service_data")
                if svc_data and isinstance(svc_data, dict):
                    payload.update(svc_data)
                try:
                    r = client.post(url, headers=headers, json=payload, timeout=5.0)
                    results.append(r.status_code < 400)
                except Exception:
                    results.append(False)
    except Exception:
        log_mod.log_line("error", "❌", "call_services_sync", traceback.format_exc())
        results = [False] * len(service_calls)
    return results

# --- CONFIG MANAGEMENT ---
def load_config():
    """Încarcă lista de entități salvată local (cu alias-uri și bife)."""
    if not os.path.exists(CONFIG_FILE): 
        return []
    try:
        with open(CONFIG_FILE, "r") as f: 
            return json.load(f)
    except Exception:
        log_mod.log_line("error", "❌", "Config load error", traceback.format_exc())
        return []

def save_config(data):
    """Salvează configurația entităților în JSON-ul local (atomic write)."""
    import tempfile, os
    dir_name = os.path.dirname(CONFIG_FILE) or "."
    fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_path, CONFIG_FILE)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise

def update_device_selection(entity_id: str, selected: bool):
    """Update the 'selected' flag for one device (used by Smart Home UI)."""
    config = load_config()
    for item in config:
        if item.get("entity_id") == entity_id:
            item["selected"] = bool(selected)
            save_config(config)
            return
    # If entity not in list (e.g. not synced yet), append it
    config.append({"entity_id": entity_id, "name": entity_id, "selected": bool(selected), "aliases": []})
    save_config(config)


def set_all_devices_selection(selected: bool):
    """Set selected flag for ALL devices at once (bulk select/deselect)."""
    config = load_config()
    for item in config:
        item["selected"] = selected
    save_config(config)


def update_device_alias(entity_id: str, aliases: list):
    """Update the aliases list for one device (used by Smart Home UI)."""
    if not isinstance(aliases, list):
        aliases = [a.strip() for a in (aliases or "").split(",") if a.strip()]
    config = load_config()
    for item in config:
        if item.get("entity_id") == entity_id:
            item["aliases"] = [str(a).strip() for a in aliases if str(a).strip()]
            save_config(config)
            return
    # If entity not in list, append with empty name/selected
    config.append({"entity_id": entity_id, "name": entity_id, "selected": False, "aliases": [str(a).strip() for a in aliases if str(a).strip()]})
    save_config(config)


def remove_devices(ids_to_remove):
    """Remove devices from local registry (ha_entities.json)."""
    if not ids_to_remove:
        return False
    config = load_config()
    new_config = [item for item in config if item["entity_id"] not in ids_to_remove]
    save_config(new_config)
    log_mod.log_line("sys", "🗑️", "HA", f"Deleted {len(ids_to_remove)} devices from local registry.")
    return True

ALLOWED_DOMAINS = ["light", "switch", "script", "cover", "media_player", "climate", "sensor", "binary_sensor", "weather", "person", "lock", "vacuum", "input_boolean"]


async def sync_entities():
    """Sincronizează lista de la HA cu fișierul local, fără să șteargă alias-urile existente."""
    live_states = await fetch_ha_states()
    current_config = {item["entity_id"]: item for item in load_config()}
    
    new_list = []
    for s in live_states:
        eid = s['entity_id']
        domain = eid.split('.')[0]
        if domain in ALLOWED_DOMAINS:
            existing = current_config.get(eid, {})
            new_list.append({
                "entity_id": eid,
                "name": s['attributes'].get('friendly_name', eid),
                "domain": domain,
                "selected": existing.get("selected", False),
                "aliases": existing.get("aliases", [])
            })
    save_config(new_list)
    return new_list


async def get_available_entities():
    """Return HA entities NOT in local config — for the Add Devices picker."""
    live_states = await fetch_ha_states()
    existing_ids = {item["entity_id"] for item in load_config()}
    available = []
    for s in live_states:
        eid = s['entity_id']
        domain = eid.split('.')[0]
        if domain in ALLOWED_DOMAINS and eid not in existing_ids:
            available.append({
                "entity_id": eid,
                "name": s['attributes'].get('friendly_name', eid),
                "domain": domain,
                "state": s.get('state', 'unknown'),
            })
    available.sort(key=lambda x: (x['domain'], x['name']))
    return available


async def add_entities(entity_ids: list):
    """Add specific entities from HA to local config."""
    live_states = await fetch_ha_states()
    state_map = {s['entity_id']: s for s in live_states}
    config = load_config()
    existing_ids = {item["entity_id"] for item in config}
    added = 0
    for eid in entity_ids:
        if eid in existing_ids:
            continue
        s = state_map.get(eid)
        domain = eid.split('.')[0]
        if domain not in ALLOWED_DOMAINS:
            continue
        name = s['attributes'].get('friendly_name', eid) if s else eid
        config.append({
            "entity_id": eid,
            "name": name,
            "domain": domain,
            "selected": True,
            "aliases": []
        })
        added += 1
    if added:
        save_config(config)
    return added

# --- ROUTER & AI CONTEXT ---
CONTROLLABLE_DOMAINS = {"light", "switch", "script", "input_boolean", "cover", "lock", "vacuum", "climate", "media_player"}

# --- HA AREAS CACHE ---
_areas_cache: dict = {}       # area_id → {"area_id", "name", "aliases"}
_areas_cache_ts: float = 0.0  # monotonic timestamp of last fetch
_AREAS_CACHE_TTL = 300.0      # 5 min

async def fetch_ha_areas() -> list[dict]:
    """Fetch area registry from HA API. Returns list of {area_id, name, aliases, ...}. Cached 5min."""
    import time as _time
    global _areas_cache, _areas_cache_ts
    now = _time.monotonic()
    if _areas_cache and (now - _areas_cache_ts) < _AREAS_CACHE_TTL:
        return list(_areas_cache.values())
    ha = settings_mod.CFG.get("home_assistant", {})
    if not ha.get("enabled"):
        return []
    url = f"{ha['url'].rstrip('/')}/api/config/area_registry/list"
    headers = {"Authorization": f"Bearer {ha['token']}"}
    client = await _get_ha_client()
    try:
        resp = await client.get(url, headers=headers, timeout=5.0)
        if resp.status_code == 200:
            areas = resp.json()
            if isinstance(areas, list):
                _areas_cache = {a.get("area_id", ""): a for a in areas}
                _areas_cache_ts = now
                return areas
    except Exception:
        log_mod.log_line("error", "⚠️", "HA Areas", "Failed to fetch areas")
    return list(_areas_cache.values()) if _areas_cache else []


async def fetch_entity_area_map() -> dict[str, str]:
    """Build entity_id → area_name mapping from HA entity/device/area registries. Cached with areas."""
    ha = settings_mod.CFG.get("home_assistant", {})
    if not ha.get("enabled"):
        return {}
    areas = await fetch_ha_areas()
    if not areas:
        return {}
    area_map = {a.get("area_id", ""): a.get("name", "") for a in areas}

    # Fetch entity registry to get area_id per entity
    base = ha['url'].rstrip('/')
    headers = {"Authorization": f"Bearer {ha['token']}"}
    client = await _get_ha_client()
    entity_area: dict[str, str] = {}
    try:
        resp = await client.get(f"{base}/api/config/entity_registry/list", headers=headers, timeout=5.0)
        if resp.status_code == 200:
            entities = resp.json()
            if isinstance(entities, list):
                for ent in entities:
                    eid = ent.get("entity_id", "")
                    area_id = ent.get("area_id") or ""
                    if eid and area_id and area_id in area_map:
                        entity_area[eid] = area_map[area_id]
    except Exception:
        pass

    # Also try device registry for entities that inherit area from their device
    if entity_area:
        return entity_area
    try:
        resp_dev = await client.get(f"{base}/api/config/device_registry/list", headers=headers, timeout=5.0)
        if resp_dev.status_code == 200:
            devices = resp_dev.json()
            device_area = {}
            if isinstance(devices, list):
                for dev in devices:
                    did = dev.get("id", "")
                    area_id = dev.get("area_id") or ""
                    if did and area_id and area_id in area_map:
                        device_area[did] = area_map[area_id]
            # Map entities to devices
            resp_ent = await client.get(f"{base}/api/config/entity_registry/list", headers=headers, timeout=5.0)
            if resp_ent.status_code == 200:
                for ent in resp_ent.json() or []:
                    eid = ent.get("entity_id", "")
                    did = ent.get("device_id") or ""
                    if eid and did in device_area and eid not in entity_area:
                        entity_area[eid] = device_area[did]
    except Exception:
        pass

    return entity_area


def get_agent_device_list():
    """Compact device list for agent system prompt — only controllable devices, grouped by room if HA provides area info.
    Result is cached until ha_entities.json is modified on disk."""
    try:
        mtime = os.path.getmtime(CONFIG_FILE)
    except OSError:
        mtime = 0.0
    if _device_list_cache["mtime"] == mtime and _device_list_cache["text"]:
        return _device_list_cache["text"]
    result = _build_agent_device_list()
    _device_list_cache["text"] = result
    _device_list_cache["mtime"] = mtime
    return result


def _build_agent_device_list():
    """Build the formatted device list (uncached inner function)."""
    config = load_config()
    lines = []
    rooms = {}  # room_name → list of device strings
    ungrouped = []

    for item in config:
        if not item.get("selected"):
            continue
        domain = (item.get("domain") or item["entity_id"].split(".")[0])
        if domain not in CONTROLLABLE_DOMAINS:
            continue
        name = item.get("name") or item["entity_id"]
        aliases = item.get("aliases") or []
        if aliases:
            line = f"{item['entity_id']} ({name}) [{', '.join(aliases)}]"
        else:
            line = f"{item['entity_id']} ({name})"

        # Try to extract room from entity_id or friendly_name
        room = _extract_room(item["entity_id"], name, aliases)
        if room:
            rooms.setdefault(room, []).append(line)
        else:
            ungrouped.append(line)

    # Format with room headers for better context
    output = []
    if rooms:
        for room_name in sorted(rooms.keys()):
            output.append(f"[{room_name}]")
            for dev in rooms[room_name]:
                output.append(f"  {dev}")
    if ungrouped:
        if rooms:
            output.append("[other]")
        for dev in ungrouped:
            output.append(f"  {dev}" if rooms else dev)

    return "\n".join(output)


def _extract_room(entity_id: str, friendly_name: str, aliases: list) -> Optional[str]:
    """
    Extract room/area name from entity_id or friendly_name.
    Uses common HA naming conventions: light.bedroom_lamp → "bedroom",
    "Living Room Light" → "living room".
    """
    import re as _re

    # Common room names to look for
    room_keywords = [
        "bedroom", "living room", "living", "kitchen", "bathroom", "hallway",
        "office", "garage", "garden", "balcony", "terrace", "attic", "basement",
        "dining", "laundry", "nursery", "guest", "master",
        # Romanian rooms
        "dormitor", "sufragerie", "bucătărie", "bucatarie", "baie", "hol",
        "birou", "garaj", "grădină", "gradina", "balcon", "terasă", "terasa",
        "mansardă", "mansarda", "subsol", "camera", "salon",
    ]

    # Check entity_id parts (e.g., light.living_room_lamp)
    eid_part = entity_id.split(".")[-1].replace("_", " ").lower()
    for room in room_keywords:
        if room in eid_part:
            return room.replace("_", " ").title()

    # Check friendly_name
    fn_lower = friendly_name.lower()
    for room in room_keywords:
        if room in fn_lower:
            return room.replace("_", " ").title()

    return None


def resolve_room_devices(room_or_group: str, domain_filter: Optional[str] = None, entity_area_map: Optional[dict] = None) -> list:
    """
    Resolve a room/area/group name to a list of matching device dicts.
    Returns list of {entity_id, name, domain} for devices in that room.
    
    room_or_group: e.g. "bedroom", "living room", "all lights"
    domain_filter: e.g. "light" to only return lights
    entity_area_map: optional pre-fetched entity→area name mapping (from fetch_entity_area_map)
    """
    import re as _re

    config = load_config()
    target = room_or_group.lower().strip()
    matches = []

    # Check if "all" is requested
    is_all = target.startswith("all ") or target in ("all", "toate", "tot")
    if is_all:
        # Extract domain hint: "all lights" → "light"
        domain_hint = _re.sub(r"^(?:all|toate|tot)\s*", "", target).strip()
        domain_map = {
            "lights": "light", "light": "light",
            "lumini": "light", "lumina": "light", "becuri": "light",
            "switches": "switch", "switch": "switch",
            "intrerupatoare": "switch", "întrerupătoare": "switch",
            "covers": "cover", "cover": "cover",
            "locks": "lock", "lock": "lock",
        }
        resolved_domain = domain_map.get(domain_hint, domain_filter)

        for item in config:
            if not item.get("selected"):
                continue
            domain = (item.get("domain") or item["entity_id"].split(".")[0])
            if domain not in CONTROLLABLE_DOMAINS:
                continue
            if resolved_domain and domain != resolved_domain:
                continue
            matches.append({
                "entity_id": item["entity_id"],
                "name": item.get("name") or item["entity_id"],
                "domain": domain,
            })
        return matches

    # Room-based resolution — combine keyword extraction + HA Areas API
    for item in config:
        if not item.get("selected"):
            continue
        domain = (item.get("domain") or item["entity_id"].split(".")[0])
        if domain not in CONTROLLABLE_DOMAINS:
            continue
        if domain_filter and domain != domain_filter:
            continue

        name = item.get("name") or item["entity_id"]
        aliases = item.get("aliases") or []
        eid = item["entity_id"]

        # Method 1: keyword-based room extraction (existing)
        room = _extract_room(eid, name, aliases)
        if room and target in room.lower():
            matches.append({"entity_id": eid, "name": name, "domain": domain})
            continue

        # Method 2: HA Areas API mapping (if provided)
        if entity_area_map:
            area_name = entity_area_map.get(eid, "").lower()
            if area_name and target in area_name:
                matches.append({"entity_id": eid, "name": name, "domain": domain})

    return matches

async def get_ai_context():
    """Aduce stările live pentru Chat, combinând numele prietenos și alias-urile."""
    config = load_config()
    selected = [i for i in config if i.get("selected")]
    if not selected: 
        return "Niciun dispozitiv configurat."
    
    live_states = await fetch_ha_states()
    state_map = {s['entity_id']: s for s in live_states}
    
    lines = []
    for item in selected:
        s = state_map.get(item["entity_id"])
        if s:
            val = s['state']
            unit = s['attributes'].get('unit_of_measurement', '')
            name = item['name']
            aliases = f"[{', '.join(item['aliases'])}]" if item.get('aliases') else ""
            lines.append(f"{item['entity_id']} ({name}) {aliases}: {val} {unit}")
    return "\n".join(lines)