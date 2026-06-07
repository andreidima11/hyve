from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session
import json
import re

import assist_keys
import auth
import database
import models
from logger import log_line

router = APIRouter()


class UpdateUserMeBody(BaseModel):
    first_name: str | None = Field(None, max_length=64)
    last_name: str | None = Field(None, max_length=64)
    location: str | None = Field(None, max_length=128)
    about_me: str | None = Field(None, max_length=2000)
    persona: str | None = Field(None, max_length=2000)
    notification_prefs: dict | None = None


class UpdateUserSecurityBody(BaseModel):
    current_password: str = Field(..., min_length=1, max_length=128)
    username: str | None = Field(None, min_length=2, max_length=64)
    email: str | None = Field(None, max_length=254)
    new_password: str | None = Field(None, min_length=8, max_length=128)


class CreateUserBody(BaseModel):
    username: str = Field(..., min_length=2, max_length=64)
    password: str = Field(..., min_length=8, max_length=128)
    full_name: str | None = Field(None, max_length=128)
    is_admin: bool = False


class LinkWhatsAppBody(BaseModel):
    phone_number: str = Field(..., min_length=3, max_length=32)


class UnlinkPhoneBody(BaseModel):
    number: str = Field(..., min_length=3, max_length=32)


_USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{2,64}$")
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def _clean_text(value: str | None, max_length: int) -> str | None:
    cleaned = str(value or "").strip()
    if not cleaned:
        return None
    return cleaned[:max_length]


def _split_full_name(full_name: str | None) -> tuple[str, str]:
    from core.user_profile import split_user_name
    return split_user_name(full_name)


def _serialize_user(current_user: models.User) -> dict:
    notif_prefs = {"app": True, "whatsapp": True}
    if current_user.notification_preferences:
        try:
            notif_prefs = json.loads(current_user.notification_preferences)
        except Exception:
            pass
    first_name, last_name = _split_full_name(current_user.full_name)
    return {
        'id': current_user.id,
        'username': current_user.username,
        'full_name': current_user.full_name or current_user.username,
        'first_name': first_name,
        'last_name': last_name,
        'email': current_user.email or '',
        'location': current_user.location or '',
        'about_me': current_user.about_me or '',
        'is_admin': current_user.is_admin,
        'phones': [p.number for p in current_user.phone_numbers],
        'persona': current_user.persona_override or '',
        'notification_prefs': notif_prefs,
    }


