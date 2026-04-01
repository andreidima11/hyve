"""Rezolvare dispozitiv HA din target/alias/nume. Folosit de brain la comenzi."""
import re
import difflib
from typing import Optional, Tuple, Dict, Any
import settings as settings_mod
import home_assistant
from logger import log_line

RE_NON_ALPHANUM = re.compile(r"[^a-z0-9\s]")
DEVICE_MATCH_THRESHOLD = 55.0

DIACRITICS_MAP = [
    ("ă", "a"), ("â", "a"), ("î", "i"), ("ș", "s"), ("ş", "s"), ("ț", "t"), ("ţ", "t"),
]


def _normalize_diacritics(s: str) -> str:
    if not s:
        return s
    for a, b in DIACRITICS_MAP:
        s = s.replace(a, b)
    return s


def normalize_str(s: str) -> str:
    if not s:
        return ""
    s = _normalize_diacritics(s.lower())
    return RE_NON_ALPHANUM.sub("", s).strip()


def _spacing_variants(s: str) -> list:
    if not s or not s.strip():
        return [s]
    s = s.strip()
    out = [s]
    m = re.match(r"^(.+?)(\d+)$", s.rstrip())
    if m:
        with_space = f"{m.group(1).rstrip()} {m.group(2)}"
        if with_space != s:
            out.append(with_space)
    m2 = re.match(r"^(.+)\s+(\d+)$", s)
    if m2:
        no_space = f"{m2.group(1).rstrip()}{m2.group(2)}"
        if no_space != s:
            out.append(no_space)
    return list(dict.fromkeys(out))


def calculate_match_score(target: str, candidate: str) -> float:
    t_clean = normalize_str(target)
    c_clean = normalize_str(candidate)
    if not t_clean or not c_clean:
        return 0.0
    if t_clean == c_clean:
        return 100.0
    if f" {c_clean} " in f" {t_clean} ":
        return 90.0
    matcher = difflib.SequenceMatcher(None, t_clean, c_clean)
    ratio = matcher.ratio() * 100
    if t_clean in c_clean or c_clean in t_clean:
        ratio += 20
    return min(ratio, 100.0)


def _user_message_bonus(device: dict, user_message: str) -> float:
    if not (user_message and user_message.strip()):
        return 0.0
    msg_lower = _normalize_diacritics(user_message.lower().strip())
    words = [w for w in re.split(r"\W+", msg_lower) if len(w) >= 2]
    if not words:
        return 0.0
    device_text = " ".join([
        str(device.get("name") or ""),
        " ".join(device.get("aliases") or []),
        (device.get("entity_id") or "").replace("_", " "),
    ]).lower()
    device_norm = normalize_str(device_text)
    count = 0
    for w in words:
        w_clean = RE_NON_ALPHANUM.sub("", w)
        if w_clean and w_clean in device_norm:
            count += 1
    return min(40.0, count * 15.0)


def _device_candidates_by_field(device: dict, field: str) -> list:
    if field == "alias":
        raw = list(device.get("aliases") or [])
    elif field == "friendly_name":
        raw = [device["name"]] if device.get("name") else []
    else:
        raw = [device["entity_id"].split(".")[-1].replace("_", " ")] if device.get("entity_id") else []
    out = []
    for c in raw:
        out.extend(_spacing_variants(c))
    return list(dict.fromkeys(out))


