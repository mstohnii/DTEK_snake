import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHandler, signTicket, cleanName, isReservedName, nameKey } from '../server/src/worker.js';
import { playRun } from './helpers.js';

// Minimal D1 stand-in over node:sqlite (same SQL dialect).
function fakeD1() {
	const db = new DatabaseSync(':memory:');
	const dir = new URL('../server/migrations/', import.meta.url);
	for (const m of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(m, dir), 'utf8'));
	return {
		db,
		prepare(sql) {
			const stmt = db.prepare(sql);
			let args = [];
			const api = {
				bind(...a) { args = a; return api; },
				async first() { return stmt.get(...args) ?? null; },
				async all() { return { results: stmt.all(...args) }; },
				async run() { const r = stmt.run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
			};
			return api;
		},
	};
}

const SECRET = 'test-secret';
const ORIGIN = 'https://mstohnii.github.io';
// Device keys (player codes) of two different browsers.
const KEY = 'K'.repeat(43);
const OTHER_KEY = 'Q'.repeat(43);
let env;
let clock;
let api;

beforeEach(() => {
	env = { DB: fakeD1(), TOKEN_SECRET: SECRET, ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5173` };
	clock = 1_000_000_000_000;
	api = createHandler({ now: () => clock });
});

async function call(method, path, body, headers = {}) {
	const res = await api.fetch(
		new Request(`https://api.test${path}`, {
			method,
			headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.7', ...headers },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		env,
	);
	return { status: res.status, headers: res.headers, data: res.status === 204 ? null : await res.json() };
}

/** Get a ticket, play a bot game on its seed, wait the real-time duration, return a submit body. */
async function playedRun(difficulty = 'normal', name = 'Тестер', key = KEY) {
	const { data } = await call('POST', '/api/runs', { difficulty });
	const run = playRun({ seed: data.seed, difficulty });
	clock += 10 * 60 * 1000; // plenty of real time passed
	return { token: data.token, name, key, inputs: run.inputs, endTick: run.endTick, score: run.score };
}

test('issues a signed ticket with a seed', async () => {
	const { status, data, headers } = await call('POST', '/api/runs', { difficulty: 'hard' });
	assert.equal(status, 200);
	assert.equal(data.difficulty, 'hard');
	assert.ok(Number.isInteger(data.seed));
	assert.match(data.token, /^[\w-]+\.[\w-]+$/);
	assert.equal(headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('rejects unknown difficulty', async () => {
	assert.equal((await call('POST', '/api/runs', { difficulty: 'god' })).status, 400);
	assert.equal((await call('GET', '/api/leaderboard?difficulty=god')).status, 400);
});

test('a legit run is verified, stored and ranked', async () => {
	const body = await playedRun('normal');
	const res = await call('POST', '/api/scores', body);
	assert.equal(res.status, 201, JSON.stringify(res.data));
	assert.equal(res.data.score, body.score);
	assert.equal(res.data.rank, 1);

	const board = await call('GET', '/api/leaderboard?difficulty=normal');
	assert.equal(board.data.entries.length, 1);
	assert.equal(board.data.entries[0].name, 'Тестер');
	assert.equal(board.data.entries[0].score, body.score);
	assert.equal((await call('GET', '/api/leaderboard?difficulty=hard')).data.entries.length, 0);
});

test('an inflated score is rejected', async () => {
	const body = await playedRun();
	const res = await call('POST', '/api/scores', { ...body, score: body.score + 100 });
	assert.equal(res.status, 422);
	assert.equal(res.data.error, 'score-mismatch');
});

test('edited inputs are rejected by the replay', async () => {
	const body = await playedRun();
	const res = await call('POST', '/api/scores', { ...body, inputs: body.inputs.slice(0, -1) });
	assert.equal(res.status, 422);
	assert.match(res.data.error, /^replay-/);
});

test('a ticket can only be used once', async () => {
	const body = await playedRun();
	assert.equal((await call('POST', '/api/scores', body)).status, 201);
	const again = await call('POST', '/api/scores', body);
	assert.equal(again.status, 409);
	assert.equal(again.data.error, 'already-submitted');
});

test('forged or tampered tickets are rejected', async () => {
	const body = await playedRun();
	const forged = await signTicket({ v: 1, id: 'x', seed: 1, d: 'normal', t: clock }, 'wrong-secret');
	assert.equal((await call('POST', '/api/scores', { ...body, token: forged })).data.error, 'bad-ticket');
	const [payload, sig] = body.token.split('.');
	const tampered = `${payload.slice(0, -2)}AA.${sig}`;
	assert.equal((await call('POST', '/api/scores', { ...body, token: tampered })).data.error, 'bad-ticket');
});

test('runs submitted faster than they could be played are rejected', async () => {
	const { data } = await call('POST', '/api/runs', { difficulty: 'normal' });
	const run = playRun({ seed: data.seed, difficulty: 'normal' });
	clock += 1000; // a whole game in one second
	const res = await call('POST', '/api/scores', { token: data.token, name: 'Bot', key: KEY, inputs: run.inputs, endTick: run.endTick, score: run.score });
	assert.equal(res.status, 422);
	assert.equal(res.data.error, 'too-fast');
});

test('expired tickets are rejected', async () => {
	const body = await playedRun();
	clock += 7 * 60 * 60 * 1000;
	assert.equal((await call('POST', '/api/scores', body)).data.error, 'ticket-expired');
});

test('names are validated', async () => {
	assert.equal(cleanName('  Макс   С. '), 'Макс С.');
	assert.equal(cleanName('a'), null);
	assert.equal(cleanName('<script>'), null);
	assert.equal(cleanName('x'.repeat(17)), null);
	const body = await playedRun('normal', '<b>hi</b>');
	assert.equal((await call('POST', '/api/scores', body)).data.error, 'bad-name');
});

test('submissions are rate limited per IP', async () => {
	// Prepare 8 finished runs first, then submit them all within one minute.
	const bodies = [];
	for (let i = 0; i < 8; i++) {
		const { data } = await call('POST', '/api/runs', { difficulty: 'normal' });
		const run = playRun({ seed: data.seed, difficulty: 'normal' });
		bodies.push({ token: data.token, name: 'Spam', key: KEY, inputs: run.inputs, endTick: run.endTick, score: run.score });
	}
	clock += 10 * 60 * 1000;
	const statuses = [];
	for (const body of bodies.slice(0, 7)) statuses.push((await call('POST', '/api/scores', body)).status);
	assert.deepEqual(statuses, [201, 201, 201, 201, 201, 201, 429]);
	const otherIp = await call('POST', '/api/scores', bodies[7], { 'CF-Connecting-IP': '198.51.100.1' });
	assert.equal(otherIp.status, 201);
});

test('failed attempts count too, so bogus replays cannot be spammed', async () => {
	const { data } = await call('POST', '/api/runs', { difficulty: 'easy' });
	clock += 10 * 60 * 1000;
	const bogus = { token: data.token, name: 'Spam', key: KEY, inputs: [], endTick: 100_000, score: 1 };
	const statuses = [];
	for (let i = 0; i < 7; i++) statuses.push((await call('POST', '/api/scores', bogus)).status);
	assert.deepEqual(statuses, [422, 422, 422, 422, 422, 422, 429]);
});

test('concurrent submissions cannot slip past the rate limit', async () => {
	const { data } = await call('POST', '/api/runs', { difficulty: 'easy' });
	clock += 10 * 60 * 1000;
	const bogus = { token: data.token, name: 'Spam', key: KEY, inputs: [], endTick: 50, score: 1 };
	const statuses = await Promise.all(Array.from({ length: 12 }, () => call('POST', '/api/scores', bogus).then((r) => r.status)));
	assert.equal(statuses.filter((s) => s !== 429).length, 6, statuses.join(','));
});

test('ticket issuance is rate limited per IP', async () => {
	const statuses = [];
	for (let i = 0; i < 31; i++) statuses.push((await call('POST', '/api/runs', { difficulty: 'normal' })).status);
	assert.equal(statuses.filter((s) => s === 200).length, 30);
	assert.equal(statuses.at(-1), 429);
	assert.equal((await call('POST', '/api/runs', { difficulty: 'normal' }, { 'CF-Connecting-IP': '198.51.100.9' })).status, 200);
	clock += 61_000;
	assert.equal((await call('POST', '/api/runs', { difficulty: 'normal' })).status, 200, 'window slides');
});

test('oversized bodies are rejected by real byte count, even without Content-Length', async () => {
	const huge = JSON.stringify({ difficulty: 'normal', pad: 'я'.repeat(200_000) }); // ~400 KB of UTF-8, ~200k chars
	const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(huge)); c.close(); } });
	const res = await api.fetch(new Request('https://api.test/api/scores', { method: 'POST', body: stream, duplex: 'half', headers: { Origin: ORIGIN } }), env);
	assert.equal(res.status, 400);
	assert.equal((await res.json()).error, 'bad-request');
});

