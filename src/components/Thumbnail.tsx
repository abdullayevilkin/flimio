import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtBytes, fmtTime } from '../lib/format';

const W = 1280;
const H = 720;
const MAX_BYTES = 2 * 1024 * 1024; // YouTube thumbnail limit

type Align = 'left' | 'center';
type Size = 'm' | 'l' | 'xl';
const SIZES: Record<Size, number> = { m: 72, l: 92, xl: 116 };

/** YouTube thumbnail maker: a frame from the loop video (or an image) + title text, exported as 1280×720 JPG. */
export function Thumbnail(props: { video: File | null; defaultTitle: string; defaultKicker: string; baseName: string }) {
  const [image, setImage] = useState<File | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // Follows the episode fields until the user edits the thumbnail text directly.
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const [kickerEdit, setKickerEdit] = useState<string | null>(null);
  const title = titleEdit ?? props.defaultTitle;
  const kicker = kickerEdit ?? props.defaultKicker;
  const [align, setAlign] = useState<Align>('left');
  const [size, setSize] = useState<Size>('l');
  const [color, setColor] = useState('#ffffff');
  const [accent, setAccent] = useState('#ffd84d');
  const [shade, setShade] = useState(55);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [exported, setExported] = useState<{ url: string; size: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Source: uploaded image, otherwise a frame of the loop video.
  const videoUrl = useObjectUrl(image ? null : props.video);
  useEffect(() => {
    if (!image) return;
    let cancelled = false;
    createImageBitmap(image).then((b) => !cancelled && setBitmap(b));
    return () => {
      cancelled = true;
    };
  }, [image]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoUrl) return;
    const grab = async () => {
      try {
        setBitmap(await createImageBitmap(v));
      } catch {
        /* frame not ready yet */
      }
    };
    v.addEventListener('seeked', grab);
    v.addEventListener('loadeddata', grab);
    return () => {
      v.removeEventListener('seeked', grab);
      v.removeEventListener('loadeddata', grab);
    };
  }, [videoUrl]);

  useEffect(() => {
    const v = videoRef.current;
    if (v && videoUrl && Number.isFinite(time)) v.currentTime = time;
  }, [time, videoUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    draw(canvas, { bitmap, title, kicker, align, size: SIZES[size], color, accent, shade });
    setExported((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  }, [bitmap, title, kicker, align, size, color, accent, shade]);

  const download = async () => {
    const canvas = canvasRef.current!;
    let quality = 0.92;
    let blob = await toJpeg(canvas, quality);
    while (blob.size > MAX_BYTES && quality > 0.4) {
      quality -= 0.08;
      blob = await toJpeg(canvas, quality);
    }
    const url = URL.createObjectURL(blob);
    setExported({ url, size: blob.size });
    const a = document.createElement('a');
    a.href = url;
    a.download = `${props.baseName || 'thumbnail'} - thumbnail.jpg`;
    a.click();
  };

  const hasSource = !!image || !!props.video;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Thumbnail</h2>
        <span className="muted-inline">1280×720 JPG, under 2 MB</span>
      </div>
      {!hasSource ? (
        <p className="muted left">Add a loop video (or an image) to design a thumbnail.</p>
      ) : (
        <div className="thumb">
          <canvas ref={canvasRef} width={W} height={H} className="thumb-canvas" />
          <div className="thumb-controls">
            <div className="field-row">
              <label className="field grow">
                Background
                <select value={image ? 'image' : 'video'} onChange={(e) => e.target.value === 'video' && setImage(null)}>
                  <option value="video" disabled={!props.video}>
                    Frame from loop video
                  </option>
                  {image && <option value="image">{image.name}</option>}
                </select>
              </label>
              <label className="btn small ghost">
                Use image…
                <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && setImage(e.target.files[0])} />
              </label>
            </div>
            {!image && videoUrl && (
              <label className="field">
                Frame at {fmtTime(time)}
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, duration - 0.05)}
                  step={0.04}
                  value={time}
                  onChange={(e) => setTime(Number(e.target.value))}
                />
              </label>
            )}
            <label className="field">
              Small text above
              <input
                value={kicker}
                onChange={(e) => setKickerEdit(e.target.value)}
                placeholder="EPISODE 12"
              />
            </label>
            <label className="field">
              Title
              <textarea
                rows={2}
                value={title}
                onChange={(e) => setTitleEdit(e.target.value)}
                placeholder="Episode title"
              />
            </label>
            <div className="field-row">
              <label className="field grow">
                Align
                <select value={align} onChange={(e) => setAlign(e.target.value as Align)}>
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                </select>
              </label>
              <label className="field grow">
                Text size
                <select value={size} onChange={(e) => setSize(e.target.value as Size)}>
                  <option value="m">Medium</option>
                  <option value="l">Large</option>
                  <option value="xl">Extra large</option>
                </select>
              </label>
              <label className="field">
                Text
                <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
              </label>
              <label className="field">
                Accent
                <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} />
              </label>
            </div>
            <label className="field">
              Darken background — {shade}%
              <input type="range" min={0} max={85} value={shade} onChange={(e) => setShade(Number(e.target.value))} />
            </label>
            <div className="field-row">
              <button className="btn" onClick={download}>
                Download thumbnail
              </button>
              {exported && <span className="muted-inline">Saved · {fmtBytes(exported.size)}</span>}
            </div>
          </div>
          {videoUrl && (
            <video
              ref={videoRef}
              src={videoUrl}
              muted
              playsInline
              preload="auto"
              hidden
              onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            />
          )}
        </div>
      )}
    </section>
  );
}

