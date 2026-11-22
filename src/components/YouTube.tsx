import { fmtBytes } from '../lib/format';
import type { Privacy } from '../lib/youtube';
import type { Youtube } from '../lib/useYoutube';
import { ErrorNotice, SectionHead, useFold } from './ui';

export function YouTube(props: { yt: Youtube; fileReady: boolean; onUpload: () => void; size: number | null }) {
  const { yt } = props;
  const fold = useFold('youtube');
  const uploading = yt.state.kind === 'uploading';
  const busy = yt.busy;

  return (
    <section className={fold.cls} id="youtube" aria-labelledby="h-youtube">
      <SectionHead id="h-youtube" fold={fold} n={6} title="Publish to YouTube" sub="Upload the finished video straight from your browser. The file goes from here to YouTube only." />
      {!props.fileReady && <p className="fast-note keep">Create the video first (steps 1–4, then “Create video”), or use “Create & upload to YouTube”.</p>}

      <div className="row" style={{ alignItems: 'flex-start' }}>
        <label className="field" style={{ flex: '2 1 280px' }}>
          Video title
          <input type="text" value={yt.title} maxLength={100} onChange={(e) => yt.setTitle(e.target.value)} disabled={busy} aria-invalid={!yt.titleOk} />
          <span className="helper">{yt.title.length}/100 · follows the File name until you edit it</span>
        </label>
        <label className="field">
          Visibility
          <select value={yt.privacy} onChange={(e) => yt.setPrivacy(e.target.value as Privacy)} disabled={busy}>
            <option value="private">Private</option>
            <option value="unlisted">Unlisted</option>
            <option value="public">Public</option>
          </select>
        </label>
      </div>
      <label className="field">
        Description (template)
        <textarea rows={4} value={yt.description} maxLength={5000} onChange={(e) => yt.setDescription(e.target.value)} disabled={busy} />
        <span className="helper">
          Tokens: <code>{'{show}'}</code> <code>{'{n}'}</code> <code>{'{nn}'}</code> <code>{'{title}'}</code> <code>{'{date}'}</code> — filled in for each video and remembered for the next one.
        </span>
      </label>
      {(yt.description.includes('{') || yt.description.includes('**')) && (
        <p className="helper" style={{ whiteSpace: 'pre-wrap' }}>
          <strong>Preview:</strong> {yt.descriptionPreview}
        </p>
      )}

      <fieldset className="yt-audience" disabled={busy}>
        <legend>Audience (YouTube requires an answer)</legend>
        <label className="check">
          <input type="radio" name="yt-kids" checked={!yt.madeForKids} onChange={() => yt.setMadeForKids(false)} />
          No, it’s not made for kids
        </label>
        <label className="check">
          <input type="radio" name="yt-kids" checked={yt.madeForKids} onChange={() => yt.setMadeForKids(true)} />
          Yes, it’s made for kids
        </label>
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={yt.aiContent} onChange={(e) => yt.setAiContent(e.target.checked)} disabled={busy} />
        Altered or synthetic content — realistic AI-generated or AI-altered visuals or voices
      </label>
      <label className="check">
        <input type="checkbox" checked={yt.withThumb} onChange={(e) => yt.setWithThumb(e.target.checked)} disabled={busy} />
        Also set the thumbnail from step 5 (needs a phone-verified YouTube channel)
      </label>

      <label className="field">
        Google OAuth client ID
        <input
          type="text"
          value={yt.clientId}
          onChange={(e) => yt.setClientId(e.target.value)}
          disabled={busy}
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

      {yt.state.kind === 'uploading' && (
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(yt.state.progress * 100)}>
          <div className="bar">
            <div style={{ transform: `scaleX(${yt.state.progress})` }} />
          </div>
          <span>
            Uploading {(yt.state.progress * 100).toFixed(0)}%{props.size ? ` of ${fmtBytes(props.size)}` : ''}
          </span>
        </div>
      )}
      {yt.state.kind === 'done' && (
        <>
          <p className="done-line">
            Uploaded as {yt.state.privacy}.{' '}
            <a href={yt.state.video.url} target="_blank" rel="noreferrer">
              {yt.state.video.url}
            </a>{' '}
            ·{' '}
            <a href={`https://studio.youtube.com/video/${yt.state.video.id}/edit`} target="_blank" rel="noreferrer">
              Open in YouTube Studio
            </a>
            {yt.state.thumb === 'set' && ' · thumbnail set'}
          </p>
          {typeof yt.state.thumb === 'object' && <p className="warn-text" role="status"><span>Video uploaded, but the thumbnail was not set: {yt.state.thumb.error}</span></p>}
        </>
      )}
      {yt.state.kind === 'error' && <ErrorNotice message={yt.state.message} details={yt.state.details} />}

      <div className="row">
        {uploading ? (
          <button id="yt-upload" className="btn secondary" onClick={yt.cancel}>
            Cancel upload
          </button>
        ) : (
          <button id="yt-upload" className="btn" onClick={props.onUpload} disabled={busy || !yt.id || !yt.titleOk || !props.fileReady}>
            {yt.session ? 'Upload to YouTube' : 'Sign in & upload to YouTube'}
          </button>
        )}
        {yt.session && !uploading && (
          <button className="btn secondary" onClick={yt.signOut}>
            Sign out of Google
          </button>
        )}
      </div>
    </section>
  );
}
