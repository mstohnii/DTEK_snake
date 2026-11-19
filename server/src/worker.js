// DTEK_snake leaderboard API (Cloudflare Worker + D1).
//
// Scores are never taken from the client. Flow:
//   1. POST /api/runs     → server issues a signed ticket: random seed + difficulty + issue time.
//   2. The browser plays a game seeded with that seed and records the accepted turns.
//   3. POST /api/scores   → server verifies the signature, replays the inputs with the
//                           shared game logic, and stores the score *it* computed.
// Checks: valid signature, ticket not expired and used once, replay reaches a crash at the
// claimed tick, claimed score matches, run wasn't played faster than real time, rate limit.
// Names: the first verified run under a name claims it for the device key that sent it
// (only its SHA-256 is stored); lookalike spellings count as the same name.
import { DIFFICULTIES } from '../../src/config.js';
import { replay } from '../../src/replay.js';
import { nameKey } from '../../src/names.js';

export { nameKey };

const TICKET_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;
const SUBMITS_PER_MINUTE = 6;
// A player needs one ticket per game (plus one per difficulty switch); this is generous.
const TICKETS_PER_MINUTE = 30;
const BOARD_SIZE = 10;
// The browser may lag a little behind the ideal pace; accept runs at ≥ 85% of real time.
const SPEED_TOLERANCE = 0.85;
const NAME_RE = /^[\p{L}\p{N} _.\-']{2,16}$/u;
// Device key: 32 random bytes, base64url (43 chars), made by the browser. Also the recovery code.
const KEY_RE = /^[A-Za-z0-9_-]{32,64}$/;

const enc = new TextEncoder();

const b64url = (bytes) =>
	btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function hmacKey(secret) {
	return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signTicket(payload, secret) {
	const body = b64url(enc.encode(JSON.stringify(payload)));
	const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
	return `${body}.${b64url(sig)}`;
}

export async function verifyTicket(token, secret) {
	if (typeof token !== 'string' || token.length > 512) return null;
	const [body, sig] = token.split('.');
	if (!body || !sig) return null;
	try {
		const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig), enc.encode(body));
		return ok ? JSON.parse(new TextDecoder().decode(fromB64url(body))) : null;
	} catch {
		return null;
	}
}

