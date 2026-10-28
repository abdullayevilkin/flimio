import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fmtBytes, fmtTime, load, save } from '../lib/format';
import { FileButton, SectionHead, useConfirm } from './ui';
import { FONTS, ensureFont, fontCss, type FontKey } from './thumbFonts';

const W = 1280;
const H = 720;
const MAX_BYTES = 2 * 1024 * 1024; // YouTube thumbnail limit

type Pos = 'tl' | 'tc' | 'tr' | 'ml' | 'mc' | 'mr' | 'bl' | 'bc' | 'br';
type Corner = 'tl' | 'tr' | 'bl' | 'br';

export type ThumbSettings = {
  bigText: string;
  smallText: string;
  smallPlacement: 'below' | 'above';
  bigFont: FontKey;
  smallFont: FontKey;
  bigSize: number;
  smallSize: number;
  bigColor: string;
  smallColor: string;
  bigUpper: boolean;
  smallUpper: boolean;
  position: Pos;
  effect: 'shadow' | 'outline' | 'box' | 'none';
  boxColor: string;
  overlay: 'gradient' | 'solid' | 'none';
  overlayColor: string;
  shade: number;
  zoom: number;
  focusX: number;
  focusY: number;
  brightness: number;
  blur: number;
  frameTime: number;
  logo: string | null;
  logoCorner: Corner;
  logoSize: number;
  format: 'jpg' | 'png';
  guides: boolean;
};

const THUMB_DEFAULTS: ThumbSettings = {
  bigText: 'EPISODE {n}',
  smallText: '{title}',
  smallPlacement: 'below',
  bigFont: 'anton',
  smallFont: 'inter',
  bigSize: 150,
  smallSize: 52,
  bigColor: '#ffffff',
  smallColor: '#ffd84d',
  bigUpper: true,
  smallUpper: false,
  position: 'bl',
  effect: 'shadow',
  boxColor: '#7c5cff',
  overlay: 'gradient',
  overlayColor: '#000000',
  shade: 55,
  zoom: 1,
  focusX: 50,
  focusY: 50,
  brightness: 100,
  blur: 0,
  frameTime: 0,
  logo: null,
  logoCorner: 'tr',
  logoSize: 12,
  format: 'jpg',
  guides: true,
};

const TOKENS_HINT = '{n} {nn} {show} {title}';

