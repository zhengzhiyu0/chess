export function themeColor(theme: 'dark' | 'light', style: 'classic' | 'duolingo') {
  if (style === 'duolingo') return theme === 'dark' ? '#142127' : '#ffffff';
  return theme === 'dark' ? '#262421' : '#f5f6f7';
}
