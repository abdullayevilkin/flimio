import { useEffect, useRef, useState } from 'react';
import {
  estimateOutputSize,
  loopMerge,
  probeAudio,
  probeVideo,
  type MediaInfo,
} from './lib/loopMerge';
import './App.css';

type Picked = { file: File; info: MediaInfo; url: string } | null;
type Status =
  | { kind: 'idle' }
  | { kind: 'running'; progress: number; elapsed: number }
  | { kind: 'done'; url: string | null; savedToDisk: boolean; seconds: number; size: number }
  | { kind: 'error'; message: string };

// File System Access API (Chrome/Edge) — nəticəni birbaşa diskə yazmaq üçün
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
      setStatus({ kind: 'error', message: errorText(e) });
    } finally {
      setLoading(null);
    }
  };

  const generate = async () => {
    if (!audio || !video) return;
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
        if ((e as DOMException).name === 'AbortError') return; // istifadəçi pəncərəni bağladı
        writable = undefined; // dəstəklənmirsə yaddaşa yazırıq
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

  const est = audio && video ? estimateOutputSize(audio.info, video.info) : 0;
  const running = status.kind === 'running';

  return (
    <main className="wrap">
      <header>
        <h1>Audio + Loop Video → MP4</h1>
        <p className="sub">
          Uzun audio (m4a) və qısa video (mp4) seçin — video audionun sonuna qədər təkrarlanır.
          Hər şey brauzerdə işləyir, fayllar heç yerə yüklənmir.
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
          label="Video"
          hint="qısa mp4 klip (məs. 10 san)"
          accept="video/*,.mp4,.mov,.webm"
          picked={video}
          loading={loading === 'video'}
          disabled={running}
          onFile={(f) => pick('video', f)}
        >
          {video && <video src={video.url} autoPlay muted loop playsInline />}
        </DropZone>
      </section>

      {audio && video && (
        <section className="panel">
          <div className="summary">
            <Stat label="Nəticə müddəti" value={fmtTime(audio.info.duration)} />
            <Stat
              label="Loop sayı"
              value={`≈ ${(audio.info.duration / video.info.duration).toFixed(1)}×`}
            />
            <Stat label="Təxmini ölçü" value={fmtBytes(est)} />
            <Stat label="Re-encode" value="yoxdur ⚡" />
          </div>

          {!savePicker && est > MEMORY_WARN_BYTES && (
            <p className="warn">
              Bu brauzer faylı birbaşa diskə yaza bilmir, nəticə yaddaşda yığılacaq (~{fmtBytes(est)}).
              Böyük fayllar üçün Chrome və ya Edge tövsiyə olunur.
            </p>
          )}

          <div className="row">
            <label className="name">
              Fayl adı
              <input value={name} onChange={(e) => setName(e.target.value)} disabled={running} />
            </label>
            {running ? (
              <button className="btn ghost" onClick={() => abortRef.current?.abort()}>
                Ləğv et
              </button>
            ) : (
              <button className="btn" onClick={generate}>
                {savePicker ? 'Yarat və yadda saxla' : 'Video yarat'}
              </button>
            )}
          </div>

          {status.kind === 'running' && <Progress status={status} />}

          {status.kind === 'done' && (
            <div className="done">
              <p>
                ✅ Hazırdır — {status.seconds.toFixed(1)} saniyəyə
                {status.savedToDisk ? ', fayl seçdiyiniz yerə yazıldı.' : ` (${fmtBytes(status.size)}).`}
              </p>
              {status.url && (
                <>
                  <video src={status.url} controls className="result" />
                  <a className="btn" href={status.url} download={name}>
                    MP4-ü yüklə
                  </a>
                </>
              )}
            </div>
          )}
        </section>
      )}

      {status.kind === 'error' && <p className="error">⚠️ {status.message}</p>}

      <footer>
        Paketlər birbaşa kopyalanır (stream copy) —{' '}
        <a href="https://mediabunny.dev" target="_blank" rel="noreferrer">
          Mediabunny
        </a>{' '}
        ilə.
      </footer>
    </main>
  );
}

function DropZone(props: {
  label: string;
  hint: string;
  accept: string;
  picked: Picked;
  loading: boolean;
  disabled: boolean;
  onFile: (f: File | undefined) => void;
  children?: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  const { picked } = props;
  return (
    <div
      className={`drop ${over ? 'over' : ''} ${picked ? 'has' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!props.disabled) props.onFile(e.dataTransfer.files[0]);
      }}
    >
      <div className="drop-head">
        <strong>{props.label}</strong>
        <label className="btn small ghost">
          {picked ? 'Dəyiş' : 'Fayl seç'}
          <input
            type="file"
            accept={props.accept}
            hidden
            disabled={props.disabled}
            onChange={(e) => {
              props.onFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </label>
      </div>
      {props.loading && <p className="muted">Oxunur…</p>}
      {!picked && !props.loading && (
        <p className="muted">
          Faylı bura atın və ya seçin
          <br />
          <small>{props.hint}</small>
        </p>
      )}
      {picked && (
        <>
          <p className="file" title={picked.file.name}>
            {picked.file.name}
          </p>
          <p className="meta">
            {fmtTime(picked.info.duration)} · {picked.info.codec ?? '?'} · {fmtBytes(picked.info.size)}
            {picked.info.width ? ` · ${picked.info.width}×${picked.info.height}` : ''}
          </p>
          <div className="preview">{props.children}</div>
        </>
      )}
    </div>
  );
}

function Progress({ status }: { status: Extract<Status, { kind: 'running' }> }) {
  const { elapsed } = status;
  const eta = status.progress > 0.02 ? elapsed / status.progress - elapsed : null;
  return (
    <div className="progress">
      <div className="bar">
        <div style={{ width: `${(status.progress * 100).toFixed(1)}%` }} />
      </div>
      <span>
        {(status.progress * 100).toFixed(0)}%{eta !== null ? ` · ~${Math.ceil(eta)} san qalıb` : ''}
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

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
