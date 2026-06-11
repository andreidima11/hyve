from fastapi import APIRouter, Depends, Query

import core.auth as auth
import core.models as models
from integrations.component_i18n import get_component_translations

router = APIRouter()


@router.get("/api/i18n/components")
async def get_component_i18n(
    lang: str = Query("en"),
    current_user: models.User = Depends(auth.get_current_user),
):
    del current_user
    return get_component_translations(lang)
