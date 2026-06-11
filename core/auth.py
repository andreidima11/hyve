import os
import secrets
import sys
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from typing import Optional
from jose import JWTError, jwt
import bcrypt as _bcrypt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
import core.assist_keys as assist_keys
import core.models as models, core.database as database
import core.settings as settings
from core.env_bootstrap import ensure_env_loaded

ensure_env_loaded()

# --- CONFIGURARE SECRETĂ ---
# Citește din env var; dacă nu există, persistă pe disk (~/.hyve_secret_key)
_SECRET_KEY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".secret_key")
SECRET_KEY = os.environ.get("HYVE_SECRET_KEY", "").strip()
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
            print("❌ FATAL: Could not persist secret key. Set HYVE_SECRET_KEY env var or fix filesystem permissions.", file=sys.stderr)
            sys.exit(1)
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 240       # 4 hours — short-lived access token
REFRESH_TOKEN_EXPIRE_MINUTES = 10080    # 7 days — long-lived refresh token
SSE_EXCHANGE_TOKEN_EXPIRE_SECONDS = 30  # 30 s one-time exchange token for SSE/WS
CAMERA_STREAM_TOKEN_EXPIRE_SECONDS = 300  # 5 min — media elements cannot send Authorization headers

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/token")

# JWT types — access tokens omit ``type`` (legacy) or use ``access``.
_NON_ACCESS_TOKEN_TYPES = frozenset({"refresh", "sse_exchange", "camera_stream"})

# --- UTILS ---
def decode_token_payload(token: str) -> Optional[dict]:
    """Decode JWT without DB checks. Returns None on failure."""
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return None


def is_access_token_payload(payload: dict) -> bool:
    """True for API bearer tokens (legacy untyped or explicit access)."""
    if not payload or not payload.get("sub"):
        return False
    token_type = payload.get("type")
    if token_type is None:
        return True
    return token_type == "access"


def decode_access_token(token: str, db: Session | None = None) -> Optional[dict]:
    """Decode and validate an API access token; optional revocation check."""
    payload = decode_token_payload(token)
    if not payload or not is_access_token_payload(payload):
        return None
    jti = payload.get("jti")
    if db and jti:
        if db.query(models.RevokedToken).filter(models.RevokedToken.jti == jti).first():
            return None
    return payload


def consume_sse_exchange_token(token: str, db: Session) -> Optional[dict]:
    """Validate a short-lived SSE/WS exchange token and revoke it (single-use)."""
    payload = verify_sse_exchange_token(token)
    if not payload:
        return None
    jti = payload.get("jti")
    if not jti:
        return None
    if db.query(models.RevokedToken).filter(models.RevokedToken.jti == jti).first():
        return None
    if not revoke_token(token, db):
        return None
    return payload


def authenticate_ws_token(token: str | None) -> Optional[models.User]:
    """Authenticate WebSocket/SSE clients using a single-use exchange token only."""
    if not token:
        return None
    db = next(database.get_db())
    try:
        payload = consume_sse_exchange_token(token, db)
        if not payload:
            return None
        username = payload.get("sub")
        if not username:
            return None
        user = db.query(models.User).filter(models.User.username == username).first()
        if not user or not user.is_active:
            return None
        return user
    except Exception:
        return None
    finally:
        db.close()


def _trusted_proxy_peer(request: Request) -> str:
    """Direct TCP peer (reverse-proxy hop), lowercased."""
    if not request.client:
        return ""
    return (request.client.host or "").strip().lower()


def resolve_client_host(request: Request) -> str:
    """Best-effort client IP; trust X-Forwarded-For only from local reverse proxies."""
    peer = _trusted_proxy_peer(request)
    forwarded = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip().lower()
    if not forwarded:
        forwarded = (request.headers.get("x-real-ip") or "").strip().lower()
    if forwarded and peer in ("127.0.0.1", "::1", "localhost"):
        return forwarded
    return peer


