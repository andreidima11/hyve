"""JWT token issuance and refresh (login, refresh, SSE exchange)."""

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import auth
import database
import models
from core.http.limiter import limiter
from core.log_stream import log_line

router = APIRouter(tags=["auth"])


@router.post("/api/token")
@limiter.limit("10/minute")
async def login_for_access_token(request: Request, form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(database.get_db)):
    user = db.query(models.User).filter(models.User.username == form_data.username).first()
    if not user or not auth.verify_password(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is deactivated",
        )
    access_token = auth.create_access_token(data={"sub": user.username})
    refresh_token = auth.create_refresh_token(data={"sub": user.username})
    log_line("sys", "🔑", "LOGIN", f"User '{user.username}' logged in.")
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "is_admin": user.is_admin,
        "expires_in": auth.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    }


@router.post("/api/token/refresh")
@limiter.limit("30/minute")
async def refresh_access_token(request: Request, db: Session = Depends(database.get_db)):
    """Exchange a valid refresh token for a new access + refresh token pair."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    token = (body.get("refresh_token") or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="refresh_token required")
    payload = auth.verify_refresh_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")
    username = payload["sub"]
    # Atomic revocation: attempt to insert the jti first to prevent race conditions.
    # If two concurrent requests use the same refresh token, only one will succeed.
    jti = payload.get("jti", "")
    if jti:
        existing = db.query(models.RevokedToken).filter(models.RevokedToken.jti == jti).first()
        if existing:
            raise HTTPException(status_code=401, detail="Token revoked")
        # Atomically revoke — if a concurrent request already inserted, catch the conflict
        try:
            auth.revoke_token(token, db)
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=401, detail="Token already consumed")
    user = db.query(models.User).filter(models.User.username == username).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account is deactivated")
    new_access = auth.create_access_token(data={"sub": username})
    new_refresh = auth.create_refresh_token(data={"sub": username})
    return {
        "access_token": new_access,
        "refresh_token": new_refresh,
        "token_type": "bearer",
        "expires_in": auth.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    }


@router.post("/api/token/sse")
async def get_sse_exchange_token(current_user: models.User = Depends(auth.get_current_user)):
    """Get a short-lived (30s) single-use token for SSE/WebSocket connections.

    This avoids passing the long-lived JWT in query params where it would
    appear in server logs, browser history, and proxy logs.
    """
    token = auth.create_sse_exchange_token(current_user.username)
    return {"sse_token": token, "expires_in": auth.SSE_EXCHANGE_TOKEN_EXPIRE_SECONDS}
