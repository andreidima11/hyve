from __future__ import annotations

import asyncio
import json
import re
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

import httpx
import settings as settings_mod
from logger import log_line, log_detail
from storage import collection
from brain.synapses import append_event, EVENT_ADDED, EVENT_UPDATED
from memory_context import get_memory_context, clean_text
from brain.cortex.llm import _get_aux_or_main_llm
from brain.cortex.thinking import strip_think

UPDATE_MEMORY_PROMPT = """You are a smart memory manager which controls the memory of a system.
You can perform four operations: (1) ADD into the memory, (2) UPDATE the memory, (3) DELETE from the memory, and (4) NONE (no change).

Guidelines:
1. **ADD**: New information not present in existing memory. Generate a new id (use "new_N" format).
2. **UPDATE**: Retrieved fact updates or enriches an existing memory. Keep the same id. Include old_memory field.
3. **DELETE**: Retrieved fact contradicts existing memory. Keep the same id.
4. **NONE**: Fact is already present or irrelevant. Keep the same id.

Return ONLY the JSON object with key "memory". No other text."""


def _find_similar_facts_bulk(new_facts: List[str], user_id: str, max_distance: float = 0.45, top_k: int = 5) -> List[Dict]:
    """For each new fact, find similar existing facts in ChromaDB. Returns deduplicated list of {id, text}."""
    all_existing = {}
    for fact_text in new_facts:
        try:
            results = collection.query(
                query_texts=[fact_text],
                n_results=top_k,
                where={"$and": [{"user_id": user_id}, {"type": "fact"}]},
                include=["documents", "distances"],
            )
            if not results.get("ids") or not results["ids"][0]:
                continue
            for i, fid in enumerate(results["ids"][0]):
                dist = results["distances"][0][i] if results.get("distances") and results["distances"][0] else 999
                if dist <= max_distance and fid not in all_existing:
                    doc = (results.get("documents") or [[]])[0]
                    text = doc[i] if doc and i < len(doc) else ""
                    if text:
                        all_existing[fid] = {"id": fid, "text": text}
        except Exception as e:
            log_line("error", "⚠️", "FIND_SIMILAR_BULK", f"{type(e).__name__}: {e}")
    return list(all_existing.values())


