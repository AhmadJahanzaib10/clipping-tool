# Clip Engine — Project Spec (v2)

Internal tool for a small clipping team. It turns a long source video (YouTube URL or MP4) into ready-to-post vertical clips (9:16) with strong hooks, tight pacing, word-by-word captions, zoom punch-ins, sound effects from the team's own SFX folder and campaign-required overlays. Team members use it from a browser on the office network. Posting to TikTok / Instagram / YouTube is done by hand — the tool never posts.

> **How to use this file with Claude Code:** put it at the repo root and copy §15 "Rules for Claude Code" into `CLAUDE.md`. Then ask: *"Read SPEC.md and build Milestone 1. Stop when its acceptance checks pass."* Build one milestone at a time.

---

## 1. Goals and non-goals

**Goals**
- Source video in → 8–10 candidate clips out, 20–60 s each, ready to post.
- Light on resources: runs on one Windows laptop with no GPU (target: 11th-gen Intel i7, 4 cores / 8 threads, 16 GB RAM, Intel Iris Xe) and stays usable for other work while processing.
- Best possible output: strong hooks, standalone moments, tight pacing, clean captions, purposeful SFX and zooms.
- Cheap: free YouTube captions first, Deepgram second (daily cap), local Whisper as fallback.
- Every clip automatically follows its campaign's brief (hashtags, mentions, overlay, length).
- Quick edits in the browser re-render in seconds, not minutes.

**Non-goals (do not build)**
- No automatic posting, liking, following or commenting on any social platform.
- No proxies, VPN handling, account switching or anything that hides location or identity.
- No view or engagement manipulation.
- No notifications/alerts in v1 (Telegram, email, webhooks).
- No user accounts with passwords in v1 (office LAN only; simple operator picker).

---

## 2. Architecture

```
 Browser (any office PC)
        │  http://<main-pc>:3000
        ▼
 ┌──────────────────────────── Main PC ─────────────────────────────┐
 │  apps/web  (Next.js: dashboard + REST API)                       │
 │      ├── SQLite (data/app.db)  ← jobs, clips, campaigns, tasks   │
 │      ├── storage/  ← audio, transcripts, sections, renders       │
 │      └── /api/worker/*  ← task claim / heartbeat / complete      │
 │                                                                  │
 │  apps/worker  (Node orchestrator, polls /api/worker/claim)       │
 │      ├── long-lived Python media service (models loaded once)    │
 │      ├── Deepgram API, OpenRouter API                            │
 │      └── FFmpeg (h264_qsv → libx264 fallback), low priority      │
 └──────────────────────────────────────────────────────────────────┘
```

- **Queue:** a `tasks` table in SQLite, claimed through the HTTP API with a lease (no Redis). Extra workers on other PCs can join later (Milestone 8) without sharing the database file.
- **Workers talk to the API, never to SQLite directly.** In v1 the worker runs on the main PC and reads/writes `storage/` directly.

---

## 3. Tech stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Language | TypeScript (Node 20+), Python 3.11 | |
| Monorepo | pnpm workspaces | `apps/web`, `apps/worker`, `packages/shared`, `py/` |
| Web | Next.js 15 (App Router), React, Tailwind, shadcn/ui | Dashboard + API routes; run with `next start` (production build) for daily use |
| DB | SQLite via `better-sqlite3` + Drizzle ORM | `data/app.db`, WAL mode |
| Validation | zod | API bodies, LLM output, Python output, campaign config |
| Media service | Python package `py/media`, run as a long-lived local process (JSON over stdin/stdout, one request per line) | Loads Whisper and MediaPipe once; yt-dlp, faster-whisper, mediapipe, scenedetect, opencv-python-headless |
| Video | FFmpeg (system install) + ASS subtitles (libass) | Encoder `h264_qsv` (Intel Quick Sync), fallback `libx264 -preset veryfast` |
| Transcription | YouTube captions → Deepgram Nova-3 (prerecorded) → faster-whisper `small.en` int8 | Provider chain, §7.3 |
| LLM | OpenRouter, two models from env (scout + editor) | §8 |
| Testing | Vitest (TS), pytest (Python) | |

---

## 4. Repository layout

