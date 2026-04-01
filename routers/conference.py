"""Conference API — multi-AI chatroom where several models respond to the same prompt.

v2: Free-flowing discussion — agents debate naturally via an LLM orchestrator
that chooses who speaks next and detects convergence.
"""
import asyncio
import fcntl
import json
import os
import random
import re
import time
import uuid
from collections import defaultdict
from typing import List, Optional, Dict, Any, Set

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import auth
import models
import settings as settings_mod
from brain.cortex import (
    _normalize_chat_url,
    _llm_headers,
    _stream_llm_turn,
    strip_think_content,
    _estimate_tokens,
    _ThinkContentStreamParser,
    _normalize_messages_for_api,
    _tool_call_status_label,
)
from brain.toolbox import get_available_tools, execute_tool, get_last_search_sources, clear_last_search_sources
from llm_client import get_llm_client
from logger import log_line

router = APIRouter(prefix="/api/conference", tags=["conference"])

# ---------------------------------------------------------------------------
# Post-processing: extract actual conversational speech from model output
# ---------------------------------------------------------------------------
# Models (all of them, not just thinking models) tend to dump their entire
# chain-of-thought as visible content: "Thinking Process:\nAnalyze the
# Request:\nRole: ...\nStrategy: ...\n\nActual response here."
#
# Strategy: find where the actual speech starts by detecting the boundary
# between reasoning and response. Multiple heuristics are combined.
# ---------------------------------------------------------------------------

# Headers that scream "this is internal reasoning, not speech"
# NOTE: Only match clear chain-of-thought headers, NOT common speech words
# like "First:", "Note:", "Summary:" which appear in legitimate responses.
_COT_HEADER_RE = re.compile(
    r"^[ \t]*(?:\*\*)?(?:"
    r"Thinking Process|Think(?:ing)?|Analyze the Request|"
    r"Corrections?(?:/Verification)?|Refinements?|Refining|"
    r"Critical Fact Check|Previous Responses?|My Role|"
    r"Drafting(?:\s+the\s+Response)?|Safety(?:/Policy)?(?:\s+Check)?|"
    r"Key (?:Points?|Considerations?|Issues?)|One more check|"
    r"Format Constraints?|Output (?:Format|Rules?)|Response (?:Plan|Draft)"
    r")(?:\*\*)?[ \t]*[:—\-]",
    re.IGNORECASE,
)

# Pattern: indented sub-items like "    Role: Critic (constructive...)"
_COT_INDENTED_RE = re.compile(r"^[ \t]{4,}(?:\*\*)?[A-Z][a-zA-Z /]+(?:\*\*)?[:—\-]", re.MULTILINE)


def _extract_speech(text: str) -> str:
    """Extract the actual conversational speech from model output that may
    contain leaked chain-of-thought reasoning.

    Returns the cleaned speech, or the original text if no reasoning pattern
    is detected.
    """
    if not text or len(text) < 30:
        return text

    lines = text.split("\n")
    # Score each line: is it reasoning or speech?
    # We look for the LAST contiguous block of non-reasoning lines
    line_is_cot = []
    for line in lines:
        stripped = line.strip()
        is_cot = bool(
            _COT_HEADER_RE.match(stripped)
            or _COT_INDENTED_RE.match(line)
            or stripped.startswith(("**Thinking", "**Analyze", "**Drafting",
                                    "**Refining", "**Critical", "**My Role",
                                    "**Previous", "**Correction"))
        )
        line_is_cot.append(is_cot)

    # Count how many lines are CoT
    cot_count = sum(line_is_cot)
    total_lines = len(lines)

    # If less than 30% of lines are CoT headers, probably no reasoning leak
    if cot_count < max(3, total_lines * 0.3):
        return text

    # Find the last block of consecutive non-CoT, non-empty lines
    # Walk backwards from end to find speech block
    speech_lines = []
    in_speech = False
    for i in range(len(lines) - 1, -1, -1):
        stripped = lines[i].strip()
        if not stripped:
            if in_speech:
                speech_lines.append(lines[i])
            continue
        if not line_is_cot[i]:
            in_speech = True
            speech_lines.append(lines[i])
        else:
            if in_speech:
                break  # Hit CoT again — we've found the boundary

    speech_lines.reverse()
    speech = "\n".join(speech_lines).strip()

    # Sanity: if extracted speech is too short vs original, try a different approach
    if len(speech) < 20 and len(text) > 100:
        # Fallback: just strip all lines that match CoT headers
        fallback_lines = [l for i, l in enumerate(lines) if not line_is_cot[i]]
        fallback = "\n".join(fallback_lines).strip()
        fallback = re.sub(r"\n{3,}", "\n\n", fallback)
        if len(fallback) > len(speech):
            speech = fallback

    # Final sanity: if we'd lose everything, return original
    if not speech or len(speech) < 10:
        return text

    return re.sub(r"\n{3,}", "\n\n", speech).strip()

# ---------------------------------------------------------------------------
# Persistence — lightweight JSON files (same pattern as sessions/)
# ---------------------------------------------------------------------------
_CONF_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "conferences")
os.makedirs(_CONF_DIR, exist_ok=True)

# Active stream tracking — cancellation + mid-discussion interjection
_active_streams: Dict[str, asyncio.Event] = {}       # conf_id -> cancel event
_interjection_queues: Dict[str, asyncio.Queue] = {}  # conf_id -> user msg queue

# Background task tracking — prevent leaked fire-and-forget tasks
_background_tasks: Set[asyncio.Task] = set()

# Rate limiting — in-memory per-user sliding window
_rate_limit_window: Dict[str, list] = defaultdict(list)  # user_id -> [timestamps]
_RATE_LIMIT_MAX = 10       # max requests per window
_RATE_LIMIT_WINDOW_S = 60  # window in seconds


def _check_rate_limit(user_id: str):
    """Raise 429 if user exceeds rate limit."""
    now = time.time()
    window = _rate_limit_window[user_id]
    # Prune old entries
    cutoff = now - _RATE_LIMIT_WINDOW_S
    _rate_limit_window[user_id] = [t for t in window if t > cutoff]
    if len(_rate_limit_window[user_id]) >= _RATE_LIMIT_MAX:
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again later.")
    _rate_limit_window[user_id].append(now)


def _track_background_task(coro):
    """Create a tracked background task that auto-removes itself on completion."""
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task


# Prompt injection sanitizer — strip dangerous control sequences
_INJECTION_PATTERNS = re.compile(
    r"(?:SYSTEM:|ASSISTANT:|USER:|HUMAN:|<<SYS>>|<</SYS>>|<\|im_start\|>|<\|im_end\|>|"
    r"\[INST\]|\[/INST\]|\\nHuman:|\\nAssistant:|<\|system\|>|<\|user\|>|<\|assistant\|>|"
    r"<\|end_header_id\|>|<\|begin_of_text\|>|<\|end_of_text\|>|<\|eot_id\|>|"
    r"<\|start_header_id\|>|<\|endoftext\|>|"
    r"<thinking>|</thinking>|<tool_call>|</tool_call>|"
    r"\[System\]|\[ROLE\]|\[AVAILABLE DEVICES\]|\[AVAILABLE SKILLS\]|"
    r"\[CONVERSATION SUMMARY\]|\[MEMORIES ABOUT THE USER\])",
    re.IGNORECASE,
)

# Zero-width and invisible Unicode characters used to hide injections
_INVISIBLE_CHARS = re.compile(r'[\u200b\u200c\u200d\u200e\u200f\u2060\u2061\u2062\u2063\u2064\ufeff\u0000-\u0008]')


def _sanitize_user_text(text: str) -> str:
    """Strip potential prompt injection sequences from user-provided text."""
    if not text:
        return text
    import unicodedata
    # Normalize Unicode to catch homoglyphs and confusable chars
    result = unicodedata.normalize('NFKC', text)
    # Remove invisible/zero-width characters
    result = _INVISIBLE_CHARS.sub('', result)
    # Remove injection patterns
    result = _INJECTION_PATTERNS.sub('', result)
    return result.strip()


_SAFE_ID_RE = re.compile(r'^[a-zA-Z0-9_-]{1,64}$')


def _validate_conf_id(conf_id: str):
    """Raise if conf_id contains path traversal or unsafe characters."""
    if not _SAFE_ID_RE.match(conf_id):
        raise HTTPException(status_code=400, detail="Invalid conference ID")


def _conf_path(conf_id: str) -> str:
    _validate_conf_id(conf_id)
    return os.path.join(_CONF_DIR, f"{conf_id}.json")


def _load_conference(conf_id: str) -> Optional[Dict]:
    p = _conf_path(conf_id)
    if not os.path.exists(p):
        return None
    with open(p, "r", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_SH)
        try:
            return json.load(f)
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def _save_conference(conf_id: str, data: Dict):
    path = _conf_path(conf_id)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            json.dump(data, f, ensure_ascii=False, indent=2)
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)
    os.replace(tmp, path)


def _list_conferences(user_id: str) -> List[Dict]:
    """List all conferences for a user, newest first."""
    results = []
    if not os.path.isdir(_CONF_DIR):
        return results
    for fname in os.listdir(_CONF_DIR):
        if not fname.endswith(".json"):
            continue
        try:
            with open(os.path.join(_CONF_DIR, fname), "r", encoding="utf-8") as f:
                data = json.load(f)
            if str(data.get("user_id")) == str(user_id):
                results.append({
                    "id": data["id"],
                    "title": data.get("title", ""),
                    "mode": data.get("mode", "brainstorm"),
                    "participants": [p.get("name", "") for p in data.get("participants", [])],
                    "message_count": len(data.get("messages", [])),
                    "created_at": data.get("created_at", 0),
                    "updated_at": data.get("updated_at", 0),
                    "forked_from": data.get("forked_from"),
                    "has_artifact": data.get("artifact") is not None,
                })
        except Exception:
            continue
    results.sort(key=lambda x: x.get("updated_at", 0), reverse=True)
    return results


