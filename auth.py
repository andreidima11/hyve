import os
import secrets
import sys
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from typing import Optional
from jose import JWTError, jwt
from passlib.context import CryptContext
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
import models, database
from env_bootstrap import ensure_env_loaded

ensure_env_loaded()

# --- CONFIGURARE SECRETĂ ---
# Citește din env var; dacă nu există, persistă pe disk (~/.memini_secret_key)
_SECRET_KEY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".secret_key")
SECRET_KEY = os.environ.get("MEMINI_SECRET_KEY", "").strip()
if not SECRET_KEY:
    # Try loading from persisted file
    try:
        if os.path.isfile(_SECRET_KEY_FILE):
            with open(_SECRET_KEY_FILE, "r") as f:
                SECRET_KEY = f.read().strip()
    except OSError:
        pass
    if not SECRET_KEY:
        SECRET_KEY = secrets.token_urlsafe(64)
        try:
            with open(_SECRET_KEY_FILE, "w") as f:
                f.write(SECRET_KEY)
            os.chmod(_SECRET_KEY_FILE, 0o600)
            print("🔑 Generated and saved secret key to .secret_key (tokens persist across restarts).")
        except OSError:
            print("❌ FATAL: Could not persist secret key. Set MEMINI_SECRET_KEY env var or fix filesystem permissions.", file=sys.stderr)
            sys.exit(1)
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 240       # 4 hours — short-lived access token
REFRESH_TOKEN_EXPIRE_MINUTES = 10080    # 7 days — long-lived refresh token
SSE_EXCHANGE_TOKEN_EXPIRE_SECONDS = 30  # 30 s one-time exchange token for SSE/WS

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/token")

# --- UTILS ---
def verify_password(plain_password, hashed_password):
    return pwd_context.verify(plain_password, hashed_password)

def get_password_hash(password):
    return pwd_context.hash(password)

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    # Dacă nu se specifică altfel, folosim valoarea globală ACCESS_TOKEN_EXPIRE_MINUTES
    if not expires_delta:
        expires_delta = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    expire = datetime.now(timezone.utc) + expires_delta
    
    to_encode.update({"exp": expire, "iat": datetime.now(timezone.utc), "jti": str(uuid4())})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt


def create_refresh_token(data: dict) -> str:
    """Create a long-lived refresh token (type=refresh)."""
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(minutes=REFRESH_TOKEN_EXPIRE_MINUTES)
    to_encode.update({
        "exp": expire,
        "iat": datetime.now(timezone.utc),
        "jti": str(uuid4()),
        "type": "refresh",
    })
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def create_sse_exchange_token(username: str) -> str:
    """Create a very short-lived single-use token for SSE/WebSocket connections.

    The token carries type=sse_exchange and is valid for only 30 seconds.
    After the SSE endpoint validates it once, it should be considered consumed.
    """
    expire = datetime.now(timezone.utc) + timedelta(seconds=SSE_EXCHANGE_TOKEN_EXPIRE_SECONDS)
    payload = {
        "sub": username,
        "exp": expire,
        "iat": datetime.now(timezone.utc),
        "jti": str(uuid4()),
        "type": "sse_exchange",
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def verify_refresh_token(token: str) -> Optional[dict]:
    """Decode a refresh token. Returns payload if valid and type=refresh, else None."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("type") != "refresh" or not payload.get("sub"):
            return None
        return payload
    except JWTError:
        return None


def verify_sse_exchange_token(token: str) -> Optional[dict]:
    """Decode an SSE exchange token. Returns payload if valid and type=sse_exchange, else None."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("type") != "sse_exchange" or not payload.get("sub"):
            return None
        return payload
    except JWTError:
        return None


def cleanup_expired_revocations(db: Session) -> int:
    """Remove expired entries from RevokedToken table. Returns count deleted."""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    deleted = db.query(models.RevokedToken).filter(
        models.RevokedToken.expires_at.isnot(None),
        models.RevokedToken.expires_at < now,
    ).delete(synchronize_session=False)
    db.commit()
    return deleted


def revoke_token(token: str, db: Session) -> bool:
    """Revoke a JWT by persisting its jti until token expiry."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return False

    jti = payload.get("jti")
    if not jti:
        return False

    existing = db.query(models.RevokedToken).filter(models.RevokedToken.jti == jti).first()
    if existing:
        return True

    exp = payload.get("exp")
    expires_at = None
    if isinstance(exp, (int, float)):
        expires_at = datetime.fromtimestamp(exp, tz=timezone.utc).replace(tzinfo=None)

    revoked = models.RevokedToken(
        jti=jti,
        username=payload.get("sub") or "",
        expires_at=expires_at,
    )
    db.add(revoked)
    db.commit()
    return True

def verify_token(token: str) -> Optional[dict]:
    """Decode and return JWT payload without DB checks. Returns None on failure."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("sub"):
            return payload
        return None
    except JWTError:
        return None

# --- DEPENDENCY PRINCIPALĂ (Gatekeeper) ---
async def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(database.get_db)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Credențiale invalide",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
        jti: str = payload.get("jti")
        if jti:
            is_revoked = db.query(models.RevokedToken).filter(models.RevokedToken.jti == jti).first()
            if is_revoked:
                raise credentials_exception
    except JWTError:
        raise credentials_exception
    
    user = db.query(models.User).filter(models.User.username == username).first()
    if user is None:
        raise credentials_exception
    return user

async def get_current_admin(current_user: models.User = Depends(get_current_user)):
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Acces interzis (Necesită Admin)")
    return current_user