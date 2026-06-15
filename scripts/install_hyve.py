#!/usr/bin/env python3
"""Install Hyve dependencies and start the server.

First-time configuration (admin account, language, timezone) is done in the
browser setup wizard after the server starts.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VENV_DIR = ROOT / ".venv"
if not VENV_DIR.exists():
    VENV_DIR = ROOT / "venv"
VENV_PYTHON = VENV_DIR / "bin" / "python"
ENV_FILE = ROOT / ".env"
ENV_EXAMPLE_FILE = ROOT / ".env.example"
CONFIG_FILE = ROOT / "config.json"
PID_FILE = ROOT / ".hyve_server.pid"
LOG_DIR = ROOT / "logs"
LOG_FILE = LOG_DIR / "install-server.log"
REQUIREMENTS_FILE = ROOT / "requirements.txt"
DEFAULT_PORT = 8082


def print_step(message: str) -> None:
    print(f"\n==> {message}")


def run(cmd: list[str], *, cwd: Path = ROOT, check: bool = True) -> subprocess.CompletedProcess:
    print("$", " ".join(cmd))
    return subprocess.run(cmd, cwd=cwd, check=check)


def detect_lan_ip() -> str | None:
    """Best-effort LAN address (for Proxmox / NAS install hints)."""
    from core.network_utils import detect_lan_ip as _detect_lan_ip

    return _detect_lan_ip()


def build_access_urls(port: int, *, lan_ip: str | None = None) -> list[str]:
    urls = [f"http://127.0.0.1:{port}/"]
    ip = (lan_ip if lan_ip is not None else detect_lan_ip()) or ""
    if ip and ip not in {"127.0.0.1", "localhost"}:
        urls.append(f"http://{ip}:{port}/")
    return urls


def format_setup_banner(*, complete: bool, bootstrap: bool) -> str:
    if bootstrap:
        return "Headless admin created — open Hyve and sign in (browser wizard skipped)."
    if complete:
        return "Setup already complete — sign in with your admin account."
    return (
        "Setup wizard required — create your admin account, language, and timezone in the browser."
    )


def fetch_setup_status(port: int, *, timeout: float = 5.0) -> dict | None:
    url = f"http://127.0.0.1:{port}/api/setup/status"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
            return payload if isinstance(payload, dict) else None
    except Exception:
        return None


def venv_has_pip() -> bool:
    if not VENV_PYTHON.is_file():
        return False
    proc = subprocess.run(
        [str(VENV_PYTHON), "-m", "pip", "--version"],
        capture_output=True,
        text=True,
    )
    return proc.returncode == 0


def recreate_venv() -> None:
    if VENV_DIR.exists():
        print_step(f"Removing virtual environment ({VENV_DIR.name})")
        shutil.rmtree(VENV_DIR)
    print_step("Creating virtual environment")
    run([sys.executable, "-m", "venv", str(VENV_DIR)])
    if not venv_has_pip():
        print_step("Bootstrapping pip (python3-venv / ensurepip)")
        run([str(VENV_PYTHON), "-m", "ensurepip", "--upgrade"])


def ensure_venv(*, force_recreate: bool = False) -> None:
    if force_recreate:
        recreate_venv()
        return
    if VENV_PYTHON.is_file() and venv_has_pip():
        print_step("Reusing existing virtual environment")
        return
    if VENV_PYTHON.is_file():
        print_step("Virtual environment is incomplete (pip missing) — recreating")
    recreate_venv()


def install_python_dependencies() -> None:
    print_step("Installing Python dependencies")
    if not REQUIREMENTS_FILE.exists():
        raise SystemExit(
            f"Missing required file: {REQUIREMENTS_FILE}. "
            "The repository clone is incomplete or the file was deleted."
        )
    run([str(VENV_PYTHON), "-m", "pip", "install", "--upgrade", "pip"])
    run([str(VENV_PYTHON), "-m", "pip", "install", "-r", str(REQUIREMENTS_FILE)])


def install_node_dependencies(skip_npm: bool) -> None:
    if skip_npm:
        print_step("Skipping Node.js dependencies by request")
        print("  Note: run npm ci && npm run js:build (outputs static/dist/app.js)")
        return

    npm = shutil.which("npm")
    if not npm:
        print_step("npm not found; skipping Node.js build")
        print("  Warning: without npm run js:build, use a release tag with prebuilt static/dist assets.")
        return

    print_step("Installing Node.js dependencies")
    npm_cmd = [npm, "ci"] if (ROOT / "package-lock.json").exists() else [npm, "install"]
    run(npm_cmd)

    try:
        print_step("Building CSS assets")
        run([npm, "run", "css:build"])
    except subprocess.CalledProcessError:
        print("Warning: CSS build failed. Existing committed frontend assets will still be used if available.")

    try:
        print_step("Building JavaScript bundles (required for setup wizard)")
        run([npm, "run", "js:build"])
    except subprocess.CalledProcessError as exc:
        raise SystemExit(
            "JavaScript build failed. Install Node.js 18+ and retry, or use --skip-npm with a release checkout."
        ) from exc


def _set_env_value(lines: list[str], key: str, value: str) -> list[str]:
    prefix = f"{key}="
    updated = False
    out: list[str] = []
    for line in lines:
        if line.startswith(prefix):
            out.append(f"{prefix}{value}")
            updated = True
        else:
            out.append(line)
    if not updated:
        if out and out[-1].strip():
            out.append("")
        out.append(f"{prefix}{value}")
    return out


def ensure_env_file() -> None:
    print_step("Preparing .env")
    if ENV_FILE.exists():
        lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    elif ENV_EXAMPLE_FILE.exists():
        lines = ENV_EXAMPLE_FILE.read_text(encoding="utf-8").splitlines()
    else:
        lines = []

    secret_value = None
    for line in lines:
        if line.startswith("HYVE_SECRET_KEY="):
            current = line.split("=", 1)[1].strip()
            if current and current != "replace_with_a_random_secret":
                secret_value = current
            break

    if not secret_value:
        secret_value = secrets.token_urlsafe(64)
    lines = _set_env_value(lines, "HYVE_SECRET_KEY", secret_value)
    ENV_FILE.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def ensure_config_file(port: int) -> None:
    print_step("Preparing config.json")
    run([str(VENV_PYTHON), "-c", "import core.settings as settings; settings.load_config()"])
    data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    if int(data.get("port") or DEFAULT_PORT) != port:
        data["port"] = port
        CONFIG_FILE.write_text(json.dumps(data, indent=4) + "\n", encoding="utf-8")


def reset_first_run_state() -> None:
    """Drop local DB + setup flag + user-created files so the wizard runs again."""
    print_step("Resetting first-run state (fresh setup wizard)")
    for path in (ROOT / "hyve.db", ROOT / "users.db"):
        if path.exists():
            path.unlink()
            print(f"  removed {path.name}")
    if CONFIG_FILE.exists():
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        data["setup_complete"] = False
        CONFIG_FILE.write_text(json.dumps(data, indent=4) + "\n", encoding="utf-8")
        print("  set config.json setup_complete=false")

    cleared = _reset_user_data_dirs()
    for line in cleared:
        print(f"  removed {line}")
    if not cleared:
        print("  user data dirs already empty")


def _reset_user_data_dirs() -> list[str]:
    """Clear dashboards/skills/etc. Uses project venv when available."""
    if VENV_PYTHON.is_file():
        proc = subprocess.run(
            [
                str(VENV_PYTHON),
                "-c",
                (
                    "import json, sys; "
                    f"sys.path.insert(0, {str(ROOT)!r}); "
                    "from core.user_data import reset_user_data; "
                    "print(json.dumps(reset_user_data()))"
                ),
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        if proc.returncode == 0:
            raw = (proc.stdout or "").strip()
            if raw:
                return json.loads(raw)
            return []
        err = (proc.stderr or proc.stdout or "").strip()
        print(f"  warning: could not clear user data dirs ({err or 'venv import failed'})")
        print("  run: python3 scripts/install_hyve.py --no-start  (reinstalls deps, then retry --fresh)")
        return []

    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    try:
        from core.user_data import reset_user_data

        return reset_user_data()
    except ModuleNotFoundError:
        print("  skipped user data dirs (no venv yet — run install_hyve.py to create one)")
        return []


def bootstrap_admin(username: str, full_name: str, email: str, password: str) -> None:
    print_step("Bootstrapping admin account (headless)")
    run([
        str(VENV_PYTHON),
        "scripts/bootstrap_admin.py",
        "--username",
        username,
        "--password",
        password,
        "--full-name",
        full_name,
        "--email",
        email,
        "--mark-setup-complete",
    ])


def _pid_is_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def stop_existing_server() -> None:
    if not PID_FILE.exists():
        return
    try:
        pid = int(PID_FILE.read_text(encoding="utf-8").strip())
    except ValueError:
        PID_FILE.unlink(missing_ok=True)
        return
    if pid and _pid_is_running(pid):
        print_step(f"Stopping existing Hyve server (PID {pid})")
        try:
            os.kill(pid, 15)
            for _ in range(20):
                if not _pid_is_running(pid):
                    break
                time.sleep(0.25)
        except OSError:
            pass
    PID_FILE.unlink(missing_ok=True)


def wait_for_server(url: str, timeout_seconds: int = 90) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if 200 <= response.status < 500:
                    return True
        except urllib.error.HTTPError as exc:
            if exc.code < 500:
                return True
        except Exception:
            pass
        time.sleep(1)
    return False


def print_access_instructions(
    port: int,
    *,
    bootstrap: bool,
    setup_status: dict | None,
    open_browser: bool,
) -> None:
    complete = bool((setup_status or {}).get("complete"))
    urls = build_access_urls(port)
    print("\n" + "=" * 60)
    print(format_setup_banner(complete=complete, bootstrap=bootstrap))
    print("Open Hyve in your browser:")
    for url in urls:
        marker = " (use this from other devices on your LAN)" if "127.0.0.1" not in url else " (on this machine)"
        print(f"  → {url}{marker}")
    if setup_status is None:
        print("  Warning: could not verify /api/setup/status — check logs if the wizard does not appear.")
    elif not complete and not bootstrap:
        print("  First visit shows the setup wizard (admin + language + timezone).")
    print("=" * 60 + "\n")
    if open_browser:
        webbrowser.open(urls[0])
    elif len(urls) > 1:
        print("From a phone or laptop on the same network, use the LAN URL above.\n")


def start_server(port: int, *, bootstrap: bool, open_browser_when_ready: bool) -> None:
    url = f"http://127.0.0.1:{port}/"
    if wait_for_server(url, timeout_seconds=2):
        print_step(f"Server already running at {url}")
        status = fetch_setup_status(port)
        print_access_instructions(
            port,
            bootstrap=bootstrap,
            setup_status=status,
            open_browser=open_browser_when_ready,
        )
        return

    stop_existing_server()

    print_step("Starting server")
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_handle = LOG_FILE.open("ab")
    process = subprocess.Popen(
        [str(VENV_PYTHON), "main.py"],
        cwd=ROOT,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    PID_FILE.write_text(str(process.pid), encoding="utf-8")

    if wait_for_server(url, timeout_seconds=90):
        status = fetch_setup_status(port)
        print(f"Hyve is ready (PID {process.pid}).")
        print_access_instructions(
            port,
            bootstrap=bootstrap,
            setup_status=status,
            open_browser=open_browser_when_ready,
        )
        return

    print(f"Server did not become ready in time. Check {LOG_FILE} for details.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Install Hyve dependencies and start the server. Configure the app in the browser on first visit.",
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"HTTP port (default {DEFAULT_PORT})")
    parser.add_argument("--skip-npm", action="store_true", help="Skip npm ci / css:build / js:build")
    parser.add_argument("--no-start", action="store_true", help="Install only; do not start uvicorn")
    parser.add_argument("--no-open-browser", action="store_true")
    parser.add_argument(
        "--recreate-venv",
        action="store_true",
        help="Delete and recreate .venv before installing dependencies",
    )
    parser.add_argument(
        "--fresh",
        action="store_true",
        help="Delete hyve.db/users.db, user dashboards/skills/automations, and reset setup_complete (re-run wizard)",
    )
    parser.add_argument(
        "--bootstrap-admin",
        nargs=2,
        metavar=("USERNAME", "PASSWORD"),
        help="Headless/Docker: create admin and skip browser onboarding",
    )
    parser.add_argument("--admin-full-name", default="", help="With --bootstrap-admin")
    parser.add_argument("--admin-email", default="", help="With --bootstrap-admin")
    return parser.parse_args()


def main() -> int:
    os.chdir(ROOT)
    args = parse_args()
    port = int(args.port or DEFAULT_PORT)
    bootstrap = bool(args.bootstrap_admin)

    if args.fresh:
        ensure_venv(force_recreate=args.recreate_venv)
        install_python_dependencies()
        reset_first_run_state()
    else:
        ensure_venv(force_recreate=args.recreate_venv)
        install_python_dependencies()
    install_node_dependencies(skip_npm=args.skip_npm)
    ensure_env_file()
    ensure_config_file(port)

    if args.bootstrap_admin:
        username, password = args.bootstrap_admin
        if len(password) < 8:
            raise SystemExit("Admin password must be at least 8 characters.")
        bootstrap_admin(
            username.strip(),
            (args.admin_full_name or username).strip(),
            (args.admin_email or "").strip(),
            password,
        )

    if args.no_start:
        print_step("Installation complete")
        print(f"Start the app with: {VENV_PYTHON} main.py")
        urls = build_access_urls(port)
        if not bootstrap:
            print(format_setup_banner(complete=False, bootstrap=False))
            print(f"Then open: {urls[-1]}")
        return 0

    start_server(
        port=port,
        bootstrap=bootstrap,
        open_browser_when_ready=not args.no_open_browser,
    )
    print_step("Installation complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
