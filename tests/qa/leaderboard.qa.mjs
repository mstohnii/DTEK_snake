// End-to-end QA of the leaderboard API over real HTTP.
// Starts a fresh dev server (in-memory DB, controllable clock) and walks through
// the scenarios a tester would check by hand. Run: npm run qa
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { playRun } from '../helpers.js';
import { createGame, start, tick } from '../../src/game.js';

const PORT = 18787;
const API = `http://localhost:${PORT}`;
const ORIGIN = 'http://localhost:5173';
let ip = '10.0.0.1';
// Player codes (device keys). Most scenarios play on the main device; ownership ones use others.
const MAIN_KEY = 'M'.repeat(43);
const deviceKey = (c) => c.repeat(43);
const results = [];

const server = spawn(process.execPath, ['--no-warnings', fileURLToPath(new URL('../../server/dev-server.mjs', import.meta.url))], {
	env: { ...process.env, PORT: String(PORT), DEV_DB: ':memory:', DEV_CLOCK: '1', QUIET: '1', TOKEN_SECRET: 'qa-secret' },
	stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
	server.stdout.on('data', (d) => String(d).includes('Leaderboard dev API') && resolve());
	server.on('exit', (code) => reject(new Error(`dev server exited (${code})`)));
});

async function http(method, path, body, headers = {}) {
	const res = await fetch(API + path, {
		method,
		headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'x-test-ip': ip, ...headers },
		body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
	});
	const text = await res.text();
	let data = null;
	try { data = JSON.parse(text); } catch { /* empty / non-JSON */ }
	return { status: res.status, data, headers: res.headers };
}
const advance = (ms) => fetch(`${API}/__dev/clock?advance=${ms}`, { method: 'POST' });
const newIp = () => { ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`; };

/** Real flow: ticket → bot plays on that seed → wait real time (via clock) → submit body. */
async function playedRun(difficulty, name, key = MAIN_KEY) {
	const t = await http('POST', '/api/runs', { difficulty });
	if (t.status !== 200) throw new Error(`ticket ${t.status} ${JSON.stringify(t.data)}`);
	const run = playRun({ seed: t.data.seed, difficulty });
	return { body: { token: t.data.token, name, key, inputs: run.inputs, endTick: run.endTick, score: run.score }, run };
}
async function submitPlayed(difficulty, name, key) {
	const { body, run } = await playedRun(difficulty, name, key);
	await advance(15 * 60_000);
	return { res: await http('POST', '/api/scores', body), run, body };
}
const board = async (d) => (await http('GET', `/api/leaderboard?difficulty=${d}`)).data.entries;

async function check(area, name, fn) {
	newIp(); // each scenario is its own "player" so rate limits don't bleed between them
	try {
		await fn();
		results.push({ area, scenario: name, result: 'PASS' });
	} catch (e) {
		results.push({ area, scenario: name, result: 'FAIL', detail: e.message });
	}
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }
const eq = (a, b, msg) => expect(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

// --- Reading ------------------------------------------------------------------------
await check('board', 'empty board for every difficulty', async () => {
	for (const d of ['easy', 'normal', 'hard', 'insane']) {
		const r = await http('GET', `/api/leaderboard?difficulty=${d}`);
		eq(r.status, 200, d);
		eq(r.data.entries, [], d);
	}
});
await check('board', 'unknown difficulty → 400', async () => {
	eq((await http('GET', '/api/leaderboard?difficulty=god')).status, 400, 'status');
	eq((await http('GET', '/api/leaderboard')).status, 400, 'missing param');
});
await check('api', 'unknown route → 404 JSON', async () => {
	const r = await http('GET', '/api/nope');
	eq([r.status, r.data?.error], [404, 'not-found'], 'response');
});

// --- CORS ---------------------------------------------------------------------------
await check('cors', 'allowed origin is echoed', async () => {
	eq((await http('GET', '/api/leaderboard?difficulty=easy')).headers.get('access-control-allow-origin'), ORIGIN, 'header');
});
await check('cors', 'other origins get no CORS header', async () => {
	const r = await http('GET', '/api/leaderboard?difficulty=easy', undefined, { Origin: 'https://evil.example' });
	eq(r.headers.get('access-control-allow-origin'), null, 'header');
});
await check('cors', 'preflight → 204 with methods', async () => {
	const r = await http('OPTIONS', '/api/scores');
	eq(r.status, 204, 'status');
	expect(r.headers.get('access-control-allow-methods')?.includes('POST'), 'POST allowed');
});

// --- Happy path ------------------------------------------------------------------------
let firstScore = 0;
await check('submit', 'real game is accepted, ranked and listed', async () => {
	const { res, run } = await submitPlayed('normal', 'Софія');
	eq(res.status, 201, `status ${JSON.stringify(res.data)}`);
	eq([res.data.score, res.data.best, res.data.rank], [run.score, run.score, 1], 'score/best/rank');
	firstScore = run.score;
	eq((await board('normal')).map((e) => e.name), ['Софія'], 'board');
});
await check('submit', 'Ukrainian apostrophe; whitespace (spaces, tabs) normalised', async () => {
	const { res } = await submitPlayed('easy', "  Ім'я   Прізвище ");
	eq(res.status, 201, JSON.stringify(res.data));
	expect((await board('easy')).some((e) => e.name === "Ім'я Прізвище"), 'name normalised');
	newIp();
	const tab = await submitPlayed('easy', 'tab\tname');
	eq(tab.res.status, 201, JSON.stringify(tab.res.data));
	expect((await board('easy')).some((e) => e.name === 'tab name'), 'tab folded to a space');
});

// --- One row per player -----------------------------------------------------------------
await check('dedupe', 'same player (other case) keeps one row; response reports best', async () => {
	const runs = [];
	for (const name of ['povir', 'POVIR', 'Povir']) runs.push((await submitPlayed('hard', name)).res);
	for (const r of runs) eq(r.status, 201, JSON.stringify(r.data));
	const best = Math.max(...runs.map((r) => r.data.score));
	const rows = (await board('hard')).filter((e) => e.name.toLowerCase() === 'povir');
	eq(rows.length, 1, 'rows for povir');
	eq(rows[0].score, best, 'best kept');
	eq(runs.at(-1).data.best, best, 'last response best');
});
await check('dedupe', 'Cyrillic case variants are the same player', async () => {
	await submitPlayed('normal', 'СОФІЯ');
	eq((await board('normal')).filter((e) => e.name.toLowerCase() === 'софія').length, 1, 'rows');
	eq((await board('normal')).length, 1, 'no extra row');
	expect(firstScore > 0, 'first score recorded');
});

await check('dedupe', 'owner using a lookalike spelling (роvіr) keeps one row', async () => {
	const { res } = await submitPlayed('hard', 'роvіr');
	eq(res.status, 201, JSON.stringify(res.data));
	const rows = (await board('hard')).filter((e) => ['povir', 'роvіr'].includes(e.name.toLowerCase()));
	eq(rows.length, 1, 'rows');
	eq(res.data.best, rows[0].score, 'best reported');
});

// --- Names --------------------------------------------------------------------------------
await check('names', 'system-looking names are rejected (reserved-name)', async () => {
	for (const name of ['null', 'None', 'empty', 'undefined', 'error occured...', 'ERROR', 'Помилка 404', 'admin']) {
		const { body } = await playedRun('normal', name);
		await advance(15 * 60_000);
		const r = await http('POST', '/api/scores', body);
		eq([r.status, r.data.error], [400, 'reserved-name'], name);
		newIp();
	}
});
await check('names', 'invalid names are rejected (bad-name)', async () => {
	for (const name of ['a', ' ', 'x'.repeat(17), '<b>hi</b>', 'emoji 🐍', 'quote"name', 42, null]) {
		const { body } = await playedRun('normal', name);
		await advance(15 * 60_000);
		const r = await http('POST', '/api/scores', body);
		eq([r.status, r.data.error], [400, 'bad-name'], String(name));
	}
});
await check('names', 'ordinary names containing reserved words are fine', async () => {
	const { res } = await submitPlayed('insane', 'Terror Nonna');
	eq(res.status, 201, JSON.stringify(res.data));
});

// --- Name ownership ------------------------------------------------------------------------
await check('ownership', 'a claimed name is refused to another device (name-taken)', async () => {
	// "Софія" was claimed by the main device in the happy-path scenario.
	const { res } = await submitPlayed('normal', 'Софія', deviceKey('X'));
	eq([res.status, res.data.error], [409, 'name-taken'], 'response');
	eq((await board('normal')).filter((e) => e.name.toLowerCase() === 'софія').length, 1, 'board untouched');
});
await check('ownership', 'lookalike spellings of a claimed name are refused', async () => {
	// Latin C/o/i inside the Cyrillic name, Cyrillic р/о/і inside "povir", digit zero.
	for (const name of ['Coфiя', 'СОФIЯ', 'роvіr', 'POVІR', 'p0vir']) {
		newIp();
		const { res } = await submitPlayed('hard', name, deviceKey('X'));
		eq([res.status, res.data.error], [409, 'name-taken'], name);
	}
});
await check('ownership', 'a refused name keeps the ticket: retry under a free name works', async () => {
	const { body } = await playedRun('easy', 'povir', deviceKey('Y'));
	await advance(15 * 60_000);
	eq((await http('POST', '/api/scores', body)).data.error, 'name-taken', 'first try');
	const retry = await http('POST', '/api/scores', { ...body, name: 'Новенький' });
	eq(retry.status, 201, JSON.stringify(retry.data));
});
await check('ownership', 'player code moves a name to another device', async () => {
	// Another IP (a phone) that pasted the main device's code.
	const { res } = await submitPlayed('easy', 'POVIR', MAIN_KEY);
	eq(res.status, 201, JSON.stringify(res.data));
});
await check('ownership', 'missing, short or junk player code → bad-key', async () => {
	for (const key of [undefined, '', 'short', 'з пробілами але досить довгий рядок!!!!', 'x'.repeat(65), 7]) {
		const { body } = await playedRun('normal', 'Keyless');
		await advance(15 * 60_000);
		const r = await http('POST', '/api/scores', { ...body, key });
		eq([r.status, r.data.error], [400, 'bad-key'], String(key));
		newIp();
	}
});
await check('ownership', 'two devices race for a free name in parallel → exactly one wins', async () => {
	const a = await playedRun('normal', 'Гонка', deviceKey('A'));
	const b = await playedRun('normal', 'ГОНКА', deviceKey('B'));
	await advance(15 * 60_000);
	const res = await Promise.all([a, b].map(({ body }) => http('POST', '/api/scores', body)));
	eq(res.map((r) => r.status).sort(), [201, 409], 'statuses');
	eq(res.find((r) => r.status === 409).data.error, 'name-taken', 'loser error');
});
await check('ownership', 'a rejected (cheated) run does not claim the name', async () => {
	const { body } = await playedRun('normal', 'Захоплення', deviceKey('Z'));
	await advance(15 * 60_000);
	eq((await http('POST', '/api/scores', { ...body, score: body.score + 5 })).data.error, 'score-mismatch', 'cheat');
	newIp();
	eq((await submitPlayed('normal', 'Захоплення', MAIN_KEY)).res.status, 201, 'real owner still free to claim');
});

// --- Anti-cheat -----------------------------------------------------------------------------
await check('anti-cheat', 'inflated score → score-mismatch', async () => {
	const { body } = await playedRun('normal', 'Cheater');
	await advance(15 * 60_000);
	eq((await http('POST', '/api/scores', { ...body, score: body.score + 100 })).data.error, 'score-mismatch', 'error');
});
await check('anti-cheat', 'edited inputs → replay-*', async () => {
	const { body } = await playedRun('normal', 'Cheater');
	await advance(15 * 60_000);
	const r = await http('POST', '/api/scores', { ...body, inputs: body.inputs.map(([t, c]) => [t, (c + 1) % 4]) });
	expect(r.status === 422 && r.data.error.startsWith('replay-'), JSON.stringify(r.data));
});
await check('anti-cheat', 'submitted faster than real time → too-fast', async () => {
	const { body } = await playedRun('normal', 'Speedy');
	eq((await http('POST', '/api/scores', body)).data.error, 'too-fast', 'error');
});
await check('anti-cheat', 'ticket reuse → already-submitted (409)', async () => {
	const { body } = await playedRun('normal', 'Twice');
	await advance(15 * 60_000);
	eq((await http('POST', '/api/scores', body)).status, 201, 'first');
	newIp();
	const again = await http('POST', '/api/scores', body);
	eq([again.status, again.data.error], [409, 'already-submitted'], 'second');
});
await check('anti-cheat', 'expired ticket → ticket-expired', async () => {
	const { body } = await playedRun('normal', 'Sleepy');
	await advance(7 * 60 * 60_000);
	eq((await http('POST', '/api/scores', body)).data.error, 'ticket-expired', 'error');
});
await check('anti-cheat', 'forged / garbled token → bad-ticket', async () => {
	const { body } = await playedRun('normal', 'Forger');
	await advance(15 * 60_000);
	const [p, s] = body.token.split('.');
	for (const token of [`${p}.${s.slice(0, -3)}abc`, 'abc.def', '', 'x'.repeat(600)]) {
		eq((await http('POST', '/api/scores', { ...body, token })).data.error, 'bad-ticket', token.slice(0, 12));
	}
});
await check('anti-cheat', 'zero-point game → zero-score', async () => {
	// No turns: the snake runs straight into a wall. Pick a seed whose first food is off that path.
	for (let tries = 0; tries < 20; tries++) {
		const t = await http('POST', '/api/runs', { difficulty: 'normal' });
		const g = createGame({ seed: t.data.seed, difficulty: 'normal' });
		start(g);
		while (g.status === 'running') tick(g);
		if (g.score !== 0) continue;
		await advance(15 * 60_000);
		const r = await http('POST', '/api/scores', { token: t.data.token, name: 'Nobody', key: MAIN_KEY, inputs: [], endTick: g.ticks, score: 0 });
		eq(r.data.error, 'zero-score', 'error');
		return;
	}
	throw new Error('no zero-score seed in 20 tickets');
});

// --- Abuse limits ------------------------------------------------------------------------------
await check('limits', 'malformed JSON → bad-request', async () => {
	eq((await http('POST', '/api/scores', '{not json')).data.error, 'bad-request', 'error');
});
await check('limits', 'body over 256 KB → bad-request', async () => {
	eq((await http('POST', '/api/scores', JSON.stringify({ pad: 'я'.repeat(200_000) }))).data.error, 'bad-request', 'error');
});
await check('limits', '12 parallel submissions from one IP → only 6 processed', async () => {
	const { body } = await playedRun('easy', 'Burst');
	await advance(15 * 60_000);
	const statuses = await Promise.all(Array.from({ length: 12 }, () => http('POST', '/api/scores', body).then((r) => r.status)));
	eq(statuses.filter((s) => s !== 429).length, 6, `statuses ${statuses.join(',')}`);
});
await check('limits', 'ticket issuance capped at 30/min per IP, then recovers', async () => {
	const statuses = [];
	for (let i = 0; i < 31; i++) statuses.push((await http('POST', '/api/runs', { difficulty: 'easy' })).status);
	eq([statuses.filter((s) => s === 200).length, statuses.at(-1)], [30, 429], 'limit');
	await advance(61_000);
	eq((await http('POST', '/api/runs', { difficulty: 'easy' })).status, 200, 'after a minute');
});

// --- Board shape -------------------------------------------------------------------------------
await check('board', 'top 10 only, sorted by score, per difficulty', async () => {
	for (let i = 0; i < 12; i++) {
		newIp();
		await submitPlayed('insane', `Гравець ${String.fromCharCode(65 + i)}`);
	}
	const rows = await board('insane');
	eq(rows.length, 10, 'size');
	expect(rows.every((r, i) => i === 0 || rows[i - 1].score >= r.score), 'sorted');
	expect(!rows.some((r) => r.name === 'Софія'), 'no rows from other difficulties');
});
await check('board', 'responses are short-cached (≤10s) for fresh results', async () => {
	const cc = (await http('GET', '/api/leaderboard?difficulty=normal')).headers.get('cache-control') ?? '';
	expect(/max-age=(\d+)/.test(cc) && Number(/max-age=(\d+)/.exec(cc)[1]) <= 10, cc);
});

server.kill();
await once(server, 'exit');

const failed = results.filter((r) => r.result === 'FAIL');
console.table(results.map(({ area, scenario, result }) => ({ area, scenario, result })));
for (const f of failed) console.log(`FAIL ${f.area} / ${f.scenario}: ${f.detail}`);
console.log(`\nQA: ${results.length - failed.length}/${results.length} scenarios passed`);
process.exit(failed.length ? 1 : 0);
