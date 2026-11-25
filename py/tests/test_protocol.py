import json
import os
import subprocess
import sys
import time

from media.download import build_ydl_opts, pick_subtitle
from media.protocol import encode, handle_line
from media.transcribe_local import WhisperManager

PY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

handlers = {"echo": lambda a: a, "boom": lambda a: 1 / 0}


def test_handle_line_ok_and_errors():
    assert handle_line('{"id":"1","cmd":"echo","args":{"x":1}}', handlers) == {"id": "1", "ok": True, "result": {"x": 1}}
    r = handle_line('{"id":"2","cmd":"boom"}', handlers)
    assert r["ok"] is False and r["type"] == "ZeroDivisionError" and r["id"] == "2"
    r = handle_line('{"id":"3","cmd":"nope"}', handlers)
    assert r["ok"] is False and "unknown command" in r["error"]


def test_handle_line_protocol_errors():
    assert handle_line("   ", handlers) is None
    assert handle_line("{bad", handlers)["type"] == "ProtocolError"
    assert handle_line("[1]", handlers)["type"] == "ProtocolError"
    r = handle_line('{"id":"4","cmd":"echo","args":[1]}', handlers)
    assert r["type"] == "ProtocolError" and r["id"] == "4"


def test_encode_is_single_ascii_line():
    s = encode({"id": "x", "ok": True, "result": {"t": "line1\nline2 café"}})
    assert "\n" not in s and s.isascii()
    assert json.loads(s)["result"]["t"] == "line1\nline2 café"


def test_pick_subtitle_prefers_manual_then_plain_en(tmp_path):
    files = {}
    for lang in ["en-orig", "en", "en-GB"]:
        p = tmp_path / f"a.{lang}.json3"
        p.write_text("{}")
        files[lang] = {"filepath": str(p)}
    assert pick_subtitle(files, manual_langs=[])["lang"] == "en"
    got = pick_subtitle(files, manual_langs=["en-GB"])
    assert got["lang"] == "en-GB" and got["kind"] == "manual"
    assert pick_subtitle({"en": {"filepath": str(tmp_path / "missing")}}, []) is None
    assert pick_subtitle({}, []) is None


def test_ydl_opts_audio_only_with_json3_subs():
    o = build_ydl_opts("C:/x y", "C:/node.exe")
    assert o["format"] == "ba"
    assert o["subtitlesformat"] == "json3"
    assert o["subtitleslangs"] == ["en", "en-US", "en-GB", "en-orig"]  # no regex: avoids translated tracks + 429
    assert o["ignoreerrors"] == "only_download"  # a failed caption must not abort the audio
    assert o["writesubtitles"] and o["writeautomaticsub"]
    assert o["js_runtimes"] == {"node": {"path": "C:/node.exe"}}
    assert "js_runtimes" not in build_ydl_opts("x", None)


class FakeModel:
    pass


def test_whisper_lazy_load_and_idle_unload():
    loads = []
    m = WhisperManager(idle_unload_sec=10, loader=lambda name, t: loads.append(name) or FakeModel())
    assert not m.loaded
    m._get("small.en", 4)
    m._done()
    m._get("small.en", 4)  # cached
    assert loads == ["small.en"]
    assert m.unload_if_idle(now=time.time() + 5) is False  # busy
    m._done()
    assert m.unload_if_idle(now=time.time() + 5) is False  # not idle long enough
    assert m.unload_if_idle(now=time.time() + 11) is True
    assert not m.loaded


def test_serve_roundtrip_keeps_stdout_clean():
    p = subprocess.Popen(
        [sys.executable, "-m", "media", "serve"],
        cwd=PY_DIR,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    try:
        ready = json.loads(p.stdout.readline())
        assert ready["ok"] and ready["result"]["ready"]
        p.stdin.write('{"id":"a","cmd":"ping"}\nnot json\n{"id":"b","cmd":"nope"}\n')
        p.stdin.flush()
        lines = [json.loads(p.stdout.readline()) for _ in range(3)]
        by_id = {l["id"]: l for l in lines}
        assert by_id["a"]["ok"] and by_id["a"]["result"]["pong"]
        assert by_id["b"]["ok"] is False
        assert by_id[None]["type"] == "ProtocolError"
    finally:
        p.stdin.close()
        assert p.wait(timeout=20) == 0
        p.stdout.close()
        p.stderr.close()


def test_serve_loads_native_libraries_from_request_threads():
    """Regression (Windows): DLL loads in a request thread deadlocked against the main thread's
    blocking stdin read. check_deps imports numpy/ctranslate2/faster_whisper from a request thread."""
    p = subprocess.Popen(
        [sys.executable, "-m", "media", "serve"],
        cwd=PY_DIR,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
    )
    try:
        assert json.loads(p.stdout.readline())["result"]["ready"]
        p.stdin.write('{"id":"d","cmd":"check_deps"}\n')
        p.stdin.flush()  # stdin stays open: the main thread is blocked reading, as in production
        result = {}

        def read():
            result["line"] = p.stdout.readline()

        import threading

        t = threading.Thread(target=read, daemon=True)
        t.start()
        t.join(timeout=60)
        assert "line" in result, "check_deps hung: native imports deadlocked with the stdin reader"
        deps = json.loads(result["line"])["result"]
        assert not any(str(v).startswith("ERROR") for v in deps.values()), deps
    finally:
        p.kill()
        p.wait(timeout=10)
        p.stdout.close()
        p.stdin.close()


def test_one_shot_ping():
    r = subprocess.run([sys.executable, "-m", "media", "ping"], cwd=PY_DIR, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0
    out = [l for l in r.stdout.splitlines() if l.strip()]
    assert len(out) == 1 and json.loads(out[0])["result"]["pong"] is True
