"""ANALYZE (SPEC §7.6), on the clip section only: PySceneDetect ContentDetector + MediaPipe face
detection at 3 fps on frames downscaled to 640 px wide. Writes analysis.json."""
from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
import urllib.request
from typing import Any, Dict, List

import numpy as np

log = logging.getLogger("media.analysis")

FACE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite"
FACE_MODEL_NAME = "blaze_face_short_range.tflite"
ANALYSIS_WIDTH = 640
_detector_lock = threading.Lock()
_detector = None


def probe(path: str, ffprobe: str = "ffprobe") -> Dict[str, Any]:
    out = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate:format=duration", "-of", "json", path],
        capture_output=True, check=True, text=True,
    ).stdout
    j = json.loads(out)
    st = (j.get("streams") or [{}])[0]
    num, _, den = (st.get("avg_frame_rate") or "30/1").partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 30.0
    return {"width": int(st["width"]), "height": int(st["height"]), "fps": round(fps, 3) or 30.0, "duration": float(j["format"]["duration"])}


def ensure_face_model(model_dir: str) -> str:
    """Download the official BlazeFace short-range model once (≈ 230 KB) into assets/.cache/models."""
    path = os.path.join(model_dir, FACE_MODEL_NAME)
    if os.path.exists(path) and os.path.getsize(path) > 100_000:
        return path
    os.makedirs(model_dir, exist_ok=True)
    tmp = path + ".part"
    log.info("downloading face model %s", FACE_MODEL_URL)
    with urllib.request.urlopen(FACE_MODEL_URL, timeout=60) as r, open(tmp, "wb") as f:
        f.write(r.read())
    if os.path.getsize(tmp) < 100_000:
        os.remove(tmp)
        raise RuntimeError("face model download looks truncated")
    os.replace(tmp, path)
    return path


def _get_detector(model_path: str):
    """MediaPipe FaceDetector, created once per process (SPEC §12: models loaded once)."""
    global _detector
    with _detector_lock:
        if _detector is None:
            from mediapipe.tasks.python import BaseOptions, vision

            opts = vision.FaceDetectorOptions(base_options=BaseOptions(model_asset_path=model_path), min_detection_confidence=0.5)
            _detector = vision.FaceDetector.create_from_options(opts)
        return _detector


def detect_scenes(path: str) -> List[Dict[str, float]]:
    from scenedetect import ContentDetector, detect

    scenes = detect(path, ContentDetector(threshold=27.0), show_progress=False)
    return [{"s": round(s.get_seconds(), 3), "e": round(e.get_seconds(), 3)} for s, e in scenes]


def nms(boxes: List[Dict[str, float]], iou_max: float = 0.4) -> List[Dict[str, float]]:
    """Non-maximum suppression on normalized boxes (merges full-frame and half-frame detections)."""
    keep: List[Dict[str, float]] = []
    for b in sorted(boxes, key=lambda x: -x["score"]):
        ok = True
        for k in keep:
            ix = max(0.0, min(b["x"] + b["w"], k["x"] + k["w"]) - max(b["x"], k["x"]))
            iy = max(0.0, min(b["y"] + b["h"], k["y"] + k["h"]) - max(b["y"], k["y"]))
            inter = ix * iy
            union = b["w"] * b["h"] + k["w"] * k["h"] - inter
            if union > 0 and inter / union > iou_max:
                ok = False
                break
        if ok:
            keep.append(b)
    return keep


def _detect_frame(detector, frame: np.ndarray) -> List[Dict[str, float]]:
    """Faces in one RGB frame. Also runs on overlapping left/right halves: the short-range model works on a
    small input, so small faces in wide two-person shots are found more reliably at half width."""
    import mediapipe as mp

    h, w, _ = frame.shape
    tiles = [(0, w), (0, int(w * 0.6)), (int(w * 0.4), w)]
    out: List[Dict[str, float]] = []
    for x0, x1 in tiles:
        tile = np.ascontiguousarray(frame[:, x0:x1])
        res = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=tile))
        for d in res.detections or []:
            bb = d.bounding_box
            score = float(d.categories[0].score) if d.categories else 0.0
            out.append({
                "x": (x0 + bb.origin_x) / w, "y": bb.origin_y / h, "w": bb.width / w, "h": bb.height / h, "score": round(score, 3),
            })
    return [{k: round(v, 4) for k, v in b.items()} for b in nms(out)]


def detect_faces(path: str, info: Dict[str, Any], model_path: str, sample_fps: float, ffmpeg: str = "ffmpeg") -> List[Dict[str, Any]]:
    """Frames at `sample_fps`, 640 px wide, piped from FFmpeg (decodes only this section)."""
    detector = _get_detector(model_path)
    out_w = ANALYSIS_WIDTH
    out_h = int(round(info["height"] * out_w / info["width"] / 2) * 2)
    cmd = [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", path, "-an",
           "-vf", f"fps={sample_fps},scale={out_w}:{out_h}", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frame_bytes = out_w * out_h * 3
    samples: List[Dict[str, Any]] = []
    i = 0
    try:
        while True:
            buf = proc.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            frame = np.frombuffer(buf, dtype=np.uint8).reshape(out_h, out_w, 3)
            samples.append({"t": round(i / sample_fps, 3), "faces": _detect_frame(detector, frame)})
            i += 1
    finally:
        proc.stdout.close()
        err = proc.stderr.read().decode("utf-8", "replace")
        if proc.wait() != 0:
            raise RuntimeError(f"ffmpeg frame extraction failed: {err.strip()[-300:]}")
    return samples


def analyze(args: Dict[str, Any]) -> Dict[str, Any]:
    section = args["section"]
    out = args["out"]
    sample_fps = float(args.get("sampleFps", 3))
    ffmpeg = args.get("ffmpegPath", "ffmpeg")
    info = probe(section, args.get("ffprobePath", "ffprobe"))
    model = ensure_face_model(args["modelDir"])
    scenes = detect_scenes(section) or [{"s": 0.0, "e": round(info["duration"], 3)}]
    faces = detect_faces(section, info, model, sample_fps, ffmpeg)
    result = {**info, "sampleFps": sample_fps, "scenes": scenes, "faces": faces}
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f)
    with_face = sum(1 for s in faces if s["faces"])
    return {"out": out, "scenes": len(scenes), "samples": len(faces), "samplesWithFace": with_face, "width": info["width"], "height": info["height"]}
