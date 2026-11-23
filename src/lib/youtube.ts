// YouTube upload from the browser: Google Identity Services (OAuth token flow) + the
// YouTube Data API v3 resumable upload endpoint. Nothing goes through any server of ours.

const SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const GIS_SRC = 'https://accounts.google.com/gsi/client';

type TokenResponse = { access_token?: string; expires_in?: number; error?: string; error_description?: string };
type TokenClient = { requestAccessToken: (o?: { prompt?: string }) => void };
type Google = {
  accounts: {
    oauth2: {
      initTokenClient: (c: {
        client_id: string;
        scope: string;
        callback: (r: TokenResponse) => void;
        error_callback?: (e: { type: string; message?: string }) => void;
      }) => TokenClient;
      revoke: (token: string, done?: () => void) => void;
    };
  };
};

let gisPromise: Promise<Google> | null = null;
function loadGis(): Promise<Google> {
  const w = window as unknown as { google?: Google };
  if (w.google?.accounts?.oauth2) return Promise.resolve(w.google);
  gisPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => (w.google?.accounts?.oauth2 ? resolve(w.google) : reject(new Error('Google sign-in did not load.')));
    s.onerror = () => {
      gisPromise = null;
      reject(new Error('Could not reach Google. Check your connection or ad blocker and try again.'));
    };
    document.head.appendChild(s);
  });
  return gisPromise;
}

export type Session = { token: string; expiresAt: number };

/** Opens the Google consent popup (call from a click). `prompt: 'none'` refreshes silently when consent was already given. */
export async function signIn(clientId: string, prompt?: 'none' | 'consent' | ''): Promise<Session> {
  const google = await loadGis();
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (r) => {
        if (r.access_token) resolve({ token: r.access_token, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000 - 30_000 });
        else reject(new Error(r.error_description || r.error || 'Google sign-in failed.'));
      },
      error_callback: (e) =>
        reject(new Error(e.type === 'popup_closed' ? 'The Google sign-in window was closed.' : e.message || 'Google sign-in failed.')),
    });
    client.requestAccessToken(prompt === undefined ? undefined : { prompt });
  });
}

export async function signOut(session: Session) {
  const google = await loadGis().catch(() => null);
  google?.accounts.oauth2.revoke(session.token);
}

export type Privacy = 'private' | 'unlisted' | 'public';
export type UploadMeta = {
  title: string;
  description: string;
  privacy: Privacy;
  madeForKids: boolean;
  aiContent: boolean;
  /** ISO time; makes the video private until then (YouTube publishes it automatically). */
  publishAt?: string;
};
export type Uploaded = { id: string; url: string };

export class UploadError extends Error {
  reason?: string;
  constructor(message: string, reason?: string) {
    super(message);
    this.reason = reason;
  }
}

/** True for errors that mean "stop uploading for today" (quota or channel upload limit). */
export const isLimitError = (e: unknown) => e instanceof UploadError && (e.reason === 'quotaExceeded' || e.reason === 'uploadLimitExceeded' || e.reason === 'rateLimitExceeded');

class Retryable extends Error {}