async def find_device_details(
    target_description: str,
    user_id: str,
    user_message: Optional[str] = None,
    context_lock: Optional[Any] = None,
    user_context: Optional[Dict[str, Dict[str, Any]]] = None,
) -> Tuple[Optional[str], Optional[str]]:
    if not target_description:
        return None, None
    if context_lock is not None and user_context is not None and target_description == "CONTEXT":
        async with context_lock:
            last_ctx = user_context.get(user_id)
            if last_ctx:
                log_line("intent", "🔗", "CONTEXT", f"Recalling: {last_ctx['name']}")
                return last_ctx["entity_id"], last_ctx["name"]
        return None, None

    try:
        cfg = settings_mod.CFG
        devices = home_assistant.load_config()
        if not devices:
            return None, None
        active_devices_all = [d for d in devices if isinstance(d, dict) and d.get("selected", False)]
        priority = (cfg.get("home_assistant") or {}).get("device_match_priority")
        if isinstance(priority, list) and priority and (user_message or "").strip():
            active = active_devices_all
            match_text = (user_message or "").strip()
            for field in priority:
                if field not in ("alias", "friendly_name", "entity_id"):
                    continue
                candidates_with_scores = []
                for device in active:
                    cands = _device_candidates_by_field(device, field)
                    if not cands:
                        continue
                    local_max = 0.0
                    for c in cands:
                        s = calculate_match_score(match_text, c)
                        if s > local_max:
                            local_max = s
                        if s >= 100.0:
                            break
                    if local_max >= DEVICE_MATCH_THRESHOLD:
                        bonus = _user_message_bonus(device, match_text)
                        candidates_with_scores.append((device, local_max + bonus))
                if candidates_with_scores:
                    best = max(candidates_with_scores, key=lambda x: x[1])
                    dev, score = best
                    log_line("ha", "🎯", "MATCH", f"'{match_text}' -> {dev.get('name')} ({score:.1f}) [priority={field}]")
                    return dev["entity_id"], dev.get("name", dev["entity_id"])
            log_line("ha", "❌", "NO MATCH", f"'{match_text}' (priority: no match at any level)")
            return None, None

        active_devices = active_devices_all
        best_device = None
        highest_score = 0.0
        for device in active_devices:
            raw_candidates = []
            if device.get("name"):
                raw_candidates.append(device["name"])
            if device.get("aliases"):
                raw_candidates.extend(device["aliases"])
            raw_candidates.append(device["entity_id"].split(".")[-1].replace("_", " "))
            candidates = []
            for c in raw_candidates:
                candidates.extend(_spacing_variants(c))
            candidates = list(dict.fromkeys(candidates))
            local_max = 0.0
            for cand in candidates:
                score = calculate_match_score(target_description, cand)
                if score > local_max:
                    local_max = score
                if score >= 100.0:
                    break
            bonus = _user_message_bonus(device, user_message or "")
            total = local_max + bonus
            if total > highest_score:
                highest_score = total
                best_device = device

        if best_device and highest_score >= DEVICE_MATCH_THRESHOLD:
            log_line("ha", "🎯", "MATCH", f"'{target_description}' -> {best_device.get('name')} ({highest_score:.1f})")
            return best_device["entity_id"], best_device.get("name", best_device["entity_id"])
        log_line("ha", "❌", "NO MATCH", f"'{target_description}' (Best: {highest_score:.1f})")
        return None, None
    except Exception as e:
        log_line("error", "⚠️", "FIND_DEVICE", f"{type(e).__name__}: {e}")
        return None, None


def resolve_target_sync(target: str, devices: Optional[list] = None) -> Optional[str]:
    """
    Rezolvă un target (alias, nume sau entity_id) la entity_id. Variantă sync pentru scheduler (automatizări).
    Dacă devices e furnizat, îl folosește (evită reîncărcarea la fiecare comandă). Returnează entity_id sau None.
    """
    if not target or not str(target).strip():
        return None
    target = str(target).strip()
    if devices is None:
        devices = home_assistant.load_config()
    devices = devices or []
    # Dacă arată ca entity_id (domain.entity), verifică că există în config și returnează
    if "." in target and " " not in target:
        for d in devices:
            if isinstance(d, dict) and d.get("entity_id") == target:
                return target
        return None
    try:
        active = [d for d in devices if isinstance(d, dict) and d.get("selected", True)]
        best_entity_id = None
        highest_score = 0.0
        for device in active:
            raw_candidates = []
            if device.get("name"):
                raw_candidates.append(device["name"])
            if device.get("aliases"):
                raw_candidates.extend(device["aliases"])
            raw_candidates.append((device.get("entity_id") or "").split(".")[-1].replace("_", " "))
            candidates = []
            for c in raw_candidates:
                candidates.extend(_spacing_variants(c))
            candidates = list(dict.fromkeys(candidates))
            for cand in candidates:
                score = calculate_match_score(target, cand)
                if score >= DEVICE_MATCH_THRESHOLD and score > highest_score:
                    highest_score = score
                    best_entity_id = device.get("entity_id")
                if score >= 100.0:
                    return device.get("entity_id")
        return best_entity_id
    except Exception as e:
        log_line("error", "⚠️", "RESOLVE_SYNC", f"{type(e).__name__}: {e}")
        return None
