import { useEffect, useMemo, useRef, useState } from 'react';
import { DropZone, type Picked } from './components/DropZone';
import { Thumbnail } from './components/Thumbnail';
import { ErrorNotice, describeError } from './components/ui';
import { fmtBytes, fmtTime, load, parseTime, save } from './lib/format';
import { DEFAULT_TEMPLATE, TEMPLATE_TOKENS, applyTemplate, toFileName } from './lib/naming';
import { probeAudio, probeVideo } from './lib/probe';
import { estimateSize, render } from './lib/render';
import './styles/base.css';
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
  | { kind: 'error'; message: string; details: string };

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
const TIME_FORMAT_ERROR = 'Enter seconds (90) or minutes:seconds (1:30).';

export default function App() {
  const [files, setFiles] = useState<Record<Slot, Picked>>({ audio: null, video: null, intro: null, outro: null });
  const [loading, setLoading] = useState<Slot | null>(null);
  const [fileError, setFileError] = useState<Partial<Record<Slot, string>>>({});
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [submitted, setSubmitted] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // audio (trim values are drafts: they survive a refresh)
  const [trimStartText, setTrimStartText] = useState(() => load('trimStart', '0'));
  const [trimEndText, setTrimEndText] = useState(() => load('trimEnd', '0'));
  const [trimUi, setTrimUi] = useState({ start: { touched: false, editing: false }, end: { touched: false, editing: false } });
  // Fast mode = the original copy-only pipeline: no re-encoding, a 20-minute video in seconds.
  const [fastMode, setFastMode] = useState(() => load('fastMode', true));
  const [normalize, setNormalize] = useState(() => load('normalize', true));
  const [targetLufs, setTargetLufs] = useState(() => load('targetLufs', -14));
  // video
  const [compress, setCompress] = useState(() => load('compress', false));
  const [maxHeight, setMaxHeight] = useState<number>(() => load('maxHeight', 1080));
  const [bitrate, setBitrate] = useState(() => load('bitrate', 2_500_000));
  // naming
  const [show, setShow] = useState(() => load('show', ''));
  const [episode, setEpisode] = useState(() => load('episode', 1));
  const [title, setTitle] = useState(() => load('title', ''));
  const [template, setTemplate] = useState(() => load('template', DEFAULT_TEMPLATE));
  const [bumpEpisode, setBumpEpisode] = useState(() => load('bumpEpisode', true));
  // Set after an export; the number goes up when the next episode's audio is loaded,
  // so the thumbnail made right after an export still shows the right episode.
  const [pendingBump, setPendingBump] = useState(() => load('pendingBump', false));

  const persisted = { fastMode, trimStart: trimStartText, trimEnd: trimEndText, normalize, targetLufs, compress, maxHeight, bitrate, show, episode, title, template, bumpEpisode, pendingBump };
  useEffect(() => {
    for (const [k, v] of Object.entries(persisted)) save(k, v);
  });

  const { audio, video } = files;
  // Features that need re-encoding are ignored in Fast mode.
  const intro = fastMode ? null : files.intro;
  const outro = fastMode ? null : files.outro;
  const useNormalize = !fastMode && normalize;
  const useCompress = !fastMode && compress;
  const running = status.kind === 'running';

  // Warn before leaving with work in progress (files can't be restored after a reload).
  useEffect(() => {
    const dirty = running || !!audio || !!video;
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [running, audio, video]);

  const baseName = applyTemplate(template, { show, episode, title }) || audio?.file.name.replace(/\.[^.]+$/, '') || 'video';
  const fileName = toFileName(baseName);

  // ---- trim validation: on blur, cleared while editing ----
  const trimStart = parseTime(trimStartText);
  const trimEnd = parseTime(trimEndText);
  const startFormatError = trimStart === null ? TIME_FORMAT_ERROR : null;
  const endFormatError = trimEnd === null ? TIME_FORMAT_ERROR : null;
  const rangeError =
    !startFormatError && !endFormatError && audio && trimStart! + trimEnd! >= audio.info.duration - 1
      ? 'That cuts the whole recording. Cut less so at least 1 second remains.'
      : null;
  const shown = (key: 'start' | 'end', err: string | null) =>
    err && (trimUi[key].touched || submitted) && !trimUi[key].editing ? err : null;
  const startErrorShown = shown('start', startFormatError);
  const endErrorShown = shown('end', endFormatError ?? rangeError);
  const trimValid = !startFormatError && !endFormatError && !rangeError;
  const fieldHandlers = (key: 'start' | 'end') => ({
    onFocus: () => setTrimUi((u) => ({ ...u, [key]: { ...u[key], editing: true } })),
    onBlur: () => setTrimUi((u) => ({ ...u, [key]: { touched: true, editing: false } })),
  });

  const mainDuration = audio && trimValid ? audio.info.duration - trimStart! - trimEnd! : audio?.info.duration ?? 0;
  const totalDuration = mainDuration + (intro?.info.duration ?? 0) + (outro?.info.duration ?? 0);
  const reencodeVideo = useCompress || !!intro || !!outro;
  const reencodeAudio = useNormalize || !!intro || !!outro;

  const estimate = useMemo(() => {
    if (!audio || !video || !mainDuration) return 0;
    return estimateSize({
      audioSize: audio.info.size,
      audioDuration: audio.info.duration,
      mainDuration,
      clipSize: video.info.size,
      clipDuration: video.info.duration,
      compressBitrate: useCompress ? bitrate : null,
      reencodeAudio,
      extraSize: (intro?.info.size ?? 0) + (outro?.info.size ?? 0),
    });
  }, [audio, video, intro, outro, mainDuration, useCompress, bitrate, reencodeAudio]);

  const pick = async (slot: Slot, file: File | undefined) => {
    if (!file) return;
    setLoading(slot);
    setFileError((e) => ({ ...e, [slot]: undefined }));
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
      setFileError((err) => ({ ...err, [slot]: describeError(e, 'This file could not be read. Choose another file.').message }));
    } finally {
      setLoading(null);
    }
  };

  const clear = (slot: Slot) =>
    setFiles((prev) => {
      if (prev[slot]) URL.revokeObjectURL(prev[slot]!.url);
      return { ...prev, [slot]: null };
    });

  const missingAudio = !audio ? 'Add an audio file to create the video.' : null;
  const missingVideo = !video ? 'Add a loop video to create the video.' : null;

  const generate = async () => {
    setSubmitted(true);
    setTrimUi({ start: { touched: true, editing: false }, end: { touched: true, editing: false } });
    // Submit stays clickable: point to the first problem instead.
    const firstProblem = missingAudio ? 'drop-audio' : missingVideo ? 'drop-video' : !trimValid ? (startFormatError ? 'trim-start' : 'trim-end') : null;
    if (firstProblem) {
      const el = document.getElementById(firstProblem);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      (el?.matches('input') ? el : el?.querySelector<HTMLElement>('button:last-of-type'))?.focus({ preventScroll: true });
      return;
    }
    if (!audio || !video) return;

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
        normalize: useNormalize ? { targetLufs } : null,
        compress: useCompress ? { maxHeight: maxHeight || null, bitrate } : null,
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
      else {
        const { message, details } = describeError(
          e,
          'Rendering stopped because of a browser error. Try again, or copy the error details for support.',
        );
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

  useEffect(() => {
    document.title = status.kind === 'running' ? `${Math.round(status.progress * 100)}% · Flimio` : 'Flimio';
  }, [status]);

  const processing =
    !reencodeVideo && !reencodeAudio ? (fastMode ? 'Fast mode · no re-encoding' : 'Copy only (fastest)') : reencodeVideo && reencodeAudio ? 'Re-encodes audio and clip' : reencodeAudio ? 'Re-encodes audio' : 'Re-encodes clip';

  return (
    <main className="page">
      <header className="page-head">
        <h1>Flimio</h1>
        <p className="lede">
          Turn a long audio recording and a short looping video into an MP4 ready for YouTube. Everything runs in your
          browser — your files never leave your computer.
        </p>
      </header>

      <div className={`mode ${fastMode ? 'on' : ''}`}>
        <label className="check">
          <input type="checkbox" checked={fastMode} onChange={(e) => setFastMode(e.target.checked)} disabled={running} />
          <span>
            <strong>Fast mode</strong> — no re-encoding
          </span>
        </label>
        <p className="helper">
          {fastMode
            ? 'Audio and video are copied as-is, so a 20-minute video is ready in seconds. Trim, file name and thumbnail still work. Turn off to use loudness normalization, clip compression, intro and outro — those re-encode and take minutes.'
            : 'Loudness normalization, clip compression, intro and outro are available. They re-encode the audio or video, so exporting takes minutes instead of seconds.'}
        </p>
      </div>

      <section className="section" aria-labelledby="h-files">
        <h2 id="h-files">Files</h2>
        <div className="grid-2">
          <DropZone
            id="drop-audio"
            label="Audio"
            hint="The episode recording — m4a, mp3, wav."
            accept="audio/*,.m4a"
            picked={audio}
            loading={loading === 'audio'}
            disabled={running}
            required
            error={fileError.audio ?? (submitted ? missingAudio : null)}
            onFile={(f) => pick('audio', f)}
          >
            {audio && <audio src={audio.url} controls preload="metadata" />}
          </DropZone>
          <DropZone
            id="drop-video"
            label="Loop video"
            hint="A short clip, e.g. 10 seconds."
            accept="video/*,.mp4,.mov,.webm"
            picked={video}
            loading={loading === 'video'}
            disabled={running}
            required
            error={fileError.video ?? (submitted ? missingVideo : null)}
            onFile={(f) => pick('video', f)}
          >
            {video && <video src={video.url} autoPlay muted loop playsInline />}
          </DropZone>
          <DropZone
            label="Intro"
            hint={fastMode ? 'Turn off Fast mode to add an intro.' : 'Plays before the episode, with its own sound.'}
            accept="video/*,.mp4,.mov,.webm"
            picked={files.intro}
            loading={loading === 'intro'}
            disabled={running || fastMode}
            note={fastMode && files.intro ? 'Not used in Fast mode.' : null}
            error={fileError.intro}
            onFile={(f) => pick('intro', f)}
            onClear={() => clear('intro')}
          />
          <DropZone
            label="Outro"
            hint={fastMode ? 'Turn off Fast mode to add an outro.' : 'Plays after the episode — handy for end screens.'}
            accept="video/*,.mp4,.mov,.webm"
            picked={files.outro}
            loading={loading === 'outro'}
            disabled={running || fastMode}
            note={fastMode && files.outro ? 'Not used in Fast mode.' : null}
            error={fileError.outro}
            onFile={(f) => pick('outro', f)}
            onClear={() => clear('outro')}
          />
        </div>
      </section>

      <section className="section" aria-labelledby="h-audio">
        <h2 id="h-audio">Audio</h2>
        <div className="row">
          <label className="field">
            Cut from start
            <input
              id="trim-start"
              inputMode="decimal"
              value={trimStartText}
              onChange={(e) => setTrimStartText(e.target.value)}
              {...fieldHandlers('start')}
              placeholder="0:00"
              disabled={running}
              aria-invalid={!!startErrorShown}
              aria-describedby="trim-help"
            />
            {startErrorShown && <span className="error-text">{startErrorShown}</span>}
          </label>
          <label className="field">
            Cut from end
            <input
              id="trim-end"
              inputMode="decimal"
              value={trimEndText}
              onChange={(e) => setTrimEndText(e.target.value)}
              {...fieldHandlers('end')}
              placeholder="0:00"
              disabled={running}
              aria-invalid={!!endErrorShown}
              aria-describedby="trim-help"
            />
            {endErrorShown && <span className="error-text">{endErrorShown}</span>}
          </label>
        </div>
        <p className="helper" id="trim-help">
          {audio && trimValid
            ? `Keeps ${fmtTime(trimStart!)} → ${fmtTime(audio.info.duration - trimEnd!)} (${fmtTime(mainDuration)}).`
            : 'Seconds (90) or minutes:seconds (1:30).'}
        </p>
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={useNormalize} onChange={(e) => setNormalize(e.target.checked)} disabled={running || fastMode} />
            Normalize loudness
          </label>
          <label className="field">
            Target loudness
            <select value={targetLufs} onChange={(e) => setTargetLufs(Number(e.target.value))} disabled={!useNormalize || running}>
              <option value={-14}>-14 LUFS · YouTube</option>
              <option value={-16}>-16 LUFS · podcast standard</option>
              <option value={-12}>-12 LUFS · louder</option>
            </select>
          </label>
        </div>
        <p className="helper">
          {fastMode
            ? 'Turn off Fast mode to normalize loudness.'
            : 'Evens out the volume and keeps peaks below -1 dB. Re-encodes the audio, so exporting takes minutes.'}
        </p>
      </section>

      <section className="section" aria-labelledby="h-video">
        <h2 id="h-video">Video</h2>
        <label className="check">
          <input type="checkbox" checked={useCompress} onChange={(e) => setCompress(e.target.checked)} disabled={running || fastMode} />
          Compress loop video
        </label>
        <div className="row">
          <label className="field">
            Resolution
            <select value={maxHeight} onChange={(e) => setMaxHeight(Number(e.target.value))} disabled={!useCompress || running}>
              <option value={0}>Original size</option>
              <option value={1080}>1080p</option>
              <option value={720}>720p</option>
            </select>
          </label>
          <label className="field">
            Bitrate
            <select value={bitrate} onChange={(e) => setBitrate(Number(e.target.value))} disabled={!useCompress || running}>
              {BITRATES.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="helper">
          {fastMode
            ? 'Turn off Fast mode to compress the loop video.'
            : 'Smaller file, faster upload. Only the short clip is re-encoded.'}
        </p>
      </section>

      <section className="section" aria-labelledby="h-episode">
        <h2 id="h-episode">Episode &amp; file name</h2>
        <div className="row">
          <label className="field">
            Show name
            <input value={show} onChange={(e) => setShow(e.target.value)} placeholder="Core Concepts" disabled={running} />
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
        </div>
        <label className="field">
          Episode title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="REST vs gRPC" disabled={running} />
        </label>
        <div className="row">
          <label className="field">
            File name template
            <input value={template} onChange={(e) => setTemplate(e.target.value)} disabled={running} aria-describedby="tpl-help" />
          </label>
          <button className="btn secondary" onClick={() => setTemplate(DEFAULT_TEMPLATE)} disabled={running || template === DEFAULT_TEMPLATE}>
            Reset template
          </button>
        </div>
        <p className="helper" id="tpl-help">
          Tokens: {TEMPLATE_TOKENS.join(' ')}. YouTube uses the file name as the first video title.
        </p>
        <p className="filename">
          <span className="helper">File name</span>
          <span className="filename-value">{fileName}</span>
        </p>
        <label className="check">
          <input type="checkbox" checked={bumpEpisode} onChange={(e) => setBumpEpisode(e.target.checked)} />
          Increase the episode number when the next episode’s audio is loaded
        </label>
      </section>

      {status.kind === 'done' && status.url && (
        <section className="section" aria-labelledby="h-result">
          <h2 id="h-result">Result</h2>
          <div className="result">
            <video src={status.url} controls />
          </div>
        </section>
      )}

      <Thumbnail video={video?.file ?? null} show={show} episode={episode} title={title} baseName={baseName} />

      <div className="actionbar" aria-live="polite">
        {status.kind === 'error' && (
          <ErrorNotice
            message={status.message}
            details={status.details}
            actions={
              <button className="btn secondary compact" onClick={generate}>
                Try again
              </button>
            }
          />
        )}
        {!savePicker && estimate > MEMORY_WARN_BYTES && (
          <p className="notice warn">
            This browser keeps the result in memory (~{fmtBytes(estimate)}). Use Chrome or Edge for big files
            {fastMode ? '.' : ', or turn on “Compress loop video”.'}
          </p>
        )}
        {status.kind === 'running' && <Progress status={status} />}
        {status.kind === 'done' && (
          <p className="done-line">
            Done in {status.seconds.toFixed(1)} s —{' '}
            {status.url ? (
              <>
                <strong>{status.fileName}</strong> ({fmtBytes(status.size ?? 0)})
              </>
            ) : (
              <>
                saved as <strong>{status.fileName}</strong> in the folder you picked (usually Downloads).
              </>
            )}
            {status.loudness && Number.isFinite(status.loudness.measured) && (
              <span className="helper">
                {' '}
                Loudness {status.loudness.measured.toFixed(1)} → {(status.loudness.measured + status.loudness.gainDb).toFixed(1)} LUFS
                {status.loudness.gainDb >= 29.9 && ' (very quiet recording — boost capped at +30 dB)'}.
              </span>
            )}
          </p>
        )}
        <div className="actionbar-row">
          <div className="actionbar-stats">
            {audio && video ? (
              <>
                <span>
                  Length <strong>{fmtTime(totalDuration)}</strong>
                </span>
                <span>
                  Loops <strong>≈ {(mainDuration / video.info.duration).toFixed(1)}×</strong>
                </span>
                <span>
                  Size <strong>≈ {fmtBytes(estimate)}</strong>
                </span>
                <span>
                  <strong>{processing}</strong>
                </span>
              </>
            ) : (
              <span>Add an audio file and a loop video to create the video.</span>
            )}
          </div>
          <div className="actionbar-buttons">
            {status.kind === 'done' && status.url && (
              <a className="btn secondary" href={status.url} download={status.fileName}>
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
        Built with{' '}
        <a href="https://mediabunny.dev" target="_blank" rel="noreferrer">
          Mediabunny
        </a>
        . Nothing is uploaded anywhere.
      </footer>
    </main>
  );
}

function Progress({ status }: { status: Extract<Status, { kind: 'running' }> }) {
  const { elapsed, progress } = status;
  const eta = progress > 0.03 && elapsed > 1 ? elapsed / progress - elapsed : null;
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
      <div className="bar">
        <div style={{ transform: `scaleX(${progress})` }} />
      </div>
      <span>
        {status.stage} · {(progress * 100).toFixed(0)}%{eta !== null ? ` · ~${Math.ceil(eta)} s left` : ''}
      </span>
    </div>
  );
}
