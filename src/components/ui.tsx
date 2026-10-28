import { useEffect, useRef, useState, type ReactNode } from 'react';

/** A real, focusable button that opens a file picker (a hidden <input type=file> is not keyboard-reachable). */
export function FileButton(props: {
  accept: string;
  label: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  onFile: (f: File | undefined) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className={props.className ?? 'btn secondary compact'}
        disabled={props.disabled}
        aria-label={props.ariaLabel}
        onClick={() => ref.current?.click()}
      >
        {props.label}
      </button>
      <input
        ref={ref}
        type="file"
        accept={props.accept}
        hidden
        tabIndex={-1}
        onChange={(e) => {
          props.onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </>
  );
}

/**
 * Named-entity confirmation for destructive actions: destructive verb on the confirm button,
 * Cancel focused by default, Escape dismisses, focus returns to the trigger.
 */
export function useConfirm() {
  const [state, setState] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (state && d && !d.open) d.showModal();
  }, [state]);

  const close = (ok: boolean) => {
    ref.current?.close();
    state?.resolve(ok);
    setState(null);
    trigger.current?.focus();
  };

  const confirm = (title: string, body: string, confirmLabel: string) =>
    new Promise<boolean>((resolve) => {
      trigger.current = document.activeElement as HTMLElement | null;
      setState({ title, body, confirmLabel, resolve });
    });

  const dialog = state ? (
    <dialog
      ref={ref}
      className="confirm"
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault();
        close(false);
      }}
    >
      <h2 id="confirm-title">{state.title}</h2>
      <p>{state.body}</p>
      <div className="dialog-actions">
        <button className="btn secondary" autoFocus onClick={() => close(false)}>
          Cancel
        </button>
        <button className="btn danger" onClick={() => close(true)}>
          {state.confirmLabel}
        </button>
      </div>
    </dialog>
  ) : null;

  return { confirm, dialog };
}

/** Error notice: plain message + recovery actions + copyable technical details. */
export function ErrorNotice(props: { message: string; details?: string; actions?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="notice error" role="alert">
      <p>{props.message}</p>
      <div className="notice-actions">
        {props.actions}
        {props.details && (
          <button
            className="btn secondary compact"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(props.details!);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              } catch {
                /* clipboard blocked */
              }
            }}
          >
            {copied ? 'Copied' : 'Copy error details'}
          </button>
        )}
      </div>
    </div>
  );
}

/** Turns a thrown error into a short user message + technical details for support. */
export function describeError(e: unknown, fallback: string): { message: string; details: string } {
  const raw = e instanceof Error ? e.message : String(e);
  const details = e instanceof Error ? `${e.name}: ${e.message}${e.stack ? `\n${e.stack}` : ''}` : raw;
  // Our own messages are written for people; browser/codec internals are not.
  const friendly = /^(This |The |Choose |Cut |Use |Could not )/.test(raw);
  return { message: friendly ? raw : fallback, details };
}

/** Numbered section header: makes each part of the form read as its own step. */
export function SectionHead(props: { id: string; n?: number; title: string; sub?: string }) {
  return (
    <div className="section-head">
      {props.n !== undefined && (
        <span className="step" aria-hidden="true">
          {props.n}
        </span>
      )}
      <div className="section-titles">
        <h2 id={props.id} tabIndex={-1}>
          {props.title}
        </h2>
        {props.sub && <p className="helper">{props.sub}</p>}
      </div>
    </div>
  );
}

/** Sticky in-page tabs: jump to a section; the one in view is highlighted (scroll-spy). */
export function SectionNav(props: { items: { id: string; label: string }[] }) {
  const [active, setActive] = useState(props.items[0]?.id);
  const listRef = useRef<HTMLOListElement>(null);

  // Keep the active tab visible when the tab row scrolls sideways (narrow screens).
  useEffect(() => {
    const list = listRef.current;
    const link = list?.querySelector<HTMLElement>('a[aria-current]');
    if (!list || !link) return;
    const left = link.offsetLeft - list.offsetLeft;
    if (left < list.scrollLeft || left + link.offsetWidth > list.scrollLeft + list.clientWidth) {
      list.scrollTo({ left: Math.max(0, left - 16) });
    }
  }, [active]);

  useEffect(() => {
    const els = props.items.map((i) => document.getElementById(i.id)).filter((e): e is HTMLElement => !!e);
    const update = () => {
      // the last section whose top has passed the nav line is the current one
      const line = 120;
      let current = els[0]?.id;
      for (const el of els) if (el.getBoundingClientRect().top - line <= 0) current = el.id;
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (atBottom && els.length) current = els[els.length - 1].id;
      setActive(current);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [props.items]);

  return (
    <nav className="sectionnav" aria-label="Sections">
      <ol ref={listRef}>
        {props.items.map((item, i) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              aria-current={active === item.id ? 'step' : undefined}
              onClick={(e) => {
                e.preventDefault();
                const el = document.getElementById(item.id);
                const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                el?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
                history.replaceState(null, '', `#${item.id}`);
                el?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
              }}
            >
              <span className="step small" aria-hidden="true">
                {i + 1}
              </span>
              {item.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