# ---------------------------------------------------------------------------
# Predefined AI personas
# ---------------------------------------------------------------------------
PERSONAS = {
    "analyst": {
        "name": "Analyst",
        "icon": "fa-chart-line",
        "color": "#3b82f6",
        "system": (
            "You are the Analyst. You're sharp, data-driven, methodical. "
            "You break problems into measurable components, cite evidence, identify risks."
        ),
    },
    "creative": {
        "name": "Creative",
        "icon": "fa-paintbrush",
        "color": "#f59e0b",
        "system": (
            "You are the Creative. You're imaginative, bold, unconventional. "
            "You think laterally, propose unexpected solutions, use metaphors."
        ),
    },
    "critic": {
        "name": "Critic",
        "icon": "fa-gavel",
        "color": "#ef4444",
        "system": (
            "You are the Critic. You're constructive and thoughtful. "
            "You stress-test ideas by finding edge cases, logical gaps, and hidden costs. "
            "However, you freely acknowledge strong ideas — you're not contrarian for the sake of it. "
            "When something is obviously good or obviously true, say so and move on to deeper analysis."
        ),
    },
    "pragmatist": {
        "name": "Pragmatist",
        "icon": "fa-wrench",
        "color": "#10b981",
        "system": (
            "You are the Pragmatist. You're practical, execution-focused, cost-conscious. "
            "You turn abstract ideas into concrete next steps."
        ),
    },
    "visionary": {
        "name": "Visionary",
        "icon": "fa-rocket",
        "color": "#8b5cf6",
        "system": (
            "You are the Visionary. You're future-oriented, ambitious, strategic. "
            "You see the big picture, connect dots across domains, think 5 years ahead."
        ),
    },
    "devil_advocate": {
        "name": "Devil's Advocate",
        "icon": "fa-mask",
        "color": "#ec4899",
        "system": (
            "You are the Devil's Advocate. You look for blind spots and uncomfortable truths "
            "that others might miss. You challenge assumptions — but ONLY when there's a genuine "
            "alternative perspective worth exploring. On clear-cut topics, you agree quickly "
            "and pivot to more interesting nuances rather than forcing absurd contrarian positions."
        ),
    },
}

# Mode-specific system prompt additions (defaults)
_DEFAULT_MODE_PROMPTS = {
    "brainstorm": "This is a brainstorm session. Generate ideas, build on others' suggestions, think creatively. Agree and extend good ideas rather than tearing them down.",
    "debate": "This is a debate session. Take positions and defend them with arguments — but be intellectually honest. If someone makes a strong point, acknowledge it. Disagree only where there's genuine room for disagreement.",
    "review": "This is a review session. Analyze thoughtfully, evaluate pros/cons, provide your expert assessment. Highlight both strengths and weaknesses fairly.",
}
# Legacy alias for any code referencing MODE_PROMPTS directly
MODE_PROMPTS = _DEFAULT_MODE_PROMPTS

# Conversation instruction appended to ALL modes so responses feel natural
_DEFAULT_CONVERSATION_INSTRUCTION = (
    "\n\nYou are in a LIVE GROUP DISCUSSION with other AI participants and a human moderator. "
    "This is a free-flowing conversation — not a formal presentation. "
    "Respond like a real person talking in a meeting — casual, direct, natural.\n\n"
    "DISCUSSION RULES:\n"
    "1. Write ONLY your spoken response. Nothing else.\n"
    "2. REACT to what others just said — agree, disagree, or build on their points.\n"
    "3. BE INTELLECTUALLY HONEST. If someone says something obviously true or makes a strong point, "
    "AGREE with them. Don't contradict for the sake of sounding different. Real smart people agree "
    "on obvious things and only debate genuine gray areas.\n"
    "4. It's perfectly fine to say 'Sunt de acord cu X' and then ADD NUANCE or a new angle. "
    "Agreement + extension is more valuable than forced disagreement.\n"
    "5. Only CONTRADICT when you have a genuinely different perspective backed by reasoning. "
    "Disagreeing on something obviously clear-cut makes you look absurd, not smart.\n"
    "6. Reference other participants by name (e.g., 'Bun punct de la Analyst — aș adăuga că...')\n"
    "7. Keep it SHORT — 1-2 paragraphs. This is a conversation, not a monologue.\n"
    "8. Reply in the same language the user used.\n"
    "9. Don't repeat what others already said. Add genuine value — new info, nuance, or experience.\n"
    "10. If the group is converging on a consensus, agree and move on to the next interesting question.\n\n"
    "STRICT OUTPUT RULES:\n"
    "- NEVER output meta-text like 'Thinking Process:', 'Analyze:', 'Role:', 'Strategy:' etc.\n"
    "- NEVER describe what you're going to say — just say it.\n"
    "- NO bullet points, NO headers. Plain paragraphs like speech.\n\n"
    "EXAMPLE of a GOOD response (agreeing + adding value):\n"
    '"Clar, ce zice Creative are sens — video content e direcția bună. '
    'Aș adăuga doar că pe LinkedIn avem deja 3x mai mult engagement pe video '
    'decât pe text, deci cifrele confirmă."\n\n'
    "EXAMPLE of a GOOD response (genuine disagreement):\n"
    '"Aici nu sunt de acord cu Pragmatist — costul e important, dar dacă economisim '
    'prea mult pe calitate, pierdem clienți pe termen lung. Am văzut asta de multe ori."\n\n'
    "EXAMPLE of a BAD response (forced, absurd disagreement):\n"
    '"Hmm, nu sunt sigur că pizza e mai bună decât să fii călcat de mașină..." '
    '— NEVER do this. On obvious topics, agree instantly and move on.\n\n'
    "Your response must be natural speech, no meta-analysis."
)

# Orchestrator prompt — decides who speaks next and when to conclude
_DEFAULT_ORCHESTRATOR_SYSTEM = (
    "You are a silent discussion moderator. Your ONLY job is to decide who speaks next "
    "in a group conversation, or whether the discussion should conclude.\n\n"
    "Rules:\n"
    "- Pick someone who has a NEW perspective to add, not someone who'll repeat existing points\n"
    "- Pick someone who was directly asked a question or addressed by name\n"
    "- Pick someone who hasn't spoken recently and could move the conversation FORWARD\n"
    "- NEVER pick the person who JUST spoke (avoid back-to-back)\n"
    "- If the group AGREES on something, don't force more debate on that topic — move on or conclude\n"
    "- If the conversation is going in circles (same arguments repeated), conclude immediately\n"
    "- If consensus is reached quickly on a simple/obvious question, conclude early — that's good\n"
    "- Aim for natural length: simple questions need 1-2 rounds, complex ones need more\n\n"
    "Reply with ONLY a JSON object, nothing else:\n"
    '{{"next": "participant_name", "reason": "brief reason"}}\n'
    "OR to end the discussion:\n"
    '{{"next": "CONCLUDE", "reason": "brief reason"}}'
)

# Synthesis prompt — generates a summary after discussion concludes
_DEFAULT_SUMMARY_SYSTEM = (
    "You observed a full group discussion between multiple AI participants and a human moderator. "
    "Produce a concise, well-structured summary that includes:\n"
    "1. Key points and ideas discussed\n"
    "2. Areas of agreement\n"
    "3. Areas of disagreement or unresolved tensions\n"
    "4. Actionable conclusions or next steps\n\n"
    "Use the same language as the discussion. "
    "Reply with ONLY the summary — no meta-text, no preamble."
)

# Artifact update prompt — maintains a living document co-created during discussion
_DEFAULT_ARTIFACT_SYSTEM = (
    "You are a document editor. You maintain a living document that is being co-created "
    "during a group discussion. After each participant speaks, you update the document "
    "with their contributions.\n\n"
    "Rules:\n"
    "- The document uses Markdown format\n"
    "- Organize content into logical sections with ## headers\n"
    "- Each section should capture key ideas, decisions, or analysis\n"
    "- Integrate new contributions naturally — don't just append quotes\n"
    "- Remove redundancy, keep the document clean and useful\n"
    "- Preserve the best insights from all participants\n"
    "- The document should be a deliverable artifact, not meeting notes\n"
    "- Use the same language as the discussion\n\n"
    "Reply with ONLY the updated document in Markdown. No preamble, no explanation."
)

# Memory extraction prompt for expert persistence
_MEMORY_EXTRACT_SYSTEM = (
    "You observed a discussion where an AI participant played a specific role. "
    "Extract 2-5 key learnings, insights, or facts that this participant discovered "
    "or established during the discussion. These will be stored as persistent memory "
    "for this persona to use in future discussions.\n\n"
    "Rules:\n"
    "- Each learning should be a concise, factual statement\n"
    "- Focus on domain-relevant insights, not discussion meta-data\n"
    "- Include conclusions, discovered facts, and established positions\n"
    "- Use the same language as the discussion\n\n"
    "Reply with ONLY a JSON array of strings. Example:\n"
    '[\"The target market is price-sensitive (elasticity > 1.5)\", \"React Native was rejected due to performance concerns\"]'
)


# ---------------------------------------------------------------------------
# Configurable prompt getters — read from settings, fall back to defaults
# ---------------------------------------------------------------------------

def _get_conversation_instruction() -> str:
    """Get conversation instruction from config or use default."""
    conf_cfg = (settings_mod.CFG.get("conference") or {})
    custom = (conf_cfg.get("conversation_instruction") or "").strip()
    return custom if custom else _DEFAULT_CONVERSATION_INSTRUCTION


def _get_mode_prompt(mode: str) -> str:
    """Get mode-specific prompt from config or use default."""
    conf_cfg = (settings_mod.CFG.get("conference") or {})
    custom_modes = conf_cfg.get("mode_prompts") or {}
    custom = (custom_modes.get(mode) or "").strip()
    return custom if custom else _DEFAULT_MODE_PROMPTS.get(mode, _DEFAULT_MODE_PROMPTS["brainstorm"])


def _get_orchestrator_system() -> str:
    """Get orchestrator system prompt from config or use default."""
    conf_cfg = (settings_mod.CFG.get("conference") or {})
    custom = (conf_cfg.get("orchestrator_system_prompt") or "").strip()
    return custom if custom else _DEFAULT_ORCHESTRATOR_SYSTEM