```
clip-engine/
  SPEC.md
  CLAUDE.md
  package.json            # scripts: dev, build, start, test, lint, doctor, sfx:scan
  pnpm-workspace.yaml
  .env.example
  start-clip-engine.bat   # builds if needed, runs `pnpm start`, opens browser
  apps/
    web/
      app/
        page.tsx                      # Overview
        jobs/new/page.tsx
        jobs/[id]/page.tsx
        clips/[id]/page.tsx           # review + editor
        campaigns/page.tsx
        campaigns/[id]/page.tsx
        sfx/page.tsx                  # SFX library browser
        settings/page.tsx
        api/
          jobs/route.ts, jobs/[id]/route.ts
          uploads/route.ts
          clips/[id]/route.ts         # GET, PATCH (edits)
          clips/[id]/compose/route.ts # fast re-render (captions/hook/SFX/overlay only)
          clips/[id]/rebase/route.ts  # full re-render (trim/layout/crop changes)
          clips/[id]/approve/route.ts, clips/[id]/reject/route.ts
          clips/[id]/upload-final/route.ts
          clips/[id]/performance/route.ts   # enter views at 72 h
          campaigns/route.ts, campaigns/[id]/route.ts
          operators/route.ts
          sfx/route.ts, sfx/scan/route.ts, sfx/[id]/route.ts
          usage/route.ts
          files/[...path]/route.ts    # media streaming with range support
          worker/claim, worker/heartbeat, worker/complete, worker/fail
    worker/
      src/
        index.ts
        mediaService.ts               # manages the long-lived Python process
        stages/
          ingest.ts, transcribe.ts, scout.ts, edit.ts, fetchSections.ts,
          analyze.ts, prepClip.ts, renderBase.ts, compose.ts, deliver.ts
        providers/
          youtubeCaptions.ts, deepgram.ts, whisperLocal.ts, openrouter.ts
        edit/
          pacing.ts                   # pause tightening, filler trimming, timeline remap
          coldOpen.ts
          zoom.ts                     # punch-in keyframes
          sfxPlanner.ts               # automatic SFX cue placement
        render/
          ass.ts, ffmpegBase.ts, ffmpegCompose.ts, crop.ts, audio.ts
  packages/
    shared/src/
      db/schema.ts, db/client.ts
      schemas/                        # zod schemas
      types.ts, constants.ts
  py/
    media/
      __main__.py                     # `python -m media serve` (long-lived) and one-shot commands
      download.py, audio.py, transcribe_local.py, youtube_captions.py,
      scenes.py, faces.py, sections.py
    tests/
    requirements.txt
  assets/
    fonts/                            # OFL fonts, e.g. Montserrat ExtraBold, Inter Bold
    sfx/                              # team-owned SFX library (§10)
      whoosh/  pop/  impact/  riser/  ding/  transition/  glitch/  click/  misc/
      sfx.json                        # optional per-file overrides
    overlays/
    .cache/                           # gitignored: normalized SFX WAVs, waveform previews
  storage/                            # gitignored
  data/                               # gitignored
```

---

## 5. Environment variables (`.env.example`)

```
# Server
PORT=3000
HOST=0.0.0.0
STORAGE_DIR=./storage
DATABASE_PATH=./data/app.db
WORKER_TOKEN=change-me
API_BASE_URL=http://localhost:3000

# Transcription
DEEPGRAM_API_KEY=
DEEPGRAM_MODEL=nova-3
DEEPGRAM_DAILY_CAP_MIN=300
DEEPGRAM_DIARIZE=true
WHISPER_MODEL=small.en            # small.en | distil-large-v3 | medium.en
WHISPER_THREADS=4
TRANSCRIBE_ORDER=youtube,deepgram,whisper

# LLM (two roles, see §8)
OPENROUTER_API_KEY=
LLM_SCOUT_MODEL=                  # cheap/fast model for finding candidates
LLM_EDITOR_MODEL=                 # strongest affordable model for ranking + hooks
LLM_MAX_CANDIDATES=10

# Resources
LOW_PRIORITY=true                 # run FFmpeg/Python at below-normal priority
FFMPEG_THREADS=4
MAX_HEAVY_TASKS=1
SECTION_DOWNLOAD=true             # download only clip sections for URL sources (§7.5)

# Render
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
VIDEO_ENCODER=h264_qsv            # h264_qsv | libx264
OUTPUT_FPS=30
TARGET_LUFS=-14
PYTHON_PATH=python

# Delivery
DRIVE_ROOT=                       # optional: Google Drive for desktop sync folder root

# Cleanup
KEEP_SOURCES_DAYS=3
KEEP_REJECTED_DAYS=2
```

---

## 6. Data model (Drizzle / SQLite)

All ids are text (`nanoid`). Timestamps are ISO strings. JSON columns are validated by zod.

**operators**: `id, name, slug, driveFolder, active, createdAt`

