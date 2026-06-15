"""Camera stream authentication — short-lived tokens without holding DB sessions."""

from __future__ import annotations

import core.auth as auth
import core.database as database
import core.models as models
from fastapi import Header, HTTPException, Query, status


def decode_camera_query_token(raw_token: str) -> dict | None:
    """Query-param auth: short-lived camera_stream tokens only."""
    if not raw_token:
        return None
    return auth.verify_camera_stream_token(raw_token)


def decode_camera_auth_token(raw_token: str) -> dict | None:
    """Bearer/header auth: camera_stream or access JWT (never used in URL query params)."""
    if not raw_token:
        return None
    payload = auth.verify_camera_stream_token(raw_token)
    if payload:
        return payload
    payload = auth.verify_token(raw_token)
    if not payload or not payload.get("sub"):
        return None
    tok_type = payload.get("type")
    if tok_type in ("refresh", "sse_exchange"):
        return None
    return payload


def user_from_camera_token_payload(payload: dict) -> models.User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"key": "common.unauthorized"},
        headers={"WWW-Authenticate": "Bearer"},
    )
    db = next(database.get_db())
    try:
        jti = payload.get("jti")
        if jti and db.query(models.RevokedToken).filter(models.RevokedToken.jti == jti).first():
            raise credentials_exception
        user = db.query(models.User).filter(models.User.username == payload.get("sub")).first()
        if user is None:
            raise credentials_exception
        return user
    finally:
        db.close()


async def get_camera_user(
    token: str | None = Query(None),
    authorization: str | None = Header(None),
) -> models.User:
    """Authenticate without holding a DB session for the whole response lifetime."""
    query_token = (token or "").strip()
    header_token = ""
    if authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer":
            header_token = value.strip()
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"key": "common.unauthorized"},
        headers={"WWW-Authenticate": "Bearer"},
    )
    payload = None
    if query_token:
        payload = decode_camera_query_token(query_token)
    elif header_token:
        payload = decode_camera_auth_token(header_token)
    if not payload:
        raise credentials_exception
    return user_from_camera_token_payload(payload)


async def authenticate_ws_user(token: str | None) -> models.User | None:
    raw_token = (token or "").strip()
    if not raw_token:
        return None
    try:
        payload = decode_camera_query_token(raw_token)
        if not payload:
            return None
        return user_from_camera_token_payload(payload)
    except HTTPException:
        return None
    except Exception:
        return None
