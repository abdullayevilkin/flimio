import { useState, type ReactNode } from 'react';
import type { MediaInfo } from '../lib/probe';
import { fmtBytes, fmtTime } from '../lib/format';

export type Picked = { file: File; info: MediaInfo; url: string } | null;

export function DropZone(props: {
  label: string;
  hint: string;
  accept: string;
  picked: Picked;
  loading: boolean;
  disabled: boolean;
  optional?: boolean;
  compact?: boolean;
  onFile: (f: File | undefined) => void;
  onClear?: () => void;
  children?: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const { picked } = props;
  return (
    <div
      className={`drop ${over ? 'over' : ''} ${picked ? 'has' : ''} ${props.compact ? 'compact' : ''}`}
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
        <strong>
          {props.label}
          {props.optional && <span className="tag">optional</span>}
        </strong>
        <div className="drop-actions">
          {picked && props.onClear && (
            <button className="btn small ghost" onClick={props.onClear} disabled={props.disabled}>
              Remove
            </button>
          )}
          <label className={`btn small ghost ${props.disabled ? 'disabled' : ''}`}>
            {picked ? 'Replace' : 'Choose file'}
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
      </div>
      {props.loading && <p className="muted">Reading…</p>}
      {!picked && !props.loading && (
        <p className="muted">
          Drop a file here or choose one
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
          {props.children && <div className="preview">{props.children}</div>}
        </>
      )}
    </div>
  );
}