def _get_summary_system() -> str:
    """Get synthesis/summary system prompt from config or use default."""
    conf_cfg = (settings_mod.CFG.get("conference") or {})
    custom = (conf_cfg.get("summary_system_prompt") or "").strip()
    return custom if custom else _DEFAULT_SUMMARY_SYSTEM


def _get_artifact_system() -> str:
    """Get artifact update system prompt from config or use default."""
    conf_cfg = (settings_mod.CFG.get("conference") or {})
    custom = (conf_cfg.get("artifact_system_prompt") or "").strip()
    return custom if custom else _DEFAULT_ARTIFACT_SYSTEM


# ---------------------------------------------------------------------------
# Persona persistent memory (Expert Persistence)
# ---------------------------------------------------------------------------
_PERSONA_MEMORY_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "conferences", "persona_memories")
os.makedirs(_PERSONA_MEMORY_DIR, exist_ok=True)


def _validate_persona_id(persona_id: str):
    """Raise if persona_id contains path traversal or unsafe characters."""
    if not _SAFE_ID_RE.match(persona_id):
        raise HTTPException(status_code=400, detail="Invalid persona ID")


def _persona_memory_path(persona_id: str) -> str:
    _validate_persona_id(persona_id)
    return os.path.join(_PERSONA_MEMORY_DIR, f"{persona_id}.json")


def _load_persona_memories(persona_id: str, limit: int = 30) -> List[str]:
    path = _persona_memory_path(persona_id)
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            fcntl.flock(f, fcntl.LOCK_SH)
            try:
                memories = json.load(f)
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)
        return memories[-limit:] if len(memories) > limit else memories
    except Exception as e:
        log_line("conf", "⚠️", "MEMORY_LOAD_ERR", f"Failed to load memories for {persona_id}: {e}")
        return []


def _save_persona_memories(persona_id: str, new_memories: List[str]):
    path = _persona_memory_path(persona_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Atomic read-modify-write with exclusive file lock
    existing = []
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                fcntl.flock(f, fcntl.LOCK_SH)
                try:
                    existing = json.load(f)
                finally:
                    fcntl.flock(f, fcntl.LOCK_UN)
        except Exception as e:
            log_line("conf", "⚠️", "MEMORY_READ_ERR", f"Failed to read existing memories for {persona_id}: {e}")
            existing = []
    # Deduplicate: skip new memories that already exist (case-insensitive)
    existing_lower = {m.lower().strip() for m in existing}
    for m in new_memories:
        if m.strip().lower() not in existing_lower:
            existing.append(m)
            existing_lower.add(m.strip().lower())
    if len(existing) > 50:
        existing = existing[-50:]
    # Write with exclusive lock + atomic replace
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            json.dump(existing, f, ensure_ascii=False, indent=2)
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)
    os.replace(tmp, path)


def _get_persona_memory_counts() -> Dict[str, int]:
    """Return {persona_id: memory_count} for all personas."""
    counts = {}
    for pid in PERSONAS:
        path = _persona_memory_path(pid)
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    counts[pid] = len(json.load(f))
            except Exception:
                counts[pid] = 0
        else:
            counts[pid] = 0
    return counts


# ---------------------------------------------------------------------------
# Artifact — live document co-created during discussion
# ---------------------------------------------------------------------------

async def _update_artifact(
    client, url: str, model: str, api_key: str,
    current_artifact: str, participant_name: str,
    latest_message: str, topic: str, timeout: float = 30,
) -> Optional[str]:
    """Update the artifact document based on a participant's latest contribution."""
    if not url or not model:
        return None
    user_prompt = (
        f"Topic: {topic}\n\n"
        f"Current document:\n{current_artifact or '(empty — create the initial structure)'}\n\n"
        f"Latest contribution from {participant_name}:\n{latest_message[:800]}\n\n"
        f"Update the document incorporating this participant's contribution."
    )
    return await _call_llm_simple(
        client, url, model,
        [{"role": "system", "content": _get_artifact_system()},
         {"role": "user", "content": user_prompt}],
        api_key=api_key, timeout=timeout, max_tokens=2000,
    )


async def _extract_persona_learnings(
    client, url: str, model: str, api_key: str,
    persona_name: str, persona_role: str,
    messages: list, topic: str, timeout: float = 30,
) -> List[str]:
    """Extract learnings for a specific persona from the discussion."""
    persona_msgs = [m for m in messages if m.get("participant_name") == persona_name and m.get("role") == "ai"]
    if not persona_msgs:
        return []
    conv_text = f"Topic: {topic}\nRole: {persona_role}\n\n"
    for m in persona_msgs:
        conv_text += f"[{persona_name}]: {m['content'][:300]}\n\n"
    raw = await _call_llm_simple(
        client, url, model,
        [{"role": "system", "content": _MEMORY_EXTRACT_SYSTEM},
         {"role": "user", "content": f"Extract learnings for {persona_name} ({persona_role}):\n\n{conv_text}"}],
        api_key=api_key, timeout=timeout, max_tokens=500,
    )
    if not raw:
        return []
    try:
        cleaned = re.sub(r"```(?:json)?\s*", "", raw).strip().rstrip("`")
        learnings = json.loads(cleaned)
        if isinstance(learnings, list):
            return [str(l) for l in learnings if l]
    except (json.JSONDecodeError, TypeError) as e:
        log_line("conf", "⚠️", "MEMORY_PARSE_ERR", f"Failed to parse learnings for {persona_name}: {e} — raw={raw[:200]}")
    return []


async def _artifact_update_events(client, data, orch_url, orch_model, orch_api_key, topic):
    """Yield artifact update SSE events if artifact mode is enabled."""
    if "artifact" not in data or data.get("artifact") is None:
        return
    msgs = data.get("messages", [])
    if not msgs:
        return
    last_msg = msgs[-1]
    if last_msg.get("role") != "ai":
        return
    artifact_content = await _update_artifact(
        client, orch_url, orch_model, orch_api_key,
        data["artifact"].get("content", ""),
        last_msg.get("participant_name", "AI"),
        last_msg.get("content", ""),
        topic,
    )
    if artifact_content:
        data["artifact"]["content"] = artifact_content
        data["artifact"]["version"] = data["artifact"].get("version", 0) + 1
        data["artifact"]["history"].append({
            "version": data["artifact"]["version"],
            "updated_by": last_msg.get("participant_name", ""),
            "timestamp": time.time(),
        })
        yield f"event: artifact_update\ndata: {json.dumps({'content': artifact_content, 'version': data['artifact']['version'], 'updated_by': last_msg.get('participant_name', '')})}\n\n"


# ---------------------------------------------------------------------------
# Free discussion configuration defaults
# ---------------------------------------------------------------------------
_DEFAULT_MIN_TURNS = 4    # minimum turns before orchestrator can conclude
_DEFAULT_MAX_TURNS = 15   # hard stop to prevent infinite loops


# ---------------------------------------------------------------------------
# Orchestrator — picks next speaker / detects convergence
# ---------------------------------------------------------------------------

async def _call_llm_simple(client, url: str, model: str, messages: list,
                            api_key: str = "", timeout: float = 30,
                            max_tokens: int = 200) -> Optional[str]:
    """Non-streaming LLM call for orchestrator decisions. Returns raw text.
    Retries up to 2 times with exponential backoff on failure."""
    headers = _llm_headers(api_key)
    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.3,
        "max_tokens": max_tokens,
        "stream": False,
    }
    last_err = None
    for attempt in range(3):
        try:
            resp = await client.post(url, json=payload, headers=headers, timeout=timeout)
            resp.raise_for_status()
            data = resp.json()
            return (data.get("choices") or [{}])[0].get("message", {}).get("content", "").strip()
        except Exception as e:
            last_err = e
            log_line("conf", "⚠️", "ORCHESTRATOR_LLM", f"Attempt {attempt+1}/3 {type(e).__name__}: {e}")
            if attempt < 2:
                await asyncio.sleep(1.5 * (attempt + 1))  # 1.5s, 3s
    log_line("conf", "❌", "ORCHESTRATOR_LLM", f"All retries failed: {last_err}")
    return None


