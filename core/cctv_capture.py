"""Capture frames from RTSP streams (requires ffmpeg). Used by CCTV and camera proxy."""
from __future__ import annotations

import asyncio
import functools
import os
import re
import subprocess
from collections.abc import AsyncIterator
from typing import Optional

DEFAULT_TIMEOUT = 15.0
STREAM_READ_TIMEOUT = 8.0


def _rtsp_url_ok(rtsp_url: str) -> bool:
    return bool((rtsp_url or "").strip().lower().startswith("rtsp://"))


@functools.lru_cache(maxsize=1)
def _ffmpeg_major_version() -> int:
    """Return ffmpeg's major version, or 0 if it can't be determined."""
    try:
        out = subprocess.run(
            ["ffmpeg", "-hide_banner", "-version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        m = re.search(r"ffmpeg version n?(\d+)", out.stdout or "")
        if m:
            return int(m.group(1))
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return 0


def _rtsp_timeout_args(microseconds: int = 5_000_000) -> list[str]:
    """RTSP socket I/O timeout flag, version-aware.

    ``-stimeout`` was removed in ffmpeg 5.0 and replaced by ``-timeout``. Using
    the wrong flag makes ffmpeg abort with "Unrecognized option", which surfaces
    as a bogus "RTSP rejected" error even when the stream and credentials are
    valid. Default to the modern ``-timeout`` when the version is unknown.
    """
    major = _ffmpeg_major_version()
    flag = "-stimeout" if 0 < major < 5 else "-timeout"
    return [flag, str(microseconds)]


def get_rtsp_frame(rtsp_url: str, timeout: float = DEFAULT_TIMEOUT) -> Optional[bytes]:
    """
    Capture one JPEG frame from an RTSP stream. Returns None on failure.
    Requires ffmpeg on PATH.
    """
    if not _rtsp_url_ok(rtsp_url):
        return None
    path = None
    try:
        fd, path = __import__("tempfile").mkstemp(suffix=".jpg")
        os.close(fd)
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-loglevel", "error",
                "-rtsp_transport", "tcp",
                *_rtsp_timeout_args(),
                "-i", rtsp_url.strip(),
                "-frames:v", "1",
                "-q:v", "2",
                "-f", "image2",
                path,
            ],
            timeout=timeout,
            capture_output=True,
            check=True,
        )
        if os.path.isfile(path):
            with open(path, "rb") as f:
                return f.read()
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError, OSError):
        pass
    finally:
        if path and os.path.exists(path):
            try:
                os.unlink(path)
            except OSError:
                pass
    return None


async def aiter_rtsp_mjpeg(rtsp_url: str) -> AsyncIterator[bytes]:
    """Stream MJPEG multipart bytes from an RTSP URL via ffmpeg (for browser proxy)."""
    if not _rtsp_url_ok(rtsp_url):
        return
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-nostdin",
        "-loglevel",
        "error",
        "-rtsp_transport",
        "tcp",
        *_rtsp_timeout_args(),
        "-i",
        rtsp_url.strip(),
        "-an",
        "-c:v",
        "mjpeg",
        "-f",
        "mpjpeg",
        "-q:v",
        "6",
        "pipe:1",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        assert proc.stdout is not None
        while True:
            try:
                chunk = await asyncio.wait_for(proc.stdout.read(16384), timeout=STREAM_READ_TIMEOUT)
            except asyncio.TimeoutError:
                break
            if not chunk:
                break
            yield chunk
    finally:
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()


def rtsp_has_audio(rtsp_url: str, timeout: float = 6.0) -> bool:
    """Return True if ffprobe finds an audio stream on the RTSP URL."""
    if not _rtsp_url_ok(rtsp_url):
        return False
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-rtsp_transport",
                "tcp",
                "-v",
                "error",
                "-select_streams",
                "a",
                "-show_entries",
                "stream=index",
                "-of",
                "csv=p=0",
                rtsp_url.strip(),
            ],
            capture_output=True,
            timeout=timeout,
            text=True,
        )
        return result.returncode == 0 and bool((result.stdout or "").strip())
    except (subprocess.TimeoutExpired, OSError):
        return False


def _ffmpeg_webm_cmd(rtsp_url: str, *, include_audio: bool) -> list[str]:
    cmd = [
        "ffmpeg",
        "-nostdin",
        "-loglevel",
        "error",
        "-rtsp_transport",
        "tcp",
        *_rtsp_timeout_args(),
        "-fflags",
        "nobuffer",
        "-flags",
        "low_delay",
        "-i",
        rtsp_url.strip(),
        "-map",
        "0:v:0",
    ]
    if include_audio:
        cmd.extend(["-map", "0:a:0?"])
    cmd.extend(
        [
            "-c:v",
            "libvpx",
            "-deadline",
            "realtime",
            "-cpu-used",
            "5",
            "-b:v",
            "1M",
        ]
    )
    if include_audio:
        cmd.extend(["-c:a", "libopus", "-b:a", "64k", "-application", "lowdelay"])
    else:
        cmd.append("-an")
    cmd.extend(
        [
            "-f",
            "webm",
            "-cluster_size_limit",
            "512",
            "-cluster_time_limit",
            "100",
            "pipe:1",
        ]
    )
    return cmd


async def aiter_rtsp_webm(rtsp_url: str, *, include_audio: bool = True) -> AsyncIterator[bytes]:
    """Stream WebM (VP8 + Opus when available) from RTSP for browser <video> playback."""
    if not _rtsp_url_ok(rtsp_url):
        return
    proc = await asyncio.create_subprocess_exec(
        *_ffmpeg_webm_cmd(rtsp_url, include_audio=include_audio),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        assert proc.stdout is not None
        while True:
            try:
                chunk = await asyncio.wait_for(proc.stdout.read(16384), timeout=STREAM_READ_TIMEOUT)
            except asyncio.TimeoutError:
                break
            if not chunk:
                break
            yield chunk
    finally:
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
