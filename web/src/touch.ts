/**
 * [I] Touch controls for phones and tablets (not in the original). The controls send the same
 * key events as the keyboard, so the game, the menu and network play need no changes:
 * - a floating joystick on the left half of the screen gives the arrow keys. In a race it steers
 *   by direction: any push walks forward (backward when pulled down) and a push to the side also
 *   turns. The menu gets one direction at a time, repeated while held, like Menu_ReadKeys;
 * - buttons on the right: the action (Space), punch (E) with the punch house rule, Ja / Nej in a
 *   quiz, OK (Enter) in the menu and after a race, and a menu / back button (Escape);
 * - a keyboard button on the menu's text fields focuses a hidden input to bring up the phone's
 *   keyboard.
 * The first touch asks for fullscreen and landscape where the browser allows it; in portrait a
 * notice asks to turn the phone.
 */

/** What the screen shows now, polled every frame. */
export interface TouchState {
  menu: boolean;
  /** The menu is on a text field. */
  text: boolean;
  quiz: boolean;
  punch: boolean;
  /** A race result waiting for Enter. */
  result: boolean;
}

const STICK_RADIUS = 60;
const DEAD_ZONE = 0.35;
/** Joystick angles from straight up: within STRAIGHT_ANGLE no turn, past BACK_ANGLE walk backward. */
const STRAIGHT_ANGLE = (20 * Math.PI) / 180;
const BACK_ANGLE = (135 * Math.PI) / 180;
/** Menu_ReadKeys repeats held keys every 200 ms. */
const MENU_REPEAT_MS = 220;

function send(type: 'keydown' | 'keyup', code: string, key = code, repeat = false): void {
  window.dispatchEvent(new KeyboardEvent(type, { code, key, repeat, bubbles: true }));
}

/** "?touch" in the URL forces the touch controls (mouse included), for trying them on a desktop. */
const FORCED = new URLSearchParams(location.search).has('touch');

export function isTouchDevice(): boolean {
  return FORCED || matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
}