/** YouTube thumbnail maker. All style settings persist in localStorage for the next episode. */
export function Thumbnail(props: { video: File | null; show: string; episode: number; title: string; baseName: string }) {
  const [s, setS] = useState<ThumbSettings>(() => ({ ...THUMB_DEFAULTS, ...load<Partial<ThumbSettings>>('thumb', {}) }));
  const set = <K extends keyof ThumbSettings>(key: K, value: ThumbSettings[K]) => setS((prev) => ({ ...prev, [key]: value }));
  useEffect(() => save('thumb', s), [s]);

  const [image, setImage] = useState<File | null>(null);
  const [duration, setDuration] = useState(0);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [logoBitmap, setLogoImg] = useState<ImageBitmap | null>(null);
  const logoImg = s.logo ? logoBitmap : null;
  const [exported, setExported] = useState<{ size: number; name: string } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { confirm, dialog } = useConfirm();

  const fill = (template: string) =>
    template
      .split('{nn}').join(String(props.episode).padStart(2, '0'))
      .split('{n}').join(String(props.episode))
      .split('{show}').join(props.show.trim())
      .split('{title}').join(props.title.trim());
  const bigText = fill(s.bigText);
  const smallText = fill(s.smallText);

  // ---- background source --------------------------------------------------------------------
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

  const frameTime = duration ? Math.min(s.frameTime, Math.max(0, duration - 0.05)) : s.frameTime;
  useEffect(() => {
    const v = videoRef.current;
    if (v && videoUrl && duration && Number.isFinite(frameTime)) v.currentTime = frameTime;
  }, [frameTime, videoUrl, duration]);

  useEffect(() => {
    if (!s.logo) return;
    let cancelled = false;
    fetch(s.logo)
      .then((r) => r.blob())
      .then((b) => createImageBitmap(b))
      .then((b) => !cancelled && setLogoImg(b))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [s.logo]);

  // ---- draw ---------------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await Promise.all([ensureFont(s.bigFont, 'big', bigText), ensureFont(s.smallFont, 'small', smallText)]);
      if (cancelled || !canvasRef.current) return;
      draw(canvasRef.current, s, { bitmap, logo: logoImg, bigText, smallText });
      const mini = miniRef.current;
      if (mini) mini.getContext('2d')!.drawImage(canvasRef.current, 0, 0, mini.width, mini.height);
    })();
    return () => {
      cancelled = true;
    };
  }, [s, bitmap, logoImg, bigText, smallText]);

  const download = async () => {
    const canvas = canvasRef.current!;
    let blob: Blob;
    if (s.format === 'png') {
      blob = await toBlob(canvas, 'image/png');
    } else {
      let quality = 0.92;
      blob = await toBlob(canvas, 'image/jpeg', quality);
      while (blob.size > MAX_BYTES && quality > 0.4) {
        quality -= 0.08;
        blob = await toBlob(canvas, 'image/jpeg', quality);
      }
    }
    const name = `${props.baseName || 'thumbnail'} - thumbnail.${s.format}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setExported({ size: blob.size, name });
  };

  const pickLogo = async (file: File | undefined) => {
    if (!file) return;
    set('logo', await toSmallDataUrl(file, 512));
  };

  const hasSource = !!image || !!props.video;
  const col = s.position[1] as 'l' | 'c' | 'r';
  const row = s.position[0] as 't' | 'm' | 'b';
  const setPos = (r: string, c: string) => set('position', `${r}${c}` as Pos);

  const resetStyle = async () => {
    if (await confirm('Reset thumbnail style?', 'Fonts, colors, layout and background adjustments go back to the defaults. Your logo and texts stay.', 'Reset style'))
      setS({ ...THUMB_DEFAULTS, logo: s.logo, frameTime: s.frameTime, bigText: s.bigText, smallText: s.smallText });
  };
  const removeLogo = async () => {
    if (await confirm('Remove the logo?', 'The saved logo is deleted from this browser. You can add it again later.', 'Remove logo'))
      set('logo', null);
  };

  return (
    <section className="section" id="thumbnail" aria-labelledby="h-thumb">
      <SectionHead id="h-thumb" n={5} title="Thumbnail" sub="Design the image people click on. Style settings are remembered." />
      {!hasSource ? (
        <div className="empty">
          <p>Design a 1280×720 thumbnail from a frame of your loop video or any image.</p>
          <p className="helper">Add a loop video above, or start from an image.</p>
          <div>
            <FileButton className="btn" accept="image/*" label="Choose an image" onFile={(f) => f && setImage(f)} />
          </div>
        </div>
      ) : (
        <div className="thumb">
          <div className="thumb-frame">
            <canvas ref={canvasRef} width={W} height={H} className="thumb-canvas" aria-label="Thumbnail preview" />
            {s.guides && (
              <div className="guide-badge" aria-hidden="true">
                12:34
              </div>
            )}
          </div>
          <div className="thumb-mini">
            <canvas ref={miniRef} width={320} height={180} aria-hidden="true" />
            <p className="helper">Feed size. If the small text is hard to read here, make it bigger.</p>
          </div>

          <Group title="Text" open>
            <label className="field">
              Big text
              <input value={s.bigText} onChange={(e) => set('bigText', e.target.value)} placeholder="EPISODE {n}" />
            </label>
            <div className="trio">
              <FontSelect label="Font" value={s.bigFont} onChange={(v) => set('bigFont', v)} />
              <ColorInput label="Color" value={s.bigColor} onChange={(v) => set('bigColor', v)} />
              <label className="check">
                <input type="checkbox" checked={s.bigUpper} onChange={(e) => set('bigUpper', e.target.checked)} />
                Uppercase
              </label>
            </div>
            <Range label="Size" value={s.bigSize} min={60} max={260} onChange={(v) => set('bigSize', v)} suffix=" px" />

            <label className="field">
              Small text
              <input value={s.smallText} onChange={(e) => set('smallText', e.target.value)} placeholder="{title}" />
            </label>
            <div className="trio">
              <FontSelect label="Font" value={s.smallFont} onChange={(v) => set('smallFont', v)} />
              <ColorInput label="Color" value={s.smallColor} onChange={(v) => set('smallColor', v)} />
              <label className="check">
                <input type="checkbox" checked={s.smallUpper} onChange={(e) => set('smallUpper', e.target.checked)} />
                Uppercase
              </label>
            </div>
            <Range label="Size" value={s.smallSize} min={24} max={110} onChange={(v) => set('smallSize', v)} suffix=" px" />
            <p className="helper">Tokens {TOKENS_HINT} are filled from the episode fields.</p>
          </Group>

          <Group title="Layout" open>
            <div className="grid-3">
              <label className="field">
                Horizontal
                <select value={col} onChange={(e) => setPos(row, e.target.value)}>
                  <option value="l">Left</option>
                  <option value="c">Center</option>
                  <option value="r">Right</option>
                </select>
              </label>
              <label className="field">
                Vertical
                <select value={row} onChange={(e) => setPos(e.target.value, col)}>
                  <option value="t">Top</option>
                  <option value="m">Middle</option>
                  <option value="b">Bottom</option>
                </select>
              </label>
              <label className="field">
                Small text
                <select value={s.smallPlacement} onChange={(e) => set('smallPlacement', e.target.value as 'below' | 'above')}>
                  <option value="below">Below big text</option>
                  <option value="above">Above big text</option>
                </select>
              </label>
            </div>
            <div className="row">
              <label className="field">
                Text effect
                <select value={s.effect} onChange={(e) => set('effect', e.target.value as ThumbSettings['effect'])}>
                  <option value="shadow">Shadow</option>
                  <option value="outline">Outline</option>
                  <option value="box">Highlight box</option>
                  <option value="none">None</option>
                </select>
              </label>
              {s.effect === 'box' && <ColorInput label="Box color" value={s.boxColor} onChange={(v) => set('boxColor', v)} />}
            </div>
          </Group>

          <Group title="Background">
            <div className="row">
              <label className="field">
                Background
                <select value={image ? 'image' : 'video'} onChange={(e) => e.target.value === 'video' && setImage(null)}>
                  <option value="video" disabled={!props.video}>
                    Frame from loop video
                  </option>
                  {image && <option value="image">{image.name}</option>}
                </select>
              </label>
              <FileButton className="btn secondary" accept="image/*" label="Use an image" onFile={(f) => f && setImage(f)} />
            </div>
            {!image && videoUrl && (
              <Range
                label={`Frame at ${fmtTime(frameTime)}`}
                value={frameTime}
                min={0}
                max={Math.max(0, duration - 0.05)}
                step={0.04}
                onChange={(v) => set('frameTime', v)}
                hideValue
              />
            )}
            <div className="grid-2">
              <Range label="Zoom" value={s.zoom} min={1} max={2.5} step={0.05} onChange={(v) => set('zoom', v)} suffix="×" />
              <Range label="Brightness" value={s.brightness} min={40} max={160} onChange={(v) => set('brightness', v)} suffix="%" />
              <Range label="Move left / right" value={s.focusX} min={0} max={100} onChange={(v) => set('focusX', v)} suffix="%" />
              <Range label="Move up / down" value={s.focusY} min={0} max={100} onChange={(v) => set('focusY', v)} suffix="%" />
              <Range label="Blur" value={s.blur} min={0} max={24} onChange={(v) => set('blur', v)} suffix=" px" />
            </div>
            <div className="row">
              <label className="field">
                Overlay
                <select value={s.overlay} onChange={(e) => set('overlay', e.target.value as ThumbSettings['overlay'])}>
                  <option value="gradient">Gradient from the text side</option>
                  <option value="solid">Solid tint</option>
                  <option value="none">None</option>
                </select>
              </label>
              <ColorInput label="Overlay color" value={s.overlayColor} onChange={(v) => set('overlayColor', v)} />
            </div>
            {s.overlay !== 'none' && (
              <Range label="Overlay strength" value={s.shade} min={0} max={90} onChange={(v) => set('shade', v)} suffix="%" />
            )}
          </Group>

          <Group title="Logo">
            {!s.logo && <p className="helper">Add your channel logo; it is remembered for the next episodes.</p>}
            <div className="row">
              <FileButton className="btn secondary" accept="image/*" label={s.logo ? 'Replace logo' : 'Add logo'} onFile={pickLogo} />
              {s.logo && (
                <button className="btn secondary" onClick={removeLogo}>
                  Remove logo
                </button>
              )}
            </div>
            {s.logo && (
              <div className="grid-2">
                <label className="field">
                  Corner
                  <select value={s.logoCorner} onChange={(e) => set('logoCorner', e.target.value as Corner)}>
                    <option value="tl">Top left</option>
                    <option value="tr">Top right</option>
                    <option value="bl">Bottom left</option>
                    <option value="br">Bottom right</option>
                  </select>
                </label>
                <Range label="Logo size" value={s.logoSize} min={5} max={35} onChange={(v) => set('logoSize', v)} suffix="%" />
              </div>
            )}
            {s.logo && s.logoCorner === 'br' && (
              <p className="notice warn">YouTube covers the bottom-right corner with the video length. Pick another corner.</p>
            )}
          </Group>

          <div className="row">
            <label className="field narrow-2">
              Format
              <select value={s.format} onChange={(e) => set('format', e.target.value as 'jpg' | 'png')}>
                <option value="jpg">JPG (under 2 MB)</option>
                <option value="png">PNG</option>
              </select>
            </label>
            <button className="btn" onClick={download}>
              Download thumbnail
            </button>
          </div>
          <div className="row spread">
            <label className="check">
              <input type="checkbox" checked={s.guides} onChange={(e) => set('guides', e.target.checked)} />
              Show where YouTube puts the length badge
            </label>
            <button className="btn secondary" onClick={resetStyle}>
              Reset style
            </button>
          </div>
          {exported && (
            <p className="helper" aria-live="polite">
              Saved “{exported.name}” · {fmtBytes(exported.size)}
              {s.format === 'png' && exported.size > MAX_BYTES && ' — over 2 MB; choose JPG for YouTube.'}
            </p>
          )}

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
      {dialog}
    </section>
  );
}

// ==== small controls =========================================================================

function Group(props: { title: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="group" open={props.open}>
      <summary>{props.title}</summary>
      <div className="group-body">{props.children}</div>
    </details>
  );
}

function Range(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  hideValue?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <label className="field">
      <span className="range-label">
        {props.label}
        {!props.hideValue && (
          <span className="range-value">
            {Number.isInteger(props.step ?? 1) ? Math.round(props.value) : props.value.toFixed(2)}
            {props.suffix ?? ''}
          </span>
        )}
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

function FontSelect(props: { label: string; value: FontKey; onChange: (v: FontKey) => void }) {
  return (
    <label className="field">
      {props.label}
      <select value={props.value} onChange={(e) => props.onChange(e.target.value as FontKey)}>
        {(Object.keys(FONTS) as FontKey[]).map((k) => (
          <option key={k} value={k}>
            {FONTS[k].label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ColorInput(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="field color-field">
      {props.label}
      <input type="color" value={props.value} onChange={(e) => props.onChange(e.target.value)} />
    </label>
  );
}

// ==== helpers ================================================================================

function useObjectUrl(file: File | null) {
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  return url;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not export the image'))), type, quality),
  );
}

/** Downscales an image to fit `max` px and returns a PNG data URL (small enough for localStorage). */
async function toSmallDataUrl(file: File, max: number) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ==== rendering ==============================================================================

type Line = { text: string; role: 'big' | 'small'; px: number; asc: number; desc: number; gapAfter: number };

function draw(
  canvas: HTMLCanvasElement,
  s: ThumbSettings,
  o: { bitmap: ImageBitmap | null; logo: ImageBitmap | null; bigText: string; smallText: string },
) {
  const ctx = canvas.getContext('2d')!;
  ctx.save();
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, W, H);

  // background: cover + zoom + pan, with brightness/blur
  if (o.bitmap) {
    const bleed = s.blur * 2;
    const scale = Math.max((W + bleed * 2) / o.bitmap.width, (H + bleed * 2) / o.bitmap.height) * s.zoom;
    const w = o.bitmap.width * scale;
    const h = o.bitmap.height * scale;
    const x = (W - w) * (s.focusX / 100);
    const y = (H - h) * (s.focusY / 100);
    const filters = [];
    if (s.brightness !== 100) filters.push(`brightness(${s.brightness}%)`);
    if (s.blur > 0) filters.push(`blur(${s.blur}px)`);
    ctx.filter = filters.join(' ') || 'none';
    ctx.drawImage(o.bitmap, x, y, w, h);
    ctx.filter = 'none';
  }

  const col = s.position[1] as 'l' | 'c' | 'r';
  const row = s.position[0] as 't' | 'm' | 'b';

  // overlay
  const a = s.shade / 100;
  if (s.overlay === 'solid' && a > 0) {
    ctx.fillStyle = hexA(s.overlayColor, a);
    ctx.fillRect(0, 0, W, H);
  } else if (s.overlay === 'gradient' && a > 0) {
    let g: CanvasGradient;
    if (col === 'l') g = ctx.createLinearGradient(0, 0, W, 0);
    else if (col === 'r') g = ctx.createLinearGradient(W, 0, 0, 0);
    else if (row === 't') g = ctx.createLinearGradient(0, 0, 0, H);
    else if (row === 'b') g = ctx.createLinearGradient(0, H, 0, 0);
    else g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W * 0.6);
    g.addColorStop(0, hexA(s.overlayColor, a));
    g.addColorStop(0.6, hexA(s.overlayColor, a * 0.5));
    g.addColorStop(1, hexA(s.overlayColor, a * 0.1));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // text block
  const pad = 72;
  const maxW = col === 'c' ? W - pad * 2 : W * 0.72;
  const big = s.bigUpper ? o.bigText.toUpperCase() : o.bigText;
  const small = s.smallUpper ? o.smallText.toUpperCase() : o.smallText;

  const layout = (text: string, role: 'big' | 'small', size: number, maxLines: number): Line[] => {
    if (!text.trim()) return [];
    const key = role === 'big' ? s.bigFont : s.smallFont;
    let px = size;
    let lines: string[] = [];
    for (; px >= 20; px -= 2) {
      ctx.font = fontCss(key, role, px);
      lines = wrap(ctx, text.trim(), maxW);
      if (lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= maxW)) break;
    }
    ctx.font = fontCss(key, role, px);
    const m = ctx.measureText('HÉgq');
    const asc = m.actualBoundingBoxAscent || px * 0.75;
    const desc = m.actualBoundingBoxDescent || px * 0.2;
    return lines.slice(0, maxLines).map((t) => ({ text: t, role, px, asc, desc, gapAfter: (asc + desc) * 0.22 }));
  };

  const bigLines = layout(big, 'big', s.bigSize, 2);
  const smallLines = layout(small, 'small', s.smallSize, 3);
  const groupGap = bigLines.length && smallLines.length ? Math.max(14, s.smallSize * 0.35) : 0;
  const ordered = s.smallPlacement === 'above' ? [smallLines, bigLines] : [bigLines, smallLines];
  const lines: Line[] = [];
  ordered.forEach((group, gi) => {
    group.forEach((l, i) => {
      lines.push({ ...l, gapAfter: i === group.length - 1 ? (gi === 0 ? groupGap : 0) : l.gapAfter });
    });
  });
  const boxPadY = s.effect === 'box' ? 14 : 0;
  const lineH = (l: Line) => l.asc + l.desc + boxPadY * 2;
  const blockH = lines.reduce((h, l) => h + lineH(l) + l.gapAfter, 0);
  let y = row === 't' ? pad : row === 'b' ? H - pad - blockH : (H - blockH) / 2;
  const x = col === 'l' ? pad : col === 'r' ? W - pad : W / 2;
  ctx.textAlign = col === 'l' ? 'left' : col === 'r' ? 'right' : 'center';
  ctx.textBaseline = 'alphabetic';

  for (const l of lines) {
    const key = l.role === 'big' ? s.bigFont : s.smallFont;
    ctx.font = fontCss(key, l.role, l.px);
    const baseline = y + boxPadY + l.asc;
    const color = l.role === 'big' ? s.bigColor : s.smallColor;

    if (s.effect === 'box') {
      const w = ctx.measureText(l.text).width;
      const padX = l.px * 0.22;
      const left = col === 'l' ? x - padX : col === 'r' ? x - w - padX : x - w / 2 - padX;
      ctx.fillStyle = l.role === 'big' ? s.boxColor : hexA('#000000', 0.75);
      roundRect(ctx, left, y, w + padX * 2, lineH(l), Math.min(14, l.px * 0.12));
    }
    if (s.effect === 'shadow') {
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = l.px * 0.18;
      ctx.shadowOffsetY = l.px * 0.04;
    }
    if (s.effect === 'outline') {
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(4, l.px * 0.1);
      ctx.strokeStyle = '#000';
      ctx.strokeText(l.text, x, baseline);
    }
    ctx.fillStyle = color;
    ctx.fillText(l.text, x, baseline);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    y += lineH(l) + l.gapAfter;
  }

  // logo
  if (o.logo) {
    const lw = (W * s.logoSize) / 100;
    const lh = (o.logo.height / o.logo.width) * lw;
    const m = 40;
    const lx = s.logoCorner[1] === 'l' ? m : W - m - lw;
    const ly = s.logoCorner[0] === 't' ? m : H - m - lh;
    ctx.drawImage(o.logo, lx, ly, lw, lh);
  }
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
  ctx.fill();
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
