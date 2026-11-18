import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHandler, signTicket, cleanName } from '../server/src/worker.js';
import { playRun } from './helpers.js';

// Minimal D1 stand-in over node:sqlite (same SQL dialect).
function fakeD1() {
	const db = new DatabaseSync(':memory:');
	for (const m of ['0001_create_scores.sql', '0002_rate_events.sql']) {
		db.exec(readFileSync(new URL(`../server/migrations/${m}`, import.meta.url), 'utf8'));
	}
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
async function playedRun(difficulty = 'normal', name = 'Тестер') {
	const { data } = await call('POST', '/api/runs', { difficulty });
	const run = playRun({ seed: data.seed, difficulty });
	clock += 10 * 60 * 1000; // plenty of real time passed
	return { token: data.token, name, inputs: run.inputs, endTick: run.endTick, score: run.score };
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
	const res = await call('POST', '/api/scores', { token: data.token, name: 'Bot', inputs: run.inputs, endTick: run.endTick, score: run.score });
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
		bodies.push({ token: data.token, name: 'Spam', inputs: run.inputs, endTick: run.endTick, score: run.score });
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
	const bogus = { token: data.token, name: 'Spam', inputs: [], endTick: 100_000, score: 1 };
	const statuses = [];
	for (let i = 0; i < 7; i++) statuses.push((await call('POST', '/api/scores', bogus)).status);
	assert.deepEqual(statuses, [422, 422, 422, 422, 422, 422, 429]);
});

test('concurrent submissions cannot slip past the rate limit', async () => {
	const { data } = await call('POST', '/api/runs', { difficulty: 'easy' });
	clock += 10 * 60 * 1000;
	const bogus = { token: data.token, name: 'Spam', inputs: [], endTick: 50, score: 1 };
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

test('leaderboard is ordered by score, then fewer ticks', async () => {
	for (const [id, name, score, ticks] of [['a', 'Low', 3, 50], ['b', 'High', 9, 300], ['c', 'Fast', 9, 200]]) {
		env.DB.db.prepare('INSERT INTO scores VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, name, 'hard', score, ticks, 'h', clock);
	}
	const { data } = await call('GET', '/api/leaderboard?difficulty=hard');
	assert.deepEqual(data.entries.map((e) => e.name), ['Fast', 'High', 'Low']);
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
