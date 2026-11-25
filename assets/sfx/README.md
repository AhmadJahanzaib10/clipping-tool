# SFX library

Put sound effects the team has the rights to use into a folder per category (SPEC §10.1).
The folder name is the category; new folders become new categories automatically.

| Folder        | Used for (automatic placement, SPEC §10.3)       |
| ------------- | ------------------------------------------------ |
| `whoosh/`     | hook at 0.0 s, cold-open transition              |
| `pop/`        | emphasis words, list items                       |
| `impact/`     | the payoff near the end (use sparingly)          |
| `riser/`      | build-up before a payoff                         |
| `ding/`       | numbers / stats                                  |
| `transition/` | scene changes, jump cuts (heavy intensity)       |
| `glitch/`     | contrarian or "wait, what" moments               |
| `click/`      | zoom punch-ins                                   |
| `misc/`       | anything else (manual use only)                  |

- Formats: mp3, wav, ogg, m4a. Any file name. No music here.
- After adding or removing files: press **Rescan** on the `/sfx` page or run `pnpm sfx:scan`
  (the dashboard also scans on startup). Unchanged files are skipped.
- A campaign only uses the categories listed in its SFX settings (default: whoosh, pop, impact, transition).
- Optional per-file overrides in `sfx.json` next to this file:

```json
{ "pop/soft-pop-02.mp3": { "gainDb": -4, "tags": ["soft"], "enabled": true } }
```
