"""FETCH_SECTIONS helpers (SPEC §7.5): download only the clip's part of the video, and measure exactly
where it starts in source time by aligning its audio against the source audio."""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import wave
from typing import Any, Dict, Optional

import numpy as np

from .download import _Logger

log = logging.getLogger("media.sections")

SECTION_FORMAT = "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b[height<=1080]"
SR = 16000


def _ydl_opts(outtmpl: str, node_path: Optional[str]) -> Dict[str, Any]:
    opts: Dict[str, Any] = {
        "format": SECTION_FORMAT,
        "merge_output_format": "mp4",
        "outtmpl": {"default": outtmpl},
        "noplaylist": True,
        "quiet": True,
        "noprogress": True,
        "logger": _Logger(),
        "retries": 3,
        "fragment_retries": 3,
        "overwrites": True,
        "writesubtitles": False,
        "writeautomaticsub": False,
    }
    if node_path:
        opts["js_runtimes"] = {"node": {"path": node_path}}
    return opts


def _full_size(info: Dict[str, Any]) -> Optional[int]:
    """Estimated size of downloading the whole video in the same formats (for the bytes check):
    filesize, else filesize_approx, else total bitrate (kbit/s) × duration."""
    fmts = info.get("requested_formats") or [info]
    duration = info.get("duration") or 0
    total = 0.0
    for f in fmts:
        size = f.get("filesize") or f.get("filesize_approx")
        if not size and f.get("tbr") and duration:
            size = f["tbr"] * 1000 / 8 * duration
        if not size:
            return None
        total += size
    return int(total)


def download_section(args: Dict[str, Any]) -> Dict[str, Any]:
    """One clip section: `--download-sections "*start-end"` equivalent through the Python API."""
    import yt_dlp
    from yt_dlp.utils import download_range_func

    url, start, end, out_file = args["url"], float(args["start"]), float(args["end"]), args["outFile"]
    os.makedirs(os.path.dirname(out_file), exist_ok=True)
    base = os.path.splitext(out_file)[0]
    opts = _ydl_opts(base + ".%(ext)s", args.get("nodePath") or shutil.which("node"))
    opts["download_ranges"] = download_range_func(None, [(max(0.0, start), end)])
    opts["force_keyframes_at_cuts"] = False  # exact start is measured by audio alignment instead
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        if info is None:
            raise RuntimeError(f"yt-dlp could not download the section {start:.1f}-{end:.1f}")
        info = ydl.sanitize_info(info)
    produced = next((d.get("filepath") for d in info.get("requested_downloads") or [] if d.get("filepath")), None)
    if not produced or not os.path.exists(produced):
        raise RuntimeError("yt-dlp finished without a section file")
    if os.path.abspath(produced) != os.path.abspath(out_file):
        os.replace(produced, out_file)
    return {"file": out_file, "bytes": os.path.getsize(out_file), "fullSizeEstimate": _full_size(info), "formatId": info.get("format_id")}


def download_full(args: Dict[str, Any]) -> Dict[str, Any]:
    """Fallback (SPEC §7.5): one full download at ≤ 1080p, cached for all clips of the source."""
    import yt_dlp

    url, out_file = args["url"], args["outFile"]
    if os.path.exists(out_file) and os.path.getsize(out_file) > 0:
        return {"file": out_file, "bytes": os.path.getsize(out_file), "cached": True}
    os.makedirs(os.path.dirname(out_file), exist_ok=True)
    base = os.path.splitext(out_file)[0]
    with yt_dlp.YoutubeDL(_ydl_opts(base + ".%(ext)s", args.get("nodePath") or shutil.which("node"))) as ydl:
        info = ydl.extract_info(url, download=True)
        if info is None:
            raise RuntimeError("yt-dlp could not download the full video")
        info = ydl.sanitize_info(info)
    produced = next((d.get("filepath") for d in info.get("requested_downloads") or [] if d.get("filepath")), None)
    if not produced or not os.path.exists(produced):
        raise RuntimeError("yt-dlp finished without a file")
    if os.path.abspath(produced) != os.path.abspath(out_file):
        os.replace(produced, out_file)
    return {"file": out_file, "bytes": os.path.getsize(out_file), "cached": False}


# ---------- audio alignment ----------


def read_media_audio(path: str, start: float, duration: float, ffmpeg: str = "ffmpeg") -> np.ndarray:
    """16 kHz mono float32 audio of [start, start+duration] from any media file (audio stream only)."""
    cmd = [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-ss", f"{max(0.0, start):.3f}", "-i", path,
           "-t", f"{duration:.3f}", "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def read_wav(path: str, start: float, duration: float) -> np.ndarray:
    """Slice of a 16 kHz mono PCM WAV (the source's audio.wav) without decoding the rest."""
    with wave.open(path, "rb") as w:
        if w.getframerate() != SR or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError("expected 16 kHz mono 16-bit WAV")
        first = max(0, int(start * SR))
        w.setpos(min(first, w.getnframes()))
        raw = w.readframes(max(0, int(duration * SR)))
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def best_lag(needle: np.ndarray, hay: np.ndarray) -> tuple[int, float]:
    """Offset of `needle` inside `hay` by normalized cross-correlation (FFT). Returns (lag, score 0–1)."""
    n, m = len(needle), len(hay)
    if n == 0 or m < n:
        return 0, 0.0
    needle = needle - needle.mean()
    size = 1 << int(np.ceil(np.log2(n + m)))
    corr = np.fft.irfft(np.fft.rfft(hay, size) * np.conj(np.fft.rfft(needle, size)), size)[: m - n + 1]
    # Sliding energy of the haystack for normalization.
    c = np.concatenate([[0.0], np.cumsum(hay.astype(np.float64))])
    c2 = np.concatenate([[0.0], np.cumsum(hay.astype(np.float64) ** 2)])
    win_sum = c[n:] - c[:-n]
    win_sq = c2[n:] - c2[:-n]
    var = np.maximum(win_sq - win_sum**2 / n, 1e-12)
    score = corr / (np.sqrt(var) * np.sqrt(np.sum(needle**2)) + 1e-12)
    lag = int(np.argmax(score))
    return lag, float(score[lag])


def align_section(args: Dict[str, Any]) -> Dict[str, Any]:
    """Where does t=0 of the section sit in source time? Search ±search seconds around the expected start."""
    section, source_wav, approx = args["section"], args["sourceWav"], float(args["approxStart"])
    ffmpeg = args.get("ffmpegPath", "ffmpeg")
    search = float(args.get("searchSec", 12.0))
    skip, length = 1.0, 8.0  # use section audio 1–9 s (skips any silent/garbled first frames)
    needle = read_media_audio(section, skip, length, ffmpeg)
    hay_start = max(0.0, approx + skip - search)
    hay = read_wav(source_wav, hay_start, length + 2 * search)
    if len(needle) < SR or np.max(np.abs(needle)) < 1e-4:
        return {"sourceStart": approx, "score": 0.0, "note": "section audio too short or silent"}
    lag, score = best_lag(needle, hay)
    source_start = hay_start + lag / SR - skip
    return {"sourceStart": round(source_start, 4), "score": round(score, 4)}
