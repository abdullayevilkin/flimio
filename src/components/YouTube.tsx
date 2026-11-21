import { useEffect, useRef, useState } from 'react';
import { fmtBytes, load, save } from '../lib/format';
import { signIn, signOut, uploadVideo, type Privacy, type Session, type Uploaded } from '../lib/youtube';
import { ErrorNotice, SectionHead, describeError, useFold } from './ui';

const ENV_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '';

type State =
  | { kind: 'idle' }
  | { kind: 'uploading'; progress: number }
  | { kind: 'done'; video: Uploaded }
  | { kind: 'error'; message: string; details: string };

export function YouTube(props: { getFile: () => Promise<Blob>; defaultTitle: string; size: number | null }) {
  const [clientId, setClientId] = useState<string>(() => load('yt.clientId', ENV_CLIENT_ID));
  const [title, setTitle] = useState(props.defaultTitle);
  const [description, setDescription] = useState<string>(() => load('yt.description', ''));
  const [privacy, setPrivacy] = useState<Privacy>(() => load('yt.privacy', 'private'));
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const fold = useFold();

  useEffect(() => save('yt.clientId', clientId), [clientId]);
  useEffect(() => save('yt.description', description), [description]);
  useEffect(() => save('yt.privacy', privacy), [privacy]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const id = clientId.trim();
  const titleOk = title.trim().length > 0 && title.length <= 100;
  const uploading = state.kind === 'uploading';

  const upload = async () => {
    if (!id || !titleOk) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      let s = session;
      if (!s || s.expiresAt < Date.now()) {
        s = await signIn(id);
        setSession(s);
      }
      setState({ kind: 'uploading', progress: 0 });
      const file = await props.getFile();
      const video = await uploadVideo(file, { title: title.trim(), description, privacy }, s, (progress) => setState({ kind: 'uploading', progress }), ctrl.signal);
      setState({ kind: 'done', video });
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') setState({ kind: 'idle' });
      else {
        const { message, details } = describeError(e, 'The upload to YouTube failed. Please try again.');
        setState({ kind: 'error', message: e instanceof Error && e.message ? e.message : message, details });
      }
    } finally {
      abortRef.current = null;
    }
  };

  return (
    <section className={fold.cls} aria-labelledby="h-youtube">
      <SectionHead id="h-youtube" fold={fold} title="Publish to YouTube" sub="Upload the finished video straight from your browser. The file goes from here to YouTube only." />

      <div className="row" style={{ alignItems: "flex-start" }}>
        <label className="field" style={{ flex: '2 1 280px' }}>
          Video title
          <input type="text" value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} disabled={uploading} aria-invalid={!titleOk} />
          <span className="helper">{title.length}/100</span>
        </label>
        <label className="field">
          Visibility
          <select value={privacy} onChange={(e) => setPrivacy(e.target.value as Privacy)} disabled={uploading}>
            <option value="private">Private</option>
            <option value="unlisted">Unlisted</option>
            <option value="public">Public</option>
          </select>
        </label>
      </div>
      <label className="field">
        Description
        <textarea rows={3} value={description} maxLength={5000} onChange={(e) => setDescription(e.target.value)} disabled={uploading} />
      </label>

      <label className="field">
        Google OAuth client ID
        <input
          type="text"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          disabled={uploading}
          placeholder="1234567890-abc….apps.googleusercontent.com"
          spellCheck={false}
          autoComplete="off"
        />
        <span className="helper">Saved in this browser only. Not set up yet? See the steps below.</span>
      </label>
      <details className="yt-help">
        <summary>How to get a client ID (once, about 5 minutes)</summary>
        <ol>
          <li>
            In <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud Console</a>, create a project and enable <strong>YouTube Data API v3</strong>.
          </li>
          <li>Open <strong>Google Auth Platform</strong>, set it up as External, and add your own Google account under Test users.</li>
          <li>
            Go to <strong>Clients → Create client → Web application</strong>. Add <code>{window.location.origin}</code> under Authorized JavaScript origins.
          </li>
          <li>Copy the client ID and paste it above.</li>
        </ol>
        <p className="helper">
          Until Google verifies the project, YouTube may keep API-uploaded videos private. You can switch them to public in YouTube Studio.
          Your daily upload limit is shown on the Quotas page of your Google Cloud project.
        </p>
      </details>

      {state.kind === 'uploading' && (
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.progress * 100)}>
          <div className="bar">
            <div style={{ transform: `scaleX(${state.progress})` }} />
          </div>
          <span>
            Uploading {(state.progress * 100).toFixed(0)}%{props.size ? ` of ${fmtBytes(props.size)}` : ''}
          </span>
        </div>
      )}
      {state.kind === 'done' && (
        <p className="done-line">
          Uploaded as {privacy}.{' '}
          <a href={state.video.url} target="_blank" rel="noreferrer">
            {state.video.url}
          </a>{' '}
          ·{' '}
          <a href={`https://studio.youtube.com/video/${state.video.id}/edit`} target="_blank" rel="noreferrer">
            Open in YouTube Studio
          </a>
        </p>
      )}
      {state.kind === 'error' && <ErrorNotice message={state.message} details={state.details} />}

      <div className="row">
        {uploading ? (
          <button className="btn secondary" onClick={() => abortRef.current?.abort()}>
            Cancel upload
          </button>
        ) : (
          <button className="btn" onClick={upload} disabled={!id || !titleOk}>
            {session ? 'Upload to YouTube' : 'Sign in & upload to YouTube'}
          </button>
        )}
        {session && !uploading && (
          <button
            className="btn secondary"
            onClick={() => {
              void signOut(session);
              setSession(null);
            }}
          >
            Sign out of Google
          </button>
        )}
      </div>
    </section>
  );
}