/** Insert a stored run directly (as if submitted earlier). */
function seedRun({ id, name, score, ticks = 100, difficulty = 'hard', hidden = 0, at = clock }) {
	env.DB.db.prepare(
		'INSERT INTO scores (run_id, name, player_key, difficulty, score, ticks, ip_hash, created_at, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
	).run(id, name, nameKey(name), difficulty, score, ticks, 'h', at, hidden);
}

test('leaderboard is ordered by score, then fewer ticks', async () => {
	for (const [id, name, score, ticks] of [['a', 'Low', 3, 50], ['b', 'High', 9, 300], ['c', 'Fast', 9, 200]]) {
		seedRun({ id, name, score, ticks });
	}
	const { data } = await call('GET', '/api/leaderboard?difficulty=hard');
	assert.deepEqual(data.entries.map((e) => e.name), ['Fast', 'High', 'Low']);
});

test('board shows one row per player: their best run', async () => {
	seedRun({ id: 'p1', name: 'povir', score: 52, ticks: 864 });
	seedRun({ id: 'p2', name: 'povir', score: 18 });
	seedRun({ id: 'p3', name: 'povir', score: 16 });
	seedRun({ id: 's1', name: 'Софія', score: 34 });
	const { data } = await call('GET', '/api/leaderboard?difficulty=hard');
	assert.deepEqual(data.entries.map((e) => [e.name, e.score]), [['povir', 52], ['Софія', 34]]);
	assert.equal(data.entries[0].id, 'p1');
});

