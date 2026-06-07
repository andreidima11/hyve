from __future__ import annotations

import re
from typing import Any, List, Optional, Tuple

RE_HA_CALL_LOG = re.compile(r" HA_CALL:\{.*?\}")
RE_THINK_BLOCK = re.compile(r"<think>\s*.*?\s*</think>", re.DOTALL | re.IGNORECASE)
RE_THINK_OPEN = re.compile(r"<think>\s*", re.IGNORECASE)
RE_THINK_CLOSE = re.compile(r"[\s`]*</think>[\s`]*", re.IGNORECASE)
RE_ORPHAN_CLOSE = re.compile(r"^.*?(?:</think>|`</think>`)", re.DOTALL | re.IGNORECASE)
RE_TOOL_CALL_BLOCK = re.compile(
    r"<tool_call>\s*(\{.*?\})\s*</tool_call>",
    re.DOTALL | re.IGNORECASE,
)
_THINK_OPEN_TAGS = ("<think>", "<thinking>")
_THINK_CLOSE_TAGS = ("</think>", "</thinking>")


class _MarkdownStreamBuffer:
    """Buffers streaming tokens so the client never receives a partial markdown construct."""

    _MAX_HOLD = 80

    def __init__(self):
        self._buf = ""

    def feed(self, token: str) -> list[str]:
        if not token:
            return []
        self._buf += token
        if not self._has_open_construct(self._buf):
            out = self._buf
            self._buf = ""
            return [out]
        if len(self._buf) >= self._MAX_HOLD:
            out = self._buf
            self._buf = ""
            return [out]
        return []

    def flush(self) -> str:
        out = self._buf
        self._buf = ""
        return out

    @staticmethod
    def _has_open_construct(text: str) -> bool:
        stripped = text.rstrip()
        if not stripped:
            return False
        fence_count = stripped.count("```")
        if fence_count % 2 == 1:
            return True
        if stripped.endswith("`") and not stripped.endswith("```"):
            return True
        if stripped.endswith("*") and not stripped.endswith("***"):
            return True
        if stripped.endswith("~") and not stripped.endswith("~~"):
            return True
        last_bracket = stripped.rfind("[")
        if last_bracket >= 0 and "]" not in stripped[last_bracket:]:
            if len(stripped) - last_bracket < 40:
                return True
        return False


def _find_earliest_tag(s: str, tags: tuple) -> Optional[tuple]:
    s_lower = s.lower()
    best = None
    for tag in tags:
        i = s_lower.find(tag.lower())
        if i >= 0 and (best is None or i < best[0]):
            best = (i, tag)
    return best


class _ThinkContentStreamParser:
    """Parse content deltas and emit thinking vs content for real-time streaming."""

    def __init__(self) -> None:
        self.buffer = ""
        self.in_think = False

    def feed(self, delta: str) -> List[Any]:
        if not delta:
            return []
        self.buffer += delta
        out: List[Any] = []
        while self.buffer:
            if not self.in_think:
                found = _find_earliest_tag(self.buffer, _THINK_OPEN_TAGS)
                if found is not None:
                    i, tag = found
                    content_part = self.buffer[:i]
                    self.buffer = self.buffer[i + len(tag):]
                    self.in_think = True
                    if content_part:
                        out.append(content_part)
                else:
                    overlap = max(len(t) for t in _THINK_OPEN_TAGS) - 1
                    if len(self.buffer) > overlap:
                        out.append(self.buffer[:-overlap])
                        self.buffer = self.buffer[-overlap:]
                    break
            else:
                found = _find_earliest_tag(self.buffer, _THINK_CLOSE_TAGS)
                if found is not None:
                    j, tag = found
                    think_part = self.buffer[:j]
                    self.buffer = self.buffer[j + len(tag):]
                    self.in_think = False
                    if think_part:
                        out.append({"t": "thinking", "content": think_part})
                else:
                    overlap = max(len(t) for t in _THINK_CLOSE_TAGS) - 1
                    if len(self.buffer) > overlap:
                        out.append({"t": "thinking", "content": self.buffer[:-overlap]})
                        self.buffer = self.buffer[-overlap:]
                    break
        return out

    def flush(self) -> List[Any]:
        out: List[Any] = []
        if self.buffer:
            if self.in_think:
                out.append({"t": "thinking", "content": self.buffer})
            else:
                out.append(self.buffer)
            self.buffer = ""
        return out


def _normalize_thinking_tags(s: str) -> str:
    s = re.sub(r"<thinking>\s*", "<think>", s, flags=re.IGNORECASE)
    s = re.sub(r"\s*</thinking>", "</think>", s, flags=re.IGNORECASE)
    return s


def _strip_think_robust(text: str) -> Tuple[str, str]:
    if not text or not isinstance(text, str):
        return "", (text or "").strip()
    s = _normalize_thinking_tags(text)
    think_parts = []

    def collect_think(m):
        think_parts.append(m.group(0))
        return ""

    s = RE_THINK_BLOCK.sub(collect_think, s)
    close_match = RE_THINK_CLOSE.search(s)
    if close_match and not RE_THINK_OPEN.search(s[:close_match.start()]):
        before = s[:close_match.start()].strip()
        if before:
            think_parts.append(before)
        s = s[close_match.end():].strip()
    if "</think>" in s or "`</think>" in s:
        orphan = RE_ORPHAN_CLOSE.search(s)
        if orphan:
            think_parts.append(orphan.group(0))
            s = s[orphan.end():].strip()
    open_match = RE_THINK_OPEN.search(s)
    if open_match:
        after = s[open_match.end():].strip()
        if after and not RE_THINK_CLOSE.search(after):
            think_parts.append(after)
            s = ""
    think_str = "\n".join(think_parts).strip() if think_parts else ""
    content_str = s.strip()
    return think_str, content_str


def strip_think(text: str) -> str:
    if not text or not isinstance(text, str):
        return text or ""
    _, content = _strip_think_robust(text)
    return content


def strip_think_content(text: str) -> Tuple[str, str]:
    if not text or not isinstance(text, str):
        return "", (text or "").strip()
    think_str, content_str = _strip_think_robust(text)
    think_clean = re.sub(r"<think>\s*", "", think_str, flags=re.IGNORECASE)
    think_clean = re.sub(r"\s*</think>", "", think_clean, flags=re.IGNORECASE)
    return think_clean.strip(), content_str