**campaigns**: `id, name, slug, niche, ratePer1k, allowedPlatforms (json), config (json: CampaignConfig §6.1), active, createdAt, updatedAt`

**sources**: `id, operatorId, campaignId, kind ("url" | "upload"), url, title, durationSec, width, height, status ("queued" | "ingesting" | "transcribing" | "selecting" | "fetching" | "clipping" | "done" | "failed"), transcriptProvider, transcriptQuality ("rough" | "precise"), error, createdAt, updatedAt`

**clips**: `id, sourceId, campaignId, operatorId, rank, score, scores (json: per-criterion §8.3), startSec, endSec, hookA, hookB, hookChoice ("A" | "B"), title, captionTiktok, captionInstagram, captionYoutube, hashtags (json), emphasisWords (json), reason, edit (json: ClipEdit §6.2), status ("candidate" | "rendering" | "rendered" | "approved" | "rejected" | "failed"), baseVersion, composeVersion, outputPath, basePath, thumbPath, views72h (int, nullable), viewsPlatform, createdAt, updatedAt`

**sfx**: `id, category, file (relative path), name, durationSec, peakDb, lufs, tags (json), defaultGainDb, enabled, cachedPath, waveformPath, updatedAt`

**tasks**: `id, type, sourceId, clipId, payload (json), priority, status ("pending" | "running" | "done" | "failed"), attempts, maxAttempts (3), workerId, leaseUntil, error, createdAt, updatedAt`
- Types: `INGEST, TRANSCRIBE, SCOUT, EDIT, FETCH_SECTIONS, ANALYZE, PREP_CLIP, RENDER_BASE, COMPOSE, DELIVER, CLEANUP`.
- Claim = atomic update of one claimable task, set `workerId`, `leaseUntil = now + 10 min`; heartbeat extends.
- **Claim order:** oldest source first, and within it the latest stage first (finish clips of source 1 before starting heavy work on source 2), so review can start early. `INGEST` of the next source may run as a light task in parallel. User-triggered `COMPOSE` / `RENDER_BASE` from the review page get top priority.

**usage**: `date (pk), deepgramSeconds, llmCalls, llmTokensIn, llmTokensOut`

**events**: `id, sourceId, clipId, level, message, data (json), createdAt` — job log in the UI.

**settings**: `key, value (json)`

### 6.1 CampaignConfig (zod)

```ts
{
  minLengthSec: number,            // default 20
  maxLengthSec: number,            // default 60
  idealLengthSec: number,          // default 35, the LLM aims for this
  requiredHashtags: string[],
  requiredMentions: string[],
  overlay?: { file: string, position: "top" | "bottom" | "top-left" | "top-right", widthPct: number, opacity: number },
  showNameOnScreen?: string,
  captionPreset: "bold-yellow" | "white-box" | "clean-white",
  hookStyle: "top-banner" | "center-pop",
  pacing: { tightenPauses: boolean, maxPauseSec: number, trimFillers: boolean },  // defaults true, 0.45, true
  coldOpen: "off" | "auto" | "always",       // default "auto"
  zoom: "off" | "subtle" | "punchy",         // default "subtle"
  sfx: { intensity: "off" | "subtle" | "normal" | "heavy", categories: string[], gainDb: number }, // default normal, ["whoosh","pop","impact","transition"], -14
  bannedWords: string[],
  briefNotes: string
}
```

### 6.2 ClipEdit (zod) — everything the editor can change

```ts
{
  trim: { start: number, end: number },            // seconds in source time
  layout: "single" | "split" | "fit",
  focus?: "auto" | "left" | "center" | "right",
  pacing: { tightenPauses: boolean, maxPauseSec: number, trimFillers: boolean },
  coldOpen: { enabled: boolean, start: number, end: number } | null,  // source-time range of the teaser
  zoom: "off" | "subtle" | "punchy",
  captionPreset: string,
  hookChoice: "A" | "B",
  hookOverride?: string,
  wordEdits: { index: number, text?: string, hidden?: boolean }[],   // fix/hide caption words
  emphasisWords: string[],
  sfxCues: { id: string, sfxId: string, at: number, gainDb: number, source: "auto" | "manual" }[],  // times in output timeline
  overlay: boolean
}
```

Changes to `trim`, `layout`, `focus`, `pacing`, `coldOpen`, `zoom` need **RENDER_BASE** (picture/timeline). Everything else only needs **COMPOSE** (fast, §7.10).

---

## 7. Pipeline