async def _pick_next_speaker(
    client, url: str, model: str, api_key: str, timeout: float,
    participants: list, messages: list,
    turn_count: int, min_turns: int, max_turns: int,
    last_speaker_id: Optional[str] = None,
    speakers_so_far: Optional[set] = None,
    batch_size: int = 3,
) -> List[Dict[str, str]]:
    """Ask the orchestrator LLM who should speak next.

    Returns a list of decisions: [{"next": "name", "pid": "...", "reason": "..."}]
    or [{"next": "CONCLUDE", "reason": "..."}].
    Batch planning: asks for up to batch_size speakers at once to reduce round-trips.
    Falls back to random selection if LLM fails.
    """
    if speakers_so_far is None:
        speakers_so_far = set()

    participant_names = [p["name"] for p in participants]
    last_speaker_name = None
    for p in participants:
        if p["id"] == last_speaker_id:
            last_speaker_name = p["name"]
            break

    # Build compact conversation summary (last 8 messages max)
    recent = messages[-8:]
    turns_text = []
    for msg in recent:
        if msg.get("role") == "user":
            turns_text.append(f"[Moderator]: {msg['content'][:250]}")
        elif msg.get("role") == "ai":
            turns_text.append(f"[{msg.get('participant_name', 'AI')}]: {msg['content'][:250]}")

    # Who hasn't spoken yet
    not_yet = [p["name"] for p in participants if p["id"] not in speakers_so_far]

    can_conclude = turn_count >= min_turns and len(not_yet) == 0
    conclude_instruction = (
        "If the group has reached genuine consensus or is repeating itself, set next to \"CONCLUDE\" for any slot."
        if can_conclude else
        f"Do NOT conclude yet — minimum {min_turns} turns, currently at {turn_count}."
        + (f" These participants haven't spoken yet: {', '.join(not_yet)}." if not_yet else "")
    )

    remaining_turns = max_turns - turn_count
    actual_batch = min(batch_size, remaining_turns, len(participants))

    user_prompt = (
        f"Participants: {', '.join(participant_names)}\n"
        f"Turn {turn_count + 1} / max {max_turns}\n"
        f"Last speaker: {last_speaker_name or 'none'}\n"
        f"Haven't spoken yet: {', '.join(not_yet) if not_yet else 'everyone spoke'}\n\n"
        f"Recent conversation:\n" + "\n".join(turns_text) + "\n\n"
        f"{conclude_instruction}\n\n"
        f"Plan the next {actual_batch} speakers. No back-to-back same speaker.\n"
        f"Reply with ONLY a JSON array of objects: [{{\"next\": \"Name\", \"reason\": \"...\"}}]\n"
        f"Use CONCLUDE as the name if the discussion should end."
    )

    raw = await _call_llm_simple(
        client, url, model,
        [{"role": "system", "content": _get_orchestrator_system()},
         {"role": "user", "content": user_prompt}],
        api_key=api_key, timeout=timeout, max_tokens=300,
    )

    if raw:
        try:
            cleaned = re.sub(r"```(?:json)?\s*", "", raw).strip().rstrip("`")
            parsed = json.loads(cleaned)

            # Handle both single object and array responses
            if isinstance(parsed, dict):
                parsed = [parsed]

            if isinstance(parsed, list):
                results = []
                prev_pid = last_speaker_id
                for item in parsed[:actual_batch]:
                    next_name = item.get("next", "")
                    reason = item.get("reason", "")

                    if next_name == "CONCLUDE" and can_conclude:
                        log_line("conf", "🏁", "ORCHESTRATOR", f"CONCLUDE: {reason}")
                        results.append({"next": "CONCLUDE", "reason": reason})
                        return results

                    # Validate the name matches a participant (and not the previous speaker)
                    for p in participants:
                        if p["name"].lower() == next_name.lower() and p["id"] != prev_pid:
                            results.append({"next": p["name"], "pid": p["id"], "reason": reason})
                            prev_pid = p["id"]
                            break

                if results:
                    log_line("conf", "🎯", "ORCHESTRATOR_BATCH", f"Planned {len(results)} turns: {[r['next'] for r in results]}")
                    return results

            log_line("conf", "⚠️", "ORCHESTRATOR", f"Could not parse batch, falling back. Raw: {raw[:200]}")
        except (json.JSONDecodeError, KeyError) as e:
            log_line("conf", "⚠️", "ORCHESTRATOR", f"Parse error: {e}, raw: {raw[:200]}")

    # Fallback: random selection excluding last speaker, preferring those who haven't spoken
    candidates = [p for p in participants if p["id"] != last_speaker_id]
    if not candidates:
        candidates = list(participants)

    # Prefer participants who haven't spoken yet
    unseen = [p for p in candidates if p["id"] not in speakers_so_far]
    if unseen:
        pick = random.choice(unseen)
    else:
        pick = random.choice(candidates)

    log_line("conf", "🎲", "ORCHESTRATOR_FALLBACK", f"Random pick: {pick['name']}")
    return [{"next": pick["name"], "pid": pick["id"], "reason": "random fallback"}]


# ---------------------------------------------------------------------------
# Helper: resolve LLM config for a participant
# ---------------------------------------------------------------------------
def _resolve_participant_llm(participant: dict, global_llm: dict) -> dict:
    """Return {url, model, api_key, timeout, max_tokens, temperature} for a participant."""
    profile_id = participant.get("model_profile_id")
    profile = _resolve_model_profile(profile_id) if profile_id else {}
    p_llm = profile if profile else global_llm
    return {
        "url": _normalize_chat_url(p_llm.get("target_url", "")),
        "model": p_llm.get("model_name", ""),
        "api_key": (p_llm.get("api_key") or "").strip(),
        "timeout": float(p_llm.get("timeout", 120)),
        "max_tokens": int(p_llm.get("max_tokens", 2048)),
        "temperature": float(p_llm.get("temperature", 0.7)),
    }


# ---------------------------------------------------------------------------
# Discussion synthesis — summary at the end
# ---------------------------------------------------------------------------

async def _generate_summary(
    client, url: str, model: str, api_key: str,
    messages: list, topic: str, timeout: float = 60,
) -> Optional[str]:
    """Generate a concise synthesis after the discussion concludes."""
    if not url or not model:
        return None
    conv_parts = []
    for msg in messages:
        if msg.get("role") == "user":
            conv_parts.append(f"[User]: {msg['content'][:500]}")
        elif msg.get("role") == "ai":
            conv_parts.append(f"[{msg.get('participant_name', 'AI')}]: {msg['content'][:500]}")
    if not conv_parts:
        return None
    conversation_text = "\n\n".join(conv_parts)
    if topic:
        conversation_text = f"Discussion topic: {topic}\n\n{conversation_text}"
    user_prompt = f"Summarize this group discussion:\n\n{conversation_text}"
    return await _call_llm_simple(
        client, url, model,
        [{"role": "system", "content": _get_summary_system()},
         {"role": "user", "content": user_prompt}],
        api_key=api_key, timeout=timeout, max_tokens=1000,
    )


# ---------------------------------------------------------------------------
# Interjection drain — process user messages injected mid-discussion
# ---------------------------------------------------------------------------

async def _drain_interjections(queue: asyncio.Queue, data: dict):
    """Yield SSE events for any pending user interjections."""
    while not queue.empty():
        try:
            msg_text = queue.get_nowait()
            if msg_text:
                data["messages"].append({
                    "role": "user",
                    "content": msg_text,
                    "timestamp": time.time(),
                })
                yield f"event: user_interjection\ndata: {json.dumps({'content': msg_text})}\n\n"
                log_line("conf", "💬", "INTERJECTION", f"User: {msg_text[:100]}")
        except asyncio.QueueEmpty:
            break


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------
class ParticipantConfig(BaseModel):
    """Per-participant configuration when creating a conference."""
    persona_id: str
    custom_name: Optional[str] = None       # None = use persona default name
    custom_icon: Optional[str] = None       # None = use persona default icon
    custom_color: Optional[str] = None      # None = use persona default color
    system_prompt: Optional[str] = None     # None = use default
    model_profile_id: Optional[str] = None  # None = use global LLM
    tools_enabled: Optional[bool] = None    # None/True = tools enabled


class CreateConferenceReq(BaseModel):
    title: str = ""
    mode: str = "brainstorm"
    participant_ids: List[str] = Field(default_factory=list)  # legacy
    participants_config: List[ParticipantConfig] = Field(default_factory=list)  # new
    topic: str = ""
    artifact_enabled: bool = False  # enable live artifact co-creation
    expert_memory_enabled: bool = True  # enable expert persistence


class ConferenceMessageReq(BaseModel):
    message: str


def _resolve_model_profile(profile_id: Optional[str]) -> Dict[str, Any]:
    """Resolve a model profile ID to its config dict. Returns {} if not found."""
    if not profile_id:
        return {}
    for p in (settings_mod.CFG.get("model_profiles") or []):
        if p.get("id") == profile_id:
            return p
    return {}


def _is_profile_configured(profile: Dict[str, Any]) -> bool:
    """A profile is usable only if both target_url and model_name are set."""
    if not profile:
        return False
    return bool((profile.get("target_url") or "").strip() and (profile.get("model_name") or "").strip())


def _is_local_profile(profile: Dict[str, Any]) -> bool:
    """Detect if profile points to a local runtime."""
    provider = (profile.get("provider") or "").strip().lower()
    if provider == "local":
        return True
    url = (profile.get("target_url") or "").strip().lower()
    return any(host in url for host in ("localhost", "127.0.0.1", "0.0.0.0", "::1"))


def _pick_orchestrator_auto_profile() -> Dict[str, Any]:
    """Auto policy: prefer local configured profile, else any configured profile (random)."""
    profiles = settings_mod.CFG.get("model_profiles") or []
    configured = [p for p in profiles if _is_profile_configured(p)]
    if not configured:
        return {}
    locals_only = [p for p in configured if _is_local_profile(p)]
    if locals_only:
        return random.choice(locals_only)
    return random.choice(configured)


# ---------------------------------------------------------------------------
# API Endpoints
# ---------------------------------------------------------------------------

@router.get("/personas")
async def get_personas(_: models.User = Depends(auth.get_current_user)):
    """Return available AI personas with their default system prompts."""
    return {pid: {"id": pid, "name": p["name"], "icon": p["icon"], "color": p["color"],
                  "system": p["system"]}
            for pid, p in PERSONAS.items()}


@router.get("/default-prompts")
async def get_default_prompts(_: models.User = Depends(auth.get_current_user)):
    """Return default prompt templates for the conference settings UI."""
    return {
        "conversation_instruction": _DEFAULT_CONVERSATION_INSTRUCTION,
        "orchestrator_system_prompt": _DEFAULT_ORCHESTRATOR_SYSTEM,
        "summary_system_prompt": _DEFAULT_SUMMARY_SYSTEM,
        "artifact_system_prompt": _DEFAULT_ARTIFACT_SYSTEM,
        "mode_prompts": _DEFAULT_MODE_PROMPTS,
    }


# Built-in modes metadata
_BUILTIN_MODES = {
    "brainstorm": {"id": "brainstorm", "name": "Brainstorm", "icon": "fa-lightbulb", "color": "#f59e0b", "builtin": True},
    "debate":     {"id": "debate",     "name": "Dezbatere",  "icon": "fa-comments",  "color": "#ef4444", "builtin": True},
    "review":     {"id": "review",     "name": "Review",     "icon": "fa-search",    "color": "#10b981", "builtin": True},
}


