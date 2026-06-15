"""Whisper (Wyoming STT) HTTP API — capability router."""

from __future__ import annotations

import asyncio
import io
import logging
import wave
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel

from core.auth import get_current_user
from core.http.errors import error_detail
from integrations import wyoming_protocol

log = logging.getLogger("whisper")

router = APIRouter(prefix="/api/whisper", tags=["whisper"])


async def _wyoming_transcribe(audio_wav: bytes, host: str, port: int, language: str) -> str:
    reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=10)
    try:
        wav_io = io.BytesIO(audio_wav)
        with wave.open(wav_io, "rb") as wf:
            rate = wf.getframerate()
            width = wf.getsampwidth()
            channels = wf.getnchannels()
            n_frames = wf.getnframes()
            pcm = wf.readframes(n_frames)

        duration = n_frames / rate if rate else 0
        log.info(
            "WAV: rate=%d width=%d ch=%d frames=%d duration=%.1fs pcm_bytes=%d",
            rate,
            width,
            channels,
            n_frames,
            duration,
            len(pcm),
        )

        writer.write(wyoming_protocol.make_event("transcribe", {"language": language}))
        writer.write(
            wyoming_protocol.make_event(
                "audio-start",
                {"rate": rate, "width": width, "channels": channels},
            )
        )

        chunk_size = 8192
        n_chunks = 0
        for i in range(0, len(pcm), chunk_size):
            chunk = pcm[i : i + chunk_size]
            writer.write(
                wyoming_protocol.make_event(
                    "audio-chunk",
                    {"rate": rate, "width": width, "channels": channels},
                    payload=chunk,
                )
            )
            n_chunks += 1

        writer.write(wyoming_protocol.make_event("audio-stop"))
        await writer.drain()
        log.info("Sent %d audio-chunk events to Wyoming", n_chunks)

        response = b""
        try:
            while True:
                data = await asyncio.wait_for(reader.read(65536), timeout=30)
                if not data:
                    break
                response += data
                if b'"transcript"' in response or b'"error"' in response:
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

        transcript_parts: list[str] = []
        for evt_type, evt_data, _payload in wyoming_protocol.parse_events(response):
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


async def _convert_to_wav(audio_bytes: bytes) -> bytes:
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-i",
        "pipe:0",
        "-f",
        "wav",
        "-acodec",
        "pcm_s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        "pipe:1",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(proc.communicate(audio_bytes), timeout=15)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg conversion failed: {stderr.decode()[:200]}")
    return stdout


@router.get("/status")
async def whisper_status(
    host: Optional[str] = None,
    port: Optional[int] = None,
    user=Depends(get_current_user),
):
    from integrations import entry_settings

    cfg = entry_settings.whisper_settings()
    _host = host or cfg.get("host", "localhost")
    _port = port or int(cfg.get("port") or 10300)

    try:
        _reader, writer = await asyncio.wait_for(asyncio.open_connection(_host, _port), timeout=5)
        writer.close()
        await writer.wait_closed()
        return {"status": "connected", "connected": True, "host": _host, "port": _port}
    except Exception as exc:
        return {"status": "error", "connected": False, "error": str(exc), "host": _host, "port": _port}


class TranscribeResponse(BaseModel):
    text: str
    language: str


@router.post("/transcribe", response_model=TranscribeResponse)
async def whisper_transcribe(
    file: UploadFile = File(...),
    user=Depends(get_current_user),
):
    from integrations import entry_settings

    cfg = entry_settings.whisper_settings()
    if not cfg:
        raise HTTPException(status_code=400, detail={"key": "integrations.whisper_disabled"})

    host = cfg.get("host", "localhost")
    port = int(cfg.get("port") or 10300)
    language = cfg.get("language", "ro")

    audio_bytes = await file.read()
    log.info(
        "Received audio: filename=%s content_type=%s size=%d bytes",
        file.filename,
        file.content_type,
        len(audio_bytes),
    )
    if not audio_bytes:
        raise HTTPException(status_code=400, detail=error_detail("integrations.whisper_empty_audio"))

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
        raise HTTPException(status_code=504, detail=error_detail("integrations.whisper_timeout")) from None
    except ConnectionRefusedError:
        raise HTTPException(
            status_code=502,
            detail=error_detail("integrations.whisper_connect_failed"),
        ) from None
    except Exception as exc:
        log.exception("Transcription failed")
        raise HTTPException(
            status_code=500,
            detail=error_detail("integrations.whisper_transcription_failed", {"message": str(exc)}),
        ) from exc
