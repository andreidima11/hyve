"""
Shell execution and proposal application API.
Handles shell command permission, audit logs, command execution, and applying AI-generated patches.
"""
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import traceback
import models
import auth

router = APIRouter(tags=["shell"])


@router.post("/api/shell/allow")
async def api_shell_allow(current_user: models.User = Depends(auth.get_current_user)):
    """Allow the AI to run terminal commands for this user in this session (e.g. after user clicks Allow in chat)."""
    try:
        from brain.tool_shell import allow_shell_for_user
        user_id = f"user_{current_user.id}"
        allow_shell_for_user(user_id)
        return {"status": "ok", "message": "Shell allowed for this session"}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": "internal_server_error"})


@router.get("/api/shell/audit")
async def api_shell_audit(
    limit: int = 50,
    current_user: models.User = Depends(auth.get_current_user),
):
    """List recent shell runs for the current user (admin sees all)."""
    try:
        from core.shell_audit_log import get_recent
        user_id = None if current_user.is_admin else f"user_{current_user.id}"
        items = get_recent(user_id=user_id, limit=min(200, max(1, limit)))
        return {"runs": items}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": "internal_server_error"})


class ShellRunBody(BaseModel):
    command: str


@router.post("/api/shell/run")
async def api_shell_run(
    data: ShellRunBody,
    current_user: models.User = Depends(auth.get_current_user),
):
    """Run a single command (e.g. from suggest_shell card). Allows shell for this user then runs."""
    try:
        from brain.tool_shell import allow_shell_for_user
        from brain import toolbox as brain_toolbox
        user_id = f"user_{current_user.id}"
        allow_shell_for_user(user_id)
        command = (data.command or "").strip()
        if not command:
            raise HTTPException(status_code=400, detail="command required")
        result = await brain_toolbox.execute_tool("run_shell", {"command": command}, user_id)
        return {"status": "ok", "result": result}
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": "internal_server_error"})


@router.post("/api/proposal/apply")
async def api_proposal_apply(
    proposal: dict,
    current_user: models.User = Depends(auth.get_current_user),
):
    """Apply an AI-proposed patch or new file (from propose_patch / propose_file card)."""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Only admin can apply proposals")
    try:
        from brain.tool_workspace import apply_proposal

        ok, msg = apply_proposal(proposal)
        if ok:
            return {"status": "ok", "message": msg}
        raise HTTPException(status_code=400, detail=msg)
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": "internal_server_error"})