async function sha256Hex(text) {
	const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function cleanName(raw) {
	if (typeof raw !== 'string') return null;
	const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
	return NAME_RE.test(name) ? name : null;
}

async function nameOwner(db, key) {
	return (await db.prepare('SELECT key_hash FROM players WHERE name_key = ?').bind(key).first())?.key_hash ?? null;
}

/** Accept a name for this device key: claim it if free (atomically), else the key must match. */
async function claimName(db, name, keyHash, nowMs) {
	const key = nameKey(name);
	await db.prepare('INSERT INTO players (name_key, name, key_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (name_key) DO NOTHING')
		.bind(key, name, keyHash, nowMs)
		.run();
	return (await nameOwner(db, key)) === keyHash;
}

// Names that read like app output ("null", "error occured...") look like bugs on the board.
const RESERVED = new Set(['null', 'none', 'nil', 'undefined', 'nan', 'empty', 'unknown', 'admin', 'administrator', 'system', 'root', 'moderator']);
export function isReservedName(name) {
	const key = name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
	return RESERVED.has(key) || /^(error|exception|помилка)/.test(key);
}

// Each player's best run per difficulty (all runs stay stored; hidden rows are moderated out).
const BEST_RUNS = `
	WITH ranked AS (
		SELECT run_id, name, player_key, score, ticks, created_at,
			ROW_NUMBER() OVER (PARTITION BY player_key ORDER BY score DESC, ticks ASC, created_at ASC) AS rn
		FROM scores
		WHERE difficulty = ?1 AND hidden = 0
	),
	best AS (SELECT * FROM ranked WHERE rn = 1)`;

/**
 * Atomic per-IP rate limit: count and record in ONE statement, so concurrent requests
 * can't all pass the check before any of them is recorded. Returns true when allowed.
 */
async function takeRateSlot(db, kind, ipHash, limit, nowMs) {
	const res = await db.prepare(
		`INSERT INTO rate_events (kind, ip_hash, created_at)
		 SELECT ?1, ?2, ?3
		 WHERE (SELECT COUNT(*) FROM rate_events WHERE kind = ?1 AND ip_hash = ?2 AND created_at > ?4) < ?5`,
	)
		.bind(kind, ipHash, nowMs, nowMs - 60_000, limit)
		.run();
	return (res?.meta?.changes ?? 0) > 0;
}

async function hashIp(request, secret) {
	const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
	return (await sha256Hex(`${secret}:${ip}`)).slice(0, 32);
}

function corsHeaders(request, env) {
	const origin = request.headers.get('Origin');
	const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
	const headers = { Vary: 'Origin' };
	if (origin && allowed.includes(origin)) {
		headers['Access-Control-Allow-Origin'] = origin;
		headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
		headers['Access-Control-Allow-Headers'] = 'Content-Type';
		headers['Access-Control-Max-Age'] = '86400';
	}
	return headers;
}

export function createHandler({ now = () => Date.now() } = {}) {
	async function route(request, env) {
		const url = new URL(request.url);
		const json = (data, status = 200, extra = {}) =>
			new Response(JSON.stringify(data), {
				status,
				headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(request, env), ...extra },
			});
		const error = (code, status) => json({ error: code }, status);

		if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });
		if (!env.TOKEN_SECRET) return error('not-configured', 500);

		// --- Issue a run ticket --------------------------------------------------
		if (url.pathname === '/api/runs' && request.method === 'POST') {
			const body = await readJson(request);
			const difficulty = body?.difficulty;
			if (!Object.hasOwn(DIFFICULTIES, difficulty)) return error('bad-difficulty', 400);
			const ipHash = await hashIp(request, env.TOKEN_SECRET);
			if (!(await takeRateSlot(env.DB, 'ticket', ipHash, TICKETS_PER_MINUTE, now()))) return error('rate-limited', 429);
			const seed = crypto.getRandomValues(new Uint32Array(1))[0];
			const issuedAt = now();
			const ticket = { v: 1, id: crypto.randomUUID(), seed, d: difficulty, t: issuedAt };
			return json({ token: await signTicket(ticket, env.TOKEN_SECRET), seed, difficulty, issuedAt });
		}

		// --- Submit a finished run -------------------------------------------------
		if (url.pathname === '/api/scores' && request.method === 'POST') {
			const body = await readJson(request);
			if (!body) return error('bad-request', 400);

			const ticket = await verifyTicket(body.token, env.TOKEN_SECRET);
			if (!ticket || ticket.v !== 1) return error('bad-ticket', 400);
			const age = now() - ticket.t;
			if (age < 0 || age > TICKET_MAX_AGE_MS) return error('ticket-expired', 400);

			const name = cleanName(body.name);
			if (!name) return error('bad-name', 400);
			if (isReservedName(name)) return error('reserved-name', 400);
			if (typeof body.key !== 'string' || !KEY_RE.test(body.key)) return error('bad-key', 400);
			const keyHash = await sha256Hex(body.key);

			// Rate-limit every attempt (accepted or not) *before* the CPU-heavy replay.
			const ipHash = await hashIp(request, env.TOKEN_SECRET);
			if (!(await takeRateSlot(env.DB, 'submit', ipHash, SUBMITS_PER_MINUTE, now()))) return error('rate-limited', 429);
			await env.DB.prepare('DELETE FROM rate_events WHERE created_at < ?').bind(now() - 60 * 60_000).run();

			// Cheap early answer for a taken name, before the replay; claimName() settles races.
			const owner = await nameOwner(env.DB, nameKey(name));
			if (owner && owner !== keyHash) return error('name-taken', 409);

			const result = replay({ seed: ticket.seed, difficulty: ticket.d, inputs: body.inputs, endTick: body.endTick });
			if (!result.ok) return error(`replay-${result.reason}`, 422);
			if (result.score !== body.score) return error('score-mismatch', 422);
			if (result.score <= 0) return error('zero-score', 422);
			if (age < result.minDurationMs * SPEED_TOLERANCE) return error('too-fast', 422);
			// Only verified runs claim names, so nobody can squat names with junk submits.
			if (!(await claimName(env.DB, name, keyHash, now()))) return error('name-taken', 409);

			try {
				await env.DB.prepare(
					'INSERT INTO scores (run_id, name, player_key, difficulty, score, ticks, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
				)
					.bind(ticket.id, name, nameKey(name), ticket.d, result.score, result.ticks, ipHash, now())
					.run();
			} catch (e) {
				if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(e?.message ?? e))) return error('already-submitted', 409);
				throw e;
			}

			// Rank = position of this player's best run among every player's best run.
			const standing = await env.DB.prepare(
				`${BEST_RUNS},
				me AS (SELECT score, ticks, created_at FROM best WHERE player_key = ?2)
				SELECT me.score AS best,
					1 + (SELECT COUNT(*) FROM best b WHERE b.score > me.score
						OR (b.score = me.score AND (b.ticks < me.ticks OR (b.ticks = me.ticks AND b.created_at < me.created_at)))) AS rank
				FROM me`,
			)
				.bind(ticket.d, nameKey(name))
				.first();
			return json({ ok: true, id: ticket.id, score: result.score, best: standing?.best ?? result.score, rank: standing?.rank ?? 1 }, 201);
		}

		// --- Read the board ------------------------------------------------------------
		if (url.pathname === '/api/leaderboard' && request.method === 'GET') {
			const difficulty = url.searchParams.get('difficulty');
			if (!Object.hasOwn(DIFFICULTIES, difficulty)) return error('bad-difficulty', 400);
			const { results } = await env.DB.prepare(
				`${BEST_RUNS}
				SELECT run_id AS id, name, score, ticks, created_at AS createdAt
				FROM best ORDER BY score DESC, ticks ASC, created_at ASC LIMIT ?2`,
			)
				.bind(difficulty, BOARD_SIZE)
				.all();
			return json({ difficulty, entries: results }, 200, { 'Cache-Control': 'public, max-age=10' });
		}

		return error('not-found', 404);
	}

	return {
		async fetch(request, env) {
			try {
				return await route(request, env);
			} catch (e) {
				console.error(e);
				return new Response(JSON.stringify({ error: 'internal' }), {
					status: 500,
					headers: { 'Content-Type': 'application/json', ...corsHeaders(request, env) },
				});
			}
		},
	};
}

/** Read a JSON body, counting real bytes as they stream in and stopping at the cap. */
async function readJson(request) {
	if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY_BYTES) return null;
	if (!request.body) return null;
	const reader = request.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_BODY_BYTES) {
				await reader.cancel().catch(() => {});
				return null;
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
}

export default createHandler();
