export function fmtTime(s: number) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return `${h ? h + ':' : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

export function fmtBytes(b: number) {
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

/** Parses "90", "1:30", "1:02:03" or "12.5" into seconds. Returns null if invalid. */
export function parseTime(text: string): number | null {
  const t = text.trim();
  if (!t) return 0;
  if (!/^\d+(\.\d+)?$|^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(t)) return null;
  return t.split(':').reduce((acc, part) => acc * 60 + parseFloat(part), 0);
}

export function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

/** localStorage helpers that never throw (private mode, quotas, etc.). */
export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`flimio:${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(`flimio:${key}`, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