INGEST → TRANSCRIBE → SCOUT → EDIT → FETCH_SECTIONS → ANALYZE → PREP_CLIP → RENDER_BASE → COMPOSE → (review) → DELIVER. CLEANUP runs daily.

### 7.1 INGEST (audio first — saves bandwidth, disk and CPU)
- **URL source:** download **audio only** first (`-f ba`, convert to 16 kHz mono WAV + 32 kbps Opus) plus English captions if available (`--write-subs --write-auto-subs --sub-langs en.* --sub-format json3`) and metadata (title, duration, width, height). The video is only fetched later for the chosen moments (§7.5).
- **Upload source:** saved by `/api/uploads`; extract the same audio files with FFmpeg (`-vn`, no video decode).

### 7.2 Word format (shared)
```ts
type Word = { w: string; s: number; e: number; speaker?: number; conf?: number; filler?: boolean }
type Transcript = { provider: "youtube" | "deepgram" | "whisper"; quality: "rough" | "precise"; words: Word[]; sentences: { s: number; e: number; text: string; speaker?: number }[] }
```
Fillers flagged by a word list (`um, uh, erm, like (when standalone), you know, I mean, so (sentence-initial)`), unit-tested.

### 7.3 TRANSCRIBE — provider chain
1. **youtube** captions (json3 → Word[]), `quality = "rough"`.
2. **deepgram** if today's usage + duration ≤ cap: POST the Opus file, `model=nova-3, smart_format=true, punctuate=true, diarize=<env>, utterances=true, filler_words=true, language=en`. Use `punctuated_word`. Add duration to `usage`. `quality = "precise"`.
3. **whisper** (media service): faster-whisper `small.en`, `cpu`, `int8`, `word_timestamps=True`, `vad_filter=True`. `quality = "precise"`.
- On error, fall through and log a `warn` event.

### 7.4 SCOUT + EDIT — two-pass moment selection (§8)
- **SCOUT** (cheap model): windows of ~8 min with 1-min overlap → up to 4 raw candidates per window (start, end, one-line summary, rough score). Run up to 3 windows in parallel.
- Merge, drop > 50% overlaps, keep top ~15 by rough score.
- **EDIT** (strong model, one call per source): receives the ~15 candidates with their full text plus ±20 s of context each, the campaign brief and up to 5 few-shot examples of the team's best past clips (§9). Returns the final 8–10 with per-criterion scores, two hooks, title, platform captions, hashtags, emphasis words, optional cold-open teaser range, and exact start/end.
- Code then: snaps start/end to sentence boundaries (never mid-word), drops leading fillers/conjunctions ("so", "and", "um") at the start, enforces length, filters banned words, computes the final score from the criteria (§8.3), and creates `clips` rows.

### 7.5 FETCH_SECTIONS (download only what is needed)
- URL sources with `SECTION_DOWNLOAD=true`: one yt-dlp call per clip with `--download-sections "*{start-2}-{end+2}"` and `-f "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]"` → `storage/clips/{clipId}/section.mp4`. ~10 × 45 s instead of the full hour.
- If section download fails twice, fall back to one full download (cached for all clips of that source).
- Upload sources: cut sections with `ffmpeg -ss … -t … -c copy` (no re-encode).
- All later stages work on `section.mp4` (small, fast seeking).

### 7.6 ANALYZE (on sections only)
- Media service: PySceneDetect ContentDetector on the section; MediaPipe face detection at 3 fps on frames downscaled to 640 px wide → `analysis.json` `{ scenes: [{s,e}], faces: [{t, faces:[{x,y,w,h,score}]}] }`.

### 7.7 PREP_CLIP — the edit decisions
1. **Words for captions:** `precise` transcript → slice words. `rough` → run local whisper on the section audio (media service; model already loaded; batch all clips of a source in one request).
2. **Pacing (`edit/pacing.ts`):** if enabled, cut pauses longer than `maxPauseSec` down to ~0.15 s and remove flagged filler words (only when the cut lands between words with ≥ 60 ms gap, to avoid clipped syllables). Produces a **timeline map** (list of kept source ranges) and remaps every word, emphasis time and scene cut to output time. Unit-tested.
3. **Cold open (`edit/coldOpen.ts`):** if the EDIT pass returned a teaser (a 2–4 s punchline line from later in the clip) and `coldOpen` is `auto`/`always`, prepend that range, then a 0.2 s flash/whoosh transition, then the clip from its start. Captions cover both.
4. **Layout + crop:** from `analysis.json`:
   - `single`: crop 9:16 of section height centered on the active face; EMA smoothing (alpha 0.15) + dead zone (move only when face center leaves the middle 40%); instant re-center at scene cuts; if diarization says the other speaker is talking and both faces are visible, cut to them at the sentence boundary. Keyframes max 2/s.
   - `split`: two faces present > 60% of frames → stacked top/bottom 1080×960 each, active speaker on top optional.
   - `fit`: no reliable face → source scaled to 1080 wide over a blurred, zoomed copy of itself (blur computed at 1/4 resolution for speed).
   - `focus` override forces left/center/right.