def _get_all_modes() -> list:
    """Return built-in + custom modes as a list with their prompts."""
    conf_cfg = settings_mod.CFG.get("conference") or {}
    custom_mode_prompts = conf_cfg.get("mode_prompts") or {}
    custom_modes_meta = conf_cfg.get("custom_modes") or []

    modes = []
    for mid, meta in _BUILTIN_MODES.items():
        entry = dict(meta)
        entry["prompt"] = custom_mode_prompts.get(mid) or _DEFAULT_MODE_PROMPTS.get(mid, "")
        modes.append(entry)
    for cm in custom_modes_meta:
        cid = cm.get("id", "")
        if not cid or cid in _BUILTIN_MODES:
            continue
        entry = {
            "id": cid,
            "name": cm.get("name", cid),
            "icon": cm.get("icon", "fa-circle"),
            "color": cm.get("color", "#8b5cf6"),
            "prompt": custom_mode_prompts.get(cid) or cm.get("prompt", ""),
            "builtin": False,
        }
        modes.append(entry)
    return modes


@router.get("/modes")
async def get_modes(_: models.User = Depends(auth.get_current_user)):
    """Return all available conference modes (built-in + custom)."""
    return _get_all_modes()


@router.post("/modes")
async def create_mode(data: dict, _: models.User = Depends(auth.get_current_admin)):
    """Create a new custom conference mode."""
    import re as _re
    raw_name = _sanitize_user_text((data.get("name") or "").strip())
    if not raw_name:
        raise HTTPException(status_code=400, detail="Name is required")
    mode_id = _re.sub(r'[^a-z0-9_]', '_', raw_name.lower())[:32]
    if mode_id in _BUILTIN_MODES:
        raise HTTPException(status_code=400, detail="Cannot override built-in mode")

    icon = data.get("icon", "fa-circle")
    color = data.get("color", "#8b5cf6")
    prompt = _sanitize_user_text((data.get("prompt") or "").strip())

    conf_cfg = settings_mod.CFG.get("conference") or {}
    custom_modes = list(conf_cfg.get("custom_modes") or [])

    # Update or add
    existing = next((m for m in custom_modes if m.get("id") == mode_id), None)
    if existing:
        existing["name"] = raw_name
        existing["icon"] = icon
        existing["color"] = color
        existing["prompt"] = prompt
    else:
        custom_modes.append({"id": mode_id, "name": raw_name, "icon": icon, "color": color, "prompt": prompt})

    # Also store prompt in mode_prompts for getter consistency
    mode_prompts = dict(conf_cfg.get("mode_prompts") or {})
    mode_prompts[mode_id] = prompt

    settings_mod.merge_config_partial({"conference": {"custom_modes": custom_modes, "mode_prompts": mode_prompts}})
    settings_mod.reload_config()
    return {"status": "ok", "mode": {"id": mode_id, "name": raw_name, "icon": icon, "color": color, "prompt": prompt, "builtin": False}}


@router.put("/modes/{mode_id}")
async def update_mode(mode_id: str, data: dict, _: models.User = Depends(auth.get_current_admin)):
    """Update a custom conference mode."""
    if mode_id in _BUILTIN_MODES:
        raise HTTPException(status_code=400, detail="Cannot modify built-in mode metadata. Use config prompts to override the prompt.")

    conf_cfg = settings_mod.CFG.get("conference") or {}
    custom_modes = list(conf_cfg.get("custom_modes") or [])
    existing = next((m for m in custom_modes if m.get("id") == mode_id), None)
    if not existing:
        raise HTTPException(status_code=404, detail="Mode not found")

    if "name" in data:
        existing["name"] = _sanitize_user_text(data["name"].strip()) or existing["name"]
    if "icon" in data:
        existing["icon"] = data["icon"]
    if "color" in data:
        existing["color"] = data["color"]
    if "prompt" in data:
        existing["prompt"] = _sanitize_user_text(data["prompt"].strip())

    mode_prompts = dict(conf_cfg.get("mode_prompts") or {})
    mode_prompts[mode_id] = existing.get("prompt", "")

    settings_mod.merge_config_partial({"conference": {"custom_modes": custom_modes, "mode_prompts": mode_prompts}})
    settings_mod.reload_config()
    return {"status": "ok", "mode": {**existing, "builtin": False}}


@router.delete("/modes/{mode_id}")
async def delete_mode(mode_id: str, _: models.User = Depends(auth.get_current_admin)):
    """Delete a custom conference mode."""
    if mode_id in _BUILTIN_MODES:
        raise HTTPException(status_code=400, detail="Cannot delete built-in mode")

    conf_cfg = settings_mod.CFG.get("conference") or {}
    custom_modes = [m for m in (conf_cfg.get("custom_modes") or []) if m.get("id") != mode_id]
    mode_prompts = dict(conf_cfg.get("mode_prompts") or {})
    mode_prompts.pop(mode_id, None)

    settings_mod.merge_config_partial({"conference": {"custom_modes": custom_modes, "mode_prompts": mode_prompts}})
    settings_mod.reload_config()
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Lobby preferences — persisted per user account
# ---------------------------------------------------------------------------

def _lobby_prefs_path(user_id: str) -> str:
    os.makedirs("sessions", exist_ok=True)
    return os.path.join("sessions", f"conf_lobby_{user_id}.json")


@router.get("/lobby-prefs")
async def get_lobby_prefs(user: models.User = Depends(auth.get_current_user)):
    """Return saved lobby preferences (selected personas, mode, overrides) for the current user."""
    path = _lobby_prefs_path(str(user.id))
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as fp:
                return json.load(fp)
        except Exception:
            pass
    return {"selected_personas": [], "selected_mode": "brainstorm", "persona_overrides": {}}


@router.put("/lobby-prefs")
async def save_lobby_prefs(body: Dict[str, Any], user: models.User = Depends(auth.get_current_user)):
    """Persist lobby preferences (selected personas, mode, overrides) for the current user."""
    # Validate: limit body size to prevent abuse
    _ALLOWED_KEYS = {"selected_personas", "selected_mode", "persona_overrides", "expert_memory_enabled"}
    filtered = {k: v for k, v in body.items() if k in _ALLOWED_KEYS}
    raw = json.dumps(filtered, ensure_ascii=False)
    if len(raw) > 64_000:  # 64KB max
        raise HTTPException(status_code=413, detail="Lobby prefs too large")
    path = _lobby_prefs_path(str(user.id))
    try:
        with open(path, "w", encoding="utf-8") as fp:
            fp.write(raw)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True}


@router.post("/create")
async def create_conference(req: CreateConferenceReq, user: models.User = Depends(auth.get_current_user)):
    """Create a new conference room."""
    conf_cfg = (settings_mod.CFG.get("conference") or {})
    if not conf_cfg.get("enabled"):
        raise HTTPException(status_code=403, detail="Conference mode is disabled")

    # Build participants from new config format or legacy format
    participants = []
    configs = req.participants_config or []
    if not configs and req.participant_ids:
        # Legacy: convert simple IDs to config objects
        configs = [ParticipantConfig(persona_id=pid) for pid in req.participant_ids]

    if len(configs) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 AI participants")
    if len(configs) > 6:
        raise HTTPException(status_code=400, detail="Maximum 6 AI participants")

    for pc in configs:
        pid = pc.persona_id
        if pid not in PERSONAS:
            raise HTTPException(status_code=400, detail=f"Unknown persona: {pid}")
        p = PERSONAS[pid]
        _custom_name = _sanitize_user_text(pc.custom_name.strip()) if pc.custom_name and pc.custom_name.strip() else ""
        participant = {
            "id": pid,
            "name": _custom_name or p["name"],
            "icon": pc.custom_icon.strip() if pc.custom_icon and pc.custom_icon.strip() else p["icon"],
            "color": pc.custom_color.strip() if pc.custom_color and pc.custom_color.strip() else p["color"],
            "tools_enabled": pc.tools_enabled if pc.tools_enabled is not None else True,
        }
        # Store custom prompt if different from default
        if pc.system_prompt is not None and pc.system_prompt.strip():
            participant["system_prompt"] = _sanitize_user_text(pc.system_prompt.strip())
        # Store model profile reference
        if pc.model_profile_id:
            profile = _resolve_model_profile(pc.model_profile_id)
            if profile:
                participant["model_profile_id"] = pc.model_profile_id
                participant["model_name"] = profile.get("model_name", "")
            else:
                log_line("conf", "⚠️", "PROFILE_NOT_FOUND", f"Profile {pc.model_profile_id} not found for {pid}")
        participants.append(participant)

    # Validate mode — accept built-in AND custom modes
    all_mode_ids = set(_BUILTIN_MODES.keys())
    conf_cfg = settings_mod.CFG.get("conference") or {}
    for cm in (conf_cfg.get("custom_modes") or []):
        if cm.get("id"):
            all_mode_ids.add(cm["id"])
    validated_mode = req.mode if req.mode in all_mode_ids else "brainstorm"

    conf_id = str(uuid.uuid4())[:8]
    now = time.time()
    data = {
        "id": conf_id,
        "user_id": str(user.id),
        "title": _sanitize_user_text(req.title.strip()) or f"Conference {conf_id[:4]}",
        "mode": validated_mode,
        "topic": _sanitize_user_text(req.topic.strip()),
        "participants": participants,
        "messages": [],
        "created_at": now,
        "updated_at": now,
        "expert_memory_enabled": req.expert_memory_enabled,
    }
    if req.artifact_enabled:
        data["artifact"] = {"content": "", "version": 0, "history": []}
    _save_conference(conf_id, data)
    log_line("conf", "🎙️", "CREATE", f"id={conf_id} mode={req.mode} participants={[p['name'] for p in participants]}")
    return data


@router.get("/list")
async def list_conferences(user: models.User = Depends(auth.get_current_user)):
    """List user's conferences."""
    return _list_conferences(str(user.id))


@router.get("/{conf_id}")
async def get_conference(conf_id: str, user: models.User = Depends(auth.get_current_user)):
    """Get a conference by ID."""
    data = _load_conference(conf_id)
    if not data or str(data.get("user_id")) != str(user.id):
        raise HTTPException(status_code=404, detail="Conference not found")
    return data


