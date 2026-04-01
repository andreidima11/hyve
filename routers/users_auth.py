from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
import json

import assist_keys
import auth
import database
import models
from logger import log_line

router = APIRouter()


class UpdateUserMeBody(BaseModel):
    persona: str | None = Field(None, max_length=2000)
    notification_prefs: dict | None = None


class CreateUserBody(BaseModel):
    username: str = Field(..., min_length=2, max_length=64)
    password: str = Field(..., min_length=8, max_length=128)
    full_name: str | None = Field(None, max_length=128)
    is_admin: bool = False


class LinkWhatsAppBody(BaseModel):
    phone_number: str = Field(..., min_length=3, max_length=32)


class UnlinkPhoneBody(BaseModel):
    number: str = Field(..., min_length=3, max_length=32)


@router.post('/api/logout')
async def logout_current_user(
    token: str = Depends(auth.oauth2_scheme),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    revoked = auth.revoke_token(token, db)
    log_line('sys', '🚪', 'LOGOUT', f"User '{current_user.username}' logged out.")
    return {'ok': True, 'revoked': revoked}


@router.get('/api/users/me')
async def read_users_me(current_user: models.User = Depends(auth.get_current_user)):
    notif_prefs = {"app": True, "whatsapp": True}  # defaults
    if current_user.notification_preferences:
        try:
            notif_prefs = json.loads(current_user.notification_preferences)
        except Exception:
            pass
    return {
        'id': current_user.id,
        'username': current_user.username,
        'is_admin': current_user.is_admin,
        'phones': [p.number for p in current_user.phone_numbers],
        'persona': current_user.persona_override or '',
        'notification_prefs': notif_prefs,
    }


@router.patch('/api/users/me')
async def update_users_me(
    data: UpdateUserMeBody,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    if data.persona is not None:
        current_user.persona_override = data.persona.strip() or None
    if data.notification_prefs is not None:
        current_user.notification_preferences = json.dumps(data.notification_prefs)
    db.commit()
    db.refresh(current_user)
    notif_prefs = {"app": True, "whatsapp": True}
    if current_user.notification_preferences:
        try:
            notif_prefs = json.loads(current_user.notification_preferences)
        except Exception:
            pass
    return {
        'id': current_user.id,
        'username': current_user.username,
        'is_admin': current_user.is_admin,
        'phones': [p.number for p in current_user.phone_numbers],
        'persona': current_user.persona_override or '',
        'notification_prefs': notif_prefs,
    }


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
        raise HTTPException(status_code=400, detail='Username already registered')
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
        raise HTTPException(status_code=400, detail='Invalid phone')

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
        raise HTTPException(status_code=400, detail='Number already linked to another account')

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
        raise HTTPException(status_code=400, detail='Cannot delete your own account')
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail='User not found')
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
        raise HTTPException(status_code=400, detail='Invalid number')
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
        raise HTTPException(status_code=404, detail='Number not linked to your account')

    db.delete(entry)
    db.commit()
    log_line('sys', '🔗', 'UNLINK', f'User {current_user.username} removed {number}')
    return {'status': 'unlinked'}
