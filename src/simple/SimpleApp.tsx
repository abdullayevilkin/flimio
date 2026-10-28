import { useEffect, useRef, useState } from 'react';
import {
  estimateOutputSize,
  loopMerge,
  probeAudio,
  probeVideo,
  type MediaInfo,
} from './loopMerge';
import { DropZone } from '../components/DropZone';
import { ErrorNotice, describeError } from '../components/ui';
import '../styles/base.css';
import './simple.css';

type Picked = { file: File; info: MediaInfo; url: string } | null;
type Status =
  | { kind: 'idle' }
  | { kind: 'running'; progress: number; elapsed: number }
  | { kind: 'done'; url: string | null; savedToDisk: boolean; seconds: number; size: number }
  | { kind: 'error'; message: string; details: string };

// File System Access API (Chrome/Edge) — writes the result straight to disk
type SavePicker = (o: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;
const savePicker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;

const MEMORY_WARN_BYTES = 1.5 * 1024 ** 3;

export default function App() {
  const [audio, setAudio] = useState<Picked>(null);
  const [video, setVideo] = useState<Picked>(null);
  const [loading, setLoading] = useState<'audio' | 'video' | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [name, setName] = useState('podcast.mp4');
  const abortRef = useRef<AbortController | null>(null);

  const pick = async (kind: 'audio' | 'video', file: File | undefined) => {
    if (!file) return;
    setLoading(kind);
    setStatus({ kind: 'idle' });
    try {
      const info = kind === 'audio' ? await probeAudio(file) : await probeVideo(file);
      const picked = { file, info, url: URL.createObjectURL(file) };
      const set = kind === 'audio' ? setAudio : setVideo;
      set((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return picked;
      });
      if (kind === 'audio') setName(file.name.replace(/\.[^.]+$/, '') + '.mp4');
    } catch (e) {
      const { message, details } = describeError(e, 'This file could not be read. Choose another file.');
      setStatus({ kind: 'error', message, details });
    } finally {
      setLoading(null);
    }
  };

  const [submitted, setSubmitted] = useState(false);
  const generate = async () => {
    setSubmitted(true);
    if (!audio || !video) {
      const el = document.getElementById(!audio ? 'drop-audio' : 'drop-video');
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.querySelector<HTMLElement>('button:last-of-type')?.focus({ preventScroll: true });
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let writable: FileSystemWritableFileStream | undefined;
    if (savePicker) {
      try {
        const handle = await savePicker({
          suggestedName: name,
          types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
        });
        writable = await handle.createWritable();
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return; // the user closed the dialog
        writable = undefined; // not supported: build in memory
      }
    }

    const startedAt = performance.now();
    setStatus({ kind: 'running', progress: 0, elapsed: 0 });
    try {
      const res = await loopMerge({
        audio: audio.file,
        video: video.file,
        writable,
        signal: ctrl.signal,
        onProgress: (p) =>
          setStatus({ kind: 'running', progress: p, elapsed: (performance.now() - startedAt) / 1000 }),
      });
      setStatus({
        kind: 'done',
        url: res.blob ? URL.createObjectURL(res.blob) : null,
        savedToDisk: !res.blob,
        seconds: (performance.now() - startedAt) / 1000,
        size: res.blob?.size ?? estimateOutputSize(audio.info, video.info),
      });
    } catch (e) {
      await writable?.abort().catch(() => {});
      if ((e as DOMException).name === 'AbortError') setStatus({ kind: 'idle' });
      else {
        const { message, details } = describeError(e, 'Rendering stopped because of a browser error. Try again, or copy the error details for support.');
        setStatus({ kind: 'error', message, details });
      }
    } finally {
      abortRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      if (status.kind === 'done' && status.url) URL.revokeObjectURL(status.url);
    };
  }, [status]);

  const est = audio && video ? estimateOutputSize(audio.info, video.info) : 0;
  const running = status.kind === 'running';

  return (
    <main className="page">
      <nav className="topnav" aria-label="Versions">
        <a href="./">Open full version (trim, loudness, intro/outro, thumbnails)</a>
      </nav>
      <header className="page-head">
        <h1>Flimio · Simple</h1>
        <p className="lede">
          Pick a long audio (m4a) and a short video (mp4) — the video repeats until the audio ends. Nothing is
          re-encoded, so even a 20-minute video is ready in seconds. Everything runs in your browser.
        </p>
      </header>

      <section className="section" aria-labelledby="h-files">
        <h2 id="h-files">Files</h2>
        <div className="grid-2">
          <DropZone
            id="drop-audio"
            label="Audio"
            hint="The episode recording — m4a, mp3, aac."
            accept="audio/*,.m4a"
            picked={audio}
            loading={loading === 'audio'}
            disabled={running}
            required
            error={submitted && !audio ? 'Add an audio file to create the video.' : null}
            onFile={(f) => pick('audio', f)}
          >
            {audio && <audio src={audio.url} controls preload="metadata" />}
          </DropZone>
          <DropZone
            id="drop-video"
            label="Loop video"
            hint="A short mp4 clip, e.g. 10 seconds."
            accept="video/*,.mp4,.mov,.webm"
            picked={video}
            loading={loading === 'video'}
            disabled={running}
            required
            error={submitted && !video ? 'Add a loop video to create the video.' : null}
            onFile={(f) => pick('video', f)}
          >
            {video && <video src={video.url} autoPlay muted loop playsInline />}
          </DropZone>
        </div>
      </section>

      <section className="section" aria-labelledby="h-output">
        <h2 id="h-output">Output</h2>
        <label className="field">
          File name
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={running} />
        </label>
        {status.kind === 'done' && status.url && (
          <div className="result">
            <video src={status.url} controls />
          </div>
        )}
      </section>

      <div className="actionbar" aria-live="polite">
        {status.kind === 'error' && (
          <ErrorNotice
            message={status.message}
            details={status.details}
            actions={
              audio && video ? (
                <button className="btn secondary compact" onClick={generate}>
                  Try again
                </button>
              ) : undefined
            }
          />
        )}
        {!savePicker && est > MEMORY_WARN_BYTES && (
          <p className="notice warn">
            This browser keeps the result in memory (~{fmtBytes(est)}). Use Chrome or Edge for big files.
          </p>
        )}
        {status.kind === 'running' && <Progress status={status} />}
        {status.kind === 'done' && (
          <p className="helper">
            Done in {status.seconds.toFixed(1)} s
            {status.savedToDisk ? ' — saved to the folder you picked (usually Downloads).' : ` (${fmtBytes(status.size)}).`}
          </p>
        )}
        <div className="actionbar-row">
          <div className="actionbar-stats">
            {audio && video ? (
              <>
                <span>
                  Length <strong>{fmtTime(audio.info.duration)}</strong>
                </span>
                <span>
                  Loops <strong>≈ {(audio.info.duration / video.info.duration).toFixed(1)}×</strong>
                </span>
                <span>
                  Size <strong>≈ {fmtBytes(est)}</strong>
                </span>
                <span>
                  <strong>No re-encoding</strong>
                </span>
              </>
            ) : (
              <span>Add an audio file and a loop video to create the video.</span>
            )}
          </div>
          <div className="actionbar-buttons">
            {status.kind === 'done' && status.url && (
              <a className="btn secondary" href={status.url} download={name}>
                Download MP4
              </a>
            )}
            {running ? (
              <button className="btn secondary" onClick={() => abortRef.current?.abort()}>
                Cancel rendering
              </button>
            ) : (
              <button className="btn" onClick={generate}>
                {savePicker ? 'Create & save video' : 'Create video'}
              </button>
            )}
          </div>
        </div>
      </div>

      <footer className="footer">
        Packets are copied directly (stream copy) — built with{' '}
        <a href="https://mediabunny.dev" target="_blank" rel="noreferrer">
          Mediabunny
        </a>
        .
      </footer>
    </main>
  );
}

function Progress({ status }: { status: Extract<Status, { kind: 'running' }> }) {
  const { elapsed } = status;
  const eta = status.progress > 0.02 ? elapsed / status.progress - elapsed : null;
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(status.progress * 100)}>
      <div className="bar">
        <div style={{ transform: `scaleX(${status.progress})` }} />
      </div>
      <span>
        {(status.progress * 100).toFixed(0)}%{eta !== null ? ` · ~${Math.ceil(eta)} s left` : ''}
      </span>
    </div>
  );
}

function fmtTime(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return `${h ? h + ':' : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

function fmtBytes(b: number) {
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}
