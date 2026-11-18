import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

function precacheList() {
	const src = read('sw.js');
	const body = src.match(/const CORE = \[([\s\S]*?)\];/)[1];
	return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('service worker precaches every game module, so the game works offline', () => {
	const core = precacheList();
	for (const f of readdirSync(new URL('src/', root))) {
		assert.ok(core.includes(`src/${f}`), `sw.js CORE is missing src/${f}`);
	}
});

test('every precached file exists (a missing file breaks the SW install)', () => {
	for (const f of precacheList()) {
		if (f === './') continue;
		assert.ok(existsSync(new URL(f, root)), `sw.js lists missing file ${f}`);
	}
});

test('precache avoids URLs that hosts redirect (index.html -> ./ on Cloudflare)', () => {
	const core = precacheList();
	assert.ok(core.includes('./'));
	assert.ok(!core.includes('index.html'));
});

test('site Worker never serves repo internals', () => {
	const ignore = read('.assetsignore').split(/\r?\n/).map((l) => l.trim());
	for (const p of ['.git', 'server', 'tests', 'docs', '.github', 'node_modules', 'wrangler.jsonc']) {
		assert.ok(ignore.includes(p), `.assetsignore must list ${p}`);
	}
});

test('manifest is valid and its icons exist', () => {
	const m = JSON.parse(read('manifest.webmanifest'));
	assert.equal(m.start_url, './');
	assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
	for (const icon of m.icons) assert.ok(existsSync(new URL(icon.src, root)), icon.src);
});

test('index.html links the manifest and allows notch-safe layout', () => {
	const html = read('index.html');
	assert.match(html, /rel="manifest" href="manifest.webmanifest"/);
	assert.match(html, /viewport-fit=cover/);
	assert.match(html, /apple-touch-icon/);
});
