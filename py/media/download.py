"""Audio-first ingest for URL sources (SPEC §7.1): best audio only + English captions (json3) + metadata.

The video stream is never downloaded here; FETCH_SECTIONS (M4) fetches only the chosen moments.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
from typing import Any, Dict, List, Optional

log = logging.getLogger("media.download")

AUDIO_BASENAME = "audio.raw"
SUB_PREFERENCE = ["en", "en-US", "en-GB", "en-orig"]
# Exact list, not the regex "en.*": that also matches YouTube's auto-translated tracks
# ("en-ar", "en-de", …), which multiplies caption requests and triggers HTTP 429.
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
    opts: Dict[str, Any] = {
        "format": "ba",  # best audio-only format: no video bytes
        "outtmpl": {"default": os.path.join(out_dir, AUDIO_BASENAME + ".%(ext)s")},
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": SUB_LANGS,
        "subtitlesformat": "json3",
        "noplaylist": True,
        "quiet": True,
        "noprogress": True,
        "no_warnings": False,
        "logger": _Logger(),
        "retries": 3,
        "fragment_retries": 3,
        "overwrites": True,
        # Captions are optional (the transcription chain falls through), so a failed caption
        # download (e.g. HTTP 429) must not abort the audio download. Audio is checked explicitly.
        "ignoreerrors": "only_download",
    }
    # YouTube needs a JS runtime (yt-dlp EJS). Node 22+ is supported; deno is the yt-dlp default.
    if node_path:
        opts["js_runtimes"] = {"node": {"path": node_path}}
    return opts


def pick_subtitle(requested: Dict[str, Dict[str, Any]], manual_langs: List[str]) -> Optional[Dict[str, Any]]:
    """Prefer manual captions over auto; within each, prefer plain 'en'."""
    def rank(lang: str) -> tuple:
        pref = SUB_PREFERENCE.index(lang) if lang in SUB_PREFERENCE else len(SUB_PREFERENCE)
        return (0 if lang in manual_langs else 1, pref, lang)

    candidates = [l for l, s in (requested or {}).items() if s.get("filepath") and os.path.exists(s["filepath"])]
    if not candidates:
        return None
    best = sorted(candidates, key=rank)[0]
    return {"lang": best, "path": requested[best]["filepath"], "kind": "manual" if best in manual_langs else "auto"}


def download_audio(args: Dict[str, Any]) -> Dict[str, Any]:
    import yt_dlp  # lazy

    url = args["url"]
    out_dir = args["outDir"]
    os.makedirs(out_dir, exist_ok=True)
    node_path = args.get("nodePath") or shutil.which("node")

    with yt_dlp.YoutubeDL(build_ydl_opts(out_dir, node_path)) as ydl:
        info = ydl.extract_info(url, download=True)
        if info is None:
            raise RuntimeError(f"yt-dlp could not extract {url}")
        info = ydl.sanitize_info(info)

    downloads = info.get("requested_downloads") or []
    audio_path = downloads[0].get("filepath") if downloads else None
    if not audio_path or not os.path.exists(audio_path):
        raise RuntimeError("yt-dlp finished without an audio file")

    sub = pick_subtitle(info.get("requested_subtitles") or {}, list((info.get("subtitles") or {}).keys()))
    captions_path = None
    if sub:
        captions_path = os.path.join(out_dir, "captions.json3")
        shutil.copyfile(sub["path"], captions_path)
    for s in (info.get("requested_subtitles") or {}).values():  # per-language copies are no longer needed
        fp = s.get("filepath")
        if fp and os.path.exists(fp) and os.path.abspath(fp) != os.path.abspath(captions_path or ""):
            os.remove(fp)

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
        "audioFormat": {"formatId": fmt.get("format_id"), "ext": fmt.get("ext"), "acodec": fmt.get("acodec"), "vcodec": fmt.get("vcodec")},
        "captionsPath": captions_path,
        "captionsKind": sub["kind"] if sub else None,
        "captionsLang": sub["lang"] if sub else None,
    }
    with open(os.path.join(out_dir, "info.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
    return result