test('player identity is case-insensitive, also for Cyrillic', async () => {
	seedRun({ id: 'a', name: 'Povir', score: 10 });
	seedRun({ id: 'b', name: 'POVIR', score: 12 });
	seedRun({ id: 'c', name: 'Софія', score: 5 });
	seedRun({ id: 'd', name: 'СОФІЯ', score: 7 });
	const { data } = await call('GET', '/api/leaderboard?difficulty=hard');
	assert.deepEqual(data.entries.map((e) => [e.name, e.score]), [['POVIR', 12], ['СОФІЯ', 7]]);
});

test('equal best scores: tie broken by fewer ticks, then earlier run', async () => {
	seedRun({ id: 'x', name: 'Late', score: 9, ticks: 100, at: clock + 5 });
	seedRun({ id: 'y', name: 'Early', score: 9, ticks: 100, at: clock });
	seedRun({ id: 'z', name: 'Slow', score: 9, ticks: 300 });
	const { data } = await call('GET', '/api/leaderboard?difficulty=hard');
	assert.deepEqual(data.entries.map((e) => e.name), ['Early', 'Late', 'Slow']);
});

test('hidden runs stay stored but are left off the board', async () => {
	seedRun({ id: 'h1', name: 'null', score: 99, hidden: 1 });
	seedRun({ id: 'ok', name: 'Real', score: 5 });
	const { data } = await call('GET', '/api/leaderboard?difficulty=hard');
	assert.deepEqual(data.entries.map((e) => e.name), ['Real']);
	assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM scores').get().n, 2);
});