@router.delete("/{conf_id}")
async def delete_conference(conf_id: str, user: models.User = Depends(auth.get_current_user)):
    """Delete a conference."""
    data = _load_conference(conf_id)
    if not data or str(data.get("user_id")) != str(user.id):
        raise HTTPException(status_code=404, detail="Conference not found")
    p = _conf_path(conf_id)
    if os.path.exists(p):
        os.remove(p)
    return {"ok": True}


class ConferencePatchReq(BaseModel):
    title: Optional[str] = None
    topic: Optional[str] = None


@router.patch("/{conf_id}")
async def patch_conference(conf_id: str, req: ConferencePatchReq,
                            user: models.User = Depends(auth.get_current_user)):
    """Update conference title and/or topic."""
    data = _load_conference(conf_id)
    if not data or str(data.get("user_id")) != str(user.id):
        raise HTTPException(status_code=404, detail="Conference not found")
    changed = False
    if req.title is not None and req.title.strip():
        data["title"] = req.title.strip()
        changed = True
    if req.topic is not None:
        data["topic"] = req.topic.strip()
        changed = True
    if changed:
        data["updated_at"] = time.time()
        _save_conference(conf_id, data)
        log_line("conf", "✏️", "PATCH", f"conf={conf_id} title={data.get('title')} topic={data.get('topic', '')[:50]}")
    return data


@router.post("/{conf_id}/fork")
async def fork_conference(conf_id: str, user: models.User = Depends(auth.get_current_user)):
    """Fork a conference — create a copy at the current point for what-if exploration."""
    data = _load_conference(conf_id)
    if not data or str(data.get("user_id")) != str(user.id):
        raise HTTPException(status_code=404, detail="Conference not found")
    import copy
    fork_id = str(uuid.uuid4())[:8]
    now = time.time()
    fork_data = copy.deepcopy(data)
    fork_data.update({
        "id": fork_id,
        "title": f"⑂ {data.get('title', '')}",
        "forked_from": conf_id,
        "fork_point": len(data.get("messages", [])),
        "created_at": now,
        "updated_at": now,
    })
    _save_conference(fork_id, fork_data)
    log_line("conf", "⑂", "FORK", f"Forked {conf_id} -> {fork_id} at message {fork_data['fork_point']}")
    return fork_data


@router.get("/persona-memories/counts")
async def get_persona_memory_counts(_: models.User = Depends(auth.get_current_user)):
    """Return memory counts for all personas."""
    return _get_persona_memory_counts()


@router.get("/persona-memories/{persona_id}")
async def get_persona_memories(persona_id: str, _: models.User = Depends(auth.get_current_user)):
    """Return stored memories for a specific persona."""
    if persona_id not in PERSONAS:
        raise HTTPException(status_code=404, detail="Unknown persona")
    return {"persona_id": persona_id, "memories": _load_persona_memories(persona_id, limit=50)}


@router.delete("/persona-memories/{persona_id}")
async def clear_persona_memories(persona_id: str, _: models.User = Depends(auth.get_current_user)):
    """Clear all stored memories for a specific persona."""
    if persona_id not in PERSONAS:
        raise HTTPException(status_code=404, detail="Unknown persona")
    path = _persona_memory_path(persona_id)
    if os.path.exists(path):
        os.remove(path)
    log_line("conf", "🧹", "MEMORY_CLEAR", f"Cleared memories for {persona_id}")
    return {"ok": True, "persona_id": persona_id}


class PersonaMemoriesUpdateReq(BaseModel):
    memories: List[str]


@router.put("/persona-memories/{persona_id}")
async def update_persona_memories(persona_id: str, req: PersonaMemoriesUpdateReq,
                                   _: models.User = Depends(auth.get_current_user)):
    """Replace stored memories for a specific persona (supports individual deletion)."""
    if persona_id not in PERSONAS:
        raise HTTPException(status_code=404, detail="Unknown persona")
    path = _persona_memory_path(persona_id)
    memories = req.memories[:50]  # enforce cap
    if not memories:
        if os.path.exists(path):
            os.remove(path)
    else:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(memories, f, ensure_ascii=False, indent=2)
    log_line("conf", "✏️", "MEMORY_UPDATE", f"Updated memories for {persona_id}: {len(memories)} items")
    return {"ok": True, "persona_id": persona_id, "count": len(memories)}


@router.post("/{conf_id}/abort")
async def abort_conference_stream(conf_id: str, user: models.User = Depends(auth.get_current_user)):
    """Signal an active conference discussion to stop after the current turn."""
    ev = _active_streams.get(conf_id)
    if ev:
        ev.set()
        log_line("conf", "🛑", "ABORT", f"conf={conf_id} — user requested abort")
        return {"ok": True}
    return {"ok": False, "detail": "No active stream for this conference"}


@router.post("/{conf_id}/interject")
async def interject_in_conference(conf_id: str, req: ConferenceMessageReq,
                                   user: models.User = Depends(auth.get_current_user)):
    """Inject a user message into an active conference discussion.

    The message will be picked up between turns and added to the conversation history.
    """
    q = _interjection_queues.get(conf_id)
    msg_text = (req.message or "").strip()
    if not msg_text:
        raise HTTPException(status_code=400, detail="Empty message")
    if q:
        await q.put(msg_text)
        log_line("conf", "💬", "INTERJECT_QUEUED", f"conf={conf_id} msg={msg_text[:80]}")
        return {"ok": True}
    return {"ok": False, "detail": "No active stream for this conference"}


