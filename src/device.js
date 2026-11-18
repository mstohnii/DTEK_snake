// Phone/tablet niceties. Every feature is optional: detect, try, and ignore failures.

export const isTouchDevice = () => window.matchMedia('(any-pointer: coarse)').matches;

/** Keep the screen on while a game is running (Screen Wake Lock API). */
export function createWakeLock() {
	let sentinel = null;
	let pending = null; // in-flight request, so rapid calls don't request two locks
	let wanted = false;
	const supported = 'wakeLock' in navigator;

	async function acquire() {
		wanted = true;
		if (!supported || sentinel || pending || document.visibilityState !== 'visible') return;
		pending = navigator.wakeLock.request('screen');
		try {
			const lock = await pending;
			if (!wanted) { lock.release().catch(() => {}); return; } // released while we waited
			sentinel = lock;
			sentinel.addEventListener('release', () => { if (sentinel === lock) sentinel = null; });
		} catch {
			sentinel = null; // denied (battery saver, iframe policy…) — not critical
		} finally {
			pending = null;
		}
	}

	function release() {
		wanted = false;
		sentinel?.release().catch(() => {});
		sentinel = null;
	}

	// The browser drops the lock when the page is hidden; take it back on return.
	document.addEventListener('visibilitychange', () => {
		if (wanted && document.visibilityState === 'visible') acquire();
	});

	return { acquire, release };
}

/** Short haptic feedback on devices that support it (Android). */
export function vibrate(pattern) {
	if (!isTouchDevice() || typeof navigator.vibrate !== 'function') return;
	try { navigator.vibrate(pattern); } catch { /* ignore */ }
}

export const fullscreenSupported = () =>
	Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);

const fullscreenElement = () => document.fullscreenElement ?? document.webkitFullscreenElement ?? null;

export async function toggleFullscreen() {
	try {
		if (fullscreenElement()) {
			await (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
			return false;
		}
		const el = document.documentElement;
		await (el.requestFullscreen ?? el.webkitRequestFullscreen).call(el, { navigationUI: 'hide' });
		// Landscape gives the 24-hour board much bigger cells. Only some browsers allow locking.
		await screen.orientation?.lock?.('landscape').catch(() => {});
		return true;
	} catch {
		return Boolean(fullscreenElement());
	}
}

export function onFullscreenChange(fn) {
	document.addEventListener('fullscreenchange', () => fn(Boolean(fullscreenElement())));
	document.addEventListener('webkitfullscreenchange', () => fn(Boolean(fullscreenElement())));
}

/** Calls fn when the device rotates between portrait and landscape. */
export function onRotate(fn) {
	window.matchMedia('(orientation: portrait)').addEventListener('change', fn);
}

/** Offline support: register the service worker on https (and localhost for testing). */
export function registerServiceWorker() {
	if (!('serviceWorker' in navigator)) return;
	const ok = location.protocol === 'https:' || location.hostname === 'localhost';
	if (!ok) return;
	window.addEventListener('load', () => {
		navigator.serviceWorker.register('sw.js').catch(() => {});
	});
}
