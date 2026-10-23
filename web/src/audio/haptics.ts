import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { isNative } from '../native';

/** Native: Taptic Engine via @capacitor/haptics; web: navigator.vibrate (no-op on iOS Safari). */
export type HapticKind = 'tap' | 'select' | 'move' | 'capture' | 'check' | 'castle' | 'promote' | 'illegal' | 'start' | 'end' | 'lowtime';

const WEB_PATTERN: Partial<Record<HapticKind, number | number[]>> = {
  capture: 18,
  check: [20, 40, 20],
  illegal: [10, 30, 10],
  end: [30, 60, 30],
  lowtime: 12,
};

let on = true;
let lastTapAt = 0;

export function configureHaptics(enabled: boolean) {
  on = enabled;
}

function native(kind: HapticKind): Promise<void> | undefined {
  switch (kind) {
    case 'tap':
      return Haptics.impact({ style: ImpactStyle.Light });
    case 'select':
      return Haptics.selectionChanged();
    case 'move':
    case 'castle':
      return Haptics.impact({ style: ImpactStyle.Light });
    case 'capture':
    case 'promote':
      return Haptics.impact({ style: ImpactStyle.Medium });
    case 'check':
    case 'lowtime':
      return Haptics.notification({ type: NotificationType.Warning });
    case 'illegal':
      return Haptics.notification({ type: NotificationType.Error });
    case 'start':
      return Haptics.impact({ style: ImpactStyle.Medium });
    case 'end':
      return Haptics.notification({ type: NotificationType.Success });
  }
}

export function haptic(kind: HapticKind) {
  if (!on) return;
  if (isNative) {
    native(kind)?.catch(() => {});
    return;
  }
  const p = WEB_PATTERN[kind];
  if (p !== undefined) navigator.vibrate?.(p);
}

/** Ticks while dragging a piece across its legal squares (native only). Light impact: selectionChanged felt too weak. */
export const dragHaptics = {
  start() {},
  tick() {
    if (!on || !isNative) return;
    Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
  },
  end() {},
};

const TAPPABLE = 'button, [role="button"], .tool, .coach-line, label.check, select, input[type="checkbox"], input[type="radio"], summary';

/** Light tap on every button press in the native app (UIKit-style feedback). */
export function installTapHaptics() {
  if (!isNative) return;
  document.addEventListener(
    'pointerdown',
    (e) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(TAPPABLE);
      if (!el || el.matches(':disabled, [aria-disabled="true"]')) return;
      const now = performance.now();
      if (now - lastTapAt < 40) return;
      lastTapAt = now;
      haptic(el.matches('select, input, label.check') ? 'select' : 'tap');
    },
    { capture: true, passive: true },
  );
}
