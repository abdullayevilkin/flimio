import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DropZone, type Picked } from './components/DropZone';
import { Thumbnail } from './components/Thumbnail';
import { ErrorNotice, FoldButton, SectionHead, SectionNav, describeError, useFold } from './components/ui';
import { fmtBytes, fmtTime, load, parseTime, save } from './lib/format';
import { clearLoop, loadLoop, saveLoop } from './lib/loopStore';
import { useYoutube } from './lib/useYoutube';
import { DEFAULT_TEMPLATE, TEMPLATE_TOKENS, applyTemplate, titleFromFileName, toFileName } from './lib/naming';
import { probeAudio, probeVideo } from './lib/probe';
import { estimateSize, render } from './lib/render';
import './styles/base.css';
import { YouTube } from './components/YouTube';
import { Bulk, type BulkControl, type BulkStatus } from './components/Bulk';
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
      getFile: () => Promise<Blob>;
      /** 'picked' = saved where you chose; 'temp' = kept in the browser for the YouTube upload */
      where: 'picked' | 'temp' | 'memory';
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
  const foldFiles = useFold('files');
  const foldAudio = useFold('audio');
  const foldEpisode = useFold('episode');
  const foldResult = useFold('result');
  const foldVideo = useFold('video', !load('fastMode', true));
  const [normOpen, setNormOpen] = useState<boolean>(() => load('fold.loudness', !load('fastMode', true)));
  useEffect(() => save('fold.loudness', normOpen), [normOpen]);
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
  const [bulkCount, setBulkCount] = useState({ n: 0, running: false });
  const bulkMode = bulkCount.n >= 2;
  const onBulkCount = useCallback((n: number, running: boolean) => setBulkCount((c) => (c.n === n && c.running === running ? c : { n, running })), []);
  const [uploadStart, setUploadStart] = useState<number | null>(null); // single upload: the clock starts after the Google sign-in
  const bulkRef = useRef<BulkControl | null>(null);
  const [bulkStatus, setBulkStatus] = useState<BulkStatus | null>(null);
  const [bulkPreview, setBulkPreview] = useState<{ video: File | null; episode: number; title: string } | null>(null);
  const [rememberLoop, setRememberLoop] = useState(() => load('rememberLoop', false));
  const [loopFromStore, setLoopFromStore] = useState(false);
  const [bumpEpisode, setBumpEpisode] = useState(() => load('bumpEpisode', true));
  // Set after an export; the number goes up when the next episode's audio is loaded,
  // so the thumbnail made right after an export still shows the right episode.
  const [pendingBump, setPendingBump] = useState(() => load('pendingBump', false));

  const persisted = { fastMode, trimStart: trimStartText, trimEnd: trimEndText, normalize, targetLufs, compress, maxHeight, bitrate, show, episode, title, template, bumpEpisode, pendingBump, rememberLoop };
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
  const audioWarning = (() => {
    if (!audio) return null;
    const small = audio.info.size < 8 * 1024 * 1024;
    const short = audio.info.duration < 30;
    if (!small && !short) return null;
    const what = small && short ? 'small and short' : small ? 'small' : 'short';
    return `This audio looks ${what} (${fmtBytes(audio.info.size)}, ${fmtTime(audio.info.duration)}). Check that you picked the right recording.`;
  })();

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
  const yt = useYoutube({
    defaultTitle: fileName.replace(/\.[a-z0-9]{2,4}$/i, ''),
    fields: { show, episode, title },
    video: video?.file ?? null,
  });

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

  const pick = async (slot: Slot, file: File | undefined, fromStore = false) => {
    if (!file) return;
    setLoading(slot);
    setFileError((e) => ({ ...e, [slot]: undefined }));
    try {
      const info = slot === 'audio' ? await probeAudio(file) : await probeVideo(file);
      const picked = { file, info, url: URL.createObjectURL(file) };
      if (slot === 'video') {
        setLoopFromStore(fromStore);
        if (rememberLoop && !fromStore) void saveLoop(file).catch(() => {});
      }
      setFiles((prev) => {
        if (prev[slot]) URL.revokeObjectURL(prev[slot]!.url);
        return { ...prev, [slot]: picked };
      });
      if (slot === 'audio') {
        const t = titleFromFileName(file.name);
        if (t) setTitle(t);
        else if (pendingBump) setTitle('');
      }
      if (slot === 'audio' && pendingBump) {
        if (bumpEpisode) setEpisode((n) => n + 1);
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

  // Restore the remembered loop clip on start.
  useEffect(() => {
    if (rememberLoop) void loadLoop().then((f) => f && pick('video', f, true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clear = (slot: Slot) =>
    setFiles((prev) => {
      if (prev[slot]) URL.revokeObjectURL(prev[slot]!.url);
      return { ...prev, [slot]: null };
    });

  const missingAudio = !audio ? 'Add an audio file to create the video.' : null;
  const missingVideo = !video ? 'Add a loop video to create the video.' : null;

  const generate = async (mode: 'save' | 'upload' = 'save') => {
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

    if (mode === 'upload') {
      // Sign in first, inside the click, so the Google popup is not blocked after a long render.
      if (!yt.id || !yt.titleOk) {
        document.getElementById('youtube')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        yt.setState({ kind: 'error', message: !yt.id ? 'Paste your Google OAuth client ID in step 6 first.' : 'Give the video a title (up to 100 characters) in step 6.', details: '' });
        return;
      }
      try {
        await yt.ensureSession();
        setUploadStart(Date.now());
      } catch {
        document.getElementById('youtube')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }
    yt.resetTitle();

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let writable: FileSystemWritableFileStream | undefined;
    let handle: FileSystemFileHandle | undefined;
    let where: 'picked' | 'temp' | 'memory' = 'memory';
    if (mode === 'save' && savePicker) {
      try {
        handle = await savePicker({
          suggestedName: fileName,
          types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
        });
        writable = await handle.createWritable();
        where = 'picked';
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return;
        writable = undefined;
      }
    } else if (mode === 'upload') {
      // No save dialog: render into the browser's private disk space, then upload from there.
      try {
        const root = await navigator.storage.getDirectory();
        for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
          if (name.startsWith('flimio-upload-')) await root.removeEntry(name).catch(() => {});
        }
        handle = await root.getFileHandle(`flimio-upload-${Date.now()}.mp4`, { create: true });
        writable = await handle.createWritable();
        where = 'temp';
      } catch {
        writable = undefined;
        handle = undefined;
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
      const file = res.blob ?? (await handle!.getFile());
      setStatus({
        kind: 'done',
        url: res.blob ? URL.createObjectURL(res.blob) : where === 'temp' ? URL.createObjectURL(file) : null,
        where,
        fileName,
        seconds: (performance.now() - startedAt) / 1000,
        size: res.blob?.size ?? (where === 'temp' ? file.size : null),
        loudness: res.loudness,
        getFile: async () => file,
      });
      setPendingBump(true);
      if (mode === 'upload') void yt.publish(file);
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
        <div className="titlerow">
          <h1>Flimio</h1>
          <span className="epbadge" title="Current episode number">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 1.5l1.9 4.1 4.5.5-3.3 3 .9 4.4L8 11.3l-4 2.2.9-4.4-3.3-3 4.5-.5L8 1.5z" fill="currentColor" />
            </svg>
            Episode {episode}
          </span>
        </div>
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

      <SectionNav
        items={[
          { id: 'files', label: 'Files' },
          { id: 'audio', label: 'Audio' },
          { id: 'video', label: 'Video' },
          { id: 'episode', label: 'Episode' },
          { id: 'thumbnail', label: 'Thumbnail' },
          { id: 'youtube', label: 'YouTube', focus: '#yt-upload' },
          { id: 'bulk', label: 'Bulk' },
        ]}
      />

      <section className={foldFiles.cls} id="files" aria-labelledby="h-files">
        <SectionHead id="h-files" fold={foldFiles} n={1} title="Files" sub="Your recording, the clip to loop, and an optional intro and outro." />
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
            warning={audioWarning}
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
            note={loopFromStore ? 'Loaded from your saved loop. Choose another file to replace it.' : null}
            error={fileError.video ?? (submitted ? missingVideo : null)}
            onFile={(f) => pick('video', f)}
          >
            {video && <video src={video.url} autoPlay muted loop playsInline />}
            {video && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={rememberLoop}
                  onChange={(e) => {
                    setRememberLoop(e.target.checked);
                    if (e.target.checked) void saveLoop(video.file).catch(() => {});
                    else {
                      void clearLoop().catch(() => {});
                      setLoopFromStore(false);
                    }
                  }}
                />
                Remember this loop on this device
              </label>
            )}
          </DropZone>
          <DropZone
            label="Intro"
            hint={fastMode ? 'Turn off Fast mode to add an intro.' : 'Plays before the episode, with its own sound.'}
            accept="video/*,.mp4,.mov,.webm"
            picked={files.intro}
            loading={loading === 'intro'}
            disabled={running || fastMode}
            dimmed={fastMode}
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
            dimmed={fastMode}
            note={fastMode && files.outro ? 'Not used in Fast mode.' : null}
            error={fileError.outro}
            onFile={(f) => pick('outro', f)}
            onClear={() => clear('outro')}
          />
        </div>
      </section>

      <section className={foldAudio.cls} id="audio" aria-labelledby="h-audio">
        <SectionHead id="h-audio" fold={foldAudio} n={2} title="Audio" sub="Trim the recording and even out its volume." />
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
        <div className={normOpen ? 'subfold' : 'subfold collapsed'}>
          <div className="subfold-head clickable" onClick={() => setNormOpen((o) => !o)}>
            <FoldButton open={normOpen} onClick={(e) => { e.stopPropagation(); setNormOpen((o) => !o); }} label="loudness settings" />
            <strong>Loudness</strong>
            {fastMode && <span className="fast-note">Turn off Fast mode to normalize loudness.</span>}
          </div>
          <div className="subfold-body">
        <div className={`row ${fastMode ? 'off' : ''}`}>
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
        {!fastMode && (
          <p className="helper">Evens out the volume and keeps peaks below -1 dB. Re-encodes the audio, so exporting takes minutes.</p>
        )}
          </div>
        </div>

      </section>

      <section className={foldVideo.cls} id="video" aria-labelledby="h-video">
        <SectionHead id="h-video" fold={foldVideo} n={3} title="Video" sub="Make the loop clip smaller for a faster upload." />
        <div className={`feature ${fastMode ? 'off' : ''}`}>
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
        </div>
        {fastMode ? (
          <p className="fast-note keep">Turn off Fast mode to compress the loop video.</p>
        ) : (
          <p className="helper">Smaller file, faster upload. Only the short clip is re-encoded.</p>
        )}
      </section>

      <section className={foldEpisode.cls} id="episode" aria-labelledby="h-episode">
        <SectionHead id="h-episode" fold={foldEpisode} n={4} title="Episode & file name" sub="Name the file the way YouTube will first show it." />
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
        <section className={foldResult.cls} aria-labelledby="h-result">
          <SectionHead id="h-result" fold={foldResult} title="Result" sub="Preview the video before you download it." />
          <div className="result">
            <video src={status.url} controls />
          </div>
        </section>
      )}

      <Thumbnail
        video={video?.file ?? (bulkPreview?.video ?? null)}
        show={show}
        episode={!video && bulkPreview ? bulkPreview.episode : episode}
        title={!video && bulkPreview ? bulkPreview.title : title}
        baseName={baseName}
      />

      <YouTube
        yt={yt}
        fileReady={status.kind === 'done'}
        size={status.kind === 'done' ? status.size : null}
        onUpload={async () => {
          if (status.kind !== 'done') return;
          try {
            await yt.ensureSession();
          } catch {
            return;
          }
          setUploadStart(Date.now());
          await yt.publish(await status.getFile());
        }}
      />

      <Bulk
        yt={yt}
        show={show}
        template={template}
        startEpisode={episode}
        sharedLoop={video?.file ?? null}
        onPreview={setBulkPreview}
        onCount={onBulkCount}
        controlRef={bulkRef}
        onStatus={setBulkStatus}
        makeOpts={(o) => ({
          audio: o.audio,
          video: o.video,
          intro: intro?.file,
          outro: outro?.file,
          trimStart: 0,
          trimEnd: 0,
          normalize: useNormalize ? { targetLufs } : null,
          compress: useCompress ? { maxHeight: maxHeight || null, bitrate } : null,
          title: o.title,
          writable: o.writable as never,
          signal: o.signal,
          onProgress: o.onProgress,
        })}
      />

      <div className="actionbar" aria-live="polite">
        {status.kind === 'error' && (
          <ErrorNotice
            message={status.message}
            details={status.details}
            actions={
              <button className="btn secondary compact" onClick={() => generate()}>
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
        {uploadStart !== null && !bulkMode && (running || yt.state.kind === 'uploading') && (
          <p className="bulkbar-head">
            Upload running for <strong><Elapsed since={uploadStart} /></strong>
          </p>
        )}
        {status.kind === 'running' && <Progress status={status} />}
        {status.kind === 'done' && (
          <p className="done-line">
            Done in {status.seconds.toFixed(1)} s —{' '}
            {status.where !== 'picked' ? (
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
        {yt.state.kind === 'uploading' && (
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(yt.state.progress * 100)}>
            <div className="bar">
              <div style={{ transform: `scaleX(${yt.state.progress})` }} />
            </div>
            <span>Uploading to YouTube · {(yt.state.progress * 100).toFixed(0)}%</span>
          </div>
        )}
        {yt.state.kind === 'done' && (
          <p className="done-line">
            On YouTube ({yt.state.privacy}):{' '}
            <a href={yt.state.video.url} target="_blank" rel="noreferrer">
              {yt.state.video.url}
            </a>
            {yt.state.thumb === 'set' && ' · thumbnail set'}
            {typeof yt.state.thumb === 'object' && ' · thumbnail not set (see step 6)'}
          </p>
        )}
        {yt.state.kind === 'error' && <p className="error-text">YouTube: {yt.state.message} Fix it in step 6 and use “Upload to YouTube” there.</p>}
        {bulkMode && bulkStatus && <BulkBar s={bulkStatus} />}
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
            {bulkStatus?.running ? (
              <>
                {bulkStatus.countdown !== null && (
                  <button className="btn secondary" onClick={() => bulkRef.current?.skipWait()} title="Skip the wait: the next episode starts in 1 second">
                    Skip wait
                  </button>
                )}
                <button className="btn secondary" onClick={() => bulkRef.current?.stop()}>
                  Stop queue
                </button>
              </>
            ) : running ? (
              <button className="btn secondary" onClick={() => abortRef.current?.abort()}>
                Cancel rendering
              </button>
            ) : yt.state.kind === 'uploading' ? (
              <button className="btn secondary" onClick={yt.cancel}>
                Cancel upload
              </button>
            ) : (
              <>
                <button
                  className="btn secondary"
                  onClick={() => (bulkMode ? bulkRef.current?.start() : void generate('upload'))}
                  disabled={yt.busy || (bulkMode && !bulkStatus?.canStart)}
                  title={bulkMode ? 'Starts the bulk queue (step 7)' : undefined}
                >
                  {bulkMode ? `Create & upload all ${bulkCount.n} to YouTube` : 'Create & upload to YouTube'}
                </button>
                <button className="btn" onClick={() => generate('save')} disabled={yt.busy || bulkMode}>
                  {savePicker ? 'Create & save video' : 'Create video'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <footer className="footer">
        Built with{' '}
        <a href="https://mediabunny.dev" target="_blank" rel="noreferrer">
          Mediabunny
        </a>
        . Nothing is uploaded anywhere unless you publish to YouTube yourself.
      </footer>
    </main>
  );
}

const HOUR = 3600;
/** Time since the queue started (after the Google sign-in). Turns red after one hour and sends a notification once. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  const notified = useRef(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.round((now - since) / 1000));
  const over = secs >= HOUR;
  useEffect(() => {
    if (!over || notified.current) return;
    notified.current = true;
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Flimio: 1 hour passed', { body: 'The bulk queue has been running for an hour. The Google sign-in may have expired, so check the page.' });
    }
  }, [over]);
  return <span className={over ? 'overdue' : undefined}>{fmtTime(secs)}</span>;
}

/** The queue (step 7) as seen from the bottom bar: what runs now, how long it has been going, the last result. */
function BulkBar({ s }: { s: BulkStatus }) {
  return (
    <div className="bulkbar">
      <p className="bulkbar-head">
        <strong>Bulk queue</strong> · {s.done} of {s.total} uploaded
        {s.startedAt !== null && (
          <>
            {' '}
            · running for <strong><Elapsed since={s.startedAt} /></strong>
          </>
        )}
      </p>
      {s.current && (
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(s.current.progress * 100)}>
          <div className="bar">
            <div style={{ transform: `scaleX(${s.current.progress})` }} />
          </div>
          <span>
            Episode {s.current.episode} · {s.current.title || 'untitled'} · {s.current.stage === 'rendering' ? 'Rendering' : 'Uploading'} {Math.round(s.current.progress * 100)}%
          </span>
        </div>
      )}
      {s.countdown !== null && (
        <p className="helper">
          Next episode in <strong>{fmtTime(s.countdown)}</strong> ({s.pauseWhy})
        </p>
      )}
      {s.lastDone && (
        <p className="done-line">
          ✓ Episode {s.lastDone.episode} {s.lastDone.title ? `“${s.lastDone.title}” ` : ''}uploaded
          {s.lastDone.url && (
            <>
              :{' '}
              <a href={s.lastDone.url} target="_blank" rel="noreferrer">
                {s.lastDone.url}
              </a>
            </>
          )}
        </p>
      )}
      {s.lastError && <p className="error-text">Episode {s.lastError.episode} failed: {s.lastError.message}</p>}
      {s.note && <p className="warn-text" role="status"><span>{s.note}</span></p>}
    </div>
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
