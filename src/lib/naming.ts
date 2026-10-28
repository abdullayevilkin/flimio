export type NamingFields = { show: string; episode: number; title: string };

export const DEFAULT_TEMPLATE = '{show} - Episode {n} - {title}';
export const TEMPLATE_TOKENS = ['{show}', '{n}', '{nn}', '{title}', '{date}'];

/** Fills a template like "{show} - Episode {n} - {title}". Empty tokens and their separators collapse. */
export function applyTemplate(template: string, f: NamingFields): string {
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const values: Record<string, string> = {
    '{show}': f.show.trim(),
    '{n}': String(f.episode),
    '{nn}': String(f.episode).padStart(2, '0'),
    '{title}': f.title.trim(),
    '{date}': date,
  };
  let out = template;
  for (const [token, value] of Object.entries(values)) out = out.split(token).join(value);
  // tidy separators left behind by empty fields, e.g. "Show -  - Title"
  out = out
    .replace(/\s*([-–—|·:])\s*(?=[-–—|·:]|$)/g, '')
    .replace(/^\s*[-–—|·:]\s*/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return out;
}

/** Makes a string safe as a file name on Windows/macOS/Linux. */
export function toFileName(name: string, ext = '.mp4'): string {
  const clean = name
    .replace(/\s*[:|]\s*/g, ' - ')
    // oxlint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return (clean || 'video') + ext;
}
