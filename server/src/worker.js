// DTEK_snake leaderboard API (Cloudflare Worker + D1).
//
// Scores are never taken from the client. Flow:
//   1. POST /api/runs     → server issues a signed ticket: random seed + difficulty + issue time.
//   2. The browser plays a game seeded with that seed and records the accepted turns.
//   3. POST /api/scores   → server verifies the signature, replays the inputs with the
//                           shared game logic, and stores the score *it* computed.
// Checks: valid signature, ticket not expired and used once, replay reaches a crash at the
// claimed tick, claimed score matches, run wasn't played faster than real time, rate limit.
import { DIFFICULTIES } from '../../src/config.js';
import { replay } from '../../src/replay.js';

const TICKET_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;
const SUBMITS_PER_MINUTE = 6;
// A player needs one ticket per game (plus one per difficulty switch); this is generous.
const TICKETS_PER_MINUTE = 30;
const BOARD_SIZE = 10;
// The browser may lag a little behind the ideal pace; accept runs at ≥ 85% of real time.
const SPEED_TOLERANCE = 0.85;
const NAME_RE = /^[\p{L}\p{N} _.\-']{2,16}$/u;

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

			// Rate-limit every attempt (accepted or not) *before* the CPU-heavy replay.
			const ipHash = await hashIp(request, env.TOKEN_SECRET);
			if (!(await takeRateSlot(env.DB, 'submit', ipHash, SUBMITS_PER_MINUTE, now()))) return error('rate-limited', 429);
			await env.DB.prepare('DELETE FROM rate_events WHERE created_at < ?').bind(now() - 60 * 60_000).run();

			const result = replay({ seed: ticket.seed, difficulty: ticket.d, inputs: body.inputs, endTick: body.endTick });
			if (!result.ok) return error(`replay-${result.reason}`, 422);
			if (result.score !== body.score) return error('score-mismatch', 422);
			if (result.score <= 0) return error('zero-score', 422);
			if (age < result.minDurationMs * SPEED_TOLERANCE) return error('too-fast', 422);

			try {
				await env.DB.prepare(
					'INSERT INTO scores (run_id, name, difficulty, score, ticks, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
				)
					.bind(ticket.id, name, ticket.d, result.score, result.ticks, ipHash, now())
					.run();
			} catch (e) {
				if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(e?.message ?? e))) return error('already-submitted', 409);
				throw e;
			}

			const better = await env.DB.prepare(
				'SELECT COUNT(*) AS n FROM scores WHERE difficulty = ? AND (score > ? OR (score = ? AND ticks < ?))',
			)
				.bind(ticket.d, result.score, result.score, result.ticks)
				.first();
			return json({ ok: true, id: ticket.id, score: result.score, rank: (better?.n ?? 0) + 1 }, 201);
		}

		// --- Read the board ------------------------------------------------------------
		if (url.pathname === '/api/leaderboard' && request.method === 'GET') {
			const difficulty = url.searchParams.get('difficulty');
			if (!Object.hasOwn(DIFFICULTIES, difficulty)) return error('bad-difficulty', 400);
			const { results } = await env.DB.prepare(
				'SELECT run_id AS id, name, score, ticks, created_at AS createdAt FROM scores WHERE difficulty = ? ORDER BY score DESC, ticks ASC, created_at ASC LIMIT ?',
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
