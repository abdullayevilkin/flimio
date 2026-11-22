import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtBytes, fmtTime, load, save } from '../lib/format';
import { applyTemplate, fillTemplate, titleFromFileName, toFileName } from '../lib/naming';
import { render, type RenderOptions } from '../lib/render';
import type { Youtube } from '../lib/useYoutube';
import { isLimitError, setThumbnail, signIn, uploadVideo } from '../lib/youtube';
import { renderThumbnailBlob } from './Thumbnail';
import { FileButton, SectionHead, useFold } from './ui';

type ItemState = 'queued' | 'rendering' | 'uploading' | 'done' | 'error' | 'earlier';
type Runtime = { state: ItemState; progress?: number; link?: string; message?: string };
type Entry = { file: File; title: string };

const key = (f: File) => `${f.name}|${f.size}`;
const natural = (a: File, b: File) => a.name.localeCompare(b.name, undefined, { numeric: true });
const DAY = 86_400_000;

type DirPicker = () => Promise<FileSystemDirectoryHandle>;
const dirPicker = (window as unknown as { showDirectoryPicker?: DirPicker }).showDirectoryPicker;

export type MakeOpts = (o: {
  audio: File;
  video: File;
  title: string;
  writable: WritableStream<never>;
  signal: AbortSignal;
  onProgress: (p: number, stage: string) => void;
}) => RenderOptions;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/** Many episodes in one go: render each one, optionally upload it, with pauses and limits that keep YouTube happy. */
export function Bulk(props: { yt: Youtube; show: string; template: string; startEpisode: number; sharedLoop: File | null; makeOpts: MakeOpts }) {
  const { yt } = props;
  const fold = useFold('bulk', false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loops, setLoops] = useState<File[]>([]);
  const [loopMode, setLoopMode] = useState<'shared' | 'each'>('shared');
  const [startEp, setStartEp] = useState(props.startEpisode);
  const startEdited = useRef(false);
  useEffect(() => {
    if (!startEdited.current) setStartEp(props.startEpisode);
  }, [props.startEpisode]);

  const [upload, setUpload] = useState<boolean>(() => load('bulk.upload', true));
  const [cap, setCap] = useState<number>(() => load('bulk.cap', 5));
  const [gap, setGap] = useState<number>(() => load('bulk.gap', 2));
  const [schedule, setSchedule] = useState<boolean>(() => load('bulk.schedule', false));
  const [scheduleStart, setScheduleStart] = useState<string>(() => load('bulk.scheduleStart', ''));
  const [everyDays, setEveryDays] = useState<number>(() => load('bulk.everyDays', 1));
  const [dir, setDir] = useState<FileSystemDirectoryHandle | null>(null);
  useEffect(() => save('bulk.upload', upload), [upload]);
  useEffect(() => save('bulk.cap', cap), [cap]);
  useEffect(() => save('bulk.gap', gap), [gap]);
  useEffect(() => save('bulk.schedule', schedule), [schedule]);
  useEffect(() => save('bulk.scheduleStart', scheduleStart), [scheduleStart]);
  useEffect(() => save('bulk.everyDays', everyDays), [everyDays]);

  const [rt, setRt] = useState<Record<string, Runtime>>({});
  const [doneMap, setDoneMap] = useState<Record<string, string>>(() => load('bulk.done', {}));
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const startMs = scheduleStart ? new Date(scheduleStart).getTime() : NaN;
  const scheduleOk = !schedule || (Number.isFinite(startMs) && startMs > Date.now() + 5 * 60_000);
  const eachMismatch = loopMode === 'each' && loops.length !== entries.length;

  const items = useMemo(
    () =>
      entries.map((e, i) => {
        const id = key(e.file);
        const loop = loopMode === 'shared' ? props.sharedLoop : loops[i] ?? null;
        const runtime: Runtime = rt[id] ?? (doneMap[id] ? { state: 'earlier', link: doneMap[id] } : { state: 'queued' });
        const publishAt = upload && schedule && Number.isFinite(startMs) ? new Date(startMs + i * everyDays * DAY).toISOString() : undefined;
        return { id, e, loop, episode: startEp + i, runtime, publishAt };
      }),
    [entries, loops, loopMode, props.sharedLoop, rt, doneMap, startEp, upload, schedule, startMs, everyDays],
  );
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    if (!running) return;
    const h = (ev: BeforeUnloadEvent) => (ev.preventDefault(), (ev.returnValue = ''));
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [running]);

  const addAudios = (list: File[] | undefined) => {
    if (!list) return;
    const have = new Set(entries.map((x) => key(x.file)));
    const add = [...list].filter((f) => !have.has(key(f))).map((file) => ({ file, title: titleFromFileName(file.name) }));
    setEntries((prev) => [...prev, ...add].sort((a, b) => natural(a.file, b.file)));
  };
  const patch = (id: string, r: Runtime) => setRt((prev) => ({ ...prev, [id]: r }));

  const counts = {
    done: items.filter((i) => i.runtime.state === 'done' || i.runtime.state === 'earlier').length,
    left: items.filter((i) => i.runtime.state === 'queued' || i.runtime.state === 'error').length,
  };
  const noOpfs = !('storage' in navigator) || !navigator.storage.getDirectory;
  const canStart =
    !running && counts.left > 0 && !eachMismatch && scheduleOk && !noOpfs && items.every((i) => i.loop || i.runtime.state === 'earlier' || i.runtime.state === 'done') && (!upload || !!yt.id);

  const run = async () => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRunning(true);
    setNote(null);
    let uploads = 0;
    let errorsInARow = 0;
    try {
      if (upload) await yt.ensureSession(); // inside the click, so the Google popup is allowed
      const root = await navigator.storage.getDirectory();
      const todo = itemsRef.current.filter((i) => i.runtime.state === 'queued' || i.runtime.state === 'error');
      for (let n = 0; n < todo.length; n++) {
        if (ctrl.signal.aborted) break;
        if (upload && uploads >= cap) {
          setNote(`Reached your limit of ${cap} uploads for this run. ${todo.length - n} left in the queue — press Start again later (or tomorrow).`);
          break;
        }
        const it = itemsRef.current.find((x) => x.id === todo[n].id)!;
        const fields = { show: props.show, episode: it.episode, title: it.e.title };
        const baseName = applyTemplate(props.template, fields) || it.e.title || `episode-${it.episode}`;
        const tempName = `flimio-bulk-${Date.now()}.mp4`;
        patch(it.id, { state: 'rendering', progress: 0 });
        try {
          const handle = await root.getFileHandle(tempName, { create: true });
          const writable = await handle.createWritable();
          try {
            await render(
              props.makeOpts({
                audio: it.e.file,
                video: it.loop!,
                title: baseName,
                writable: writable as unknown as WritableStream<never>,
                signal: ctrl.signal,
                onProgress: (p) => patch(it.id, { state: 'rendering', progress: p }),
              }),
            );
          } catch (e) {
            await writable.abort().catch(() => {});
            throw e;
          }
          const file = await handle.getFile();
          if (dir) {
            const out = await (await dir.getFileHandle(toFileName(baseName), { create: true })).createWritable();
            await file.stream().pipeTo(out);
          }
          let link: string | undefined;
          let thumbWarn = '';
          if (upload) {
            let session = yt.getSession();
            if (!session || session.expiresAt <= Date.now()) {
              try {
                session = await signIn(yt.id, 'none'); // silent refresh, no popup
                yt.setSession(session);
              } catch {
                patch(it.id, { state: 'queued' });
                setNote('Your Google sign-in expired. Press Start to sign in again; finished episodes are kept.');
                break;
              }
            }
            patch(it.id, { state: 'uploading', progress: 0 });
            const video = await uploadVideo(
              file,
              {
                title: baseName.slice(0, 100),
                description: fillTemplate(yt.description, fields),
                privacy: yt.privacy,
                madeForKids: yt.madeForKids,
                aiContent: yt.aiContent,
                publishAt: it.publishAt,
              },
              session,
              (p) => patch(it.id, { state: 'uploading', progress: p }),
              ctrl.signal,
            );
            link = video.url;
            uploads++;
            if (yt.withThumb) {
              try {
                await setThumbnail(video.id, await renderThumbnailBlob({ video: it.loop, ...fields }), session, ctrl.signal);
              } catch (e) {
                thumbWarn = ` Thumbnail not set: ${e instanceof Error ? e.message : 'unknown error'}`;
              }
            }
            setDoneMap((prev) => {
              const next = { ...prev, [it.id]: video.url };
              save('bulk.done', next);
              return next;
            });
          }
          patch(it.id, { state: 'done', link, message: thumbWarn.trim() || undefined });
          errorsInARow = 0;
          // Pause between uploads so YouTube does not see a burst.
          if (upload && gap > 0 && n < todo.length - 1 && uploads < cap) {
            for (let s = Math.round(gap * 60); s > 0 && !ctrl.signal.aborted; s--) {
              setCountdown(s);
              await sleep(1000, ctrl.signal);
            }
            setCountdown(null);
          }
        } catch (e) {
          if ((e as DOMException).name === 'AbortError') {
            patch(it.id, { state: 'queued' });
            break;
          }
          const message = e instanceof Error ? e.message : String(e);
          if (isLimitError(e)) {
            patch(it.id, { state: 'queued' });
            setNote(`${message} Stopped here; ${todo.length - n} left in the queue. Press Start again later.`);
            break;
          }
          patch(it.id, { state: 'error', message });
          if (++errorsInARow >= 3) {
            setNote('Three failures in a row, so the queue stopped. Check the messages, then press Start to retry.');
            break;
          }
        } finally {
          await root.removeEntry(tempName).catch(() => {});
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) setNote(e instanceof Error ? e.message : 'Could not start the queue.');
    } finally {
      setCountdown(null);
      setRunning(false);
      abortRef.current = null;
    }
  };

  const eta = (i: (typeof items)[number]) => {
    const r = i.runtime;
    if (r.state === 'rendering') return `Rendering ${Math.round((r.progress ?? 0) * 100)}%`;
    if (r.state === 'uploading') return `Uploading ${Math.round((r.progress ?? 0) * 100)}%`;
    if (r.state === 'done') return 'Done';
    if (r.state === 'earlier') return 'Uploaded earlier';
    if (r.state === 'error') return 'Failed';
    return 'Waiting';
  };

  return (
    <section className={fold.cls} id="bulk" aria-labelledby="h-bulk">
      <SectionHead id="h-bulk" fold={fold} n={7} title="Bulk queue" sub="Many episodes in a row: render each one, upload it, wait, repeat." />

      <p className="helper">
        Uses the processing settings from steps 2–3 (Fast mode, loudness, intro/outro, compression) and the YouTube settings from step 6. Audio trimming is not applied.
        Needs a Chromium-based browser (Chrome, Edge).
      </p>
      {noOpfs && <p className="warn-text"><span>This browser cannot keep temporary files, so the bulk queue is unavailable here.</span></p>}

      <div className="row">
        <FileButton className="btn" accept="audio/*,.m4a" label="Add audio files" multiple onFiles={addAudios} disabled={running} />
        {entries.length > 0 && (
          <button className="btn secondary" onClick={() => setEntries([])} disabled={running}>
            Clear list
          </button>
        )}
        <span className="helper">{entries.length ? `${entries.length} audio files, sorted by name` : 'Select all audio files at once.'}</span>
      </div>

      <fieldset className="yt-audience" disabled={running}>
        <legend>Loop video</legend>
        <label className="check">
          <input type="radio" name="bulk-loop" checked={loopMode === 'shared'} onChange={() => setLoopMode('shared')} />
          The same loop for every episode (the one from step 1{props.sharedLoop ? ` — ${props.sharedLoop.name}` : ', not chosen yet'})
        </label>
        <label className="check">
          <input type="radio" name="bulk-loop" checked={loopMode === 'each'} onChange={() => setLoopMode('each')} />
          A different loop for each episode (matched by file name order)
        </label>
      </fieldset>
      {loopMode === 'each' && (
        <div className="row">
          <FileButton className="btn secondary" accept="video/*,.mp4,.mov,.webm" label="Add loop videos" multiple onFiles={(l) => l && setLoops([...l].sort(natural))} disabled={running} />
          <span className="helper">{loops.length} loop videos</span>
          {eachMismatch && entries.length > 0 && <span className="error-text">The number of loops ({loops.length}) must match the number of audio files ({entries.length}).</span>}
        </div>
      )}

      <div className="row">
        <label className="field narrow">
          First episode no.
          <input type="number" min={0} value={startEp} onChange={(e) => ((startEdited.current = true), setStartEp(Number(e.target.value) || 0))} disabled={running} />
        </label>
        <label className="check" style={{ flex: '1 1 240px' }}>
          <input type="checkbox" checked={upload} onChange={(e) => setUpload(e.target.checked)} disabled={running} />
          Upload each episode to YouTube
        </label>
        {dirPicker && (
          <button
            className="btn secondary"
            disabled={running}
            onClick={async () => {
              try {
                setDir(await dirPicker());
              } catch {
                /* cancelled */
              }
            }}
          >
            {dir ? `Copies go to “${dir.name}”` : 'Also save copies to a folder…'}
          </button>
        )}
      </div>

      {upload && (
        <>
          <div className="row">
            <label className="field narrow">
              Uploads per run
              <input type="number" min={1} max={50} value={cap} onChange={(e) => setCap(Math.max(1, Number(e.target.value) || 1))} disabled={running} />
            </label>
            <label className="field narrow">
              Wait (minutes)
              <input type="number" min={0} max={60} value={gap} onChange={(e) => setGap(Math.max(0, Number(e.target.value) || 0))} disabled={running} />
            </label>
            <span className="helper" style={{ flex: '2 1 260px' }}>
              The queue stops after this many uploads and pauses between them. It also stops by itself when YouTube says the daily limit is reached.
            </span>
          </div>
          <label className="check">
            <input type="checkbox" checked={schedule} onChange={(e) => setSchedule(e.target.checked)} disabled={running} />
            Schedule publishing (uploads stay private, then YouTube publishes them one by one)
          </label>
          {schedule && (
            <div className="row">
              <label className="field">
                First video goes public at
                <input type="datetime-local" value={scheduleStart} onChange={(e) => setScheduleStart(e.target.value)} disabled={running} aria-invalid={!scheduleOk} />
              </label>
              <label className="field narrow">
                Then every (days)
                <input type="number" min={0} max={30} value={everyDays} onChange={(e) => setEveryDays(Math.max(0, Number(e.target.value) || 0))} disabled={running} />
              </label>
              {!scheduleOk && <span className="error-text">Pick a time at least 5 minutes from now.</span>}
            </div>
          )}
          {!yt.id && <p className="fast-note keep">Paste your Google OAuth client ID in step 6 first.</p>}
        </>
      )}

      {items.length > 0 && (
        <div className="bulk-list" role="table" aria-label="Queue">
          {items.map((i, idx) => (
            <div className={`bulk-row ${i.runtime.state}`} role="row" key={i.id}>
              <span className="bulk-no">{idx + 1}</span>
              <div className="bulk-main">
                <div className="bulk-top">
                  <span className="epbadge small">Ep {i.episode}</span>
                  <input
                    type="text"
                    aria-label={`Title for ${i.e.file.name}`}
                    value={i.e.title}
                    disabled={running || i.runtime.state === 'done' || i.runtime.state === 'earlier'}
                    onChange={(ev) => setEntries((prev) => prev.map((x) => (key(x.file) === i.id ? { ...x, title: ev.target.value } : x)))}
                  />
                </div>
                <span className="helper">
                  {i.e.file.name} · {fmtBytes(i.e.file.size)} · loop: {i.loop ? (loopMode === 'shared' ? 'shared' : i.loop.name) : 'missing'}
                  {i.publishAt && ` · publishes ${new Date(i.publishAt).toLocaleString()}`}
                </span>
                {i.runtime.message && <span className={i.runtime.state === 'error' ? 'error-text' : 'helper'}>{i.runtime.message}</span>}
                {(i.runtime.state === 'rendering' || i.runtime.state === 'uploading') && (
                  <div className="bar mini"><div style={{ transform: `scaleX(${i.runtime.progress ?? 0})` }} /></div>
                )}
              </div>
              <span className="bulk-state">
                {eta(i)}
                {i.runtime.link && (
                  <>
                    {' '}
                    <a href={i.runtime.link} target="_blank" rel="noreferrer">
                      open
                    </a>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {countdown !== null && <p className="helper">Waiting {fmtTime(countdown)} before the next upload…</p>}
      {note && <p className="warn-text" role="status"><span>{note}</span></p>}

      <div className="row">
        {running ? (
          <button className="btn secondary" onClick={() => abortRef.current?.abort()}>
            Stop after cancelling the current step
          </button>
        ) : (
          <button className="btn" onClick={run} disabled={!canStart}>
            {counts.done > 0 ? `Continue (${counts.left} left)` : `Start ${counts.left || ''} ${upload ? 'render & upload' : 'render'}`.replace(/\s+/g, ' ')}
          </button>
        )}
        {Object.keys(doneMap).length > 0 && !running && (
          <button
            className="btn secondary"
            onClick={() => {
              setDoneMap({});
              save('bulk.done', {});
              setRt({});
            }}
          >
            Forget uploaded history
          </button>
        )}
      </div>
    </section>
  );
}