5. **Zoom punch-ins (`edit/zoom.ts`):** `subtle` = scale 1.00→1.06 eased over 150 ms on emphasis words, hold, ease back after 1.2 s; `punchy` = 1.00→1.12. At most one zoom every 4 s; never during a scene cut. Implemented in the crop window (no extra pass).
6. **SFX cues (`edit/sfxPlanner.ts`, §10.3):** automatic cues from the campaign's intensity and categories.
7. Write `plan.json` (timeline map, crop keyframes, zoom keyframes, layout) and `words.json`; enqueue `RENDER_BASE`.

### 7.8 RENDER_BASE (the heavy pass, once per picture change)
- Input `section.mp4`; output `base.mp4`: 1080×1920, `OUTPUT_FPS`, cropped/zoomed per plan, timeline cuts applied (concat of kept ranges via `trim`/`atrim` + `concat` filter), **no captions, no hook, no SFX**, voice audio cleaned: `highpass=f=80, acompressor` (gentle), not yet loudness-normalized.
- Encode high quality for re-use: QSV `-global_quality 18` (fallback `libx264 -preset veryfast -crf 17`). `-threads $FFMPEG_THREADS`, below-normal priority.
- `base.mp4` doubles as the **Download clean version** for CapCut.

### 7.9 Captions (`render/ass.ts`)
- Lines of 2–3 words (break on punctuation or > 0.35 s gap), max ~16 characters per line.
- **Safe zones:** captions centered horizontally between 58–68 % of frame height; hook between 12–22 %; nothing in the bottom 20 % or the right 12 % (platform buttons and captions sit there). In `split`, captions on the seam.
- Active word highlighted in the preset color; emphasis words in an accent color with a scale pop (`\fscx115\fscy115` easing back over 120 ms).
- Presets: `bold-yellow` (Montserrat ExtraBold 80 px, white, yellow active word, 6 px black outline), `white-box` (Inter Bold 64 px, white on 70 % black box, `BorderStyle=3`), `clean-white` (Inter Bold 68 px, white, soft shadow).
- Hook title 0.0–2.8 s (style per `hookStyle`, max 2 lines, slight pop-in), using `hookOverride` or the chosen hook.
- Hidden words (`wordEdits.hidden`) are skipped; edited words replace text but keep timing.
- `showNameOnScreen` small label at the top.

### 7.10 COMPOSE (fast pass — every text/SFX edit)
- Inputs: `base.mp4`, `captions.ass`, overlay PNG, SFX cue list.
- Video: `subtitles` + overlay + thin progress bar at the very bottom (time-driven width; implement with an overlaid `color` source cropped by `t`, test against the installed FFmpeg) → encode QSV `-global_quality 23` (fallback `libx264 -preset veryfast -crf 21`), `yuv420p`, `+faststart`.
- Audio: base audio + SFX (each from `assets/.cache` pre-normalized WAV, placed with `adelay`, gain per cue) mixed with `amix=normalize=0`, then `loudnorm` to `TARGET_LUFS` (single pass with measured values cached from RENDER_BASE).
- Target: a 45 s clip composes in ~15–30 s on the target laptop.
- Output `clip.v{n}.mp4` + `thumb.jpg` (frame at 1.0 s). Keep the previous version until approval for side-by-side compare.

### 7.11 DELIVER (on approve)
- Copy the approved version to `storage/out/{operator}/{campaign}/{YYYY-MM-DD}/{clipId}-{slug(title)}.mp4` and, if configured, to `{DRIVE_ROOT}/{operator.driveFolder}/…`.
- Sidecar `{clipId}.txt`: TikTok / Instagram / YouTube captions and title, required hashtags and mentions always appended.

### 7.12 CLEANUP (daily, and on startup)
- Delete source audio/full downloads after `KEEP_SOURCES_DAYS`, `section.mp4` and `base.mp4` of approved clips after delivery + 2 days, rejected clips after `KEEP_REJECTED_DAYS`. Show disk usage on Overview.

---

## 8. LLM prompts

