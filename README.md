# Flimio

**Live:** https://abdullayevilkin.github.io/flimio/

Turn a long audio recording (e.g. a 10–20 minute podcast in `.m4a`) and a short looping video (e.g. a 10 second `.mp4`) into an MP4 ready for YouTube. Runs entirely in the browser — files never leave your computer.

## Features

- **Fast mode** (on by default) — audio and video are copied without re-encoding, so a 20-minute video is ready in seconds. Trim, file name template and thumbnail still work. Turn it off for loudness normalization, clip compression and intro/outro, which re-encode and take minutes.

- **Loop video over audio** — the clip repeats until the audio ends, cut exactly at the end.
- **Trim audio** — cut seconds (or `m:ss`) from the start and the end.
- **Normalize loudness** — measures integrated loudness (ITU-R BS.1770 / EBU R128) and brings it to -14 LUFS (YouTube), -16 or -12, with a look-ahead limiter keeping peaks below -1 dBFS.
- **Intro & outro** — optional clips played before/after the episode with their own sound; other sizes are letterboxed.
- **Compress loop video** — re-encode only the short clip to 1080p/720p at 1–5 Mbps for a much smaller file and faster upload.
- **File name template** — `{show} - Episode {n} - {title}` (tokens `{show}`, `{n}`, `{nn}`, `{title}`, `{date}`); also written into the MP4 title metadata. The episode number goes up when the next episode's audio is loaded.
- **Thumbnail generator** — a frame from the loop video (or any image) with a big text (e.g. `EPISODE {n}`) and a small text (e.g. `{title}`); 6 bundled fonts (Anton, Bebas Neue, Oswald, Montserrat, Inter, Playfair), 9 positions, shadow / outline / highlight box, zoom & pan, brightness, blur, overlay, logo, feed-size preview and the YouTube length badge guide. Exports 1280×720 JPG (≤ 2 MB) or PNG. All style settings are remembered in the browser for the next episode.
- **Publish to YouTube** — after the video is created, sign in with Google and upload it straight from the browser (title, description, visibility). It uses the YouTube Data API v3 resumable upload; the file goes from your browser to YouTube only. You need your own Google OAuth *Web application* client ID (paste it in the page, or set `VITE_GOOGLE_CLIENT_ID` at build time) with this site listed under Authorized JavaScript origins.
- **Create & upload to YouTube** — one button renders the video in the browser's private storage and uploads it right away, then sets the thumbnail from step 5 (thumbnails need a phone-verified channel). “Create & save video” still just saves the file.
- **Remember loop** — keeps the loop clip in the browser (IndexedDB) so you only add the new audio next time.
- **Description template** — `{show}` `{n}` `{nn}` `{title}` `{date}` are filled in for each video; the template is remembered.
- **Bulk queue** — add many audio files (same loop for all, or one loop per episode matched by file-name order). Each one is rendered and optionally uploaded, with a per-run upload cap, a pause between uploads, automatic stop on YouTube quota / upload-limit errors, optional scheduled publishing (`publishAt`, one video every N days) and an “uploaded earlier” memory so the queue can be continued the next day. Needs a Chromium-based browser.

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
- `src/components/YouTube.tsx`, `src/lib/youtube.ts` — Google sign-in and YouTube upload

## Deploy

Every push to `main` builds and deploys to GitHub Pages via `.github/workflows/deploy.yml`.

### Bulk queue controls

- **Skip wait** (row, panel or bottom bar) ends the current pause and starts the next episode in 1 second.
- **Start from here** on a not-started row starts the queue at that episode (useful after the computer was off).
- The bottom bar shows the running episode, progress, time since Start, the next-episode countdown and the last result or error.
- The bar's timer starts after the Google sign-in, turns red after 1 hour and sends a browser notification once (allow notifications when asked).
- Both waits (between uploads and the long pause) are in seconds, and every wait gets a random 1–10 seconds added.
- With 2 or more episodes, the bottom “Create & upload to YouTube” button starts the bulk queue; with one episode it renders and uploads that episode.
- The thumbnail's Big text defaults to `{show}` (the Show name).
