"""Audio-first ingest for URL sources (SPEC §7.1): best audio only + English captions (json3) + metadata.

The video stream is never downloaded here; FETCH_SECTIONS (M4) fetches only the chosen moments.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import time
from typing import Any, Dict, List, Optional

log = logging.getLogger("media.download")

AUDIO_BASENAME = "audio.raw"
SUB_PREFERENCE = ["en", "en-US", "en-GB", "en-orig"]
# Exact English codes, not the regex "en.*": that also matches YouTube's auto-translated
# tracks ("en-ar", "en-de", …), which multiplies caption requests and triggers HTTP 429.
SUB_LANGS = list(SUB_PREFERENCE)


class _Logger:
    """Route yt-dlp output to our stderr logger (stdout belongs to the protocol)."""

    def debug(self, msg: str) -> None:
        if not msg.startswith("[debug] "):
            log.info(msg)

    def info(self, msg: str) -> None:
        log.info(msg)

    def warning(self, msg: str) -> None:
        log.warning(msg)

    def error(self, msg: str) -> None:
        log.error(msg)


def build_ydl_opts(out_dir: str, node_path: Optional[str]) -> Dict[str, Any]:
    """Audio-only download. Captions are fetched separately (fetch_captions) so a caption
    failure such as HTTP 429 can never abort the audio: yt-dlp drops the whole video when a
    subtitle download fails, even with ignoreerrors."""
    opts: Dict[str, Any] = {
        "format": "ba",  # best audio-only format: no video bytes
        "outtmpl": {"default": os.path.join(out_dir, AUDIO_BASENAME + ".%(ext)s")},
        "writesubtitles": False,
        "writeautomaticsub": False,
        "noplaylist": True,
        "quiet": True,
        "noprogress": True,
        "no_warnings": False,
        "logger": _Logger(),
        "retries": 3,
        "fragment_retries": 3,
        "overwrites": True,
    }
    # YouTube needs a JS runtime (yt-dlp EJS). Node 22+ is supported; deno is the yt-dlp default.
    if node_path:
        opts["js_runtimes"] = {"node": {"path": node_path}}
    return opts


def pick_caption_track(subtitles: Dict[str, List[Dict[str, Any]]], automatic: Dict[str, List[Dict[str, Any]]]) -> Optional[Dict[str, Any]]:
    """Best English json3 track: manual before auto; within each, the SUB_PREFERENCE order.
    Only exact English codes (SUB_LANGS), never auto-translated tracks like 'en-ar'."""
    for kind, tracks in (("manual", subtitles or {}), ("auto", automatic or {})):
        for lang in SUB_PREFERENCE:
            fmt = next((f for f in tracks.get(lang) or [] if f.get("ext") == "json3" and f.get("url")), None)
            if fmt:
                return {"lang": lang, "kind": kind, "url": fmt["url"]}
    return None


def fetch_captions(ydl, track: Dict[str, Any], dest: str, waits=(3, 8)) -> bool:
    """Download one caption track with a short backoff on HTTP 429. Returns False on failure."""
    for attempt in range(len(waits) + 1):
        try:
            data = ydl.urlopen(track["url"]).read()
            json.loads(data)  # must be valid json3
            with open(dest, "wb") as f:
                f.write(data)
            return True
        except Exception as e:  # noqa: BLE001 - captions are optional
            status = getattr(getattr(e, "response", None), "status", None) or getattr(e, "status", None)
            log.warning("captions %s (%s) attempt %d failed: %s", track["lang"], track["kind"], attempt + 1, e)
            if attempt < len(waits) and (status == 429 or "429" in str(e)):
                time.sleep(waits[attempt])
                continue
            return False
    return False


def download_audio(args: Dict[str, Any]) -> Dict[str, Any]:
    import yt_dlp  # lazy

    url = args["url"]
    out_dir = args["outDir"]
    os.makedirs(out_dir, exist_ok=True)
    node_path = args.get("nodePath") or shutil.which("node")

    with yt_dlp.YoutubeDL(build_ydl_opts(out_dir, node_path)) as ydl:
        info = ydl.extract_info(url, download=False)
        if info is None:
            raise RuntimeError(f"yt-dlp could not extract {url}")
        info = ydl.process_ie_result(info, download=True)
        info = ydl.sanitize_info(info)

        downloads = info.get("requested_downloads") or []
        audio_path = downloads[0].get("filepath") if downloads else None
        if not audio_path or not os.path.exists(audio_path):
            raise RuntimeError("yt-dlp finished without an audio file")

        captions_path = None
        track = pick_caption_track(info.get("subtitles") or {}, info.get("automatic_captions") or {})
        if track:
            dest = os.path.join(out_dir, "captions.json3")
            if fetch_captions(ydl, track, dest):
                captions_path = dest
            else:
                track = None  # the transcription chain falls through to Deepgram / Whisper
        sub = track

    meta = {
        "id": info.get("id"),
        "title": info.get("title"),
        "durationSec": info.get("duration"),
        "width": info.get("width"),
        "height": info.get("height"),
        "uploader": info.get("uploader"),
        "webpageUrl": info.get("webpage_url"),
    }
    # Best video dimensions come from the formats list since the downloaded format is audio-only.
    vids = [f for f in info.get("formats") or [] if f.get("vcodec") not in (None, "none") and f.get("height")]
    if vids:
        top = max(vids, key=lambda f: (f.get("height") or 0, f.get("width") or 0))
        meta["width"], meta["height"] = top.get("width"), top.get("height")

    fmt = downloads[0]
    result = {
        **meta,
        "audioPath": audio_path,
        "audioBytes": os.path.getsize(audio_path),
        # With extract_info + process_ie_result the format fields may sit on the top-level info.
        "audioFormat": {k: fmt.get(f) or info.get(f) for k, f in (("formatId", "format_id"), ("ext", "ext"), ("acodec", "acodec"), ("vcodec", "vcodec"))},
        "captionsPath": captions_path,
        "captionsKind": sub["kind"] if sub else None,
        "captionsLang": sub["lang"] if sub else None,
    }
    with open(os.path.join(out_dir, "info.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
    return result
