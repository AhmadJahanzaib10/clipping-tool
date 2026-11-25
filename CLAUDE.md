# CLAUDE.md

The full project spec is in [SPEC.md](SPEC.md). Read it before working on this repo.

## Rules for Claude Code (SPEC.md §15)

- Build one milestone at a time from SPEC.md; do not start the next until its acceptance checks pass. Commit at the end of each milestone.
- TypeScript strict; zod for every external input (API bodies, LLM output, Python output, campaign config, `sfx.json`).
- Python media service: one JSON object per line on stdout; logs to stderr.
- FFmpeg commands are built by pure functions returning an args array; unit-test them without running FFmpeg.
- Unit tests required for: task leasing/priority, sentence snapping, filler trimming, timeline remapping, overlap removal, score formula, banned-word filter, ASS generation (safe zones), SFX planner rules, FFmpeg arg builders.
- Never decode the full source video in the normal path; prefer audio-only and sections.
- Windows paths must work (`path` module, quote paths with spaces, escape `:` and `\` in the `subtitles=` filter path).
- Never add features from the Non-goals list.
- When unsure about an external API's current parameters (Deepgram, OpenRouter, yt-dlp flags), check the official docs before coding.
