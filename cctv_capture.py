"""Capture a single frame from an RTSP stream (requires ffmpeg). Used by CCTV integration."""
import os
import subprocess
from typing import Optional

DEFAULT_TIMEOUT = 15.0


def get_rtsp_frame(rtsp_url: str, timeout: float = DEFAULT_TIMEOUT) -> Optional[bytes]:
    """
    Capture one JPEG frame from an RTSP stream. Returns None on failure.
    Requires ffmpeg on PATH.
    """
    if not (rtsp_url or "").strip().lower().startswith("rtsp://"):
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
                "-i", rtsp_url.strip(),
                "-frames:v", "1",
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
