"""JSON-lines protocol (SPEC §3, §12): one request per line on stdin, one response per line on stdout.

Request:  {"id": "abc", "cmd": "ping", "args": {...}}
Response: {"id": "abc", "ok": true, "result": {...}}  or  {"id": "abc", "ok": false, "error": "...", "type": "ValueError"}
Logs go to stderr only.
"""
from __future__ import annotations

import json
import logging
import traceback
from typing import Any, Callable, Dict

log = logging.getLogger("media")

Handler = Callable[[Dict[str, Any]], Any]


class ProtocolError(ValueError):
    pass


def parse_request(line: str) -> Dict[str, Any]:
    try:
        req = json.loads(line)
    except json.JSONDecodeError as e:
        raise ProtocolError(f"invalid JSON: {e.msg}") from None
    if not isinstance(req, dict):
        raise ProtocolError("request must be a JSON object")
    if not isinstance(req.get("id"), str) or not req["id"]:
        raise ProtocolError("request needs a non-empty string 'id'")
    if not isinstance(req.get("cmd"), str):
        raise ProtocolError("request needs a string 'cmd'")
    args = req.get("args", {})
    if args is None:
        args = {}
    if not isinstance(args, dict):
        raise ProtocolError("'args' must be an object")
    req["args"] = args
    return req


def handle(req: Dict[str, Any], handlers: Dict[str, Handler]) -> Dict[str, Any]:
    """Run one parsed request; never raises."""
    rid = req["id"]
    fn = handlers.get(req["cmd"])
    if fn is None:
        return {"id": rid, "ok": False, "error": f"unknown command: {req['cmd']}", "type": "UnknownCommand"}
    try:
        return {"id": rid, "ok": True, "result": fn(req["args"])}
    except Exception as e:  # noqa: BLE001 - every failure must become a response line
        log.error("command %s failed:\n%s", req["cmd"], traceback.format_exc())
        return {"id": rid, "ok": False, "error": str(e) or type(e).__name__, "type": type(e).__name__}


def handle_line(line: str, handlers: Dict[str, Handler]) -> Dict[str, Any] | None:
    line = line.strip()
    if not line:
        return None
    try:
        req = parse_request(line)
    except ProtocolError as e:
        rid = None
        try:
            obj = json.loads(line)
            if isinstance(obj, dict) and isinstance(obj.get("id"), str):
                rid = obj["id"]
        except Exception:  # noqa: BLE001
            pass
        return {"id": rid, "ok": False, "error": str(e), "type": "ProtocolError"}
    return handle(req, handlers)


def encode(resp: Dict[str, Any]) -> str:
    """One line, ASCII-safe, no embedded newlines."""
    return json.dumps(resp, ensure_ascii=True, separators=(",", ":"))
