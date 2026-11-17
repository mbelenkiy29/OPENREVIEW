# README demo recording

Records the public interactive demo at [openreview.tech](https://openreview.tech) (sample data only: acme/shop #42). It never signs in and never uses tokens, accounts, or private repositories.

## Prerequisites

- Playwright Chromium: `pnpm exec playwright install chromium`
- `ffmpeg` on `PATH`
- `gifski` on `PATH` (`cargo install gifski`)

## Record

From the repository root:

```sh
pnpm exec tsx scripts/demo/record.ts
```

Writes:

- `docs/images/demo.gif` — 860px wide, ~12 fps, looping, under 8 MB
- `docs/images/demo.mp4` — H.264, same storyboard
- `docs/images/demo-short.gif` — ~8 s cut of the summary + P0 quotes, under 3 MB when it fits

Scratch files land in `output/demo/` (gitignored). Override the source with `--url` only for a local landing page, and set `DEMO_ALLOW_LOCAL=1`.

The storyboard follows the live sample-data demo. If a beat is missing on the site, the recorder skips it rather than faking UI.
