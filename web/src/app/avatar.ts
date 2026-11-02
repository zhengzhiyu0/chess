import { coachBg, coachSvg } from './coach-avatars';
import { escapeHtml } from './dom';

/**
 * Player avatar, stored in settings as one of:
 * - '' (default silhouette)
 * - '<glyph>|<#rrggbb>' (preset: emoji/symbol on a coloured tile)
 * - 'data:image/jpeg;base64,…' (photo; only from older backups, no longer produced)
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

export function coachAvatarHtml(index: number, extraCls = ''): string {
  return `<div class="avatar coach ${extraCls}" style="background:${coachBg(index)}">${coachSvg(index)}</div>`;
}
