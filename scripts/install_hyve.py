#!/usr/bin/env python3
"""Install Hyve dependencies and start the server.

First-time configuration (admin account, language, timezone) is done in the
browser at http://localhost:<port>/ after the server starts.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
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


def ensure_venv() -> None:
    if VENV_PYTHON.exists():
        print_step("Reusing existing virtual environment")
        return
    print_step("Creating virtual environment")
    run([sys.executable, "-m", "venv", str(VENV_DIR)])


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
        return

    npm = shutil.which("npm")
    if not npm:
        print_step("npm not found; skipping Node.js dependencies")
        return

    print_step("Installing Node.js dependencies")
    npm_cmd = [npm, "ci"] if (ROOT / "package-lock.json").exists() else [npm, "install"]
    run(npm_cmd)

    try:
        print_step("Building CSS assets")
        run([npm, "run", "css:build"])
    except subprocess.CalledProcessError:
        print("Warning: CSS build failed. Existing committed frontend assets will still be used if available.")


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
    run([str(VENV_PYTHON), "-c", "import settings; settings.load_config()"])
    data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    if int(data.get("port") or DEFAULT_PORT) != port:
        data["port"] = port
        CONFIG_FILE.write_text(json.dumps(data, indent=4) + "\n", encoding="utf-8")


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


def start_server(port: int, open_browser_when_ready: bool) -> None:
    url = f"http://127.0.0.1:{port}/"
    if wait_for_server(url, timeout_seconds=2):
        print_step(f"Server already running at {url}")
        if open_browser_when_ready:
            webbrowser.open(url)
        else:
            print(f"Open this URL in your browser: {url}")
        return

    if PID_FILE.exists():
        try:
            old_pid = int(PID_FILE.read_text(encoding="utf-8").strip())
        except ValueError:
            old_pid = 0
        if old_pid and _pid_is_running(old_pid):
            print_step(f"Server already running with PID {old_pid}")
            if open_browser_when_ready:
                webbrowser.open(url)
            else:
                print(f"Open this URL in your browser: {url}")
            return
        PID_FILE.unlink(missing_ok=True)

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
        print(f"Hyve is ready at {url}")
        print("Complete first-time setup in your browser (admin account, language, timezone).")
        if open_browser_when_ready:
            webbrowser.open(url)
        else:
            print(f"Open this URL in your browser: {url}")
        return

    print(f"Server did not become ready in time. Check {LOG_FILE} for details.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Install Hyve dependencies and start the server. Configure the app in the browser on first visit.",
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"HTTP port (default {DEFAULT_PORT})")
    parser.add_argument("--skip-npm", action="store_true")
    parser.add_argument("--no-start", action="store_true", help="Install only; do not start uvicorn")
    parser.add_argument("--no-open-browser", action="store_true")
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

    ensure_venv()
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
        if not args.bootstrap_admin:
            print(f"Then open http://127.0.0.1:{port}/ to finish setup in the browser.")
        return 0

    start_server(port=port, open_browser_when_ready=not args.no_open_browser)
    print_step("Installation complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
