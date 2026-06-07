# Load .env BEFORE any module that reads environment variables.
from env_bootstrap import ensure_env_loaded
ensure_env_loaded()

import warnings
warnings.filterwarnings("ignore", message=".*resource_tracker.*leaked semaphore.*", category=UserWarning, module="multiprocessing.resource_tracker")
warnings.filterwarnings("ignore", category=FutureWarning, module=r"transformers\.utils\.generic")
warnings.filterwarnings("ignore", category=FutureWarning, module=r"huggingface_hub\.file_download")
import logging
logging.getLogger("uvicorn.error").addFilter(
    type("_ShutdownFilter", (), {"filter": staticmethod(lambda r: all(x not in r.getMessage() for x in ("CancelledError", "Exception in ASGI application")))})()
)

import os
import socket
import sys
import uvicorn

import settings
settings.enforce_runtime_requirements(settings.CFG)

from core.http.app import get_hyve_app

_hyve = get_hyve_app()
app = _hyve.app
templates = _hyve.templates
limiter = _hyve.limiter
_APP_START_TS = _hyve.app_start_ts
_main_loop = None  # legacy alias; use core.http.runtime.get_main_loop()


def _port_bind_error(host: str, port: int) -> str | None:
    """Return a bind error string when *port* is not available."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host or "0.0.0.0", int(port)))
        return None
    except OSError as exc:
        return str(exc) or "address already in use"
    finally:
        sock.close()


def extract_json_payload(text):
    from core.chat_helpers import extract_json_payload_safe
    from core.log_stream import log_line
    return extract_json_payload_safe(text, log_line)


if __name__ == "__main__":
    disabled_marker = os.path.join(os.path.dirname(__file__), ".server_disabled")
    if os.path.exists(disabled_marker):
        print("⛔ Server start blocked: .server_disabled marker found")
        print("Remove .server_disabled to allow start again.")
        sys.exit(1)

    port = int(settings.CFG.get('port', 8082))
    bind_err = _port_bind_error("0.0.0.0", port)
    if bind_err:
        print(f"\n⛔ Port {port} is already in use — Hyve cannot start.")
        print(f"   ({bind_err})")
        print(f"\n   Another Hyve instance (or another app) is listening on :{port}.")
        print(f"   Check:  lsof -i :{port}")
        print(f"   Stop it: kill <PID>   — or change config.json → \"port\"")
        sys.exit(1)

    try:
        uvicorn.run(app, host="0.0.0.0", port=port, log_config=None, h11_max_incomplete_event_size=10 * 1024 * 1024)
    except OSError as exc:
        print(f"\n⛔ Failed to bind port {port}: {exc}")
        print(f"   Check:  lsof -i :{port}")
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n👋 Shutting down...")
