const entries: string[] = [];
const limit = 1000;
let installed = false;

function format(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function record(level: string, values: unknown[]) {
  const line = `${new Date().toISOString()} [JS/${level}] ${values.map(format).join(' ')}`;
  entries.push(line);
  if (entries.length > limit) entries.splice(0, entries.length - limit);
}

export function installRuntimeLogCapture() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...values: unknown[]) => {
      record(level, values);
      original(...values);
    };
  }
  window.addEventListener('error', (event) => record('uncaught', [event.message, event.filename, event.lineno, event.colno, event.error]));
  window.addEventListener('unhandledrejection', (event) => record('unhandledrejection', [event.reason]));
  record('info', ['launch log capture started', navigator.userAgent]);
}

export function runtimeLogText(nativeLogs = ''): string {
  const sections = [`Maia Coach launch diagnostics`, `Exported: ${new Date().toISOString()}`, '', '=== JavaScript ===', ...entries];
  if (nativeLogs) sections.push('', '=== iOS native TTS ===', nativeLogs);
  return sections.join('\n') + '\n';
}
