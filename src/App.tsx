import { useEffect, useMemo, useRef, useState } from 'react';
import { DropZone, type Picked } from './components/DropZone';
import { Thumbnail } from './components/Thumbnail';
import { errorText, fmtBytes, fmtTime, load, parseTime, save } from './lib/format';
import { DEFAULT_TEMPLATE, TEMPLATE_TOKENS, applyTemplate, toFileName } from './lib/naming';
import { probeAudio, probeVideo } from './lib/probe';
import { estimateSize, render } from './lib/render';
import './App.css';

type Slot = 'audio' | 'video' | 'intro' | 'outro';
type Status =
  | { kind: 'idle' }
  | { kind: 'running'; progress: number; stage: string; elapsed: number }
  | {
      kind: 'done';
      url: string | null;
      fileName: string;
      seconds: number;
      size: number | null;
      loudness?: { measured: number; gainDb: number };
    }
  | { kind: 'error'; message: string };

type SavePicker = (o: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;
const savePicker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;

const MEMORY_WARN_BYTES = 1.5 * 1024 ** 3;
const BITRATES = [
  { label: 'Low · 1 Mbps', value: 1_000_000 },
  { label: 'Medium · 2.5 Mbps', value: 2_500_000 },
  { label: 'High · 5 Mbps', value: 5_000_000 },
];

export default function App() {
  const [files, setFiles] = useState<Record<Slot, Picked>>({ audio: null, video: null, intro: null, outro: null });
  const [loading, setLoading] = useState<Slot | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  // audio
  const [trimStartText, setTrimStartText] = useState('0');
  const [trimEndText, setTrimEndText] = useState('0');
  const [normalize, setNormalize] = useState(() => load('normalize', true));
  const [targetLufs, setTargetLufs] = useState(() => load('targetLufs', -14));
  // video
  const [compress, setCompress] = useState(() => load('compress', false));
  const [maxHeight, setMaxHeight] = useState<number>(() => load('maxHeight', 1080));
  const [bitrate, setBitrate] = useState(() => load('bitrate', 2_500_000));
  // naming
  const [show, setShow] = useState(() => load('show', ''));
  const [episode, setEpisode] = useState(() => load('episode', 1));
  const [title, setTitle] = useState('');
  const [template, setTemplate] = useState(() => load('template', DEFAULT_TEMPLATE));
  const [bumpEpisode, setBumpEpisode] = useState(() => load('bumpEpisode', true));
  // Set after an export; the number goes up when the next episode's audio is loaded,
  // so the thumbnail made right after an export still shows the right episode.
  const [pendingBump, setPendingBump] = useState(() => load('pendingBump', false));

  useEffect(() => save('normalize', normalize), [normalize]);
  useEffect(() => save('targetLufs', targetLufs), [targetLufs]);
  useEffect(() => save('compress', compress), [compress]);
  useEffect(() => save('maxHeight', maxHeight), [maxHeight]);
  useEffect(() => save('bitrate', bitrate), [bitrate]);
  useEffect(() => save('show', show), [show]);
  useEffect(() => save('episode', episode), [episode]);
  useEffect(() => save('template', template), [template]);
  useEffect(() => save('bumpEpisode', bumpEpisode), [bumpEpisode]);
  useEffect(() => save('pendingBump', pendingBump), [pendingBump]);

  const { audio, video, intro, outro } = files;
  const running = status.kind === 'running';

  const baseName = applyTemplate(template, { show, episode, title }) || audio?.file.name.replace(/\.[^.]+$/, '') || 'video';
  const fileName = toFileName(baseName);

  const trimStart = parseTime(trimStartText);
  const trimEnd = parseTime(trimEndText);
  const trimValid =
    trimStart !== null && trimEnd !== null && (!audio || trimStart + trimEnd < audio.info.duration - 1);
  const mainDuration = audio && trimValid ? audio.info.duration - trimStart! - trimEnd! : 0;
  const introDur = intro?.info.duration ?? 0;
  const outroDur = outro?.info.duration ?? 0;
  const totalDuration = mainDuration + introDur + outroDur;

  const reencodeVideo = compress || !!intro || !!outro;
  const reencodeAudio = normalize || !!intro || !!outro;

  const estimate = useMemo(() => {
    if (!audio || !video || !mainDuration) return 0;
    return estimateSize({
      audioSize: audio.info.size,
      audioDuration: audio.info.duration,
      mainDuration,
      clipSize: video.info.size,
      clipDuration: video.info.duration,
      compressBitrate: compress ? bitrate : null,
      reencodeAudio,
      extraSize: (intro?.info.size ?? 0) + (outro?.info.size ?? 0),
    });
  }, [audio, video, intro, outro, mainDuration, compress, bitrate, reencodeAudio]);

  const pick = async (slot: Slot, file: File | undefined) => {
    if (!file) return;
    setLoading(slot);
    setStatus({ kind: 'idle' });
    try {
      const info = slot === 'audio' ? await probeAudio(file) : await probeVideo(file);
      const picked = { file, info, url: URL.createObjectURL(file) };
      setFiles((prev) => {
        if (prev[slot]) URL.revokeObjectURL(prev[slot]!.url);
        return { ...prev, [slot]: picked };
      });
      if (slot === 'audio' && pendingBump) {
        if (bumpEpisode) setEpisode((n) => n + 1);
        setTitle('');
        setTrimStartText('0');
        setTrimEndText('0');
        setPendingBump(false);
      }
    } catch (e) {
      setStatus({ kind: 'error', message: errorText(e) });
    } finally {
      setLoading(null);
    }
  };

  const clear = (slot: Slot) =>
    setFiles((prev) => {
      if (prev[slot]) URL.revokeObjectURL(prev[slot]!.url);
      return { ...prev, [slot]: null };
    });

  const generate = async () => {
    if (!audio || !video || !trimValid) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let writable: FileSystemWritableFileStream | undefined;
    if (savePicker) {
      try {
        const handle = await savePicker({
          suggestedName: fileName,
          types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
        });
        writable = await handle.createWritable();
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return;
        writable = undefined;
      }
    }

    const startedAt = performance.now();
    setStatus({ kind: 'running', progress: 0, stage: 'Starting', elapsed: 0 });
    try {
      const res = await render({
        audio: audio.file,
        video: video.file,
        intro: intro?.file,
        outro: outro?.file,
        trimStart: trimStart!,
        trimEnd: trimEnd!,
        normalize: normalize ? { targetLufs } : null,
        compress: compress ? { maxHeight: maxHeight || null, bitrate } : null,
        title: baseName,
        writable,
        signal: ctrl.signal,
        onProgress: (progress, stage) =>
          setStatus({ kind: 'running', progress, stage, elapsed: (performance.now() - startedAt) / 1000 }),
      });
      setStatus({
        kind: 'done',
        url: res.blob ? URL.createObjectURL(res.blob) : null,
        fileName,
        seconds: (performance.now() - startedAt) / 1000,
        size: res.blob?.size ?? null,
        loudness: res.loudness,
      });
      setPendingBump(true);
    } catch (e) {
      await writable?.abort().catch(() => {});
      if ((e as DOMException).name === 'AbortError') setStatus({ kind: 'idle' });
      else setStatus({ kind: 'error', message: errorText(e) });
    } finally {
      abortRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      if (status.kind === 'done' && status.url) URL.revokeObjectURL(status.url);
    };
  }, [status]);

  useEffect(() => {
    document.title = status.kind === 'running' ? `${Math.round(status.progress * 100)}% · Flimio` : 'Flimio';
  }, [status]);

  return (
    <main className="wrap">
      <header>
        <h1>Flimio</h1>
        <p className="sub">
          Turn a long audio recording and a short looping video into an MP4 ready for YouTube. Everything runs in your
          browser — your files never leave your computer.
        </p>
      </header>

      <section className="grid">
        <DropZone
          label="Audio"
          hint="m4a, mp3, aac, wav…"
          accept="audio/*,.m4a"
          picked={audio}
          loading={loading === 'audio'}
          disabled={running}
          onFile={(f) => pick('audio', f)}
        >
          {audio && <audio src={audio.url} controls preload="metadata" />}
        </DropZone>
        <DropZone
          label="Loop video"
          hint="a short clip, e.g. 10 seconds"
          accept="video/*,.mp4,.mov,.webm"
          picked={video}
          loading={loading === 'video'}
          disabled={running}
          onFile={(f) => pick('video', f)}
        >
          {video && <video src={video.url} autoPlay muted loop playsInline />}
        </DropZone>
        <DropZone
          label="Intro"
          hint="plays before the episode, with its own sound"
          accept="video/*,.mp4,.mov,.webm"
          picked={intro}
          loading={loading === 'intro'}
          disabled={running}
          optional
          compact
          onFile={(f) => pick('intro', f)}
          onClear={() => clear('intro')}
        />
        <DropZone
          label="Outro"
          hint="plays after the episode — handy for end screens"
          accept="video/*,.mp4,.mov,.webm"
          picked={outro}
          loading={loading === 'outro'}
          disabled={running}
          optional
          compact
          onFile={(f) => pick('outro', f)}
          onClear={() => clear('outro')}
        />
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Audio</h2>
        </div>
        <div className="field-row">
          <label className="field">
            Cut from start
            <input
              className={trimStart === null ? 'invalid' : ''}
              value={trimStartText}
              onChange={(e) => setTrimStartText(e.target.value)}
              placeholder="0:00"
              disabled={running}
            />
          </label>
          <label className="field">
            Cut from end
            <input
              className={trimEnd === null ? 'invalid' : ''}
              value={trimEndText}
              onChange={(e) => setTrimEndText(e.target.value)}
              placeholder="0:00"
              disabled={running}
            />
          </label>
          <div className="field hint-block">
            {audio && trimValid && (
              <span>
                Keeps {fmtTime(trimStart!)} → {fmtTime(audio.info.duration - trimEnd!)} ({fmtTime(mainDuration)})
              </span>
            )}
            {!trimValid && <span className="bad">Enter seconds (90) or minutes:seconds (1:30).</span>}
          </div>
        </div>
        <div className="field-row">
          <label className="check">
            <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} disabled={running} />
            Normalize loudness
          </label>
          <select
            value={targetLufs}
            onChange={(e) => setTargetLufs(Number(e.target.value))}
            disabled={!normalize || running}
          >
            <option value={-14}>-14 LUFS · YouTube</option>
            <option value={-16}>-16 LUFS · podcast standard</option>
            <option value={-12}>-12 LUFS · louder</option>
          </select>
          <span className="muted-inline">Evens out the volume and keeps peaks below -1 dB.</span>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Video</h2>
        </div>
        <div className="field-row">
          <label className="check">
            <input type="checkbox" checked={compress} onChange={(e) => setCompress(e.target.checked)} disabled={running} />
            Compress loop video
          </label>
          <select value={maxHeight} onChange={(e) => setMaxHeight(Number(e.target.value))} disabled={!compress || running}>
            <option value={0}>Original size</option>
            <option value={1080}>1080p</option>
            <option value={720}>720p</option>
          </select>
          <select value={bitrate} onChange={(e) => setBitrate(Number(e.target.value))} disabled={!compress || running}>
            {BITRATES.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
          <span className="muted-inline">Smaller file, faster upload. Only the short clip is re-encoded.</span>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Episode &amp; file name</h2>
        </div>
        <div className="field-row">
          <label className="field grow">
            Show name
            <input value={show} onChange={(e) => setShow(e.target.value)} placeholder="My Podcast" disabled={running} />
          </label>
          <label className="field narrow">
            Episode
            <input
              type="number"
              min={0}
              value={episode}
              onChange={(e) => setEpisode(Math.max(0, Number(e.target.value) || 0))}
              disabled={running}
            />
          </label>
          <label className="field grow2">
            Episode title
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What this episode is about" disabled={running} />
          </label>
        </div>
        <div className="field-row">
          <label className="field grow">
            Template
            <input value={template} onChange={(e) => setTemplate(e.target.value)} disabled={running} />
          </label>
          <button className="btn small ghost" onClick={() => setTemplate(DEFAULT_TEMPLATE)} disabled={running}>
            Reset
          </button>
        </div>
        <p className="muted-inline">
          Tokens: {TEMPLATE_TOKENS.map((t) => <code key={t}>{t}</code>)} — YouTube uses the file name as the initial
          video title.
        </p>
        <div className="filename">
          <span>File name</span>
          <strong>{fileName}</strong>
        </div>
        <label className="check">
          <input type="checkbox" checked={bumpEpisode} onChange={(e) => setBumpEpisode(e.target.checked)} />
          Increase the episode number when the next episode's audio is loaded
        </label>
      </section>

      {audio && video && (
        <section className="panel">
          <div className="summary">
            <Stat label="Output length" value={fmtTime(totalDuration)} />
            <Stat label="Loops" value={`≈ ${(mainDuration / video.info.duration).toFixed(1)}×`} />
            <Stat label="Estimated size" value={fmtBytes(estimate)} />
            <Stat
              label="Processing"
              value={!reencodeVideo && !reencodeAudio ? 'Copy only ⚡' : reencodeVideo && reencodeAudio ? 'Re-encode parts' : 'Mostly copy'}
            />
          </div>

          {!savePicker && estimate > MEMORY_WARN_BYTES && (
            <p className="warn">
              This browser can't write straight to disk, so the result is kept in memory (~{fmtBytes(estimate)}). For big
              files use Chrome or Edge, or turn on “Compress loop video”.
            </p>
          )}

          <div className="row">
            {running ? (
              <button className="btn ghost" onClick={() => abortRef.current?.abort()}>
                Cancel
              </button>
            ) : (
              <button className="btn" onClick={generate} disabled={!trimValid}>
                {savePicker ? 'Create & save video' : 'Create video'}
              </button>
            )}
          </div>

          {status.kind === 'running' && <Progress status={status} />}

          {status.kind === 'done' && (
            <div className="done">
              <p>
                ✅ Done in {status.seconds.toFixed(1)} s —{' '}
                {status.url ? (
                  <>
                    <strong>{status.fileName}</strong> ({fmtBytes(status.size ?? 0)})
                  </>
                ) : (
                  <>
                    saved as <strong>{status.fileName}</strong> in the folder you picked (usually Downloads).
                  </>
                )}
              </p>
              {status.loudness && Number.isFinite(status.loudness.measured) && (
                <p className="muted-inline">
                  Loudness: {status.loudness.measured.toFixed(1)} LUFS →{' '}
                  {(status.loudness.measured + status.loudness.gainDb).toFixed(1)} LUFS (
                  {status.loudness.gainDb >= 0 ? '+' : ''}
                  {status.loudness.gainDb.toFixed(1)} dB)
                  {status.loudness.gainDb >= 29.9 && ' — the recording is very quiet; boost was capped at +30 dB.'}
                </p>
              )}
              {status.url && (
                <>
                  <video src={status.url} controls className="result" />
                  <a className="btn" href={status.url} download={status.fileName}>
                    Download MP4
                  </a>
                </>
              )}
            </div>
          )}
        </section>
      )}

      {status.kind === 'error' && <p className="error">⚠️ {status.message}</p>}

      <Thumbnail
        video={video?.file ?? null}
        defaultTitle={title}
        defaultKicker={show || episode ? [show, `Episode ${episode}`].filter(Boolean).join(' · ') : ''}
        baseName={baseName}
      />

      <footer>
        Built with{' '}
        <a href="https://mediabunny.dev" target="_blank" rel="noreferrer">
          Mediabunny
        </a>{' '}
        · Nothing is uploaded anywhere.
      </footer>
    </main>
  );
}

function Progress({ status }: { status: Extract<Status, { kind: 'running' }> }) {
  const { elapsed, progress } = status;
  const eta = progress > 0.03 && elapsed > 1 ? elapsed / progress - elapsed : null;
  return (
    <div className="progress">
      <div className="bar">
        <div style={{ width: `${(progress * 100).toFixed(1)}%` }} />
      </div>
      <span>
        {status.stage} · {(progress * 100).toFixed(0)}%{eta !== null ? ` · ~${Math.ceil(eta)} s left` : ''}
      </span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
