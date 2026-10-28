// Bundled with the app (no network needed). Each CSS file declares the font with unicode-range
// subsets, so only the glyph ranges actually used (e.g. latin-ext for ə, ğ, ş) get loaded.
import '@fontsource/inter/600.css';
import '@fontsource/inter/800.css';
import '@fontsource/montserrat/600.css';
import '@fontsource/montserrat/800.css';
import '@fontsource/anton/400.css';
import '@fontsource/bebas-neue/400.css';
import '@fontsource/oswald/500.css';
import '@fontsource/oswald/700.css';
import '@fontsource/playfair-display/600.css';
import '@fontsource/playfair-display/800.css';

export type FontKey = 'anton' | 'bebas' | 'oswald' | 'montserrat' | 'inter' | 'playfair';

export const FONTS: Record<FontKey, { label: string; family: string; big: number; small: number }> = {
  anton: { label: 'Anton', family: 'Anton', big: 400, small: 400 },
  bebas: { label: 'Bebas Neue', family: 'Bebas Neue', big: 400, small: 400 },
  oswald: { label: 'Oswald', family: 'Oswald', big: 700, small: 500 },
  montserrat: { label: 'Montserrat', family: 'Montserrat', big: 800, small: 600 },
  inter: { label: 'Inter', family: 'Inter', big: 800, small: 600 },
  playfair: { label: 'Playfair (serif)', family: 'Playfair Display', big: 800, small: 600 },
};

export function fontCss(key: FontKey, role: 'big' | 'small', px: number) {
  const f = FONTS[key] ?? FONTS.inter;
  return `${role === 'big' ? f.big : f.small} ${px}px "${f.family}", "Segoe UI", Roboto, system-ui, sans-serif`;
}

/** Makes sure the glyphs for `text` are loaded before drawing on canvas. */
export async function ensureFont(key: FontKey, role: 'big' | 'small', text: string) {
  try {
    await document.fonts.load(fontCss(key, role, 40), text || 'A');
  } catch {
    /* fall back to system fonts */
  }
}
