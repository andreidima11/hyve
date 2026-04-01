import base64
from typing import Optional

from fastapi import HTTPException


def detect_image_type(raw: bytes) -> Optional[str]:
    if raw.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if raw.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp"
    if raw.startswith(b"BM"):
        return "bmp"
    return None


def validate_incoming_image_base64(image_b64: Optional[str], max_bytes: int = 3_000_000) -> Optional[str]:
    """Validate uploaded image base64 to reduce malformed payload risk."""
    if not image_b64:
        return image_b64
    payload = image_b64.strip()
    if payload.startswith("data:"):
        _, _, payload = payload.partition(",")
    try:
        raw = base64.b64decode(payload, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid image encoding.") from exc

    if len(raw) > max_bytes:
        raise HTTPException(status_code=413, detail=f"Image too large. Max {max_bytes} bytes.")

    img_type = detect_image_type(raw)
    if not img_type:
        raise HTTPException(status_code=400, detail="Unsupported image type. Allowed: JPEG, PNG, GIF, WEBP, BMP.")
    return payload
