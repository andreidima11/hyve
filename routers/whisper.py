"""Whisper (Wyoming Faster Whisper) integration router.

Provides:
 - GET  /api/whisper/status   – check connection to the Whisper server
 - POST /api/whisper/transcribe – upload audio, get transcript
"""

import asyncio
import io
import struct
import wave
from typing import Optional

from fastapi import APIRouter, UploadFile, File, Depends, HTTPException
from pydantic import BaseModel

import core.settings as settings_mod
from core.auth import get_current_user
from core.http.errors import error_detail

router = APIRouter(prefix="/api/whisper", tags=["whisper"])


# ---------------------------------------------------------------------------
# Wyoming protocol helpers
# ---------------------------------------------------------------------------

_WYOMING_VERSION = "1.0.0"


def _make_event(event_type: str, data: Optional[dict] = None, payload: Optional[bytes] = None) -> bytes:
    """Build a Wyoming protocol event.

    Wire format (Wyoming >= 1.x):
      {"type":"…","version":"1.0"[,"data_length":D][,"payload_length":P]}\n
      [<D bytes of JSON-encoded data>]
      [<P bytes of binary payload>]
    """
    import json as _json
    header: dict = {"type": event_type, "version": "1.0"}
    data_bytes = b""
    if data:
        data_bytes = _json.dumps(data, ensure_ascii=False).encode("utf-8")
        header["data_length"] = len(data_bytes)
    if payload:
        header["payload_length"] = len(payload)
    frame = _json.dumps(header, ensure_ascii=False).encode("utf-8") + b"\n"
    frame += data_bytes
    if payload:
        frame += payload
    return frame


def _parse_events(raw: bytes):
    """Yield (event_type, data_dict) from raw Wyoming response bytes."""
    import json as _json
    pos = 0
    while pos < len(raw):
        nl = raw.find(b"\n", pos)
        if nl == -1:
            break
        line = raw[pos:nl].strip()
        pos = nl + 1
        if not line:
            continue
        try:
            header = _json.loads(line)
        except _json.JSONDecodeError:
            continue
        # Read data section (separate from header)
        data_length = header.get("data_length", 0)
        evt_data = {}
        if data_length and pos + data_length <= len(raw):
            try:
                evt_data = _json.loads(raw[pos:pos + data_length])
            except _json.JSONDecodeError:
                pass
            pos += data_length
        # Skip binary payload
        payload_length = header.get("payload_length", 0)
        if payload_length:
            pos += payload_length
        yield header.get("type", ""), evt_data