function useObjectUrl(file: File | null) {
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  return url;
}

function toJpeg(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not export JPG'))), 'image/jpeg', quality),
  );
}

function draw(
  canvas: HTMLCanvasElement,
  o: {
    bitmap: ImageBitmap | null;
    title: string;
    kicker: string;
    align: Align;
    size: number;
    color: string;
    accent: string;
    shade: number;
  },
) {
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, W, H);

  if (o.bitmap) {
    // cover
    const s = Math.max(W / o.bitmap.width, H / o.bitmap.height);
    const w = o.bitmap.width * s;
    const h = o.bitmap.height * s;
    ctx.drawImage(o.bitmap, (W - w) / 2, (H - h) / 2, w, h);
  }

  const a = o.shade / 100;
  if (a > 0) {
    const g =
      o.align === 'left'
        ? ctx.createLinearGradient(0, 0, W, 0)
        : ctx.createLinearGradient(0, H, 0, 0);
    g.addColorStop(0, `rgba(0,0,0,${a})`);
    g.addColorStop(0.6, `rgba(0,0,0,${a * 0.55})`);
    g.addColorStop(1, `rgba(0,0,0,${a * 0.15})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  const pad = 80;
  const maxW = o.align === 'left' ? W * 0.68 : W - pad * 2;
  const x = o.align === 'left' ? pad : W / 2;
  ctx.textAlign = o.align;
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 4;

  const font = (weight: number, px: number) => `${weight} ${px}px Inter, "Segoe UI", Roboto, system-ui, sans-serif`;

  // shrink the title until it fits in 3 lines
  let px = o.size;
  let lines: string[] = [];
  for (; px >= 40; px -= 4) {
    ctx.font = font(800, px);
    lines = wrap(ctx, o.title.trim(), maxW);
    if (lines.length <= 3) break;
  }
  lines = lines.slice(0, 3);
  const lineH = px * 1.08;
  const kickerPx = Math.round(px * 0.42);
  const blockH = lines.length * lineH + (o.kicker.trim() ? kickerPx * 1.6 : 0);
  let y = o.align === 'left' ? H - pad - blockH : (H - blockH) / 2;

  if (o.kicker.trim()) {
    ctx.font = font(700, kickerPx);
    ctx.fillStyle = o.accent;
    y += kickerPx;
    ctx.fillText(o.kicker.trim().toUpperCase(), x, y);
    y += kickerPx * 0.6;
  }
  ctx.font = font(800, px);
  ctx.fillStyle = o.color;
  for (const line of lines) {
    y += lineH;
    ctx.fillText(line, x, y - px * 0.12);
  }
  ctx.shadowColor = 'transparent';
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line);
        line = word;
      } else line = test;
    }
    if (line) lines.push(line);
  }
  return lines;
}
