"""Piper (Wyoming TTS) integration router.

Provides:
 - GET  /api/piper/status     – check connection to the Piper server
 - POST /api/piper/synthesize  – send text, get WAV audio back (or Opus if format=opus)
"""

import asyncio
import io
import struct
import wave
import logging
import shutil
import subprocess
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

import core.settings as settings_mod
from core.auth import get_current_user
from core.http.errors import error_detail

log = logging.getLogger("piper")

router = APIRouter(prefix="/api/piper", tags=["piper"])

# Check for ffmpeg at import time
_FFMPEG = shutil.which("ffmpeg")


# ---------------------------------------------------------------------------
# Wyoming protocol helpers  (shared logic with whisper router)
# ---------------------------------------------------------------------------

def _make_event(event_type: str, data: Optional[dict] = None, payload: Optional[bytes] = None) -> bytes:
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
        data_length = header.get("data_length", 0)
        evt_data = {}
        if data_length and pos + data_length <= len(raw):
            try:
                evt_data = _json.loads(raw[pos:pos + data_length])
            except _json.JSONDecodeError:
                pass
            pos += data_length
        payload_length = header.get("payload_length", 0)
        payload = b""
        if payload_length and pos + payload_length <= len(raw):
            payload = raw[pos:pos + payload_length]
            pos += payload_length
        yield header.get("type", ""), evt_data, payload


# ---------------------------------------------------------------------------
# TTS synthesis via Wyoming protocol
# ---------------------------------------------------------------------------

async def _wyoming_synthesize(text: str, host: str, port: int,
                               voice: str = "ro_RO-mihai-medium",
                               speaker_id: int = 0,
                               length_scale: float = 1.0) -> bytes:
    """Send text to Wyoming Piper via TCP and return WAV audio bytes."""
    reader, writer = await asyncio.wait_for(
        asyncio.open_connection(host, port), timeout=10
    )
    try:
        # 1. synthesize event with text + voice params
        synth_data = {"text": text}
        if voice:
            synth_data["voice"] = {"name": voice}
            if speaker_id:
                synth_data["voice"]["speaker"] = speaker_id
        if length_scale and length_scale != 1.0:
            synth_data["length_scale"] = length_scale

        writer.write(_make_event("synthesize", synth_data))
        await writer.drain()

        log.info("Sent synthesize request: text=%d chars, voice=%s", len(text), voice)

        # 2. Read response — collect audio-start, audio-chunk*, audio-stop
        audio_params = {}
        pcm_chunks = []
        response = b""

        try:
            while True:
                data = await asyncio.wait_for(reader.read(65536), timeout=30)
                if not data:
                    break
                response += data
                # Check if we have audio-stop (terminal event)
                if b'"audio-stop"' in data:
                    # Grace period for trailing bytes
                    try:
                        extra = await asyncio.wait_for(reader.read(4096), timeout=0.5)
                        if extra:
                            response += extra
                    except asyncio.TimeoutError:
                        pass
                    break
        except asyncio.TimeoutError:
            log.warning("Timeout waiting for Piper response (got %d bytes)", len(response))

        # 3. Parse events and collect audio
        for evt_type, evt_data, payload in _parse_events(response):
            if evt_type == "audio-start":
                audio_params = evt_data
                log.info("Audio params: %s", audio_params)
            elif evt_type == "audio-chunk":
                if payload:
                    pcm_chunks.append(payload)
            elif evt_type == "audio-stop":
                break
            elif evt_type == "error":
                raise RuntimeError(evt_data.get("text", "Piper TTS error"))

        if not pcm_chunks:
            raise RuntimeError("No audio data received from Piper")

        pcm_data = b"".join(pcm_chunks)
        rate = audio_params.get("rate", 22050)
        width = audio_params.get("width", 2)
        channels = audio_params.get("channels", 1)

        # Pad ~300 ms of silence so the last syllable isn't clipped on playback.
        silence_frames = int(rate * 0.30) * channels * width
        pcm_data += b"\x00" * silence_frames

        log.info("Received %d PCM bytes (rate=%d, width=%d, ch=%d)",
                 len(pcm_data), rate, width, channels)

        # 4. Build WAV
        wav_io = io.BytesIO()
        with wave.open(wav_io, "wb") as wf:
            wf.setnchannels(channels)
            wf.setsampwidth(width)
            wf.setframerate(rate)
            wf.writeframes(pcm_data)

        return wav_io.getvalue()
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
async def piper_status(
    host: Optional[str] = None,
    port: Optional[int] = None,
    user=Depends(get_current_user),
):
    """Check if the Piper server is reachable."""
    from integrations import entry_settings

    cfg = entry_settings.piper_settings()
    _host = host or cfg.get("host", "localhost")
    _port = port or int(cfg.get("port") or 10200)

    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(_host, _port), timeout=5
        )
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return {"connected": True, "host": _host, "port": _port}
    except Exception as e:
        return {"connected": False, "host": _host, "port": _port, "error": str(e)}


class SynthesizeRequest(BaseModel):
    text: str
    voice: Optional[str] = None
    speaker_id: Optional[int] = None
    length_scale: Optional[float] = None
    format: Optional[str] = None  # "wav" (default) or "opus"


def _wav_to_opus(wav_bytes: bytes) -> bytes:
    """Convert WAV bytes to OGG/Opus using ffmpeg. Falls back to WAV if ffmpeg unavailable."""
    if not _FFMPEG:
        return wav_bytes
    proc = subprocess.run(
        [_FFMPEG, "-i", "pipe:0", "-c:a", "libopus", "-b:a", "32k",
         "-application", "voip", "-f", "ogg", "pipe:1"],
        input=wav_bytes, capture_output=True, timeout=15,
    )
    if proc.returncode != 0:
        log.warning("ffmpeg opus conversion failed: %s", proc.stderr[:200])
        return wav_bytes
    return proc.stdout


@router.post("/synthesize")
async def synthesize(req: SynthesizeRequest, user=Depends(get_current_user)):
    """Synthesize text to speech, returns WAV or Opus audio."""
    from integrations import entry_settings

    cfg = entry_settings.piper_settings()
    if not cfg:
        raise HTTPException(status_code=400, detail={"key": "integrations.piper_disabled"})

    host = cfg.get("host", "localhost")
    port = int(cfg.get("port") or 10200)
    voice = req.voice or cfg.get("voice", "ro_RO-mihai-medium")
    speaker_id = req.speaker_id if req.speaker_id is not None else int(cfg.get("speaker_id") or 0)
    length_scale = req.length_scale if req.length_scale is not None else float(cfg.get("length_scale") or "1.0")
    out_format = (req.format or "wav").lower()

    try:
        wav_bytes = await _wyoming_synthesize(
            text=req.text,
            host=host,
            port=port,
            voice=voice,
            speaker_id=speaker_id,
            length_scale=length_scale,
        )
        if out_format == "opus" and _FFMPEG:
            opus_bytes = await asyncio.get_event_loop().run_in_executor(
                None, _wav_to_opus, wav_bytes)
            return Response(content=opus_bytes, media_type="audio/ogg")
        return Response(content=wav_bytes, media_type="audio/wav")
    except Exception as e:
        log.error("Piper synthesize error: %s", e)
        raise HTTPException(status_code=502, detail=error_detail("common.error_with_message", {"message": str(e)}))
