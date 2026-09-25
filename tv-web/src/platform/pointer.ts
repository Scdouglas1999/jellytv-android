/**
 * The LG Magic Remote's pointer, as LG's guidelines ask (webostv.developer.lge.com/develop/guides/magic-remote and
 * its RemoteControl sample): the remote is in pointer mode or in 5-way mode, and the app follows.
 *  - Moving the pointer onto something focusable focuses it (the amber frame follows the pointer), as the arrow keys
 *    would; the frame stays where it is when the pointer leaves (the next arrow key starts from there).
 *  - A click is OK on what is under the pointer. webOS may also send OK's key (13) for the same press: an OK key
 *    just before the click means the key router already did it, so the click is dropped. Focus can scroll a row or
 *    a page (as on Android TV), moving what the pointer just focused away from under it: a click where it was when
 *    it was focused still means it.
 *  - The wheel steps focus up and down, one row per notch (lists scroll in the wheel's direction).
 *  - `cursorStateChange` (detail.visibility, webOS 2+; the system-ui-visibility guide) says whether the pointer is
 *    showing: `html.pointer-mode` while it is. An arrow key hides it (the TV switches to 5-way mode).
 * Everything goes through the key router as the remote's own keys would (synthetic key events), so dialogs, the
 * players and HOLD handling see a click exactly as an OK press.
 */
import { currentFocusKey, focusKeyAt, focusableAt, setFocus } from '../focus/focus';

/** A click this soon after an OK key is the same press (webOS sends both on some models). */
const CLICK_AFTER_KEY_MS = 400;
/** One wheel step at most this often (a notch sends several events on some remotes). */
const WHEEL_STEP_MS = 180;

export interface PointerOptions {
  /** For the tests: the clock. */
  now?: () => number;
  target?: Window;
}

const KEY_CODES: Record<string, number> = { Enter: 13, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };

/** The remote's key, as the key router receives it (keyCode set: Chromium 68 ignores it in the init dictionary). */
export function remoteKey(target: Window, key: string): void {
  for (const type of ['keydown', 'keyup']) {
    const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true });
    const code = KEY_CODES[key] ?? 0;
    Object.defineProperty(event, 'keyCode', { get: () => code });
    Object.defineProperty(event, 'which', { get: () => code });
    target.dispatchEvent(event);
  }
}

export function setPointerMode(on: boolean): void {
  document.documentElement.classList.toggle('pointer-mode', on);
}

export function installPointer(options: PointerOptions = {}): () => void {
  const now = options.now ?? Date.now;
  const target = options.target ?? window;
  let lastX = -1;
  let lastY = -1;
  let lastOkKey = -Infinity;
  let lastWheel = -Infinity;
  let synthetic = false;
  /** What the pointer focused last, and where it was then (canvas pixels). */
  let hovered: { key: string; el: Element; rect: { left: number; top: number; right: number; bottom: number } } | null = null;

  const onCursor = (e: Event): void => {
    const detail = (e as CustomEvent<{ visibility?: boolean }>).detail;
    setPointerMode(detail?.visibility === true);
  };

  const onMove = (e: MouseEvent): void => {
    // Chromium sends a move with the same coordinates after a scroll: only a real move focuses
    if (e.clientX === lastX && e.clientY === lastY) return;
    lastX = e.clientX;
    lastY = e.clientY;
    setPointerMode(true);
    const at = focusableAt(e.target as Element | null);
    if (at === null || at.key === currentFocusKey()) return;
    const r = at.node.getBoundingClientRect();
    hovered = { key: at.key, el: at.node, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
    setFocus(at.key);
  };

  /** What a click at (x, y) means: the focusable under it, or the one focused there before focus scrolled it away. */
  const clicked = (e: MouseEvent): string | null => {
    const key = focusKeyAt(e.target as Element | null);
    if (key !== null) return key;
    if (hovered === null || hovered.key !== currentFocusKey()) return null;
    const { rect } = hovered;
    const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    const now = hovered.el.getBoundingClientRect();
    const moved = now.left !== rect.left || now.top !== rect.top;
    return inside && moved ? hovered.key : null;
  };

  const onKey = (e: KeyboardEvent): void => {
    if (synthetic) return;
    if (e.keyCode === 13) lastOkKey = now();
    else if (e.keyCode >= 37 && e.keyCode <= 40) setPointerMode(false);
  };

  const onClick = (e: MouseEvent): void => {
    const key = clicked(e);
    if (key === null) return;
    e.preventDefault();
    if (now() - lastOkKey < CLICK_AFTER_KEY_MS) return;
    if (key !== currentFocusKey()) setFocus(key);
    synthetic = true;
    try {
      remoteKey(target, 'Enter');
    } finally {
      synthetic = false;
    }
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const t = now();
    if (t - lastWheel < WHEEL_STEP_MS || e.deltaY === 0) return;
    lastWheel = t;
    synthetic = true;
    try {
      remoteKey(target, e.deltaY > 0 ? 'ArrowDown' : 'ArrowUp');
    } finally {
      synthetic = false;
    }
  };

  document.addEventListener('cursorStateChange', onCursor);
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('wheel', onWheel, { capture: true, passive: false });
  // only reads the key (after the key router, which listens on the same phase and was added first)
  target.addEventListener('keydown', onKey, true);
  return () => {
    document.removeEventListener('cursorStateChange', onCursor);
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('wheel', onWheel, true);
    target.removeEventListener('keydown', onKey, true);
  };
}
