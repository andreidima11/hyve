"""When to require web search given knowledge cutoff vs current date."""
from __future__ import annotations

import calendar
import re
from datetime import date, datetime
from typing import Optional

_FRESH_SEARCH_RE = re.compile(
    r"\b(?:"
    r"premier|prim(?:e)?[\s-]?minist|pre[sș]edinte|president|ministru|minister|"
    r"guvern(?:ul)?|cabinet|antrenor|coach|ceo|director(?:ul)?|leader|"
    r"parlament|alegeri|election|campion|winner|"
    r"noul|noua|actual(?:ul|a)?|"
    r"cine (?:e|este) (?:noul|noua|actual)|"
    r"who is the (?:new|current)|"
    r"what(?:'s| is) the (?:new|current)"
    r")\b",
    re.I,
)


def parse_knowledge_cutoff_end(raw: str) -> Optional[date]:
    """Last calendar day covered by the cutoff string (YYYY, YYYY-MM, or YYYY-MM-DD)."""
    s = (raw or "").strip()
    if not s:
        return None
    m = re.match(r"^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$", s)
    if not m:
        return None
    year = int(m.group(1))
    month = int(m.group(2)) if m.group(2) else 12
    day = int(m.group(3)) if m.group(3) else calendar.monthrange(year, month)[1]
    try:
        return date(year, month, day)
    except ValueError:
        return None


def knowledge_is_outdated(cutoff_str: str, today: Optional[date] = None) -> bool:
    end = parse_knowledge_cutoff_end(cutoff_str)
    if not end:
        return False
    return (today or date.today()) > end


def message_needs_fresh_search(message: str) -> bool:
    """Questions about roles, leadership, or other facts that change over time."""
    text = (message or "").strip()
    if not text:
        return False
    return bool(_FRESH_SEARCH_RE.search(text))


def build_stale_knowledge_search_rules(
    knowledge_cutoff_str: str,
    current_date_label: str,
    *,
    user_msg: str = "",
) -> str:
    """Extra prompt block when today is past the configured knowledge cutoff."""
    if not knowledge_cutoff_str or not knowledge_is_outdated(knowledge_cutoff_str):
        return ""

    lines = [
        f"IMPORTANT: Today is {current_date_label}, but your reliable knowledge ends ~{knowledge_cutoff_str}.",
        "Any question about who CURRENTLY holds an office (PM, president, minister, CEO, coach),",
        "election results, laws in effect now, prices, or news may have changed since the cutoff.",
        "For those questions you MUST call search_web BEFORE answering — do NOT guess from old training data.",
        "Words like 'noul/noua', 'actual', 'current', 'cine e acum' always require search when the cutoff is in the past.",
    ]
    if user_msg and message_needs_fresh_search(user_msg):
        lines.insert(
            0,
            "[SEARCH REQUIRED FOR THIS MESSAGE] Call search_web first, then answer using the results.",
        )
    return "\n".join(lines) + "\n"
