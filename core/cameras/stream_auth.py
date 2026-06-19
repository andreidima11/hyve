"""Camera stream authentication — short-lived tokens without holding DB sessions."""

from __future__ import annotations

import core.auth as auth
import core.database as database
import core.models as models
from core.cameras.access import user_may_access_camera
from fastapi import Header, HTTPException, Query, Request, status


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
    if tok_type in ("refresh", "sse_exchange", "media_proxy"):
        return None
    return payload


def _token_matches_entity(payload: dict, entity_id: str) -> bool:
    scoped = str(payload.get("entity_id") or "").strip()
    if payload.get("type") == "camera_stream":
        if not scoped:
            return False
        return scoped == str(entity_id or "").strip()
    return True


def _assert_camera_access(user: models.User, entity_id: str) -> None:
    if entity_id and not user_may_access_camera(user, entity_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"key": "cameras.access_denied"},
        )


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
    request: Request,
    token: str | None = Query(None),
    authorization: str | None = Header(None),
) -> models.User:
    """Authenticate without holding a DB session for the whole response lifetime."""
    entity_id = str(request.path_params.get("entity_id") or "").strip()
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
        if payload and entity_id and not _token_matches_entity(payload, entity_id):
            raise credentials_exception
    elif header_token:
        payload = decode_camera_auth_token(header_token)
    if not payload:
        raise credentials_exception
    user = user_from_camera_token_payload(payload)
    if entity_id:
        if not _token_matches_entity(payload, entity_id):
            raise credentials_exception
        _assert_camera_access(user, entity_id)
    return user


async def authenticate_ws_user(token: str | None, entity_id: str = "") -> models.User | None:
    raw_token = (token or "").strip()
    if not raw_token:
        return None
    try:
        payload = decode_camera_query_token(raw_token)
        if not payload:
            return None
        if entity_id and not _token_matches_entity(payload, entity_id):
            return None
        user = user_from_camera_token_payload(payload)
        if entity_id:
            _assert_camera_access(user, entity_id)
        return user
    except HTTPException:
        return None
    except Exception:
        return None
