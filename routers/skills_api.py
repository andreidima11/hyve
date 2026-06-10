"""Skills API routes."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
import skills
import settings
import models
import auth
import forge
from core.http.errors import error_detail
from core.log_stream import log_line

router = APIRouter(prefix="/api/skills", tags=["skills"])


class GeneratePreviewBody(BaseModel):
    description: str
    name_hint: str | None = None
    inputs_hint: str | None = None
    allow_network: bool = False


class ConfirmGeneratedBody(BaseModel):
    code: str
    suggested_filename: str


@router.get("")
async def api_skills_list(current_user: models.User = Depends(auth.get_current_user)):
    try:
        reg = skills.get_skill_registry()
        disabled = set(settings.CFG.get("skills_disabled") or [])
        return [
            {"name": s["name"], "description": s["description"], "generated": s.get("generated", False), "disabled": s["name"] in disabled}
            for s in reg
        ]
    except Exception as e:
        log_line("error", "❌", "SKILLS API", str(e))
        raise HTTPException(status_code=500, detail=error_detail("common.error_with_message", {"message": str(e)}))


@router.post("/generate-preview")
async def api_skills_generate_preview(
    body: GeneratePreviewBody,
    current_user: models.User = Depends(auth.get_current_admin),
):
    """Generate skill code without saving (preview). Admin only."""
    desc = (body.description or "").strip()
    if len(desc) < 3:
        raise HTTPException(status_code=400, detail=error_detail("skills.description_too_short"))
    ok, code_or_err, suggested = await forge.run_forge(
        desc, save=False,
        name_hint=body.name_hint, inputs_hint=body.inputs_hint, allow_network=body.allow_network,
    )
    if not ok:
        raise HTTPException(status_code=400, detail=error_detail("common.error_with_message", {"message": code_or_err}))
    return {"code": code_or_err, "suggested_filename": suggested or "skill.py"}


@router.post("/confirm-generated")
async def api_skills_confirm_generated(
    body: ConfirmGeneratedBody,
    current_user: models.User = Depends(auth.get_current_admin),
):
    """Save skill code after preview (validate + dry-run + version + save). Admin only."""
    ok, msg = forge.run_forge_confirm(body.code or "", body.suggested_filename or "")
    if not ok:
        raise HTTPException(status_code=400, detail=error_detail("common.error_with_message", {"message": msg}))
    return {"status": "ok", "message": msg}


@router.get("/{skill_name}")
async def api_skill_get(skill_name: str, current_user: models.User = Depends(auth.get_current_user)):
    src = skills.get_skill_source(skill_name)
    if src is None:
        raise HTTPException(status_code=404, detail=error_detail("skills.not_found"))
    return {"name": skill_name, "source": src}


class SkillUpdateBody(BaseModel):
    source: str


@router.patch("/{skill_name}")
async def api_skill_update(
    skill_name: str,
    body: SkillUpdateBody,
    current_user: models.User = Depends(auth.get_current_admin),
):
    ok, msg = skills.update_skill_source(skill_name, body.source or "")
    if not ok:
        raise HTTPException(status_code=400, detail=error_detail("common.error_with_message", {"message": msg}))
    log_line("sys", "✏️", "SKILL", f"Updated skill: {skill_name}")
    return {"status": "updated", "message": msg}


@router.delete("/{skill_name}")
async def api_skill_delete(
    skill_name: str,
    current_user: models.User = Depends(auth.get_current_admin),
):
    ok, msg = skills.delete_skill(skill_name)
    if not ok:
        raise HTTPException(status_code=400, detail=error_detail("common.error_with_message", {"message": msg}))
    log_line("sys", "🗑️", "SKILL", f"Deleted skill: {skill_name}")
    return {"status": "deleted", "message": msg}


@router.get("/{skill_name}/versions")
async def api_skill_versions(
    skill_name: str,
    current_user: models.User = Depends(auth.get_current_user),
):
    """List saved versions for a generated skill."""
    versions = forge.list_skill_versions(skill_name)
    return {"skill_name": skill_name, "versions": [{"id": v["id"], "timestamp": v["timestamp"]} for v in versions]}


@router.post("/{skill_name}/versions/{version_id}/restore")
async def api_skill_restore_version(
    skill_name: str,
    version_id: str,
    current_user: models.User = Depends(auth.get_current_admin),
):
    """Restore a generated skill to a previous version. Admin only."""
    ok, msg = forge.restore_skill_version(skill_name, version_id)
    if not ok:
        raise HTTPException(status_code=400, detail=error_detail("common.error_with_message", {"message": msg}))
    return {"status": "ok", "message": msg}


@router.post("/{skill_name}/toggle")
async def api_skill_toggle(
    skill_name: str,
    current_user: models.User = Depends(auth.get_current_admin),
):
    """Toggle skill disabled state. Admin only."""
    cfg = settings.load_config()
    disabled = list(cfg.get("skills_disabled") or [])
    if skill_name in disabled:
        disabled = [x for x in disabled if x != skill_name]
    else:
        disabled = disabled + [skill_name]
    settings.save_config({"skills_disabled": disabled})
    settings.reload_config()
    return {"disabled": skill_name in disabled, "skills_disabled": disabled}
