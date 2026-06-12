"""First-run setup API — public only while onboarding is incomplete."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError
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
    db: Session = Depends(database.get_db),
):
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail={"key": "common.invalid_json"})
    try:
        payload = SetupCompleteBody.model_validate(data)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors()) from exc

    if payload.password != payload.password_confirm:
        raise HTTPException(
            status_code=400,
            detail={"key": "setup.password_mismatch"},
        )
    try:
        return complete_setup(
            db,
            username=payload.username.strip(),
            password=payload.password,
            full_name=payload.full_name.strip(),
            email=payload.email.strip(),
            language=payload.language.strip(),
            timezone=payload.timezone.strip(),
            server_name=payload.server_name.strip(),
        )
    except SetupAlreadyCompleteError:
        raise HTTPException(status_code=403, detail={"key": "setup.already_complete"})
    except SetupValidationError as exc:
        raise HTTPException(status_code=400, detail={"key": exc.key, "params": exc.params})
