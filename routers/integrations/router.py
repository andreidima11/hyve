"""Shared FastAPI router for all integration submodules."""

from fastapi import APIRouter

router = APIRouter(prefix="/api/integrations", tags=["integrations"])