### 8.1 SCOUT (cheap model, per window)
System: `You find candidate viral moments in transcripts. Return ONLY JSON.`
User:
```
Niche: {{niche}}. Ideal clip length: {{idealLengthSec}} s (allowed {{min}}–{{max}}).
Transcript window (start time in seconds, speaker):
{{lines}}

List up to 4 self-contained moments that could stop a scroll: a strong or contrarian opinion, a surprising fact or number, a story with a payoff, conflict or tension, a funny line, a vulnerable admission, or practical advice. Return start, end (from the timestamps), summary (one line), roughScore 0–100.
```

### 8.2 EDIT (strong model, one call per source)
System:
```
You are a senior short-form editor whose clips regularly reach millions of views. You choose the best moments and write hooks that create a curiosity gap in the first 2 seconds without lying. Return ONLY JSON matching the schema.
```
User:
```
Campaign niche: {{niche}}
Brief notes: {{briefNotes}}
Never use: {{bannedWords}}
Ideal length {{idealLengthSec}} s (allowed {{min}}–{{max}}).

Examples of our best past clips (hook → views):
{{fewShot}}

Candidates (id, times, text, ±20 s context):
{{candidates}}

Pick the best {{n}}. For each:
- id, start, end: tighten so the first spoken line is already interesting (no warm-up, no "so", "um", "and") and it ends right after the payoff.
- scores (0–10 each): hook (first 3 s), standalone (makes sense alone), payoff (clear ending), emotion, novelty, quotability.
- hookA and hookB: on-screen text, max 7 words each, two different angles from this list: curiosity gap, bold claim, number/stat, question, "POV:"/story setup, contrarian. Must match what is actually said. No emojis, no ALL CAPS sentences.
- coldOpen: optional {start, end} of a 2–4 s punchline line from inside the clip that would work as a teaser at the very start; null if not clearly better.
- title (YouTube, max 70 chars), captionTiktok, captionInstagram, captionYoutube (different wording, max 150 chars, no hashtags), hashtags (3–5, niche-specific, no generic #fyp spam), emphasisWords (2–6 single words spoken in the clip).
- reason: one sentence.
```

### 8.3 Scoring in code
`final = 0.30*hook + 0.20*standalone + 0.20*payoff + 0.10*emotion + 0.10*novelty + 0.10*quotability` (×10 → 0–100). Weights in settings. The model's own ranking is ignored; code sorts by `final`.

### 8.4 Validation
zod-validate every response; on failure retry once with the error appended; then skip (SCOUT window) or fall back to SCOUT results with template hooks (EDIT). Hooks/captions filtered for banned words and length after the model.

---

## 9. Learning from results (few-shot loop)
- On the clip review page and a bulk table, operators can enter **views at 72 h** and the platform.
- The EDIT prompt includes the top 5 clips of the same niche from the last 30 days by `views72h` (hook used, first line, length), so hooks improve with the team's own data.
- Overview shows: average views by hook angle and by caption preset (simple table).

---

## 10. SFX library

### 10.1 Folder
```
assets/sfx/
  whoosh/      transition into the hook, cold-open transition
  pop/         emphasis words, list items
  impact/      big punchline, bold claim (use sparingly)
  riser/       build-up 1–2 s before a payoff
  ding/        number/stat reveal, "correct"
  transition/  scene changes, jump cuts
  glitch/      contrarian or "wait, what" moments
  click/       subtle UI-like ticks for zooms
  misc/        anything else (manual use only)
```
- Accepted formats: **mp3**, wav, ogg, m4a. Any file name. Sub-folder = category (new folders become new categories automatically).
- Only add sounds the team has the rights to use. No music in this folder.
- Optional `assets/sfx/sfx.json` per-file overrides: `{ "pop/soft-pop-02.mp3": { "gainDb": -4, "tags": ["soft"], "enabled": true } }`.

### 10.2 Scan (`pnpm sfx:scan`, also a button on `/sfx` and run on startup)
- Walk the folder, ffprobe duration, measure peak and LUFS, convert each to a cached 48 kHz stereo WAV in `assets/.cache/sfx/` normalized to a common level (short sounds: peak −6 dBFS; longer than 1.5 s: −20 LUFS), render a small waveform PNG. Upsert `sfx` rows; mark removed files disabled. Skip unchanged files (hash + mtime).
- Rendering always uses the cached WAVs (no MP3 decoding at render time).