export function installTouchControls(state: () => TouchState): void {
  const root = document.createElement('div');
  root.id = 'touch';
  root.innerHTML = `
    <div class="stick hidden"><div class="knob"></div></div>
    <button class="btn esc" data-code="Escape">Meny</button>
    <button class="btn kbd hidden">⌨</button>
    <button class="btn action" data-code="Space">●</button>
    <button class="btn punch hidden" data-code="KeyE">Slag</button>
    <button class="btn ok hidden" data-code="Enter">OK</button>
    <button class="btn yes hidden" data-code="KeyJ" data-key="j">Ja</button>
    <button class="btn no hidden" data-code="KeyN" data-key="n">Nej</button>
    <input class="text" autocomplete="off" autocapitalize="off" spellcheck="false" />
    <div class="rotate hidden">Vrid telefonen till liggande läge</div>`;
  document.body.appendChild(root);
  document.body.classList.add('touch');
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;

  // Buttons: key down while pressed.
  root.querySelectorAll<HTMLButtonElement>('button[data-code]').forEach((b) => {
    const code = b.dataset.code!, key = b.dataset.key ?? (code === 'Space' ? ' ' : code);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      b.classList.add('down');
      send('keydown', code, key);
    });
    const up = () => {
      if (!b.classList.contains('down')) return;
      b.classList.remove('down');
      send('keyup', code, key);
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
  });

  // The phone keyboard for the menu's text fields.
  const input = $<HTMLInputElement>('input.text');
  $('.kbd').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    input.value = '';
    input.focus();
  });
  input.addEventListener('beforeinput', (e) => {
    e.preventDefault();
    if (e.inputType === 'deleteContentBackward') send('keydown', 'Backspace', 'Backspace');
    else if (e.inputType === 'insertLineBreak') {
      send('keydown', 'Enter', 'Enter');
      input.blur();
    } else for (const ch of e.data ?? '') send('keydown', ch === ' ' ? 'Space' : `Key${ch.toUpperCase()}`, ch);
  });
  input.addEventListener('keydown', (e) => {
    // Hardware or soft keys that reach the input are passed on by beforeinput; Enter closes it.
    if (e.key === 'Enter') {
      e.preventDefault();
      send('keydown', 'Enter', 'Enter');
      input.blur();
    }
    e.stopPropagation();
  });

  // The floating joystick.
  const stick = $('.stick'), knob = $('.knob');
  let stickId: number | null = null;
  let cx = 0, cy = 0;
  const held = new Set<string>();
  let lastRepeat = 0;
  const setKeys = (want: Set<string>) => {
    for (const k of held) if (!want.has(k)) send('keyup', k);
    for (const k of want) if (!held.has(k)) send('keydown', k);
    held.clear();
    want.forEach((k) => held.add(k));
    lastRepeat = performance.now();
  };
  const moveStick = (x: number, y: number) => {
    let dx = (x - cx) / STICK_RADIUS, dy = (y - cy) / STICK_RADIUS;
    const len = Math.hypot(dx, dy);
    if (len > 1) (dx /= len), (dy /= len);
    knob.style.transform = `translate(${dx * STICK_RADIUS}px, ${dy * STICK_RADIUS}px)`;
    const want = new Set<string>();
    if (state().menu) {
      // One direction at a time in the menu.
      if (Math.max(Math.abs(dx), Math.abs(dy)) > DEAD_ZONE * 1.5) want.add(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'ArrowRight' : 'ArrowLeft') : dy > 0 ? 'ArrowDown' : 'ArrowUp');
    } else if (len > DEAD_ZONE) {
      // Steer by direction: any push walks (forward, or backward when pulled down) and a push
      // to the side turns that way, so holding left walks a left turn without also pushing up.
      const angle = Math.abs(Math.atan2(dx, -dy)); // 0 = up, pi = down
      want.add(angle <= BACK_ANGLE ? 'ArrowUp' : 'ArrowDown');
      if (angle > STRAIGHT_ANGLE && angle < Math.PI - STRAIGHT_ANGLE) want.add(dx > 0 ? 'ArrowRight' : 'ArrowLeft');
    }
    if ([...want].some((k) => !held.has(k)) || [...held].some((k) => !want.has(k))) setKeys(want);
  };
  window.addEventListener(
    'pointerdown',
    (e) => {
      if ((e.pointerType === 'mouse' && !FORCED) || stickId !== null || e.target instanceof HTMLButtonElement || e.clientX > window.innerWidth * 0.5) return;
      stickId = e.pointerId;
      cx = e.clientX;
      cy = e.clientY;
      stick.style.left = `${cx}px`;
      stick.style.top = `${cy}px`;
      stick.classList.remove('hidden');
      moveStick(cx, cy);
    },
    { passive: true },
  );
  window.addEventListener('pointermove', (e) => {
    if (e.pointerId === stickId) moveStick(e.clientX, e.clientY);
  });
  const release = (e: PointerEvent) => {
    if (e.pointerId !== stickId) return;
    stickId = null;
    stick.classList.add('hidden');
    knob.style.transform = '';
    setKeys(new Set());
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);

  // Fullscreen and landscape on the first touch (Android browsers; iOS Safari allows neither).
  const goFullscreen = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen({ navigationUI: 'hide' })
        .then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape'))
        .catch(() => {});
    }
  };
  window.addEventListener('pointerdown', goFullscreen, { passive: true });

  // Show the buttons that apply now.
  const show = (sel: string, on: boolean) => $(sel).classList.toggle('hidden', !on);
  const frame = () => {
    const s = state();
    show('.kbd', s.menu && s.text);
    show('.action', !s.menu && !s.result);
    show('.punch', !s.menu && !s.result && s.punch);
    show('.ok', s.menu || s.result);
    show('.yes', s.quiz);
    show('.no', s.quiz);
    show('.rotate', window.innerHeight > window.innerWidth);
    // Menu_ReadKeys-style repeat of a held joystick direction.
    const now = performance.now();
    if (s.menu && held.size && now - lastRepeat > MENU_REPEAT_MS) {
      lastRepeat = now;
      held.forEach((k) => send('keydown', k, k, true));
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
