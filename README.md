# Flimio

**Live:** https://abdullayevilkin.github.io/flimio/

Turn a long audio recording (e.g. a 10–20 minute podcast in `.m4a`) and a short looping video (e.g. a 10 second `.mp4`) into an MP4 ready for YouTube. Runs entirely in the browser — files never leave your computer.

## Features

- **Loop video over audio** — the clip repeats until the audio ends, cut exactly at the end.
- **Trim audio** — cut seconds (or `m:ss`) from the start and the end.
- **Normalize loudness** — measures integrated loudness (ITU-R BS.1770 / EBU R128) and brings it to -14 LUFS (YouTube), -16 or -12, with a look-ahead limiter keeping peaks below -1 dBFS.
- **Intro & outro** — optional clips played before/after the episode with their own sound; other sizes are letterboxed.
- **Compress loop video** — re-encode only the short clip to 1080p/720p at 1–5 Mbps for a much smaller file and faster upload.
- **File name template** — `{show} - Episode {n} - {title}` (tokens `{show}`, `{n}`, `{nn}`, `{title}`, `{date}`); also written into the MP4 title metadata. The episode number goes up when the next episode's audio is loaded.
- **Thumbnail generator** — a frame from the loop video (or any image) plus title text, exported as a 1280×720 JPG under 2 MB.

## How it works

Built on [Mediabunny](https://mediabunny.dev). Each stream uses the cheapest path:

| | Copy (no re-encode) | Re-encode |
|---|---|---|
| Video | default — clip packets are copied and their timestamps shifted per loop | when compressing or adding an intro/outro; only the short pieces are encoded, with one encoder so they share a decoder config, then looped by packet copy |
| Audio | default — packets copied, trimmed at packet precision | when normalizing or adding an intro/outro; decoded, trimmed sample-accurately, gain + limiter, AAC (native WebCodecs, or a WASM fallback via `@mediabunny/aac-encoder`) |

In Chrome/Edge the result is written straight to disk via the File System Access API; other browsers build it in memory and offer a download.

## Development

```bash
npm install
npm run dev      # http://localhost:5173/flimio/
npm run build    # dist/
```

- `src/lib/render.ts` — the render pipeline (framework-agnostic)
- `src/lib/loudness.ts` — loudness meter and limiter
- `src/lib/naming.ts` — file name template
- `src/components/Thumbnail.tsx` — thumbnail generator

## Deploy

Every push to `main` builds and deploys to GitHub Pages via `.github/workflows/deploy.yml`.
