import { useState, type ReactNode } from 'react';
import type { MediaInfo } from '../lib/probe';
import { fmtBytes, fmtTime } from '../lib/format';
import { FileButton } from './ui';

export type Picked = { file: File; info: MediaInfo; url: string } | null;

export function DropZone(props: {
  id?: string;
  label: string;
  hint: string;
  accept: string;
  picked: Picked;
  loading: boolean;
  disabled: boolean;
  required?: boolean;
  error?: string | null;
  note?: string | null;
  onFile: (f: File | undefined) => void;
  onClear?: () => void;
  children?: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const { picked } = props;
  const errorId = props.id ? `${props.id}-error` : undefined;
  return (
    <div
      id={props.id}
      className={`drop ${over ? 'over' : ''} ${picked ? 'has' : ''} ${props.error ? 'invalid' : ''}`}
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
        <span className="drop-title">
          {props.label}
          <span className="meta">{props.required ? '(required)' : '(optional)'}</span>
        </span>
        <div className="drop-actions">
          {picked && props.onClear && (
            <button className="btn secondary compact" onClick={props.onClear} disabled={props.disabled}>
              Remove
            </button>
          )}
          <FileButton
            accept={props.accept}
            label={picked ? 'Replace' : 'Choose file'}
            ariaLabel={`${picked ? 'Replace' : 'Choose'} ${props.label.toLowerCase()} file`}
            disabled={props.disabled}
            onFile={props.onFile}
          />
        </div>
      </div>
      {props.loading && <p className="drop-empty" aria-live="polite">Reading file…</p>}
      {!picked && !props.loading && (
        <p className="drop-empty">
          {props.hint}
          {!props.disabled && ' Drop a file here or choose one.'}
        </p>
      )}
      {picked && (
        <>
          <p className="file-name" title={picked.file.name}>
            {picked.file.name}
          </p>
          <p className="meta">
            {fmtTime(picked.info.duration)} · {picked.info.codec ?? '?'} · {fmtBytes(picked.info.size)}
            {picked.info.width ? ` · ${picked.info.width}×${picked.info.height}` : ''}
          </p>
          {props.children}
        </>
      )}
      {props.note && <p className="helper">{props.note}</p>}
      {props.error && (
        <p className="error-text" id={errorId}>
          {props.error}
        </p>
      )}
    </div>
  );
}