@router.post("/{conf_id}/message")
async def send_conference_message(conf_id: str, req: ConferenceMessageReq,
                                   request: Request,
                                   user: models.User = Depends(auth.get_current_user)):
    """Send a message to the conference. AI participants discuss freely via SSE stream.

    Flow:
    1. Initial round — every participant speaks once (shuffled order)
    2. Free discussion — orchestrator LLM picks next speaker each turn
    3. Ends when orchestrator says CONCLUDE or max_turns reached
    """
    _check_rate_limit(str(user.id))

    data = _load_conference(conf_id)
    if not data or str(data.get("user_id")) != str(user.id):
        raise HTTPException(status_code=404, detail="Conference not found")

    user_msg = _sanitize_user_text((req.message or "").strip())
    if not user_msg:
        raise HTTPException(status_code=400, detail="Empty message")

    # Add user message to history
    data["messages"].append({
        "role": "user",
        "content": user_msg,
        "timestamp": time.time(),
    })
    data["updated_at"] = time.time()
    _save_conference(conf_id, data)

    # Token accounting — track total tokens used in this conference
    _token_counter = {"prompt": 0, "completion": 0, "total": 0}

    async def generate():
        """Free-flowing discussion streamed via SSE."""
        # Register cancellation + interjection support
        cancel_event = asyncio.Event()
        interject_queue = asyncio.Queue()
        _active_streams[conf_id] = cancel_event
        _interjection_queues[conf_id] = interject_queue
        _heartbeat = ": keepalive\n\n"  # SSE comment — keeps connection alive

        participants = data.get("participants", [])
        n_participants = len(participants)
        log_line("conf", "🎙️", "STREAM_START", f"conf={conf_id} participants={n_participants} mode=free_discussion")

        # Global LLM config as fallback
        global_llm = settings_mod.CFG.get("llm") or {}
        mode = data.get("mode", "brainstorm")
        mode_prompt = _get_mode_prompt(mode)
        topic = data.get("topic", "")

        # Discussion config
        conf_cfg = (settings_mod.CFG.get("conference") or {})
        min_turns = int(conf_cfg.get("min_turns", _DEFAULT_MIN_TURNS))
        max_turns = int(conf_cfg.get("max_turns", _DEFAULT_MAX_TURNS))

        # Resolve orchestrator LLM — explicit profile, or auto (prefer local), then global fallback
        _orch_profile_id = conf_cfg.get("orchestrator_model_profile_id")
        _orch_cfg = _resolve_model_profile(_orch_profile_id) if _orch_profile_id else {}
        if not _is_profile_configured(_orch_cfg):
            _orch_cfg = _pick_orchestrator_auto_profile()
        if not _is_profile_configured(_orch_cfg):
            _orch_cfg = global_llm
        orch_url = _normalize_chat_url(_orch_cfg.get("target_url", ""))
        orch_model = _orch_cfg.get("model_name", "")
        orch_api_key = (_orch_cfg.get("api_key") or "").strip()

        client = await get_llm_client()

        # Track discussion state
        turn_count = 0
        last_speaker_id = None
        speakers_so_far = set()
        concluded = False

        # Emit discussion_start so frontend knows the parameters
        yield f"event: discussion_start\ndata: {json.dumps({'max_turns': max_turns, 'min_turns': min_turns, 'participant_count': n_participants})}\n\n"

        # Phase 1: Initial round — everyone speaks once (shuffled order)
        initial_order = list(participants)
        random.shuffle(initial_order)

        for participant in initial_order:
            if concluded or cancel_event.is_set():
                break

            # Client disconnect detection — stop wasting LLM calls
            if await request.is_disconnected():
                log_line("conf", "🔌", "CLIENT_DISCONNECTED", f"conf={conf_id} — stopping (phase1, turn {turn_count})")
                cancel_event.set()
                break

            yield _heartbeat  # SSE keepalive

            # Check for user interjections
            async for evt in _drain_interjections(interject_queue, data):
                yield evt

            pid = participant["id"]
            persona = PERSONAS.get(pid)
            if not persona:
                continue

            # Emit turn info
            turn_count += 1
            p_display = participant.get("name") or persona["name"]
            yield f"event: turn_info\ndata: {json.dumps({'turn': turn_count, 'max_turns': max_turns, 'phase': 'initial', 'speaker_id': pid, 'speaker_name': p_display})}\n\n"

            # Run this participant's turn
            async for sse_chunk in _run_participant_turn(
                client=client,
                participant=participant,
                persona=persona,
                data=data,
                global_llm=global_llm,
                mode_prompt=mode_prompt,
                topic=topic,
                user_id=str(user.id),
                token_counter=_token_counter,
            ):
                yield sse_chunk

            speakers_so_far.add(pid)
            last_speaker_id = pid

            # Incremental save — crash-safe
            data["updated_at"] = time.time()
            _save_conference(conf_id, data)

            # Live artifact update — batch every 2 turns
            if turn_count % 2 == 0 or turn_count == len(initial_order):
                try:
                    async for evt in _artifact_update_events(client, data, orch_url, orch_model, orch_api_key, topic):
                        yield evt
                except Exception as e:
                    log_line("conf", "⚠️", "ARTIFACT_ERR", f"Artifact update failed (phase1): {e}")

        # Phase 2: Free discussion — orchestrator plans speakers in batches
        log_line("conf", "🔄", "FREE_DISCUSSION", f"Initial round done ({turn_count} turns). Starting free discussion.")

        _speaker_plan = []  # pre-planned speaker queue from orchestrator batch

        while turn_count < max_turns and not concluded and not cancel_event.is_set():
            # Client disconnect detection — stop wasting LLM calls
            if await request.is_disconnected():
                log_line("conf", "🔌", "CLIENT_DISCONNECTED", f"conf={conf_id} — stopping (phase2, turn {turn_count})")
                cancel_event.set()
                break

            yield _heartbeat  # SSE keepalive

            # Check for user interjections — invalidate plan if user interjects
            _had_interjection = False
            async for evt in _drain_interjections(interject_queue, data):
                yield evt
                _had_interjection = True
            if _had_interjection:
                _speaker_plan.clear()  # user changed the conversation, re-plan

            # Ask orchestrator for batch plan when plan is empty
            if not _speaker_plan:
                decisions = await _pick_next_speaker(
                    client=client,
                    url=orch_url,
                    model=orch_model,
                    api_key=orch_api_key,
                    timeout=30,
                    participants=participants,
                    messages=data.get("messages", []),
                    turn_count=turn_count,
                    min_turns=min_turns,
                    max_turns=max_turns,
                    last_speaker_id=last_speaker_id,
                    speakers_so_far=speakers_so_far,
                    batch_size=3,
                )
                _speaker_plan = list(decisions)

            # Pop next decision from plan
            decision = _speaker_plan.pop(0) if _speaker_plan else {"next": "CONCLUDE", "reason": "No plan"}

            if decision.get("next") == "CONCLUDE":
                concluded = True
                log_line("conf", "🏁", "DISCUSSION_END", f"Concluded after {turn_count} turns: {decision.get('reason', '')}")
                yield f"event: discussion_conclude\ndata: {json.dumps({'turns': turn_count, 'reason': decision.get('reason', 'Consensus reached')})}\n\n"
                break

            # Find the participant to speak
            next_pid = decision.get("pid")
            next_participant = None
            for p in participants:
                if p["id"] == next_pid:
                    next_participant = p
                    break

            if not next_participant:
                # Fallback: name-based lookup
                next_name = decision.get("next", "")
                for p in participants:
                    if p["name"].lower() == next_name.lower():
                        next_participant = p
                        next_pid = p["id"]
                        break

            if not next_participant:
                log_line("conf", "⚠️", "NO_MATCH", f"Could not find participant for: {decision}")
                _speaker_plan.clear()  # force re-plan
                continue

            persona = PERSONAS.get(next_pid)
            if not persona:
                continue

            turn_count += 1
            p_display = next_participant.get("name") or persona["name"]
            yield f"event: turn_info\ndata: {json.dumps({'turn': turn_count, 'max_turns': max_turns, 'phase': 'discussion', 'speaker_id': next_pid, 'speaker_name': p_display})}\n\n"

            async for sse_chunk in _run_participant_turn(
                client=client,
                participant=next_participant,
                persona=persona,
                data=data,
                global_llm=global_llm,
                mode_prompt=mode_prompt,
                topic=topic,
                user_id=str(user.id),
                token_counter=_token_counter,
            ):
                yield sse_chunk

            speakers_so_far.add(next_pid)
            last_speaker_id = next_pid

            # Incremental save — crash-safe
            data["updated_at"] = time.time()
            _save_conference(conf_id, data)

            # Live artifact update — batch every 2 turns
            if turn_count % 2 == 0:
                try:
                    async for evt in _artifact_update_events(client, data, orch_url, orch_model, orch_api_key, topic):
                        yield evt
                except Exception as e:
                    log_line("conf", "⚠️", "ARTIFACT_ERR", f"Artifact update failed (phase2): {e}")

        # Hard limit reached
        if turn_count >= max_turns and not concluded:
            log_line("conf", "🏁", "MAX_TURNS", f"Hard stop at {turn_count} turns")
            yield f"event: discussion_conclude\ndata: {json.dumps({'turns': turn_count, 'reason': 'Maximum turns reached'})}\n\n"

        # --- Final artifact update (ensure document is up-to-date) ---
        try:
            async for evt in _artifact_update_events(client, data, orch_url, orch_model, orch_api_key, topic):
                yield evt
        except Exception:
            pass

        # --- Final synthesis ---
        synthesis_enabled = conf_cfg.get("synthesis_enabled", True)
        if synthesis_enabled and not cancel_event.is_set() and turn_count >= min_turns:
            log_line("conf", "📝", "SYNTHESIS", "Generating discussion summary…")
            yield f"event: synthesis_start\ndata: {json.dumps({})}\n\n"
            summary = await _generate_summary(
                client, orch_url, orch_model, orch_api_key,
                data.get("messages", []), topic,
            )
            if summary:
                data["messages"].append({
                    "role": "summary",
                    "content": summary,
                    "timestamp": time.time(),
                })
                yield f"event: discussion_summary\ndata: {json.dumps({'summary': summary})}\n\n"
                log_line("conf", "📝", "SYNTHESIS_DONE", f"{len(summary)} chars")

        # --- Expert Persistence: fire-and-forget background extraction ---
        # Check if enabled at conference level (overrides global setting)
        expert_memory_enabled = data.get("expert_memory_enabled")
        if expert_memory_enabled is None:
            # Fallback to global config if not set on conference
            expert_memory_enabled = conf_cfg.get("expert_memory_enabled", True)
        if expert_memory_enabled and not cancel_event.is_set() and turn_count >= min_turns:
            log_line("conf", "🧠", "EXPERT_MEMORY", "Scheduling background persona memory extraction...")
            # Snapshot needed data before stream ends
            _bg_participants = list(participants)
            _bg_messages = list(data.get("messages", []))
            _bg_topic = topic
            _bg_conf_id = conf_id

            async def _bg_extract():
                try:
                    bg_client = await get_llm_client()

                    async def _extract_one(p):
                        persona = PERSONAS.get(p["id"])
                        if not persona:
                            return
                        learnings = await _extract_persona_learnings(
                            bg_client, orch_url, orch_model, orch_api_key,
                            p.get("name", persona["name"]),
                            persona["system"],
                            _bg_messages,
                            _bg_topic,
                        )
                        if learnings:
                            _save_persona_memories(p["id"], learnings)
                            log_line("conf", "🧠", "MEMORY_SAVED", f"{p.get('name')}: {len(learnings)} learnings")

                    # Extract all participants in parallel
                    await asyncio.gather(*[_extract_one(p) for p in _bg_participants], return_exceptions=True)
                except Exception as e:
                    log_line("conf", "⚠️", "MEMORY_ERR", f"Background memory extraction failed: {e}")

            _track_background_task(_bg_extract())

        # Token accounting — emit as final event
        if _token_counter["total"] > 0:
            yield f"event: token_usage\ndata: {json.dumps(_token_counter)}\n\n"
            log_line("conf", "📊", "TOKEN_USAGE", f"conf={conf_id} prompt={_token_counter['prompt']} completion={_token_counter['completion']} total={_token_counter['total']}")

        # Cleanup active stream tracking
        _active_streams.pop(conf_id, None)
        _interjection_queues.pop(conf_id, None)

        # Save updated conference
        data["updated_at"] = time.time()
        _save_conference(conf_id, data)

        yield f"event: done\ndata: {json.dumps({'ok': True, 'turns': turn_count})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Per-participant turn execution (extracted for reuse in free discussion)
# ---------------------------------------------------------------------------

