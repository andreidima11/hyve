#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


import core.auth as auth
import core.database as database
import core.models as models


def upsert_admin(username: str, password: str, full_name: str, email: str | None) -> str:
    database.Base.metadata.create_all(bind=database.engine)
    db = database.SessionLocal()
    try:
        user = db.query(models.User).filter(models.User.username == username).first()
        hashed_password = auth.get_password_hash(password)
        if user:
            user.full_name = full_name or user.full_name or username
            user.email = (email or "").strip() or user.email
            user.hashed_password = hashed_password
            user.is_admin = True
            user.is_active = True
            action = "updated"
        else:
            user = models.User(
                username=username,
                full_name=full_name or username,
                email=(email or "").strip() or None,
                hashed_password=hashed_password,
                is_admin=True,
                is_active=True,
            )
            db.add(user)
            action = "created"
        db.commit()
        return action
    finally:
        db.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Create or update a local Hyve admin user.")
    parser.add_argument("--username", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--full-name", default="")
    parser.add_argument("--email", default="")
    parser.add_argument(
        "--mark-setup-complete",
        action="store_true",
        help="Skip browser onboarding (headless/Docker installs).",
    )
    args = parser.parse_args()

    action = upsert_admin(
        username=args.username.strip(),
        password=args.password,
        full_name=args.full_name.strip(),
        email=args.email.strip(),
    )
    if args.mark_setup_complete:
        from core.setup_service import mark_setup_complete

        mark_setup_complete()
        print("Setup marked complete.")
    print(f"Admin user {action}: {args.username.strip()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())