@router.post('/api/logout')
async def logout_current_user(
    request: Request,
    token: str = Depends(auth.oauth2_scheme),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    revoked = auth.revoke_token(token, db)
    # Also revoke refresh token if provided in the body
    try:
        body = await request.json()
        refresh_token = (body.get("refresh_token") or "").strip()
        if refresh_token:
            auth.revoke_token(refresh_token, db)
    except Exception:
        pass
    log_line('sys', '🚪', 'LOGOUT', f"User '{current_user.username}' logged out.")
    return {'ok': True, 'revoked': revoked}


@router.get('/api/users/me')
async def read_users_me(current_user: models.User = Depends(auth.get_current_user)):
    return _serialize_user(current_user)


@router.patch('/api/users/me')
async def update_users_me(
    data: UpdateUserMeBody,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    if data.first_name is not None or data.last_name is not None:
        current_first, current_last = _split_full_name(current_user.full_name)
        first_name = _clean_text(data.first_name, 64) if data.first_name is not None else current_first
        last_name = _clean_text(data.last_name, 64) if data.last_name is not None else current_last
        current_user.full_name = " ".join(part for part in [first_name, last_name] if part).strip() or current_user.username
    if data.location is not None:
        current_user.location = _clean_text(data.location, 128)
    if data.about_me is not None:
        current_user.about_me = _clean_text(data.about_me, 2000)
    if data.persona is not None:
        current_user.persona_override = data.persona.strip() or None
    if data.notification_prefs is not None:
        current_user.notification_preferences = json.dumps(data.notification_prefs)
    db.commit()
    db.refresh(current_user)
    return _serialize_user(current_user)


@router.patch('/api/users/me/security')
async def update_users_me_security(
    data: UpdateUserSecurityBody,
    token: str = Depends(auth.oauth2_scheme),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    if not auth.verify_password(data.current_password, current_user.hashed_password):
        raise HTTPException(status_code=403, detail={"key": "user.current_password_incorrect"})

    username = data.username.strip() if data.username is not None else current_user.username
    if not _USERNAME_RE.fullmatch(username):
        raise HTTPException(status_code=400, detail={"key": "user.invalid_username"})

    if username.lower() != current_user.username.lower():
        existing = db.query(models.User).filter(func.lower(models.User.username) == username.lower()).first()
        if existing:
            raise HTTPException(status_code=400, detail={"key": "user.username_taken"})

    email = current_user.email
    if data.email is not None:
        email = _clean_text(data.email, 254)
        if email and not _EMAIL_RE.fullmatch(email):
            raise HTTPException(status_code=400, detail={"key": "user.invalid_email"})
        if email:
            email = email.lower()

    auth_changed = username != current_user.username or bool(data.new_password)
    current_user.username = username
    current_user.email = email
    if data.new_password:
        if data.new_password == data.current_password:
            raise HTTPException(status_code=400, detail={"key": "user.new_password_same_as_current"})
        current_user.hashed_password = auth.get_password_hash(data.new_password)

    db.commit()
    db.refresh(current_user)

    response = _serialize_user(current_user)
    if auth_changed:
        auth.revoke_token(token, db)
        response.update({
            'access_token': auth.create_access_token(data={'sub': current_user.username}),
            'refresh_token': auth.create_refresh_token(data={'sub': current_user.username}),
            'token_type': 'bearer',
            'expires_in': auth.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        })
    log_line('sys', '🔐', 'USER_SECURITY', f"User '{current_user.username}' updated account security settings.")
    return response


@router.get('/api/assist-key')
async def get_assist_key(current_user: models.User = Depends(auth.get_current_user)):
    key = assist_keys.get_or_create_key(current_user.id)
    return {'assist_api_key': key}


@router.post('/api/assist-key/regenerate')
async def regenerate_assist_key(current_user: models.User = Depends(auth.get_current_user)):
    key = assist_keys.regenerate_key(current_user.id)
    log_line('sys', '🔑', 'ASSIST_KEY', f"User '{current_user.username}' regenerated Assist API key.")
    return {'assist_api_key': key}


@router.post('/api/users/register')
async def create_user(
    new_user_data: CreateUserBody,
    db: Session = Depends(database.get_db),
    admin_user: models.User = Depends(auth.get_current_admin)
):
    if db.query(models.User).filter(models.User.username == new_user_data.username).first():
        raise HTTPException(status_code=400, detail={"key": "user.username_already_registered"})
    hashed_password = auth.get_password_hash(new_user_data.password)
    user = models.User(
        username=new_user_data.username,
        full_name=new_user_data.full_name or new_user_data.username,
        hashed_password=hashed_password,
        is_admin=new_user_data.is_admin,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    log_line('sys', '👤', 'USER', f"Admin created user: {new_user_data.username}")
    return {'status': 'created', 'username': new_user_data.username}


@router.post('/api/users/link-whatsapp')
async def link_whatsapp(
    data: LinkWhatsAppBody,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user)
):
    phone = data.phone_number.replace(' ', '').strip()
    if not phone:
        raise HTTPException(status_code=400, detail={"key": "user.invalid_phone"})

    if phone.startswith('0'):
        waha_id = f'4{phone}@c.us'
    elif phone.startswith('+'):
        waha_id = f'{phone[1:]}@c.us'
    else:
        waha_id = f'{phone}@c.us'

    existing = db.query(models.PhoneNumber).filter(models.PhoneNumber.waha_id == waha_id).first()
    if existing:
        if existing.user_id == current_user.id:
            return {'status': 'already_linked'}
        raise HTTPException(status_code=400, detail={"key": "user.phone_already_linked"})

    new_phone = models.PhoneNumber(number=phone, waha_id=waha_id, user_id=current_user.id)
    db.add(new_phone)
    db.commit()
    log_line('sys', '🔗', 'LINK', f'User {current_user.username} linked {phone}')
    return {'status': 'linked', 'waha_id': waha_id}


@router.get('/api/users')
async def list_users(
    db: Session = Depends(database.get_db),
    admin_user: models.User = Depends(auth.get_current_admin)
):
    users = db.query(models.User).filter(models.User.is_active).all()
    return [
        {
            'id': u.id,
            'username': u.username,
            'full_name': u.full_name or u.username,
            'is_admin': u.is_admin,
            'is_active': u.is_active,
            'created_at': u.created_at.isoformat() if u.created_at else None,
            'phones': [p.number for p in u.phone_numbers]
        }
        for u in users
    ]


@router.delete('/api/users/{user_id}')
async def delete_user(
    user_id: int,
    db: Session = Depends(database.get_db),
    admin_user: models.User = Depends(auth.get_current_admin)
):
    if user_id == admin_user.id:
        raise HTTPException(status_code=400, detail={"key": "user.cannot_delete_self"})
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail={"key": "user.user_not_found"})
    db.delete(user)
    db.commit()
    log_line('sys', '👤', 'USER', f'Admin deleted user id={user_id}')
    return {'status': 'deleted'}


@router.post('/api/users/me/phones/unlink')
async def unlink_phone(
    data: UnlinkPhoneBody,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user)
):
    number = data.number.strip().replace(' ', '')
    if not number:
        raise HTTPException(status_code=400, detail={"key": "user.invalid_number"})
    if number.startswith('0'):
        waha_id = f'4{number}@c.us'
    elif number.startswith('+'):
        waha_id = f'{number[1:]}@c.us'
    else:
        waha_id = f'{number}@c.us'

    entry = db.query(models.PhoneNumber).filter(
        models.PhoneNumber.user_id == current_user.id,
        models.PhoneNumber.waha_id == waha_id
    ).first()
    if not entry:
        raise HTTPException(status_code=404, detail={"key": "user.phone_not_linked"})

    db.delete(entry)
    db.commit()
    log_line('sys', '🔗', 'UNLINK', f'User {current_user.username} removed {number}')
    return {'status': 'unlinked'}