async def _resolve_memories(new_facts: List[str], existing_memories: List[Dict],
                            llm_url: str, llm_model: str, llm_api_key: str = "") -> List[Dict]:
    """Single LLM call: given new facts + existing memories, return ADD/UPDATE/DELETE/NONE decisions.
    Returns list of {id, text, event, old_memory?}."""
    if not llm_url or not llm_model:
        # No LLM: default to ADD all
        return [{"id": f"new_{i}", "text": f, "event": "ADD"} for i, f in enumerate(new_facts)]

    # Map existing memory IDs to sequential integers (prevent UUID hallucination)
    id_mapping = {}  # str(idx) -> real_id
    mapped_existing = []
    for idx, mem in enumerate(existing_memories):
        id_mapping[str(idx)] = mem["id"]
        mapped_existing.append({"id": str(idx), "text": mem["text"]})

    existing_str = json.dumps(mapped_existing, ensure_ascii=False) if mapped_existing else "[]"
    facts_str = json.dumps(new_facts, ensure_ascii=False)

    # /no_think suppresses thinking on Qwen3-style models so the
    # token budget goes to the actual JSON answer, not internal reasoning.
    user_prompt = (
        f"Old Memory: {existing_str}\n"
        f"New Facts: {facts_str}\n"
        f"Output: /no_think"
    )

    try:
        client = await get_llm_client()
        payload = {
            "model": llm_model,
            "messages": [
                {"role": "system", "content": UPDATE_MEMORY_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0.0,
            "max_tokens": 1000,
            "stream": False,
        }
        resp = await client.post(
            llm_url,
            json=payload,
            timeout=60.0,
            headers=_llm_headers(llm_api_key),
        )
        if resp.status_code != 200:
            log_line("error", "⚠️", "RESOLVE", f"HTTP {resp.status_code}")
            return [{"id": f"new_{i}", "text": f, "event": "ADD"} for i, f in enumerate(new_facts)]

        raw = (resp.json().get("choices") or [{}])[0].get("message", {}).get("content") or ""
        if bool((settings_mod.CFG or {}).get("verbose_logging")):
            log_line("mem", "🧠", "RESOLVE_RAW", raw[:200])

        # Parse response — same strategy: find last valid JSON
        stripped = re.sub(r"```(?:json)?", "", raw)
        all_json = re.findall(r'\{"memory"\s*:\s*\[.*?\]\s*\}', stripped, re.DOTALL)
        if not all_json:
            # Try more lenient: any JSON with "memory" key
            all_json = re.findall(r'\{[^{}]*"memory"\s*:\s*\[.*?\][^{}]*\}', stripped, re.DOTALL)

        for json_str in reversed(all_json):
            try:
                data = json.loads(json_str)
                actions = data.get("memory") or []
                if not isinstance(actions, list):
                    continue
                # Restore real IDs
                resolved = []
                for action in actions:
                    aid = str(action.get("id", ""))
                    # Map back from sequential int to real ChromaDB ID
                    if aid in id_mapping:
                        action["id"] = id_mapping[aid]
                    resolved.append(action)
                return resolved
            except (json.JSONDecodeError, ValueError):
                continue

        # Fallback: no valid JSON parsed, ADD everything
        log_line("mem", "⚠️", "RESOLVE", "Could not parse resolution response, defaulting to ADD all")
        return [{"id": f"new_{i}", "text": f, "event": "ADD"} for i, f in enumerate(new_facts)]

    except Exception as e:
        log_line("error", "⚠️", "RESOLVE", f"{type(e).__name__}: {e}")
        return [{"id": f"new_{i}", "text": f, "event": "ADD"} for i, f in enumerate(new_facts)]


# Legacy wrapper for save_fact_from_agent (single-fact arbitration)
async def _arbitrate_and_store(clean_fact: str, user_id: str, llm_url: str, llm_model: str,
                                sim_threshold: float, source_label: str = "EXTRACT", llm_api_key: str = "") -> Optional[str]:
    """Single-fact arbitration using the two-phase approach."""
    existing = _find_similar_facts_bulk([clean_fact], user_id, max_distance=sim_threshold)
    actions = await _resolve_memories([clean_fact], existing, llm_url, llm_model, llm_api_key)
    if not actions:
        await resolve_and_save(clean_fact, user_id)
        return "SAVE"
    action = actions[0]
    event = (action.get("event") or "ADD").upper()
    if event == "ADD":
        await resolve_and_save(action.get("text") or clean_fact, user_id)
        return "SAVE"
    elif event == "UPDATE":
        aid = action.get("id", "")
        text = action.get("text") or clean_fact
        if aid:
            try:
                ts = time.time()
                collection.update(ids=[aid], documents=[text],
                                  metadatas=[{"timestamp": ts, "user_id": user_id, "type": "fact"}])
                log_line("mem", "💾", "UPDATED", text[:80])
            except Exception as e:
                log_line("error", "⚠️", "UPDATE ERR", str(e))
        return "UPDATE"
    elif event == "DELETE":
        aid = action.get("id", "")
        if aid:
            try:
                collection.delete(ids=[aid])
                log_line("mem", "🗑️", "DELETED", f"id={aid}")
            except Exception as e:
                log_line("error", "⚠️", "DELETE ERR", str(e))
        return "IGNORE"
    else:  # NONE
        return "IGNORE"
_MEMORY_SYSTEM_PROMPT_BASE = """You are a memory extraction system. Given a conversation between a User and an Assistant, extract personal facts about the User that are worth remembering long-term.

What to extract:
- Personal details (name, age, relationships, location)
- Preferences and opinions (likes, dislikes, favorites)
- Possessions (car, phone, pet, house)
- Professional info (job, workplace, career)
- Habits, hobbies, routines
- Health info (allergies, diet, fitness)
- Plans and life events (trips, moves, milestones)
- Specific details mentioned (quantities, dates, names, models)

What NOT to extract:
- Generic questions without personal info
- Common knowledge or facts about the world
- Greetings, filler, or conversational pleasantries
- Information stated only by the Assistant (not the User)
- Things the Assistant recalled from memory (those already exist)

When comparing against Existing Memories:
- If a fact is truly NEW → ADD
- If it enriches or updates an existing memory → UPDATE (include the id)
- If it contradicts an existing memory → DELETE the old one (include the id) + ADD the corrected version
- If the info is already captured → skip entirely

Always respond with a JSON object: {"actions": [...]}
Each action is one of:
  {"action": "ADD", "text": "..."}
  {"action": "UPDATE", "id": "N", "text": "..."}
  {"action": "DELETE", "id": "N"}

Write facts in the SAME language the User used. Be specific — include names, numbers, details.
For most casual messages, return {"actions": []}."""

_MEMORY_RULES = """
Rules:
- Extract ONLY from the User's messages. Never from the Assistant's replies.
- If the User only asked a question without revealing personal info, return {"actions": []}.
- Use [Earlier context] to resolve pronouns/references, but only extract from [Current exchange].
- Write facts in the User's language. Be specific: include exact names, numbers, details.
- Combine related details into one coherent fact (e.g. "Has an Audi A6, grey, 3.0L diesel V6, 204 HP").
- Compare against Existing Memories before adding. Skip duplicates.
- Return ONLY a JSON object with key "actions". No explanation, no reasoning."""


# Prefix expected at the start of the rules block (used when loading from config).
_MEMORY_RULES_PREFIX = "Rules:"


def _build_extraction_input(
    user_text: str,
    assistant_reply: Optional[str] = None,
    recent_exchanges: Optional[List[Dict]] = None,
) -> str:
    """Build extraction input with conversation context for coreference resolution."""
    current_user = (user_text or "").strip()[:800]
    current_assistant = strip_think((assistant_reply or "").strip())[:600]

    context_parts = []
    if recent_exchanges:
        history_msgs = []
        for m in recent_exchanges:
            content = (m.get("content") or "").strip()
            role = m.get("role")
            if content and role in ("user", "assistant"):
                if role == "assistant":
                    content = strip_think(content)
                history_msgs.append({**m, "content": content})
        if (current_user and current_assistant and len(history_msgs) >= 2
                and history_msgs[-1].get("role") == "assistant"
                and history_msgs[-2].get("role") == "user"):
            history_msgs = history_msgs[:-2]
        elif current_user and len(history_msgs) >= 1 and history_msgs[-1].get("role") == "user":
            history_msgs = history_msgs[:-1]
        context_msgs = history_msgs[-6:]
        for m in context_msgs:
            role = m.get("role", "")
            label = "User" if role == "user" else "Assistant"
            content = (m.get("content") or "").strip()[:300]
            if content:
                context_parts.append(f"{label}: {content}")

    parts = []
    if context_parts:
        parts.append("[Earlier context]")
        parts.extend(context_parts)
        parts.append("")
        parts.append("[Current exchange]")
    if current_user:
        parts.append(f"User: {current_user}")
    if current_assistant:
        parts.append(f"Assistant: {current_assistant}")

    if parts:
        return "\n".join(parts)

    if recent_exchanges:
        msgs = [m for m in recent_exchanges if (m.get("content") or "").strip()][-4:]
        if msgs:
            fallback_parts = []
            for m in msgs:
                role = m.get("role", "")
                label = "User" if role == "user" else "Assistant"
                content = (m.get("content") or "").strip()[:400]
                if content:
                    fallback_parts.append(f"{label}: {content}")
            if fallback_parts:
                return "\n".join(fallback_parts)
    return ""


def _build_memory_prompt() -> str:
    """Build the unified extraction+resolve system prompt from config.

    Uses memory.extraction_examples for few-shot and memory.extraction_rules for the rules block.
    If extraction_rules is missing or empty, falls back to built-in _MEMORY_RULES.
    """
    mem_cfg = settings_mod.CFG.get("memory") or {}
    examples = mem_cfg.get("extraction_examples") or []
    examples = [ex for ex in examples if isinstance(ex, dict) and (ex.get("input") or "").strip()]

    rules_raw = mem_cfg.get("extraction_rules")
    if isinstance(rules_raw, str) and rules_raw.strip():
        rules = rules_raw.strip()
    else:
        rules = _MEMORY_RULES.strip()
    if not rules.startswith(_MEMORY_RULES_PREFIX):
        rules = f"{_MEMORY_RULES_PREFIX}\n{rules}"

    if not examples:
        log_line("mem", "⚠️", "PROMPT", "No extraction_examples in config — memory extraction may be unreliable")
        return _MEMORY_SYSTEM_PROMPT_BASE + "\n\n" + rules

    lines = [_MEMORY_SYSTEM_PROMPT_BASE, "", "Few-shot examples (extraction only, no existing memories):", ""]
    for ex in examples:
        inp = (ex.get("input") or "").strip()
        out = ex.get("output") or []
        if isinstance(out, str):
            out = [s.strip() for s in out.split(",") if s.strip()]
        # Convert simple example format to action format
        if not out:
            actions_json = "[]"
        else:
            actions = [{"action": "ADD", "text": f} for f in out]
            actions_json = json.dumps(actions, ensure_ascii=False)
        lines.append(f'Input: {inp}')
        lines.append(f'Existing Memories: []')
        lines.append(f'Output: {{"actions": {actions_json}}}')
        lines.append("")
    lines.append(rules)
    return "\n".join(lines)


def _looks_like_real_fact(text: str) -> bool:
    """Accept any line that looks like a real fact, not instructions or meta-commentary."""
    if not text or len(text) < 8:
        return False
    lower = text.lower()
    junk_indicators = (
        "output:", "input:", "example", "format:", "json", "note:",
        "remember", "instruction", "step ", "rule ", "return ",
        "analyze", "organizer", "extract", "conversation", "request",
        "role:", "task:", "personal information", "few-shot", "guidelines",
        "user:", "assistant:", "romanian", "english", "translation",
        "evaluate", "the user is asking", "the user is not", "no relevant",
        "no preference", "no fact", "no information", "nothing to extract",
        "does not contain", "doesn't contain", "no personal",
        "there is no", "final check", "check:", "provided by",
        "statement of", "in this ", "specific turn", "this turn",
    )
    if any(j in lower for j in junk_indicators):
        return False
    placeholder_indicators = (
        "list of strings", "array of strings", "string list",
        "fact 1", "fact1", "example fact", "sample fact",
    )
    if any(p in lower for p in placeholder_indicators):
        return False
    if lower in {"string", "strings", "list", "facts"}:
        return False
    words = [w for w in re.findall(r'[a-zA-Z]+', text) if len(w) >= 2]
    return len(words) >= 2


def _parse_memory_response(raw: str) -> List[Dict]:
    """Parse the unified extraction+resolve LLM response.
    Expects JSON like: {"actions": [{"action": "ADD", "text": "..."}, ...]}
    Returns list of action dicts."""
    if not raw or len(raw.strip()) < 5:
        return []
    raw = strip_think(raw.strip())
    # Strip thinking blocks
    thinking_match = re.match(r'^(?:Thinking\s*Process|Analysis|Reasoning)\s*:.*?(?=\{)', raw, re.DOTALL | re.IGNORECASE)
    if thinking_match:
        raw = raw[thinking_match.end():]

    stripped = re.sub(r"```(?:json)?", "", raw)

    # Try to find {"actions": [...]} patterns
    all_json = re.findall(r'\{"actions"\s*:\s*\[.*?\]\s*\}', stripped, re.DOTALL)
    if not all_json:
        all_json = re.findall(r'\{[^{}]*"actions"\s*:\s*\[.*?\][^{}]*\}', stripped, re.DOTALL)

    for json_str in reversed(all_json):
        try:
            data = json.loads(json_str)
            actions = data.get("actions")
            if actions is None:
                continue
            if not isinstance(actions, list):
                continue
            # Validate each action
            valid_actions = []
            for a in actions:
                if not isinstance(a, dict):
                    continue
                action_type = (a.get("action") or "").upper()
                text = (a.get("text") or "").strip()
                if action_type == "ADD" and text and _looks_like_real_fact(text):
                    valid_actions.append({"action": "ADD", "text": text})
                elif action_type == "UPDATE" and text:
                    aid = a.get("id")
                    if aid is not None:
                        valid_actions.append({"action": "UPDATE", "id": aid, "text": text})
                elif action_type == "DELETE":
                    aid = a.get("id")
                    if aid is not None:
                        valid_actions.append({"action": "DELETE", "id": aid, "text": text})
            return valid_actions
        except (json.JSONDecodeError, ValueError):
            continue

    # Fallback: try old {"facts": [...]} format for backward compat
    old_json = re.findall(r'\{"facts"\s*:\s*\[.*?\]\s*\}', stripped, re.DOTALL)
    for json_str in reversed(old_json):
        try:
            data = json.loads(json_str)
            facts = data.get("facts")
            if not isinstance(facts, list) or not facts:
                continue
            actions = []
            for f in facts:
                f = str(f).strip()
                if f and _looks_like_real_fact(f):
                    actions.append({"action": "ADD", "text": f})
            return actions
        except (json.JSONDecodeError, ValueError):
            continue

    return []


def _find_relevant_memories(user_text: str, user_id: str, max_distance: float = 0.6, top_k: int = 10) -> List[Dict]:
    """Find existing memories relevant to the user's message for the unified extraction+resolve call."""
    try:
        query_str = (user_text or "")[:500].strip()
        if not query_str:
            return []
        results = collection.query(
            query_texts=[query_str],
            n_results=top_k,
            where={"$and": [{"user_id": user_id}, {"type": "fact"}]},
            include=["documents", "distances"],
        )
        if not results.get("ids") or not results["ids"][0]:
            return []
        existing = []
        for i, fid in enumerate(results["ids"][0]):
            dist = results["distances"][0][i] if results.get("distances") and results["distances"][0] else 999
            if dist <= max_distance:
                doc = (results.get("documents") or [[]])[0]
                text = doc[i] if doc and i < len(doc) else ""
                if text:
                    existing.append({"id": fid, "text": text})
        return existing
    except Exception as e:
        log_line("error", "⚠️", "FIND_RELEVANT", f"{type(e).__name__}: {e}")
        return []


# ── Trivial-message pre-filter ──────────────────────────────────────────────
_TRIVIAL_EXACT: set[str] = {
    # Romanian
    "ok", "da", "nu", "bine", "salut", "buna", "hey", "hei", "pa", "ciao",
    "mersi", "multumesc", "ms", "noapte buna", "buna seara", "buna ziua",
    "la revedere", "pe curand", "aha", "mhm", "hmm", "sigur", "exact",
    "super", "gata", "ok mersi", "da asa e", "de acord", "am inteles",
    # English
    "hi", "hello", "hey", "bye", "thanks", "thank you", "ok thanks",
    "yes", "no", "sure", "got it", "alright", "good", "great", "nice",
    "good morning", "good night", "good evening",
}

# Keyword signals that COULD indicate personal info worth extracting.
# If none of these match, skip LLM call entirely.
# Philosophy: be INCLUSIVE here — it's cheap to let the LLM decide "no facts".
# Only block messages that are OBVIOUSLY not personal info.
# Language-agnostic patterns for memory signal detection
# Keep this MINIMAL — let the LLM handle the real extraction work
_MEMORY_SIGNAL_PATTERNS = [
    r'\d{4}',  # Years (1998, 2024, etc.)
    r'\d+\s*(years?|months?|days?|km|miles?|kg|lbs?)\b',  # Quantities with units
    r'\$|€|£|\d+[.,]\d+',  # Prices/amounts
    r'\b[A-Z][a-z]+(?:[A-Z][a-z]*)+',  # PascalCase (brand names: iPhone, PlayStation, etc.)
    r'\b[A-Z]{2,}\d+',  # Model numbers (VN1500, A6, RTX3080, etc.)
    r'@\w+',  # Email/username patterns
    r'\+\d+',  # Phone number indicators
]


def _is_trivial_message(text: str) -> bool:
    """Return True if message is too trivial to contain personal info."""
    if not text:
        return True
    lower = text.lower().strip()
    cleaned = lower.rstrip("!?.,;:")
    if cleaned in _TRIVIAL_EXACT:
        return True
    if len(cleaned.split()) <= 2 and len(cleaned) < 15:
        return True
    return False


def _has_memory_signal(user_text: str, assistant_reply: str = "") -> bool:
    """Language-agnostic signal detection: does the message likely contain personal info?
    Checks both user message and assistant's reply for minimal universal patterns.
    Very lenient — delegates real extraction work to the LLM."""
    # Check user message for universal patterns (years, model numbers, amounts)
    if any(re.search(p, user_text, re.IGNORECASE) for p in _MEMORY_SIGNAL_PATTERNS):
        return True
    
    # If assistant mentioned memory/storage in reply, that's a strong signal
    # (works across languages: "noted", "запомню", "je retiens", "ho notato", etc.)
    if assistant_reply:
        assistant_lower = assistant_reply.lower()
        memory_keywords = ['note', 'remember', 'memory', 'zapomn', 'retien', 'notat', 'memor', '记住', '記憶']
        if any(keyword in assistant_lower for keyword in memory_keywords):
            return True
    
    # Very lenient: if message is longer than 6 words, let the LLM decide
    if len(user_text.split()) > 6:
        return True
    
    return False


async def process_memory_pipeline(
    user_text: str,
    user_id: str,
    assistant_reply: Optional[str] = None,
    recent_exchanges: Optional[List[Dict]] = None,
):
    """Single-call memory pipeline:
    1. Pre-filter: skip trivial messages (zero cost)
    2. Signal detection: skip messages with no personal-info keywords (zero cost)
    3. Retrieve existing memories relevant to the message
    4. ONE LLM call: extract facts + resolve against existing → ADD/UPDATE/DELETE actions
    5. Execute actions
    """
    mem_cfg = settings_mod.CFG.get("memory") or {}
    llm_url, llm_model, llm_api_key = _get_aux_or_main_llm()
    fact_sim_threshold = float(mem_cfg.get("fact_similarity_threshold", 0.45))
    # Looser threshold for finding existing memories to show the LLM (avoids duplicate ADD when user just asked a question)
    existing_max_distance = float(mem_cfg.get("existing_memories_max_distance", 0.85))

    # ── Pre-filter: skip trivial messages ──
    clean_user = (user_text or "").strip()
    if _is_trivial_message(clean_user):
        return

    # ── Signal detection: skip if no personal-info keywords ──
    assistant_text = (assistant_reply or "").strip()
    if not _has_memory_signal(clean_user, assistant_text):
        return

    if not llm_url or not llm_model:
        return

    input_text = _build_extraction_input(user_text, assistant_reply, recent_exchanges)
    if not input_text.strip():
        return

    try:
        # ── Retrieve existing memories relevant to this message ──
        existing_memories = _find_relevant_memories(clean_user, user_id,
                                                     max_distance=existing_max_distance)
        log_line("mem", "📚", "EXISTING", f"{len(existing_memories)} relevant memories")

        # Map existing IDs to sequential integers (prevent UUID hallucination)
        id_mapping = {}
        mapped_existing = []
        for idx, mem in enumerate(existing_memories):
            id_mapping[str(idx)] = mem["id"]
            mapped_existing.append({"id": str(idx), "text": mem["text"]})

        existing_str = json.dumps(mapped_existing, ensure_ascii=False) if mapped_existing else "[]"

        # ── Config-driven params ──
        llm_cfg = settings_mod.CFG.get("llm") or {}
        extraction_timeout = float(mem_cfg.get("extraction_timeout") or llm_cfg.get("timeout") or 120)
        extraction_input_max_chars = max(300, int(mem_cfg.get("extraction_input_max_chars") or 1500))
        extraction_max_tokens = max(128, int(mem_cfg.get("extraction_max_tokens_full") or 2000))
        extraction_max_lines = max(1, int(mem_cfg.get("extraction_max_lines") or 5))

        # ── Single LLM call: extract + resolve ──
        user_content = (
            f"Existing Memories: {existing_str}\n\n"
            f"Input:\n{input_text[:extraction_input_max_chars]}\n\n"
            f"Output: /no_think"
        )

        client = await get_llm_client()
        payload = {
            "model": llm_model,
            "messages": [
                {"role": "system", "content": _build_memory_prompt()},
                {"role": "user", "content": user_content},
            ],
            "temperature": 0.0,
            "max_tokens": extraction_max_tokens,
            "stream": False,
        }
        resp = await client.post(
            llm_url,
            json=payload,
            timeout=extraction_timeout,
            headers=_llm_headers(llm_api_key),
        )

        if resp.status_code != 200:
            log_line("error", "⚠️", "MEMORY", f"LLM HTTP {resp.status_code}")
            return

        raw = (resp.json().get("choices") or [{}])[0].get("message", {}).get("content") or ""
        if bool((settings_mod.CFG or {}).get("verbose_logging")):
            log_line("mem", "🧠", "RAW", raw[:300])

        actions = _parse_memory_response(raw)
        if not actions:
            return

        # Cap actions at max_lines
        actions = actions[:extraction_max_lines]

        # ── Restore real IDs and execute ──
        for action in actions:
            event = action.get("action", "").upper()
            text = (action.get("text") or "").strip()
            aid = action.get("id")

            # Map sequential IDs back to real ChromaDB IDs
            if aid is not None and str(aid) in id_mapping:
                real_id = id_mapping[str(aid)]
            else:
                real_id = None

            if event == "ADD" and text:
                await resolve_and_save(text, user_id)
                log_line("mem", "💾", "ADD", text[:80])
            elif event == "UPDATE" and text and real_id:
                try:
                    ts = time.time()
                    collection.update(ids=[real_id], documents=[text],
                                      metadatas=[{"timestamp": ts, "user_id": user_id, "type": "fact"}])
                    log_line("mem", "✏️", "UPDATE", text[:80])
                    try:
                        append_event(EVENT_UPDATED, user_id=user_id,
                                     summary=text[:120], details={"fact_id": real_id})
                    except Exception as e:
                        log_line("warn", "⚠️", "AUDIT", f"append_event UPDATE failed: {e}")
                except Exception as e:
                    log_line("error", "⚠️", "UPDATE ERR", str(e))
            elif event == "DELETE" and real_id:
                try:
                    collection.delete(ids=[real_id])
                    log_line("mem", "🗑️", "DELETE", f"id={real_id} text={text[:60]}")
                except Exception as e:
                    log_line("error", "⚠️", "DELETE ERR", str(e))

        log_line("mem", "✅", "PIPELINE", f"{len(actions)} actions executed")

    except httpx.ReadTimeout:
        log_line("mem", "⏳", "MEMORY", f"Pipeline timeout")
    except Exception as e:
        log_line("error", "⚠️", "MEMORY", f"Pipeline error: {type(e).__name__}: {e}")


async def resolve_and_save(new_fact, user_id):
    """Save a new fact to ChromaDB with quality scoring and per-user limit enforcement."""
    try:
        # ── QUALITY FILTER: rule-based pre-check ──
        quality = _score_fact_quality(new_fact)
        if quality < 0.2:
            log_line("mem", "🚫", "QUALITY", f"Rejected (score={quality:.2f}): {new_fact[:80]}")
            return

        ts = time.time()
        safe_uid = (user_id or "anon").replace(" ", "_")
        fact_id = f"fact_{safe_uid}_{int(ts * 1000)}"

        # Store with quality score in metadata
        metadata = {
            "timestamp": ts,
            "user_id": user_id,
            "type": "fact",
            "quality": round(quality, 2),
        }
        collection.add(documents=[new_fact], metadatas=[metadata], ids=[fact_id])
        log_line("mem", "💾", "SAVED", f"(q={quality:.2f}) {new_fact}")

        # ── PER-USER FACT LIMIT: prune oldest low-quality facts if over limit ──
        mem_cfg = settings_mod.CFG.get("memory") or {}
        max_facts = int(mem_cfg.get("max_facts_per_user", 500) or 500)
        if max_facts > 0:
            await _enforce_fact_limit(user_id, max_facts)

        try:
            append_event(EVENT_ADDED, user_id=user_id,
                         summary=new_fact[:120] + ("…" if len(new_fact) > 120 else ""),
                         details={"fact_id": fact_id, "quality": quality})
        except Exception as e:
            log_line("error", "⚠️", "EVENT LOG", f"Failed to log save event: {e}")
    except Exception as e:
        log_line("error", "⚠️", "SAVE ERR", str(e))


def _score_fact_quality(fact: str) -> float:
    """
    Rule-based quality scoring for a memory fact. Returns 0.0 - 1.0.
    Higher = more worth storing. No LLM call — pure heuristics.
    
    Scoring criteria:
    - Length: very short (<10 chars) or very long (>500) penalized
    - Specificity: contains names, numbers, dates → bonus
    - Personal info signals: "my", "I", preferences → bonus
    - Junk patterns: greetings, fillers, questions → penalty
    """
    if not fact or not fact.strip():
        return 0.0

    text = fact.strip()
    score = 0.5  # baseline

    # ── Length scoring ──
    length = len(text)
    if length < 5:
        return 0.0  # absolute junk
    if length < 10:
        score -= 0.25
    elif length < 20:
        score -= 0.1
    elif 30 <= length <= 300:
        score += 0.1  # good length
    elif length > 500:
        score -= 0.15  # too verbose

    words = text.split()
    word_count = len(words)

    # ── Specificity bonus: numbers, dates, proper nouns ──
    import re as _re
    if _re.search(r'\d{4}[-/]\d{2}[-/]\d{2}', text):
        score += 0.15  # contains a date
    if _re.search(r'\b\d+[.,]?\d*\s*(?:kg|lbs?|cm|m|km|°[CF]|lei|euro?|usd|\$|ron)\b', text, _re.I):
        score += 0.1  # contains a measurement/amount
    if any(w[0].isupper() and len(w) > 1 for w in words[1:] if w.isalpha()):
        score += 0.1  # contains proper nouns (capitalized mid-sentence)

    # ── Personal info signals → higher value ──
    lower = text.lower()
    personal_patterns = [
        r'\b(my |mine |i am |i\'m |i have |i\'ve |i like |i love |i hate |i prefer )',
        r'\b(name is |called |born |live in |moved to |wife |husband |son |daughter )',
        r'\b(meu |mea |prefer |ador |urăsc|favorit)',
        r'\b(lucrez |locuiesc |mă numesc|ma numesc|soți[ae]|sotia|copil)',
        r'\b(allergic |birthday |anniversary |phone |email |address )',
    ]
    for pat in personal_patterns:
        if _re.search(pat, lower):
            score += 0.1
            break  # one bonus is enough

    # ── Factual structure bonus: "X is Y", "X prefers Y" ──
    if _re.search(r'(?:is|are|was|were|has|have|prefers?|likes?|works?|lives?)\b', lower):
        score += 0.05

    # ── Junk patterns → penalty ──
    junk_patterns = [
        r'^(?:ok|okay|da|nu|yes|no|sure|alright|fine|good|great|nice|cool|thanks|mersi|mulțumesc|salut|hello|hi|hey|bye|pa)\s*[.!?]*$',
        r'^(?:ce faci|cum ești|how are you|what\'s up|sup)\s*[?]*$',
        r'^(?:haha|lol|lmao|rofl|:[\)\(]|😂|😀|👍)',
    ]
    for pat in junk_patterns:
        if _re.search(pat, lower):
            score -= 0.3

    # ── Question-only penalty (questions rarely make good stored facts) ──
    if text.strip().endswith("?") and word_count < 10:
        score -= 0.15

    # ── Contains "user" or "assistant" verbatim (extraction artifact) ──
    if lower.startswith("user ") or lower.startswith("assistant "):
        score -= 0.2

    return max(0.0, min(1.0, score))


async def _enforce_fact_limit(user_id: str, max_facts: int) -> None:
    """
    If user has more than max_facts, prune the lowest-quality + oldest ones.
    Pruning strategy: sort by quality ASC, then timestamp ASC → delete oldest low-quality first.
    """
    try:
        # Count user's facts
        results = collection.get(
            where={"$and": [{"user_id": user_id}, {"type": "fact"}]},
            include=["metadatas"],
        )
        if not results or not results.get("ids"):
            return
        
        count = len(results["ids"])
        if count <= max_facts:
            return

        # Need to prune: sort by quality (lowest first), then timestamp (oldest first)
        facts = []
        for i, fid in enumerate(results["ids"]):
            meta = results["metadatas"][i] if results.get("metadatas") else {}
            facts.append({
                "id": fid,
                "quality": float(meta.get("quality", 0.5)),
                "timestamp": float(meta.get("timestamp", 0)),
            })

        # Sort: lowest quality first, then oldest first
        facts.sort(key=lambda f: (f["quality"], f["timestamp"]))

        # Delete excess (prune 10% batch to avoid constant single-deletes)
        to_delete = count - max_facts
        to_delete = max(to_delete, int(max_facts * 0.05))  # at least 5% when pruning
        to_delete = min(to_delete, len(facts))  # safety cap

        ids_to_delete = [f["id"] for f in facts[:to_delete]]
        if ids_to_delete:
            collection.delete(ids=ids_to_delete)
            log_line("mem", "🧹", "PRUNE", f"Deleted {len(ids_to_delete)} low-quality facts for {user_id} (had {count}, limit {max_facts})")

    except Exception as e:
        log_line("error", "⚠️", "PRUNE ERR", f"{type(e).__name__}: {e}")


async def save_fact_from_agent(fact: str, user_id: str) -> str:
    """Called by store_memory tool. Single fact_decision (SAVE/UPDATE/IGNORE) then saves. Returns a short message for the AI."""
    clean_fact = clean_text((fact or "").strip())
    if len(clean_fact) < 3:
        return "Memory not saved: fact too short."
    if len(clean_fact) > 300:
        clean_fact = clean_fact[:300].strip()

    # Quality pre-check before spending an LLM call on arbitration
    quality = _score_fact_quality(clean_fact)
    if quality < 0.2:
        log_line("mem", "🚫", "QUALITY", f"Agent fact rejected (score={quality:.2f}): {clean_fact[:80]}")
        return "Memory not saved: content quality too low (too generic or short)."

    llm_url, llm_model, llm_api_key = _get_aux_or_main_llm()
    mem_cfg = settings_mod.CFG.get("memory") or {}
    try:
        fact_sim_threshold = float(mem_cfg.get("fact_similarity_threshold", 0.45))
        action = await _arbitrate_and_store(clean_fact, user_id, llm_url, llm_model, fact_sim_threshold, "TOOL", llm_api_key)
        if action == "IGNORE":
            return "Memory not saved: duplicate or too similar to an existing memory."
        if action == "UPDATE":
            return "Memory updated."
        return "Memory saved."
    except Exception as e:
        log_line("error", "⚠️", "MEMORY TOOL", f"{type(e).__name__}: {e}")
        return "Memory save failed due to an error."