async def _run_participant_turn(
    client,
    participant: dict,
    persona: dict,
    data: dict,
    global_llm: dict,
    mode_prompt: str,
    topic: str,
    user_id: str,
    token_counter: Optional[Dict] = None,
):
    """Execute a single participant's turn. Yields SSE chunks.

    This handles: system prompt building, conversation history,
    LLM streaming, tool execution, post-processing, and persistence.
    """
    pid = participant["id"]

    # --- Resolve model config ---
    llm_cfg = _resolve_participant_llm(participant, global_llm)
    url = llm_cfg["url"]
    model = llm_cfg["model"]
    api_key = llm_cfg["api_key"]
    timeout = llm_cfg["timeout"]
    max_tokens = llm_cfg["max_tokens"]
    temperature = llm_cfg["temperature"]

    if not url or not model:
        log_line("conf", "⚠️", "NO_LLM", f"{persona['name']}: No LLM URL or model configured")
        yield f"event: participant_error\ndata: {json.dumps({'id': pid, 'error': 'No model configured for this participant'})}\n\n"
        return

    # Resolve display name — use custom name if set, otherwise persona default
    display_name = participant.get("name") or persona["name"]

    # Signal participant start — use custom icon/color if set
    log_line("conf", "🎙️", "PARTICIPANT", f"Starting {display_name} (pid={pid}) model={model}")
    p_icon = participant.get("icon") or persona["icon"]
    p_color = participant.get("color") or persona["color"]
    yield f"event: participant_start\ndata: {json.dumps({'id': pid, 'name': display_name, 'color': p_color, 'icon': p_icon})}\n\n"

    # --- Build system prompt ---
    custom_prompt = participant.get("system_prompt") or persona["system"]
    system_prompt = f"{custom_prompt}\n\n{mode_prompt}{_get_conversation_instruction()}"

    # Tell the agent its own name explicitly so it uses it correctly
    system_prompt += f"\n\nYour name in this discussion is: {display_name}. Always refer to yourself by this name."

    if topic:
        system_prompt += f"\n\nConference topic: {topic}"

    # --- Expert Persistence: inject persona memories (only if enabled) ---
    _em_enabled = data.get("expert_memory_enabled", True)
    if _em_enabled:
        memories = _load_persona_memories(pid)
        if memories:
            memory_text = "\n".join(f"- {m}" for m in memories)
            system_prompt += f"\n\n[YOUR MEMORIES FROM PAST DISCUSSIONS]\n{memory_text}\n(Use these to provide deeper, more informed contributions.)"
            log_line("conf", "🧠", "MEMORY_INJECT", f"{display_name}: {len(memories)} memories injected into system prompt")

    # --- Build conversation messages ---
    # Smart history windowing: include as many recent messages as fit in ~6000 tokens
    all_msgs = data.get("messages", [])
    TOKEN_BUDGET = 6000
    token_sum = 0
    window_start = len(all_msgs)
    for i in range(len(all_msgs) - 1, -1, -1):
        est = _estimate_tokens(all_msgs[i].get("content", ""))
        if token_sum + est > TOKEN_BUDGET:
            break
        token_sum += est
        window_start = i
    # Always include at least the last 4 messages for context
    window_start = min(window_start, max(len(all_msgs) - 4, 0))
    history_msgs = all_msgs[window_start:]
    messages = [{"role": "system", "content": system_prompt}]

    for msg in history_msgs:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role == "user":
            messages.append({"role": "user", "content": content})
        elif role == "ai" and msg.get("participant_id") == pid:
            messages.append({"role": "assistant", "content": content})
        elif role == "ai":
            p_name = msg.get("participant_name", "AI")
            # Use proper 'name' field for multi-party attribution
            messages.append({"role": "user", "name": p_name.replace(" ", "_")[:64], "content": f"[{p_name}]: {content}"})

    # If the last message is from this participant (their own previous response),
    # add a nudge to continue the discussion
    if messages and messages[-1].get("role") == "assistant":
        messages.append({"role": "user", "content": "[Moderator]: The discussion continues. React to what others have said since your last message."})

    # Give model enough room to reason + speak
    conf_max_tokens = min(max(max_tokens, 2048), 4096)

    # --- Tool support ---
    tools_enabled = participant.get("tools_enabled", True)
    tools_list = None
    if tools_enabled:
        try:
            tools_list = get_available_tools(user_id)
        except Exception as te:
            log_line("conf", "⚠️", "TOOLS_INIT", f"{persona['name']}: {te}")
            tools_list = None

    # Normalize messages for API compatibility
    normalized_msgs = _normalize_messages_for_api(messages)

    payload = {
        "model": model,
        "messages": normalized_msgs,
        "temperature": min(temperature + 0.1, 1.0),
        "max_tokens": conf_max_tokens,
        "stream": True,
    }
    if tools_list:
        payload["tools"] = tools_list

    # GLM thinking support (flash/thinking models only)
    model_lower = model.lower()
    _glm_supports_thinking = (
        ("glm" in model_lower and ("flash" in model_lower or "thinking" in model_lower))
        or "4.7-flash" in model_lower
    )
    if _glm_supports_thinking:
        payload["thinking"] = {"type": "enabled"}
        if tools_list:
            payload["thinking"]["clear_thinking"] = False
            payload["tool_stream"] = True

    try:
        log_line("conf", "🔧", "LLM_CALL", f"{persona['name']}: model={model}, url={url[:60]}, msg_count={len(messages)}, max_tokens={conf_max_tokens}, tools={bool(tools_list)}")
        full_content = ""
        full_thinking = ""
        chunk_count = 0
        tool_steps_collected = []
        search_sources_collected = []
        max_tool_rounds = 5
        _max_retries = 2
        _last_err = None

        # Search / tool limits
        searxng_cfg = (settings_mod.CFG or {}).get("searxng") or {}
        max_searches = max(1, min(20, int(searxng_cfg.get("max_searches_per_request", 5) or 5)))
        max_read_pages = max(1, min(15, int(searxng_cfg.get("max_read_pages_per_request", 5) or 5)))
        tool_result_max = int((settings_mod.CFG.get("intelligence") or {}).get("tool_result_max_chars", 6000) or 6000)
        search_web_calls = 0
        read_page_calls = 0

        # --- LLM call with tool execution loop ---
        for tool_round in range(max_tool_rounds + 1):
            stream_done = None

            async for event in _stream_llm_turn(
                client, url, payload, timeout, headers=_llm_headers(api_key)
            ):
                if isinstance(event, dict):
                    if event.get("t") == "_stream_done":
                        stream_done = event
                        done_content = event.get("content", "")
                        if done_content and not full_content:
                            full_content = done_content
                        finish_reason = event.get("finish_reason", "unknown")
                        error = event.get("error")
                        if error:
                            log_line("conf", "⚠️", "LLM_ERROR", f"{persona['name']}: {error}")
                        # Token accounting
                        if token_counter is not None:
                            token_counter["prompt"] += event.get("prompt_tokens", 0) or 0
                            token_counter["completion"] += event.get("completion_tokens", 0) or 0
                            token_counter["total"] += event.get("total_tokens", 0) or 0
                        log_line("conf", "📊", "STREAM_DONE", f"{persona['name']}: {len(full_content)} chars, finish={finish_reason}, chunks={chunk_count}, round={tool_round}")
                        break
                    if event.get("t") == "thinking":
                        tc = event.get("content", "")
                        full_thinking += tc
                        yield f"event: thinking\ndata: {json.dumps({'participant_id': pid, 'content': tc})}\n\n"
                        continue
                elif isinstance(event, str):
                    full_content += event
                    chunk_count += 1
                    yield f"event: chunk\ndata: {json.dumps({'participant_id': pid, 'content': event})}\n\n"

            # Check for tool calls
            tool_calls = (stream_done or {}).get("tool_calls") or []
            if not tool_calls or not tools_list:
                break

            log_line("conf", "🔧", "TOOL_CALLS", f"{persona['name']}: {len(tool_calls)} tool calls in round {tool_round}")

            assistant_msg = {"role": "assistant", "content": full_content or "", "tool_calls": tool_calls}
            reasoning_from_done = (stream_done or {}).get("reasoning_content") or ""
            if reasoning_from_done or full_thinking:
                assistant_msg["reasoning_content"] = reasoning_from_done or full_thinking
            else:
                assistant_msg["reasoning_content"] = ""
            messages.append(assistant_msg)

            for tc in tool_calls:
                fn = tc.get("function", {})
                fn_name = fn.get("name", "unknown")
                fn_args_raw = fn.get("arguments", "{}")
                tc_id = tc.get("id", f"call_{uuid.uuid4().hex[:8]}")
                try:
                    fn_args = json.loads(fn_args_raw) if isinstance(fn_args_raw, str) else fn_args_raw
                except json.JSONDecodeError:
                    fn_args = {}

                human_label = _tool_call_status_label(fn_name, fn_args)
                tool_steps_collected.append({"name": fn_name, "label": human_label})
                yield f"event: tool_use\ndata: {json.dumps({'participant_id': pid, 'tool_name': fn_name, 'label': human_label})}\n\n"

                tool_result = ""
                if fn_name == "search_web" and search_web_calls >= max_searches:
                    tool_result = f"Search limit reached (max {max_searches} per message)."
                elif fn_name == "read_web_page" and read_page_calls >= max_read_pages:
                    tool_result = f"Read-page limit reached (max {max_read_pages} per message)."
                else:
                    try:
                        tool_result = await execute_tool(fn_name, fn_args, user_id)
                    except Exception as te:
                        tool_result = f"Tool error: {te}"
                    if fn_name == "search_web":
                        search_web_calls += 1
                    elif fn_name == "read_web_page":
                        read_page_calls += 1

                if len(tool_result) > tool_result_max:
                    tool_result = tool_result[:tool_result_max] + "\n... (output truncated)"

                if fn_name == "search_web":
                    try:
                        sources = get_last_search_sources()
                        if sources:
                            search_sources_collected.extend(sources)
                            yield f"event: search_sources\ndata: {json.dumps({'participant_id': pid, 'sources': sources})}\n\n"
                            clear_last_search_sources()
                    except Exception:
                        pass

                messages.append({"role": "tool", "tool_call_id": tc_id, "content": tool_result})

            full_content = ""
            chunk_count = 0
            payload["messages"] = _normalize_messages_for_api(messages)

        # --- Post-processing ---
        think_part, clean_content = strip_think_content(full_content)
        if think_part and not full_thinking:
            full_thinking = think_part
        if clean_content:
            full_content = clean_content

        raw_len = len(full_content)
        full_content = _extract_speech(full_content)
        if len(full_content) != raw_len:
            log_line("conf", "✂️", "COT_STRIPPED", f"{persona['name']}: {raw_len} -> {len(full_content)} chars")

        if not full_content:
            full_content = "(No response generated)"

        # Emit participant_done
        done_payload = {'id': pid, 'content': full_content, 'thinking': full_thinking}
        if tool_steps_collected:
            done_payload['tool_steps'] = tool_steps_collected
        if search_sources_collected:
            done_payload['search_sources'] = search_sources_collected
        log_line("conf", "✅", "PARTICIPANT_DONE", f"{display_name}: {len(full_content)} chars")
        yield f"event: participant_done\ndata: {json.dumps(done_payload)}\n\n"

        # Persist to conference history
        msg_record = {
            "role": "ai",
            "participant_id": pid,
            "participant_name": display_name,  # use custom name, not persona default
            "content": full_content,
            "thinking": full_thinking,
            "timestamp": time.time(),
        }
        if tool_steps_collected:
            msg_record["tool_steps"] = tool_steps_collected
        if search_sources_collected:
            msg_record["search_sources"] = search_sources_collected
        data["messages"].append(msg_record)

    except Exception as e:
        log_line("conf", "⚠️", "STREAM_ERR", f"{pid}: {type(e).__name__}: {e}")
        yield f"event: participant_error\ndata: {json.dumps({'id': pid, 'error': str(e)})}\n\n"
