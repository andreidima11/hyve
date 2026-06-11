"""Utility: date/time helpers for AI context."""
from datetime import datetime
from typing import Optional

# Weekday names in English so the model has unambiguous calendar (luni=Monday, joi=Thursday, etc.)
_WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def get_current_datetime_str(timezone_name: Optional[str] = None, round_minutes: int = 0) -> str:
    """Returns current date, weekday and time for the AI context. Includes weekday so the model never confuses e.g. Thursday vs Friday.
    If round_minutes > 0 (e.g. 5), time is rounded down to the previous multiple so the same string is reused for that interval — improves KV cache hits in LM Studio / llama.cpp."""
    try:
        if timezone_name and timezone_name.strip():
            from zoneinfo import ZoneInfo
            tz = ZoneInfo(timezone_name.strip())
            now = datetime.now(tz)
        else:
            now = datetime.now()
        if round_minutes > 0:
            # Round down to previous multiple of round_minutes (e.g. 14:32 -> 14:30 when round_minutes=5)
            total_mins = now.hour * 60 + now.minute
            rounded_mins = (total_mins // round_minutes) * round_minutes
            now = now.replace(hour=rounded_mins // 60, minute=rounded_mins % 60, second=0, microsecond=0)
        weekday = _WEEKDAYS[now.weekday()]  # 0=Monday, 6=Sunday
        return f"{now.strftime('%Y-%m-%d')} ({weekday}) {now.strftime('%H:%M')}"
    except Exception:
        now = datetime.now()
        if round_minutes > 0:
            total_mins = now.hour * 60 + now.minute
            rounded_mins = (total_mins // round_minutes) * round_minutes
            now = now.replace(hour=rounded_mins // 60, minute=rounded_mins % 60, second=0, microsecond=0)
        weekday = _WEEKDAYS[now.weekday()]
        return f"{now.strftime('%Y-%m-%d')} ({weekday}) {now.strftime('%H:%M')}"