test('board is capped at 10 players and isolated per difficulty', async () => {
	for (let i = 0; i < 14; i++) seedRun({ id: `r${i}`, name: `Гравець ${i}`, score: i + 1 });
	seedRun({ id: 'other', name: 'Інший рівень', score: 999, difficulty: 'easy' });
	const { data } = await call('GET', '/api/leaderboard?difficulty=hard');
	assert.equal(data.entries.length, 10);
	assert.equal(data.entries[0].score, 14);
	assert.ok(!data.entries.some((e) => e.name === 'Інший рівень'));
});

test('reserved names are rejected for new runs', async () => {
	for (const name of ['null', 'None', 'empty', 'error occured...', 'Error 500', 'undefined', 'ADMIN', 'помилка']) {
		const body = await playedRun('normal', name);
		const res = await call('POST', '/api/scores', body);
		assert.equal(res.data.error, 'reserved-name', name);
	}
	// Ordinary names that merely contain those letters are fine.
	for (const name of ['Nonna', 'Terror', 'Nullius', 'MCP']) {
		assert.equal(isReservedName(name), false, name);
	}
});

test('submit returns the rank of the player best run, not of a weaker repeat', async () => {
	seedRun({ id: 'top', name: 'Champion', score: 500, difficulty: 'normal' });
	const first = await call('POST', '/api/scores', await playedRun('normal', 'Тестер'));
	assert.equal(first.status, 201);
	assert.equal(first.data.rank, 2);
	assert.equal(first.data.best, first.data.score);

	seedRun({ id: 'mine-best', name: 'тестер', score: 400, difficulty: 'normal' }); // same player, other case
	const again = await call('POST', '/api/scores', await playedRun('normal', 'ТЕСТЕР'));
	assert.equal(again.status, 201);
	assert.equal(again.data.best, 400);
	assert.equal(again.data.rank, 2);

	const { data } = await call('GET', '/api/leaderboard?difficulty=normal');
	assert.deepEqual(data.entries.map((e) => e.score), [500, 400]);
});

test('leaderboard responses are not cached by the browser for long', async () => {
	const res = await call('GET', '/api/leaderboard?difficulty=easy');
	assert.match(res.headers.get('Cache-Control') ?? '', /max-age=\d+/);
	assert.ok(Number(/max-age=(\d+)/.exec(res.headers.get('Cache-Control'))[1]) <= 10);
});

