from fastapi import APIRouter, Depends, Query

import core.auth as auth
import core.models as models
from core.i18n.bundles import get_bundled_translations
from integrations.component_i18n import get_component_translations

router = APIRouter()


@router.get("/api/i18n/bundles")
async def get_i18n_bundles(
    lang: str = Query("en"),
    current_user: models.User = Depends(auth.get_current_user),
):
    del current_user
    return get_bundled_translations(lang, all_components=True, all_addons=True)


@router.get("/api/i18n/components")
async def get_component_i18n(
    lang: str = Query("en"),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Legacy endpoint — component namespaced slice of :func:`get_bundled_translations`."""
    del current_user
    return get_component_translations(lang, domains=None)