### 10.3 Automatic placement (`edit/sfxPlanner.ts`)
| Moment | Category | subtle | normal | heavy |
| --- | --- | --- | --- | --- |
| Hook appears (0.0 s) | whoosh | ✓ | ✓ | ✓ |
| Cold-open → clip transition | whoosh / transition | ✓ | ✓ | ✓ |
| Emphasis word | pop | – | every 2nd | every one |
| Zoom punch-in | click | – | ✓ | ✓ |
| Payoff line (end − ~3 s) | impact | – | ✓ | ✓ |
| Number/stat word | ding | – | ✓ | ✓ |
| Scene cut / jump cut | transition | – | – | ✓ |
- Rules: min 1.5 s between any two cues (heavy: 1.0 s); never the same file twice in a row (random pick within category, seeded by clip id so re-renders are stable); never over the first 0.3 s of speech of a sentence if it would mask a word (shift to the gap before); gain = campaign `gainDb` + file `defaultGainDb`.

### 10.4 In the editor
- An SFX track under the player: each cue shows time, category and file; drag to move; click to preview; remove; **Add SFX at playhead** opens the library picker (filter by category/tag, play preview, pick). Edits save to `edit.sfxCues` and trigger a fast COMPOSE.
- `/sfx` page: browse the library, preview, enable/disable, set default gain, rescan.

---

## 11. Dashboard (apps/web)

| Page | What it does |
| --- | --- |
| **Overview** `/` | Today's sources and stage, clips awaiting review per operator, worker status, Deepgram minutes today / cap, disk usage, failed tasks with retry, hook-angle performance table |
| **New job** `/jobs/new` | Paste URLs (one per line) or drag-drop MP4s; pick campaign and operator; options: number of clips, length range override |
| **Job detail** `/jobs/[id]` | Stage progress, event log, transcript provider, grid of clips (thumbnail, score, length, chosen hook, status) |
| **Clip review/editor** `/clips/[id]` | 9:16 player with version compare; score breakdown; transcript with clickable (seek) and editable words (fix text, hide fillers); hook A/B pick or custom text; title + 3 platform captions + hashtags; trim nudges ±0.5/±1 s, extend/shorten by a sentence; pacing toggles; cold-open toggle with range; zoom off/subtle/punchy; layout + focus override; caption preset; SFX track (§10.4); **Fast re-render** (COMPOSE) and **Full re-render** (RENDER_BASE) with the correct one chosen automatically from what changed; Approve / Reject; **Download clean version** (`base.mp4` + `captions.srt`); **Upload final** (replace with a CapCut-edited MP4); copy buttons for platform captions (required hashtags appended); views-at-72h input; shortcuts A approve, R reject, J/K next/prev |
| **Campaigns** | CampaignConfig form, overlay upload, caption preset preview |
| **SFX** `/sfx` | Library browser (§10.4) |
| **Settings** | Operators, Deepgram cap, transcription order, LLM models, score weights, cleanup days, test buttons: Deepgram, OpenRouter (both models), FFmpeg QSV |

Media served by `/api/files/[...path]` with range support; paths validated to stay inside `STORAGE_DIR`.

---

## 12. Worker and resource limits

- **One heavy task at a time** (`MAX_HEAVY_TASKS=1`): TRANSCRIBE-whisper, ANALYZE, RENDER_BASE. Light tasks (INGEST download, SCOUT/EDIT LLM calls, FETCH_SECTIONS, COMPOSE, DELIVER) may run alongside, max 2 concurrent total. COMPOSE requested from the editor jumps the queue.
- **Low priority:** spawn FFmpeg and the Python service at below-normal priority (`os.setPriority` / Windows `BELOW_NORMAL_PRIORITY_CLASS`) and cap FFmpeg threads, so the laptop stays usable.
- **Python media service:** one long-lived process; loads Whisper only when first needed and unloads it after 10 min idle; MediaPipe model loaded once. Requests/responses are single JSON lines; logs on stderr.
- **No full-video decoding** anywhere in the normal path (audio-first ingest, section downloads, analysis on sections).
- Retries: 3 attempts, backoff 30 s / 2 min. Heartbeat every 30 s. On SIGINT finish or release the lease.
- Expected on the target laptop for one 60-min source (estimates): transcript 1–3 min (Deepgram) · LLM 2–4 min · sections download depends on bandwidth (~10 × 45 s) · analysis 1–2 min · base renders ~30–45 s per clip · compose 15–30 s per clip. Peak RAM ~3 GB; idle ~0.5 GB.

---

## 13. Setup (Windows)