/** A step that can hang (for example in a hidden tab) must not hold the queue forever. */
export function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/** Uploads one file with the resumable protocol (single PUT, real progress via XHR). */
export async function uploadVideo(
  file: Blob,
  meta: UploadMeta,
  session: Session,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<Uploaded> {
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${session.token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(file.size),
      'X-Upload-Content-Type': 'video/mp4',
    },
    body: JSON.stringify({
      snippet: { title: meta.title, description: meta.description, categoryId: '22' },
      status: {
        privacyStatus: meta.publishAt ? 'private' : meta.privacy,
        selfDeclaredMadeForKids: meta.madeForKids,
        containsSyntheticMedia: meta.aiContent,
        ...(meta.publishAt ? { publishAt: meta.publishAt } : {}),
      },
    }),
  });
  if (!init.ok) {
    const e = parseApiError(await init.text());
    throw new UploadError(e.message || `YouTube refused the request (HTTP ${init.status}).`, e.reason);
  }
  const location = init.headers.get('Location');
  if (!location) throw new UploadError('YouTube did not return an upload address. Please try again.');

  const total = file.size;
  const SEND_STALL_MS = 90_000; // no progress while sending
  const ANSWER_WAIT_MS = 180_000; // everything is sent but YouTube has not answered

  /** One PUT with the bytes from `offset` on. Rejects with Retryable when the connection drops or goes silent. */
  const putFrom = (offset: number) =>
    new Promise<string>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let stalled = false;
      let watchdog = 0;
      const arm = (ms: number) => {
        clearTimeout(watchdog);
        watchdog = window.setTimeout(() => ((stalled = true), xhr.abort()), ms);
      };
      xhr.open('PUT', location);
      xhr.setRequestHeader('Content-Type', 'video/mp4');
      if (offset > 0) xhr.setRequestHeader('Content-Range', `bytes ${offset}-${total - 1}/${total}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress((offset + e.loaded) / total);
        arm(SEND_STALL_MS);
      };
      xhr.upload.onload = () => arm(ANSWER_WAIT_MS);
      xhr.onload = () => {
        clearTimeout(watchdog);
        if (xhr.status >= 200 && xhr.status < 300) return resolve(xhr.responseText);
        const e = parseApiError(xhr.responseText);
        const err = new UploadError(e.message || `YouTube rejected the upload (HTTP ${xhr.status}).`, e.reason);
        reject(xhr.status >= 500 ? new Retryable(err.message) : err);
      };
      xhr.onerror = () => (clearTimeout(watchdog), reject(new Retryable('The connection dropped during the upload.')));
      xhr.onabort = () => (clearTimeout(watchdog), reject(stalled ? new Retryable('YouTube stopped answering.') : new DOMException('Aborted', 'AbortError')));
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(offset > 0 ? file.slice(offset) : file);
    });

  /** Asks YouTube how much it already has (or the finished video, when the last answer got lost). */
  const askStatus = () =>
    new Promise<{ done: true; body: string } | { done: false; offset: number }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', location);
      xhr.setRequestHeader('Content-Range', `bytes */${total}`);
      xhr.timeout = 30_000;
      xhr.onload = () => {
        if (xhr.status === 200 || xhr.status === 201) return resolve({ done: true, body: xhr.responseText });
        if (xhr.status === 308) {
          const m = /bytes=0-(\d+)/.exec(xhr.getResponseHeader('Range') ?? '');
          return resolve({ done: false, offset: m ? Number(m[1]) + 1 : 0 });
        }
        reject(new Error(`status ${xhr.status}`));
      };
      xhr.onerror = xhr.ontimeout = () => reject(new Error('status check failed'));
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send();
    });

  let body = '';
  let offset = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      body = await putFrom(offset);
      break;
    } catch (e) {
      if (!(e instanceof Retryable)) throw e;
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (attempt >= 4) throw new UploadError(`${e.message} The upload could not be finished. Press Retry.`);
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      const st = await askStatus().catch(() => null);
      if (st?.done) {
        body = st.body; // YouTube already had everything; only the answer was lost
        break;
      }
      if (st) offset = st.offset;
    }
  }
  const id = (JSON.parse(body) as { id?: string }).id;
  if (!id) throw new UploadError('YouTube accepted the file but returned no video id.');
  return { id, url: `https://youtu.be/${id}` };
}

function parseApiError(text: string): { message: string; reason?: string } {
  try {
    const j = JSON.parse(text) as { error?: { message?: string; errors?: { reason?: string }[] } };
    const reason = j.error?.errors?.[0]?.reason;
    if (reason === 'quotaExceeded') return { reason, message: 'The daily YouTube quota of this Google project is used up. Try again tomorrow.' };
    if (reason === 'uploadLimitExceeded') return { reason, message: 'Your channel reached its daily upload limit. Try again later.' };
    if (reason === 'rateLimitExceeded') return { reason, message: 'YouTube says you are uploading too fast. Wait a while and try again.' };
    if (reason === 'youtubeSignupRequired') return { reason, message: 'This Google account has no YouTube channel yet. Create one on youtube.com first.' };
    return { reason, message: j.error?.message ?? '' };
  } catch {
    return { message: '' };
  }
}

/** Sets the custom thumbnail. Needs a phone-verified channel; callers should treat failure as a warning. */
export async function setThumbnail(videoId: string, image: Blob, session: Session, signal?: AbortSignal): Promise<void> {
  const r = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': image.type || 'image/jpeg' },
    body: image,
  });
  if (!r.ok) {
    const e = parseApiError(await r.text());
    throw new UploadError(e.message || `YouTube refused the thumbnail (HTTP ${r.status}).`, e.reason);
  }
}
