"""Local Whisper fallback (SPEC §7.3 step 3): faster-whisper, CPU, int8, word timestamps, VAD.

The model loads on first use and unloads after IDLE_UNLOAD_SEC without requests (SPEC §12).
"""
from __future__ import annotations

import gc
import logging
import threading
import time
from typing import Any, Dict, Optional

log = logging.getLogger("media.whisper")

IDLE_UNLOAD_SEC = 600


class WhisperManager:
    def __init__(self, idle_unload_sec: float = IDLE_UNLOAD_SEC, loader=None):
        self._lock = threading.Lock()
        self._model = None
        self._key: Optional[tuple] = None
        self._last_used = 0.0
        self._busy = 0
        self.idle_unload_sec = idle_unload_sec
        self._loader = loader or _load_faster_whisper
        threading.Thread(target=self._reaper, name="whisper-reaper", daemon=True).start()

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def _get(self, model: str, threads: int):
        key = (model, threads)
        with self._lock:
            if self._model is None or self._key != key:
                self._model = None
                gc.collect()
                t0 = time.time()
                log.info("loading whisper model %s (cpu, int8, %d threads)", model, threads)
                self._model = self._loader(model, threads)
                self._key = key
                log.info("whisper model loaded in %.1fs", time.time() - t0)
            self._busy += 1
            return self._model

    def _done(self):
        with self._lock:
            self._busy -= 1
            self._last_used = time.time()

    def unload_if_idle(self, now: Optional[float] = None) -> bool:
        now = time.time() if now is None else now
        with self._lock:
            if self._model is not None and self._busy == 0 and now - self._last_used >= self.idle_unload_sec:
                log.info("unloading idle whisper model")
                self._model = None
                self._key = None
                gc.collect()
                return True
        return False

    def _reaper(self):
        while True:
            time.sleep(30)
            self.unload_if_idle()

    def transcribe(self, args: Dict[str, Any]) -> Dict[str, Any]:
        audio = args["audio"]
        model_name = args.get("model", "small.en")
        threads = int(args.get("threads", 4))
        language = args.get("language", "en")
        model = self._get(model_name, threads)
        try:
            t0 = time.time()
            segments, info = model.transcribe(
                audio, language=language, word_timestamps=True, vad_filter=True, condition_on_previous_text=False
            )
            words = []
            for seg in segments:  # generator: decoding happens while iterating
                for w in seg.words or []:
                    words.append({"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3), "conf": round(w.probability, 3)})
            dur = float(getattr(info, "duration", 0.0) or 0.0)
            log.info("transcribed %.0fs of audio in %.0fs (%d words)", dur, time.time() - t0, len(words))
            return {"words": [w for w in words if w["w"]], "durationSec": dur, "model": model_name}
        finally:
            self._done()


def _load_faster_whisper(model: str, threads: int):
    from faster_whisper import WhisperModel  # imported lazily: heavy

    return WhisperModel(model, device="cpu", compute_type="int8", cpu_threads=threads)
