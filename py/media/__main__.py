"""Entry point.

  python -m media serve                       long-lived JSON-lines service (used by the worker)
  python -m media <cmd> --json '{"k": "v"}'   one-shot command, prints one JSON response line
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict

from . import __version__
from .analysis import analyze
from .download import download_audio
from .sections import align_section, download_full, download_section, locate_audio
from .protocol import encode, handle, handle_line
from .transcribe_local import WhisperManager

log = logging.getLogger("media")


def make_handlers(whisper: WhisperManager) -> Dict[str, Any]:
    return {
        "ping": lambda a: {"pong": True, "version": __version__, "pid": os.getpid(), "whisperLoaded": whisper.loaded},
        "download_audio": download_audio,
        "transcribe": whisper.transcribe,
        "check_deps": check_deps,
        "download_section": download_section,
        "download_full": download_full,
        "align_section": align_section,
        "analyze": analyze,
        "locate_audio": locate_audio,
    }


def _protocol_stdout():
    """Keep the real stdout for protocol lines and point fd 1 (and sys.stdout) at stderr,
    so stray prints from libraries or subprocesses can never corrupt the protocol."""
    proto_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return os.fdopen(proto_fd, "w", encoding="utf-8", newline="\n", buffering=1)


def _protocol_stdin():
    """Read requests from a private duplicate of the stdin pipe and point fd 0 (and the Win32
    STD_INPUT_HANDLE, which os.dup2 updates for fds 0-2) at NUL.

    Why: Windows serializes synchronous I/O per pipe. While the main thread blocks reading
    requests, any thread that loads a DLL (numpy, ctranslate2, mediapipe…) runs C-runtime init
    that queries the standard handles, and that call waits behind the pending read: a deadlock,
    since the read only returns when the worker sends its next request.
    """
    proto_fd = os.dup(0)
    nul = os.open(os.devnull, os.O_RDONLY)
    os.dup2(nul, 0)
    os.close(nul)
    sys.stdin = open(os.devnull, "r", encoding="utf-8")
    return os.fdopen(proto_fd, "r", encoding="utf-8", newline=None)


def check_deps(_args: Dict[str, Any]) -> Dict[str, Any]:
    """Import the native-heavy dependencies (from a request thread, like real work) and report versions."""
    import importlib

    out: Dict[str, Any] = {}
    for mod in ["numpy", "ctranslate2", "faster_whisper", "yt_dlp", "av", "mediapipe", "scenedetect", "cv2"]:
        try:
            m = importlib.import_module(mod)
            out[mod] = getattr(m, "__version__", None) or getattr(getattr(m, "version", None), "__version__", "ok")
        except Exception as e:  # noqa: BLE001
            out[mod] = f"ERROR: {e}"
    return out


def serve(max_workers: int = 3) -> int:
    out = _protocol_stdout()
    write_lock = threading.Lock()
    handlers = make_handlers(WhisperManager())
    pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="req")

    def respond(resp):
        if resp is None:
            return
        with write_lock:
            out.write(encode(resp) + "\n")
            out.flush()

    requests = _protocol_stdin()
    log.info("media service %s ready (pid %d)", __version__, os.getpid())
    respond({"id": None, "ok": True, "result": {"ready": True, "version": __version__}})
    for line in requests:
        pool.submit(lambda l=line: respond(handle_line(l, handlers)))
    pool.shutdown(wait=True)
    log.info("stdin closed, exiting")
    return 0


def one_shot(cmd: str, raw_args: str) -> int:
    out = _protocol_stdout()
    handlers = make_handlers(WhisperManager())
    try:
        args = json.loads(raw_args)
    except json.JSONDecodeError as e:
        out.write(encode({"id": "cli", "ok": False, "error": f"--json: {e.msg}", "type": "ProtocolError"}) + "\n")
        return 2
    resp = handle({"id": "cli", "cmd": cmd, "args": args}, handlers)
    out.write(encode(resp) + "\n")
    out.flush()
    return 0 if resp["ok"] else 1


def main(argv=None) -> int:
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    p = argparse.ArgumentParser(prog="python -m media")
    p.add_argument("cmd", help="'serve' or a command name (ping, download_audio, transcribe)")
    p.add_argument("--json", default="{}", help="command args as a JSON object (one-shot mode)")
    a = p.parse_args(argv)
    return serve() if a.cmd == "serve" else one_shot(a.cmd, a.json)


if __name__ == "__main__":
    sys.exit(main())
