import subprocess
import wave

import numpy as np
import pytest

from media.analysis import nms
from media.sections import SR, _full_size, align_section, best_lag, locate_audio, read_wav


def noise_wav(path, seconds, seed=0):
    """Speech-like test signal: band-limited noise with a syllable-rate envelope (unique, no repeats)."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    x = rng.standard_normal(n)
    x = np.convolve(x, np.ones(8) / 8, mode="same")
    env = 0.5 + 0.5 * np.sin(np.arange(n) / SR * 2 * np.pi * 4.3) ** 2
    pcm = (np.clip(x * env * 0.3, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    return pcm.astype(np.float32) / 32768


def test_best_lag_finds_exact_offset():
    rng = np.random.default_rng(1)
    hay = rng.standard_normal(SR * 10).astype(np.float32)
    needle = hay[37123 : 37123 + SR * 2].copy()
    lag, score = best_lag(needle, hay)
    assert lag == 37123 and score > 0.99


def test_best_lag_low_score_for_unrelated_audio():
    rng = np.random.default_rng(2)
    lag, score = best_lag(rng.standard_normal(SR).astype(np.float32), rng.standard_normal(SR * 5).astype(np.float32))
    assert score < 0.2


def test_read_wav_slices(tmp_path):
    pcm = noise_wav(tmp_path / "a.wav", 5)
    got = read_wav(str(tmp_path / "a.wav"), 2.0, 1.0)
    assert len(got) == SR and np.allclose(got, pcm[2 * SR : 3 * SR], atol=1e-4)


def test_align_section_measures_true_start(tmp_path):
    """Cut a 'section' from 61.37 s with ffmpeg (as AAC in MP4, like a real download) and ask the aligner
    where it starts, giving it a deliberately wrong guess (keyframe-style error of ~1.4 s)."""
    src = tmp_path / "audio.wav"
    noise_wav(src, 120, seed=3)
    section = tmp_path / "section.mp4"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", "61.37", "-i", str(src), "-t", "20",
         "-c:a", "aac", "-b:a", "128k", str(section)],
        check=True,
    )
    r = align_section({"section": str(section), "sourceWav": str(src), "approxStart": 60.0})
    assert r["score"] > 0.8
    # AAC encoder priming can shift by a few ms; 20 ms is far below a word.
    assert r["sourceStart"] == pytest.approx(61.37, abs=0.02)


def test_nms_merges_overlapping_boxes():
    a = {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.3, "score": 0.9}
    b = {"x": 0.11, "y": 0.1, "w": 0.2, "h": 0.3, "score": 0.8}
    c = {"x": 0.6, "y": 0.1, "w": 0.2, "h": 0.3, "score": 0.7}
    assert nms([b, a, c]) == [a, c]


def test_full_size_estimate_falls_back_to_bitrate():
    info = {"duration": 600, "requested_formats": [{"filesize": 50_000_000}, {"filesize_approx": 9_000_000}]}
    assert _full_size(info) == 59_000_000
    dash = {"duration": 600, "requested_formats": [{"tbr": 2000}, {"tbr": 128}]}
    assert _full_size(dash) == int((2000 + 128) * 1000 / 8 * 600)
    assert _full_size({"duration": 600, "requested_formats": [{}]}) is None


def test_locate_audio_finds_a_mixed_in_sound(tmp_path):
    whoosh = tmp_path / "whoosh.wav"
    noise_wav(whoosh, 0.5, seed=9)
    bed = tmp_path / "bed.wav"
    noise_wav(bed, 4, seed=10)
    mixed = tmp_path / "mixed.wav"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(bed), "-i", str(whoosh), "-filter_complex",
                    "[0]volume=0.3[a];[1]adelay=1250:all=1[b];[a][b]amix=inputs=2:normalize=0:duration=first", str(mixed)], check=True)
    r = locate_audio({"needle": str(whoosh), "hay": str(mixed), "duration": 3.0})
    assert r["offset"] == pytest.approx(1.25, abs=0.01) and r["score"] > 0.5
