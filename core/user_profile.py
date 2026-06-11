"""Build user profile context for AI prompts (name, location, about)."""
from __future__ import annotations

from typing import Any


def split_user_name(full_name: str | None) -> tuple[str, str]:
    """Split stored full_name into (first_name, last_name). Matches users_auth convention."""
    parts = str(full_name or "").strip().split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return " ".join(parts[:-1]), parts[-1]


def build_user_profile_context(user: Any) -> dict[str, str]:
    """Dict passed to cortex for [USER PROFILE] / [USER IDENTITY] blocks."""
    first_name, last_name = split_user_name(getattr(user, "full_name", None))
    username = str(getattr(user, "username", None) or "").strip()
    full_name = str(getattr(user, "full_name", None) or "").strip()
    # Prefer first name for direct address; fall back to surname, full name, or username.
    preferred_name = first_name or last_name or full_name or username
    return {
        "username": username,
        "first_name": first_name,
        "last_name": last_name,
        "preferred_name": preferred_name,
        "full_name": full_name or preferred_name,
        "location": str(getattr(user, "location", None) or "").strip(),
        "about_me": str(getattr(user, "about_me", None) or "").strip(),
    }


def load_user_profile_context(user_id: str) -> dict[str, str] | None:
    """Load profile context from DB for brain user_id (e.g. user_1). Returns None if unknown."""
    uid = str(user_id or "").strip()
    if not uid or uid.startswith("web_"):
        return None
    try:
        import core.database as database
        import core.models as models

        db = database.SessionLocal()
        try:
            user = None
            if uid.startswith("user_"):
                try:
                    numeric_id = int(uid.split("_", 1)[1])
                    user = db.query(models.User).filter(models.User.id == numeric_id).first()
                except (ValueError, IndexError):
                    pass
            if not user:
                user = db.query(models.User).filter(models.User.username == uid).first()
            if not user:
                return None
            return build_user_profile_context(user)
        finally:
            db.close()
    except Exception:
        return None
