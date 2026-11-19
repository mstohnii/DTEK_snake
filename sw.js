// Offline support. Network-first for this site's own files, so updates show up
// immediately when online; the cached copy is used when the network fails
// (handy during an actual blackout). The leaderboard API is never cached.
const VERSION = 'dtek-snake-v2.3.0';
const CORE = [
	// Not index.html: Cloudflare redirects it to ./ and a redirected response cannot serve a navigation.
	'./',
	'styles.css',
	'manifest.webmanifest',
	'src/main.js',
	'src/config.js',
	'src/game.js',
	'src/rng.js',
	'src/replay.js',
	'src/renderer.js',
	'src/input.js',
	'src/storage.js',
	'src/leaderboard.js',
	'src/names.js',
	'src/device.js',
	'assets/snake.svg',
	'assets/target.svg',
	'assets/bolt.svg',
	'assets/icons/icon-192.png',
	'assets/icons/icon-512.png',
	'assets/icons/apple-touch-icon.png',
];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
	event.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') return;
	const url = new URL(req.url);

	if (url.origin === self.location.origin) {
		event.respondWith(networkFirst(req));
	} else if (FONT_HOSTS.includes(url.hostname)) {
		event.respondWith(cacheFirst(req));
	}
	// Everything else (the leaderboard API) goes straight to the network.
});

async function networkFirst(req) {
	const cache = await caches.open(VERSION);
	try {
		const res = await Promise.race([
			fetch(req),
			new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS)),
		]);
		if (res.ok && !res.redirected) cache.put(req, res.clone());
		return res;
	} catch {
		const cached = await cache.match(req, { ignoreSearch: true })
			?? (req.mode === 'navigate' ? await cache.match('./') : undefined);
		return cached ?? Response.error();
	}
}

async function cacheFirst(req) {
	const cache = await caches.open(VERSION);
	const cached = await cache.match(req);
	if (cached) return cached;
	try {
		const res = await fetch(req);
		if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
		return res;
	} catch {
		return Response.error();
	}
}