test('CORS: unknown origins get no allow header; preflight works', async () => {
	const res = await call('GET', '/api/leaderboard?difficulty=easy', undefined, { Origin: 'https://evil.example' });
	assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
	const pre = await call('OPTIONS', '/api/scores', undefined);
	assert.equal(pre.status, 204);
	assert.equal(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('missing secret fails closed', async () => {
	env.TOKEN_SECRET = '';
	assert.equal((await call('POST', '/api/runs', { difficulty: 'normal' })).status, 500);
});

// --- Name ownership ---------------------------------------------------------------------

const submitAs = async (name, key, difficulty = 'normal') => call('POST', '/api/scores', await playedRun(difficulty, name, key));

test('lookalike spellings share one owner key', () => {
	const povir = nameKey('povir');
	for (const n of ['POVIR', 'Povir', 'роvіr', 'POVІR', 'p0vir', 'ροvιr']) assert.equal(nameKey(n), povir, n);
	assert.equal(nameKey('Софія'), nameKey('СОФІЯ'));
	assert.equal(nameKey('Coфія'), nameKey('Софія'), 'Latin C and o inside a Cyrillic name');
	for (const [a, b] of [['Олег', 'Ольга'], ['Софія', 'Соня'], ['povir', 'povir2'], ['Max', 'Mах C']]) assert.notEqual(nameKey(a), nameKey(b), `${a}/${b}`);
});

test('a name belongs to the device that first played under it', async () => {
	assert.equal((await submitAs('povir', KEY)).status, 201);
	for (const name of ['povir', 'POVIR', 'роvіr', 'p0vir']) {
		const res = await submitAs(name, OTHER_KEY);
		assert.equal(res.status, 409, name);
		assert.equal(res.data.error, 'name-taken', name);
	}
	assert.equal((await submitAs('Povir', KEY)).status, 201, 'the owner may change case');
	assert.equal((await submitAs('Чужий', OTHER_KEY)).status, 201, 'other names stay free');
	const { data } = await call('GET', '/api/leaderboard?difficulty=normal');
	// Rejected runs never reach the board: one povir row (the owner's best) plus the other player.
	assert.equal(data.entries.length, 2);
	assert.equal(data.entries.filter((e) => e.name.toLowerCase() === 'povir').length, 1);
	assert.equal(data.entries.filter((e) => e.name === 'Чужий').length, 1);
});

test('a taken name does not burn the ticket: the player can pick another name', async () => {
	assert.equal((await submitAs('Owner', KEY)).status, 201);
	const body = await playedRun('normal', 'Owner', OTHER_KEY);
	assert.equal((await call('POST', '/api/scores', body)).data.error, 'name-taken');
	const retry = await call('POST', '/api/scores', { ...body, name: 'Newcomer' });
	assert.equal(retry.status, 201, JSON.stringify(retry.data));
});

test('the player code moves a name to another device', async () => {
	assert.equal((await submitAs('Mover', KEY)).status, 201);
	// The second device pasted the first device's code, so it now sends KEY too.
	assert.equal((await submitAs('MOVER', KEY, 'easy')).status, 201);
});

test('a missing or malformed device key is rejected', async () => {
	for (const key of [undefined, '', 'short', 'x'.repeat(65), 'has spaces in it but is long enough!!', 42]) {
		const body = { ...(await playedRun('normal', 'Keyless')), key }; // undefined drops the field
		const res = await call('POST', '/api/scores', body);
		assert.equal(res.status, 400, String(key));
		assert.equal(res.data.error, 'bad-key', String(key));
	}
});

test('only verified runs claim a name, so names cannot be squatted with junk', async () => {
	const { data } = await call('POST', '/api/runs', { difficulty: 'easy' });
	clock += 10 * 60 * 1000;
	const junk = await call('POST', '/api/scores', { token: data.token, name: 'Squat', key: OTHER_KEY, inputs: [], endTick: 50, score: 1 });
	assert.equal(junk.status, 422);
	assert.equal((await submitAs('Squat', KEY)).status, 201);
});

test('two devices racing for one free name: exactly one wins', async () => {
	const a = await playedRun('normal', 'Race', KEY);
	const b = await playedRun('normal', 'RACE', OTHER_KEY);
	const statuses = (await Promise.all([a, b].map((body) => call('POST', '/api/scores', body)))).map((r) => r.status).sort();
	assert.deepEqual(statuses, [201, 409]);
	assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM players').get().n, 1);
});

test('names already on the board are claimed by their next verified run', async () => {
	seedRun({ id: 'old', name: 'Ветеран', score: 50, difficulty: 'normal' });
	assert.equal((await submitAs('Ветеран', KEY)).status, 201);
	assert.equal((await submitAs('Ветеран', OTHER_KEY)).data.error, 'name-taken');
});

test('only a hash of the device key is stored', async () => {
	assert.equal((await submitAs('Hashed', KEY)).status, 201);
	const row = env.DB.db.prepare('SELECT * FROM players').get();
	assert.match(row.key_hash, /^[0-9a-f]{64}$/);
	assert.ok(!JSON.stringify(env.DB.db.prepare('SELECT * FROM players').all()).includes(KEY));
	assert.ok(!JSON.stringify(env.DB.db.prepare('SELECT * FROM scores').all()).includes(KEY));
});

test('the owner playing under lookalike spellings still gets one row (best run)', async () => {
	const a = await submitAs('povir', KEY);
	const b = await submitAs('роvіr', KEY); // Cyrillic р, о, і
	assert.deepEqual([a.status, b.status], [201, 201]);
	const { data } = await call('GET', '/api/leaderboard?difficulty=normal');
	assert.equal(data.entries.length, 1);
	assert.equal(data.entries[0].score, Math.max(a.data.score, b.data.score));
	assert.equal(b.data.best, data.entries[0].score);
});
