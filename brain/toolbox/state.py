from __future__ import annotations

from typing import Dict, List

# Thread-safe storage for conversation history (set by cortex before agent loop)
_lazy_history_store: Dict[str, List[Dict]] = {}



def set_lazy_history(user_id: str, messages: List[Dict]) -> None:
    """Store full conversation history for lazy retrieval by get_conversation_history tool."""
    _lazy_history_store[user_id] = list(messages)


def clear_lazy_history(user_id: str) -> None:
    """Remove lazy history for a user (cleanup)."""
    _lazy_history_store.pop(user_id, None)