async def _wyoming_transcribe(audio_wav: bytes, host: str, port: int, language: str) -> str:
    """Send WAV audio to Wyoming Faster Whisper via TCP and return transcript."""
    import logging
    log = logging.getLogger("whisper")

    reader, writer = await asyncio.wait_for(
        asyncio.open_connection(host, port), timeout=10
    )
    try:
        # Parse WAV
        wav_io = io.BytesIO(audio_wav)
        with wave.open(wav_io, "rb") as wf:
            rate = wf.getframerate()
            width = wf.getsampwidth()
            channels = wf.getnchannels()
            n_frames = wf.getnframes()
            pcm = wf.readframes(n_frames)

        duration = n_frames / rate if rate else 0
        log.info("WAV: rate=%d width=%d ch=%d frames=%d duration=%.1fs pcm_bytes=%d",
                 rate, width, channels, n_frames, duration, len(pcm))

        # 1. transcribe — sets language for server
        writer.write(_make_event("transcribe", {"language": language}))

        # 2. audio-start
        writer.write(_make_event("audio-start", {
            "rate": rate,
            "width": width,
            "channels": channels,
        }))

        # 3. audio-chunk events (8192 bytes each)
        chunk_size = 8192
        n_chunks = 0
        for i in range(0, len(pcm), chunk_size):
            chunk = pcm[i:i + chunk_size]
            writer.write(_make_event("audio-chunk", {
                "rate": rate,
                "width": width,
                "channels": channels,
            }, payload=chunk))
            n_chunks += 1

        # 4. audio-stop
        writer.write(_make_event("audio-stop"))
        await writer.drain()
        log.info("Sent %d audio-chunk events to Wyoming", n_chunks)

        # 5. Read response — wait for transcript or error
        response = b""
        try:
            while True:
                data = await asyncio.wait_for(reader.read(65536), timeout=30)
                if not data:
                    break
                response += data
                # Check for terminal event
                if b'"transcript"' in response or b'"error"' in response:
                    # Small grace period for any remaining bytes
                    try:
                        extra = await asyncio.wait_for(reader.read(4096), timeout=0.5)
                        if extra:
                            response += extra
                    except asyncio.TimeoutError:
                        pass
                    break
        except asyncio.TimeoutError:
            log.warning("Timeout waiting for Wyoming response (got %d bytes so far)", len(response))

        log.info("Wyoming response size: %d bytes", len(response))

        # 6. Extract transcript
        transcript_parts = []
        for evt_type, evt_data in _parse_events(response):
            log.info("Wyoming event: type=%s data=%s", evt_type, evt_data)
            if evt_type == "transcript":
                txt = evt_data.get("text", "")
                if txt:
                    transcript_parts.append(txt)
            elif evt_type == "error":
                raise RuntimeError(evt_data.get("text", "Whisper error"))

        result = " ".join(transcript_parts).strip()
        log.info("Transcript result: '%s'", result)
        return result
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/status")
async def whisper_status(
    host: Optional[str] = None,
    port: Optional[int] = None,
    user=Depends(get_current_user),
):
    """Check if the Whisper server is reachable.
    
    Optional query params override config values (useful for testing before save).
    """
    from integrations import entry_settings

    cfg = entry_settings.whisper_settings()
    _host = host or cfg.get("host", "localhost")
    _port = port or int(cfg.get("port") or 10300)

    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(_host, _port), timeout=5
        )
        writer.close()
        await writer.wait_closed()
        return {"status": "connected", "connected": True, "host": _host, "port": _port}
    except Exception as e:
        return {"status": "error", "connected": False, "error": str(e), "host": _host, "port": _port}


class TranscribeResponse(BaseModel):
    text: str
    language: str


@router.post("/transcribe", response_model=TranscribeResponse)
async def whisper_transcribe(
    file: UploadFile = File(...),
    user=Depends(get_current_user),
):
    """Transcribe uploaded audio via Wyoming Faster Whisper."""
    import logging
    log = logging.getLogger("whisper")

    from integrations import entry_settings

    cfg = entry_settings.whisper_settings()
    if not cfg:
        raise HTTPException(status_code=400, detail={"key": "integrations.whisper_disabled"})

    host = cfg.get("host", "localhost")
    port = int(cfg.get("port") or 10300)
    language = cfg.get("language", "ro")

    # Read uploaded audio
    audio_bytes = await file.read()
    log.info("Received audio: filename=%s content_type=%s size=%d bytes",
             file.filename, file.content_type, len(audio_bytes))
    if not audio_bytes:
        raise HTTPException(status_code=400, detail=error_detail("integrations.whisper_empty_audio"))

    # Convert to WAV if needed (browser sends webm/ogg)
    content_type = file.content_type or ""
    if "wav" not in content_type:
        log.info("Converting %s to WAV via ffmpeg...", content_type)
        audio_bytes = await _convert_to_wav(audio_bytes)
        log.info("WAV conversion done: %d bytes", len(audio_bytes))

    try:
        text = await _wyoming_transcribe(audio_bytes, host, port, language)
        log.info("Final transcription: '%s'", text)
        return TranscribeResponse(text=text, language=language)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail=error_detail("integrations.whisper_timeout"))
    except ConnectionRefusedError:
        raise HTTPException(status_code=502, detail=error_detail("integrations.whisper_connect_failed"))
    except Exception as e:
        log.exception("Transcription failed")
        raise HTTPException(
            status_code=500,
            detail=error_detail("integrations.whisper_transcription_failed", {"message": str(e)}),
        )


async def _convert_to_wav(audio_bytes: bytes) -> bytes:
    """Convert audio (webm/ogg/mp3) to WAV using ffmpeg."""
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-i", "pipe:0",
        "-f", "wav",
        "-acodec", "pcm_s16le",
        "-ar", "16000",
        "-ac", "1",
        "pipe:1",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(proc.communicate(audio_bytes), timeout=15)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg conversion failed: {stderr.decode()[:200]}")
    return stdout
