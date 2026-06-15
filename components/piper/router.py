"""Piper (Wyoming TTS) HTTP API — capability router."""

from __future__ import annotations

import asyncio
import io
import logging
import shutil
import subprocess
import wave
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from core.auth import get_current_user
from core.http.errors import error_detail
from integrations import wyoming_protocol

log = logging.getLogger("piper")

router = APIRouter(prefix="/api/piper", tags=["piper"])

_FFMPEG = shutil.which("ffmpeg")


async def _wyoming_synthesize(
    text: str,
    host: str,
    port: int,
    voice: str = "ro_RO-mihai-medium",
    speaker_id: int = 0,
    length_scale: float = 1.0,
) -> bytes:
    """Send text to Wyoming Piper via TCP and return WAV audio bytes."""
    reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=10)
    try:
        synth_data: dict = {"text": text}
        if voice:
            synth_data["voice"] = {"name": voice}
            if speaker_id:
                synth_data["voice"]["speaker"] = speaker_id
        if length_scale and length_scale != 1.0:
            synth_data["length_scale"] = length_scale

        writer.write(wyoming_protocol.make_event("synthesize", synth_data))
        await writer.drain()

        log.info("Sent synthesize request: text=%d chars, voice=%s", len(text), voice)

        audio_params: dict = {}
        pcm_chunks: list[bytes] = []
        response = b""

        try:
            while True:
                data = await asyncio.wait_for(reader.read(65536), timeout=30)
                if not data:
                    break
                response += data
                if b'"audio-stop"' in data:
                    try:
                        extra = await asyncio.wait_for(reader.read(4096), timeout=0.5)
                        if extra:
                            response += extra
                    except asyncio.TimeoutError:
                        pass
                    break
        except asyncio.TimeoutError:
            log.warning("Timeout waiting for Piper response (got %d bytes)", len(response))

        for evt_type, evt_data, payload in wyoming_protocol.parse_events(response):
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

        silence_frames = int(rate * 0.30) * channels * width
        pcm_data += b"\x00" * silence_frames

        log.info(
            "Received %d PCM bytes (rate=%d, width=%d, ch=%d)",
            len(pcm_data),
            rate,
            width,
            channels,
        )

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


@router.get("/status")
async def piper_status(
    host: Optional[str] = None,
    port: Optional[int] = None,
    user=Depends(get_current_user),
):
    from integrations import entry_settings

    cfg = entry_settings.piper_settings()
    _host = host or cfg.get("host", "localhost")
    _port = port or int(cfg.get("port") or 10200)

    try:
        _reader, writer = await asyncio.wait_for(asyncio.open_connection(_host, _port), timeout=5)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return {"connected": True, "host": _host, "port": _port}
    except Exception as exc:
        return {"connected": False, "host": _host, "port": _port, "error": str(exc)}


class SynthesizeRequest(BaseModel):
    text: str
    voice: Optional[str] = None
    speaker_id: Optional[int] = None
    length_scale: Optional[float] = None
    format: Optional[str] = None


def _wav_to_opus(wav_bytes: bytes) -> bytes:
    if not _FFMPEG:
        return wav_bytes
    proc = subprocess.run(
        [
            _FFMPEG,
            "-i",
            "pipe:0",
            "-c:a",
            "libopus",
            "-b:a",
            "32k",
            "-application",
            "voip",
            "-f",
            "ogg",
            "pipe:1",
        ],
        input=wav_bytes,
        capture_output=True,
        timeout=15,
    )
    if proc.returncode != 0:
        log.warning("ffmpeg opus conversion failed: %s", proc.stderr[:200])
        return wav_bytes
    return proc.stdout


@router.post("/synthesize")
async def synthesize(req: SynthesizeRequest, user=Depends(get_current_user)):
    from integrations import entry_settings

    cfg = entry_settings.piper_settings()
    if not cfg:
        raise HTTPException(status_code=400, detail={"key": "integrations.piper_disabled"})

    host = cfg.get("host", "localhost")
    port = int(cfg.get("port") or 10200)
    voice = req.voice or cfg.get("voice", "ro_RO-mihai-medium")
    speaker_id = req.speaker_id if req.speaker_id is not None else int(cfg.get("speaker_id") or 0)
    length_scale = (
        req.length_scale if req.length_scale is not None else float(cfg.get("length_scale") or "1.0")
    )
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
            opus_bytes = await asyncio.get_event_loop().run_in_executor(None, _wav_to_opus, wav_bytes)
            return Response(content=opus_bytes, media_type="audio/ogg")
        return Response(content=wav_bytes, media_type="audio/wav")
    except Exception as exc:
        log.error("Piper synthesize error: %s", exc)
        raise HTTPException(
            status_code=502,
            detail=error_detail("common.error_with_message", {"message": str(exc)}),
        ) from exc