def decode_media_url_token(raw_token: str) -> Optional[dict]:
    """Short-lived camera_stream token or access JWT for media URL query auth."""
    if not raw_token:
        return None
    payload = verify_camera_stream_token(raw_token)
    if payload:
        return payload
    payload = decode_token_payload(raw_token)
    if payload and is_access_token_payload(payload):
        return payload
    return None


def _client_is_loopback(request: Request) -> bool:
    host = resolve_client_host(request)
    if host in ("127.0.0.1", "::1", "localhost"):
        return True
    if host.startswith("127."):
        return True
    return False

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return _bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))

def get_password_hash(password: str) -> str:
    return _bcrypt.hashpw(password.encode("utf-8"), _bcrypt.gensalt()).decode("utf-8")

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


def create_camera_stream_token(username: str) -> str:
    """Short-lived token for camera snapshot/stream/play URLs (query param auth)."""
    expire = datetime.now(timezone.utc) + timedelta(seconds=CAMERA_STREAM_TOKEN_EXPIRE_SECONDS)
    to_encode = {
        "sub": username,
        "exp": expire,
        "iat": datetime.now(timezone.utc),
        "jti": str(uuid4()),
        "type": "camera_stream",
    }
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def verify_camera_stream_token(token: str) -> Optional[dict]:
    """Decode a camera stream token. Returns payload if valid, else None."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("type") != "camera_stream" or not payload.get("sub"):
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
    """Decode access-token JWT payload without DB checks. Returns None on failure."""
    payload = decode_token_payload(token)
    if payload and is_access_token_payload(payload):
        return payload
    return None


def extract_bearer_or_assist_token(request: Request) -> Optional[str]:
    """Bearer token from Authorization, or X-Assist-Key header."""
    auth_header = (request.headers.get("Authorization") or "").strip()
    token: Optional[str] = None
    if auth_header:
        if auth_header.lower().startswith("bearer "):
            token = auth_header[7:].strip()
        else:
            token = auth_header.strip()
    if not token:
        token = (request.headers.get("x-assist-key") or "").strip() or None
    return token


async def resolve_assist_user_id(request: Request, db: Session) -> int:
    """Resolve user id for Ollama/Assist from assist key or valid access JWT."""
    token = extract_bearer_or_assist_token(request)
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"key": "common.invalid_credentials"},
        headers={"WWW-Authenticate": "Bearer"},
    )

    if token:
        uid = assist_keys.get_user_id_by_token(token)
        if uid is not None:
            return uid

        payload = verify_token(token)
        if payload:
            jti = payload.get("jti")
            if jti:
                is_revoked = db.query(models.RevokedToken).filter(models.RevokedToken.jti == jti).first()
                if is_revoked:
                    raise credentials_exception
            username = payload.get("sub")
            if username:
                user = db.query(models.User).filter(models.User.username == username).first()
                if user is None:
                    raise credentials_exception
                if not user.is_active:
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail={"key": "common.account_deactivated"},
                    )
                return user.id

        raise credentials_exception

    assist_cfg = settings.CFG.get("assist") or {}
    default_id = assist_cfg.get("assist_default_user_id")
    if default_id is not None and isinstance(default_id, int) and default_id > 0:
        if _client_is_loopback(request):
            return default_id

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"key": "common.auth_required"},
        headers={"WWW-Authenticate": "Bearer"},
    )


# --- DEPENDENCY PRINCIPALĂ (Gatekeeper) ---
async def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(database.get_db)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"key": "common.invalid_credentials"},
        headers={"WWW-Authenticate": "Bearer"},
    )
    payload = decode_access_token(token, db)
    if not payload:
        raise credentials_exception
    username = payload.get("sub")
    if not username:
        raise credentials_exception

    user = db.query(models.User).filter(models.User.username == username).first()
    if user is None:
        raise credentials_exception
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"key": "common.account_deactivated"},
        )
    return user

async def get_current_admin(current_user: models.User = Depends(get_current_user)):
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail={"key": "common.admin_required"})
    return current_user