import { escapeHtml } from './dom';

/**
 * Player avatar, stored in settings as one of:
 * - '' (default silhouette)
 * - '<glyph>|<#rrggbb>' (preset: emoji/symbol on a coloured tile)
 * - 'data:image/jpeg;base64,…' (photo, already cropped/resized by {@link avatarFromFile})
 */
export const AVATAR_PRESETS: string[] = [
  '',
  '🦁|#e0a243',
  '🐯|#d9773b',
  '🦊|#c8553d',
  '🐼|#6b8f71',
  '🐨|#7a8ca3',
  '🐸|#5d9948',
  '🐧|#3d6e9e',
  '🦉|#8a6d4e',
  '🐱|#b9769a',
  '🐶|#a77b4f',
  '🐰|#9b7fc4',
  '♔|#4b4847',
  '♕|#7b3f61',
  '♘|#2f6f6b',
  '😎|#c2a33a',
];

const SILHOUETTE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="4.2" fill="currentColor"/><path d="M3.8 21c.6-4.4 4-7 8.2-7s7.6 2.6 8.2 7z" fill="currentColor"/></svg>';

const IMG_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

/** Inner HTML + inline style for an `.avatar` element. */
export function avatarParts(value: string): { cls: string; style: string; html: string } {
  if (IMG_RE.test(value)) return { cls: 'img', style: `background-image:url(${value})`, html: '' };
  const [glyph, bg] = value.split('|');
  if (glyph && bg && COLOR_RE.test(bg)) return { cls: 'glyph', style: `background:${bg}`, html: escapeHtml(glyph) };
  return { cls: 'default', style: '', html: SILHOUETTE };
}

export function avatarHtml(value: string, extraCls = ''): string {
  const p = avatarParts(value);
  return `<div class="avatar me ${p.cls} ${extraCls}"${p.style ? ` style="${p.style}"` : ''}>${p.html}</div>`;
}

/** Centre-crops and downsizes a picked photo to a small JPEG data URL (~10KB) so it fits in localStorage. */
export async function avatarFromFile(file: File, size = 160): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    if (!s) throw new Error('无法读取图片');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const g = canvas.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}
