// Input mapping. `keyToAction` is pure so it can be unit-tested.

const CODE_ACTIONS = {
	ArrowUp: 'up', KeyW: 'up',
	ArrowDown: 'down', KeyS: 'down',
	ArrowLeft: 'left', KeyA: 'left',
	ArrowRight: 'right', KeyD: 'right',
	Space: 'pause', KeyP: 'pause', Escape: 'pause',
	Enter: 'restart', NumpadEnter: 'restart',
};

// Fallback by produced character, for keyboards/browsers that report odd codes.
// Ukrainian/Russian layouts: Ц Ф І/Ы В sit where W A S D are.
const KEY_ACTIONS = {
	w: 'up', 'ц': 'up',
	s: 'down', 'і': 'down', 'ы': 'down',
	a: 'left', 'ф': 'left',
	d: 'right', 'в': 'right',
	' ': 'pause', p: 'pause', 'з': 'pause',
};

/** @returns {'up'|'down'|'left'|'right'|'pause'|'restart'|null} */
export function keyToAction({ code, key, ctrlKey, metaKey, altKey }) {
	if (ctrlKey || metaKey || altKey) return null;
	if (code && Object.hasOwn(CODE_ACTIONS, code)) return CODE_ACTIONS[code];
	const k = typeof key === 'string' ? key.toLowerCase() : '';
	return Object.hasOwn(KEY_ACTIONS, k) ? KEY_ACTIONS[k] : null;
}

/** Swipe direction from a pointer delta, or null if below the threshold. */
export function swipeDirection(dx, dy, threshold = 24) {
	const adx = Math.abs(dx);
	const ady = Math.abs(dy);
	if (Math.max(adx, ady) < threshold) return null;
	if (adx > ady) return dx > 0 ? 'right' : 'left';
	return dy > 0 ? 'down' : 'up';
}

const isTextField = (el) =>
	el instanceof HTMLElement && (el.matches('input, select, textarea') || el.isContentEditable);
const isButton = (el) => el instanceof HTMLElement && el.matches('button, a[href]');

export function bindKeyboard(onAction) {
	window.addEventListener('keydown', (e) => {
		// Form fields keep all their keys; a focused button keeps Space/Enter (activation).
		if (isTextField(e.target)) return;
		const action = keyToAction(e);
		if (!action) return;
		if (isButton(e.target) && (action === 'pause' || action === 'restart')) return;
		e.preventDefault();
		onAction(action, e);
	});
}

/**
 * Swipes anywhere on `el`. Turns fire mid-gesture as soon as the threshold is
 * crossed, and the origin resets so one continuous gesture can chain turns.
 */
export function bindSwipe(el, onAction) {
	let origin = null;
	el.addEventListener('pointerdown', (e) => {
		if (e.pointerType === 'mouse') return;
		origin = { x: e.clientX, y: e.clientY };
	});
	el.addEventListener('pointermove', (e) => {
		if (!origin) return;
		const dir = swipeDirection(e.clientX - origin.x, e.clientY - origin.y);
		if (dir) {
			onAction(dir, e);
			origin = { x: e.clientX, y: e.clientY };
		}
	});
	const end = () => { origin = null; };
	el.addEventListener('pointerup', end);
	el.addEventListener('pointercancel', end);
}

/** On-screen buttons with `data-action`. */
export function bindButtons(root, onAction) {
	root.addEventListener('pointerdown', (e) => {
		const btn = e.target.closest('[data-action]');
		if (!btn) return;
		e.preventDefault(); // keep focus off the button, fire immediately
		btn.classList.add('pressed'); // :active doesn't show once pointerdown is cancelled
		onAction(btn.dataset.action, e);
	});
	const unpress = (e) => e.target.closest?.('[data-action]')?.classList.remove('pressed');
	for (const type of ['pointerup', 'pointercancel', 'pointerleave', 'pointerout']) root.addEventListener(type, unpress);
	// Stop iOS from opening the long-press menu on the buttons.
	root.addEventListener('contextmenu', (e) => e.preventDefault());
}