```
winget install OpenJS.NodeJS.LTS
winget install Python.Python.3.11
winget install Gyan.FFmpeg
npm i -g pnpm
git clone <repo> && cd clip-engine
pnpm install
python -m pip install -r py/requirements.txt
copy .env.example .env   # fill keys and models
pnpm db:migrate
pnpm sfx:scan
pnpm build
start-clip-engine.bat    # daily use (production mode)
```
- Allow port 3000 in Windows Firewall (private network); others open `http://<main-pc-ip>:3000`.
- `ffmpeg -hide_banner -encoders | findstr qsv` must list `h264_qsv` (Settings has a test button).
- `pnpm doctor`: checks Node, Python, FFmpeg + QSV, yt-dlp, fonts present, SFX scanned, keys set, disk space ≥ 30 GB free; prints pass/fail.
- Laptop plugged in, power mode "Best performance" while processing.

---

## 14. Milestones (build in order; each ends with passing checks and a commit)

**M1 — Skeleton + data**: monorepo, Next.js, shared package, Drizzle schema + migrations, seed (2 operators, 1 campaign), `.env.example`, `pnpm doctor`, task queue API with leasing + priority + tests.
✅ `pnpm test` passes; dashboard loads.

**M2 — Ingest + transcription**: audio-first ingest, uploads, Python media service (long-lived), YouTube captions / Deepgram / Whisper chain with cap and usage, filler flagging.
✅ 10-min YouTube URL → transcript with words, without downloading video; captionless MP4 → Deepgram; no key → Whisper; usage shown.

**M3 — Two-pass selection**: SCOUT + EDIT prompts, zod + retry, merge/overlap removal, sentence snapping, leading-filler trim, length enforcement, score formula, banned-word filter.
✅ 60-min podcast → 8–10 clips inside range, no > 50% overlap, none starting/ending mid-word or on a filler, two distinct hooks each ≤ 7 words.

**M4 — Sections + analysis + plan**: section downloads with fallback, scenes/faces on sections, pacing + timeline map, cold open, layout/crop keyframes, zoom keyframes.
✅ Only clip sections downloaded (check bytes); one-speaker → `single` smooth; two-speaker → `split`; screen recording → `fit`; timeline map unit tests pass (word times correct after pause removal).

**M5 — SFX library**: folder scan, cache/normalize, waveforms, `/sfx` page, sfxPlanner rules + tests.
✅ Dropping new MP3s into a category folder and pressing Rescan makes them available; planner never places two cues < 1.5 s apart or repeats a file back-to-back.

**M6 — Render**: ASS generator (presets, safe zones, emphasis pop, hook), RENDER_BASE, COMPOSE (subtitles, overlay, progress bar, SFX mix, loudnorm), QSV with fallback, thumbnails.
✅ 1080×1920 output; captions in sync (±100 ms on 3 spot-checked words); nothing in bottom 20 % / right 12 %; whoosh at 0 s; ≈ −14 LUFS (`ebur128` check); 45 s clip: base < 60 s, compose < 30 s on target laptop.

**M7 — Review/editor + deliver + learning loop**: clip editor with all controls, automatic fast vs full re-render, version compare, clean download + SRT, upload final, approve → deliver, views-at-72h input, few-shot examples in EDIT prompt, cleanup job.
✅ Hook edit → fast re-render only; trim change → full re-render; approved file lands in operator folder (and Drive path if set) with caption sidecar.

**M8 — Optional**: remote workers on other office PCs (artifact upload/download over HTTP, `WORKER_TOKEN`), overnight batch mode, stats page, optional Remotion templates (check Remotion's license terms for team size first).

---

## 15. Rules for Claude Code (copy into CLAUDE.md)

- Build one milestone at a time from SPEC.md; do not start the next until its acceptance checks pass. Commit at the end of each milestone.
- TypeScript strict; zod for every external input (API bodies, LLM output, Python output, campaign config, `sfx.json`).
- Python media service: one JSON object per line on stdout; logs to stderr.
- FFmpeg commands are built by pure functions returning an args array; unit-test them without running FFmpeg.
- Unit tests required for: task leasing/priority, sentence snapping, filler trimming, timeline remapping, overlap removal, score formula, banned-word filter, ASS generation (safe zones), SFX planner rules, FFmpeg arg builders.
- Never decode the full source video in the normal path; prefer audio-only and sections.
- Windows paths must work (`path` module, quote paths with spaces, escape `:` and `\` in the `subtitles=` filter path).
- Never add features from the Non-goals list.
- When unsure about an external API's current parameters (Deepgram, OpenRouter, yt-dlp flags), check the official docs before coding.
