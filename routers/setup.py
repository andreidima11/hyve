"""First-run setup API — public only while onboarding is incomplete."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import core.database as database
from core.http.limiter import limiter
from core.setup_service import (
    SetupAlreadyCompleteError,
    SetupValidationError,
    complete_setup,
    get_setup_status,
)

router = APIRouter(tags=["setup"])


class SetupCompleteBody(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=1)
    password_confirm: str = Field(..., min_length=1)
    full_name: str = ""
    email: str = ""
    language: str = "en"
    timezone: str = ""
    server_name: str = "Hyve"


@router.get("/api/setup/status")
async def setup_status():
    return get_setup_status()


@router.post("/api/setup/complete")
@limiter.limit("5/minute")
async def setup_complete(
    request: Request,
    body: SetupCompleteBody,
    db: Session = Depends(database.get_db),
):
    if body.password != body.password_confirm:
        raise HTTPException(
            status_code=400,
            detail={"key": "setup.password_mismatch"},
        )
    try:
        return complete_setup(
            db,
            username=body.username.strip(),
            password=body.password,
            full_name=body.full_name.strip(),
            email=body.email.strip(),
            language=body.language.strip(),
            timezone=body.timezone.strip(),
            server_name=body.server_name.strip(),
        )
    except SetupAlreadyCompleteError:
        raise HTTPException(status_code=403, detail={"key": "setup.already_complete"})
    except SetupValidationError as exc:
        raise HTTPException(status_code=400, detail={"key": exc.key, "params": exc.params})
