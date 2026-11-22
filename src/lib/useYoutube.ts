import { useEffect, useRef, useState } from 'react';
import { describeError } from '../components/ui';
import { renderThumbnailBlob } from '../components/Thumbnail';
import { load, save } from './format';
import { fillTemplate, type NamingFields } from './naming';
import { setThumbnail, signIn, signOut, uploadVideo, type Privacy, type Session, type Uploaded } from './youtube';

const ENV_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '';

export type YtState =
  | { kind: 'idle' }
  | { kind: 'signing' }
  | { kind: 'uploading'; progress: number }
  | { kind: 'done'; video: Uploaded; privacy: Privacy; thumb: 'set' | 'off' | { error: string } }
  | { kind: 'error'; message: string; details: string };

const valid = (s: Session | null): s is Session => !!s && s.expiresAt > Date.now();

/** YouTube settings, Google session and the upload itself. Shared by the YouTube section and the one-click flow. */
export function useYoutube(p: { defaultTitle: string; fields: NamingFields; video: File | null }) {
  const [clientId, setClientId] = useState<string>(() => load('yt.clientId', ENV_CLIENT_ID));
  const [title, setTitleState] = useState(p.defaultTitle);
  const [description, setDescription] = useState<string>(() => load('yt.description', ''));
  const [privacy, setPrivacy] = useState<Privacy>(() => load('yt.privacy', 'private'));
  const [madeForKids, setMadeForKids] = useState<boolean>(() => load('yt.madeForKids', false));
  const [aiContent, setAiContent] = useState<boolean>(() => load('yt.aiContent', true));
  const [withThumb, setWithThumb] = useState<boolean>(() => load('yt.withThumb', true));
  const [session, setSession] = useState<Session | null>(() => {
    const saved = load<Session | null>('yt.session', null);
    return valid(saved) ? saved : null;
  });
  const [state, setState] = useState<YtState>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const titleEdited = useRef(false);

  useEffect(() => save('yt.clientId', clientId), [clientId]);
  useEffect(() => save('yt.description', description), [description]);
  useEffect(() => save('yt.privacy', privacy), [privacy]);
  useEffect(() => save('yt.madeForKids', madeForKids), [madeForKids]);
  useEffect(() => save('yt.aiContent', aiContent), [aiContent]);
  useEffect(() => save('yt.withThumb', withThumb), [withThumb]);
  useEffect(() => save('yt.session', session), [session]);
  useEffect(() => () => abortRef.current?.abort(), []);

  // The title follows the File name field until it is edited by hand.
  useEffect(() => {
    if (!titleEdited.current) setTitleState(p.defaultTitle);
  }, [p.defaultTitle]);
  const setTitle = (t: string) => {
    titleEdited.current = true;
    setTitleState(t);
  };
  const resetTitle = () => {
    titleEdited.current = false;
    setTitleState(p.defaultTitle);
  };

  const latest = useRef({ clientId, title, description, privacy, madeForKids, aiContent, withThumb, session, ...p });
  latest.current = { clientId, title, description, privacy, madeForKids, aiContent, withThumb, session, ...p };

  const id = clientId.trim();
  const titleOk = title.trim().length > 0 && title.length <= 100;
  const descriptionPreview = fillTemplate(description, p.fields);

  /** Call from a click: opens the Google popup only when there is no valid sign-in yet. */
  const ensureSession = async (): Promise<Session> => {
    const cur = latest.current.session;
    if (valid(cur)) return cur;
    setState({ kind: 'signing' });
    try {
      const s = await signIn(latest.current.clientId.trim());
      setSession(s);
      latest.current.session = s;
      setState({ kind: 'idle' });
      return s;
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : 'Google sign-in failed.', details: String(e) });
      throw e;
    }
  };

  const publish = async (file: Blob): Promise<Uploaded | null> => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const s = valid(latest.current.session) ? latest.current.session : await ensureSession();
      setState({ kind: 'uploading', progress: 0 });
      const l = latest.current;
      const video = await uploadVideo(
        file,
        { title: l.title.trim(), description: fillTemplate(l.description, l.fields), privacy: l.privacy, madeForKids: l.madeForKids, aiContent: l.aiContent },
        s,
        (progress) => setState({ kind: 'uploading', progress }),
        ctrl.signal,
      );
      let thumb: 'set' | 'off' | { error: string } = 'off';
      if (l.withThumb) {
        try {
          await setThumbnail(video.id, await renderThumbnailBlob({ video: l.video, ...l.fields }), s, ctrl.signal);
          thumb = 'set';
        } catch (e) {
          thumb = { error: e instanceof Error ? e.message : 'The thumbnail could not be set.' };
        }
      }
      setState({ kind: 'done', video, privacy: l.privacy, thumb });
      return video;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') setState({ kind: 'idle' });
      else {
        const { message, details } = describeError(e, 'The upload to YouTube failed. Please try again.');
        setState({ kind: 'error', message: e instanceof Error && e.message ? e.message : message, details });
      }
      return null;
    } finally {
      abortRef.current = null;
    }
  };

  return {
    clientId, setClientId, id, title, setTitle, resetTitle, titleOk, description, setDescription, descriptionPreview,
    privacy, setPrivacy, madeForKids, setMadeForKids, aiContent, setAiContent, withThumb, setWithThumb,
    session, signOut: () => { if (session) void signOut(session); setSession(null); },
    state, setState, ensureSession, publish, cancel: () => abortRef.current?.abort(),
    get busy() { return state.kind === 'uploading' || state.kind === 'signing'; },
  };
}
export type Youtube = ReturnType<typeof useYoutube>;
