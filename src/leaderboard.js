// Client for the leaderboard Worker (server/src/worker.js).
import { nameKey } from './names.js';

const TIMEOUT_MS = 8000;

export class LeaderboardError extends Error {
	constructor(code, status) {
		super(code);
		this.code = code;
		this.status = status;
	}
}

/**
 * Where the API lives. On localhost always the local dev server (`npm run dev:api`),
 * so development and QA never write to the real leaderboard; otherwise <meta name="leaderboard-api">.
 */
export function resolveApiBase(doc = document, loc = location) {
	if (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1') return 'http://localhost:8787';
	const meta = doc.querySelector('meta[name="leaderboard-api"]')?.content?.trim();
	return meta ? meta.replace(/\/+$/, '') : '';
}

/** Message after a successful submit. The board shows each player's best run, so rank is for that. */
export function submitResultText({ score, best, rank }, levelLabel) {
	const place = `${rank}-му місці («${levelLabel}»)`;
	if (best != null && best > score) return `Збережено! Ваш рекорд — ${best}, з ним ви на ${place}.`;
	return `Збережено! Ви на ${place}.`;
}

// --- Player code ------------------------------------------------------------------------
// A random device key proves who owns a name (the server keeps only its hash). The same
// string is the "player code" a person copies to move their name to another device.

/** New 32-byte key, base64url (43 chars). */
export function newPlayerCode(cryptoObj = globalThis.crypto) {
	const bytes = cryptoObj.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A pasted code, cleaned up (spaces, line breaks), or null when it can't be a code. */
export function parsePlayerCode(text) {
	const code = String(text ?? '').replace(/\s+/g, '');
	return /^[A-Za-z0-9_-]{32,64}$/.test(code) ? code : null;
}

/** The viewer's own row: the run just submitted, or the row of the name they play under. */
export function isOwnEntry(entry, { lastId, playerName }) {
	if (lastId && entry.id === lastId) return true;
	return Boolean(playerName?.trim()) && nameKey(entry.name) === nameKey(playerName);
}

export function createLeaderboardClient(baseUrl) {
	async function request(method, path, body) {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
		let res;
		try {
			res = await fetch(baseUrl + path, {
				method,
				headers: body ? { 'Content-Type': 'application/json' } : undefined,
				body: body ? JSON.stringify(body) : undefined,
				// Always revalidate: right after a submit the board must include the new score.
				cache: 'no-cache',
				signal: ctrl.signal,
			});
		} catch {
			throw new LeaderboardError('network', 0);
		} finally {
			clearTimeout(timer);
		}
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new LeaderboardError(data.error ?? 'http', res.status);
		return data;
	}

	return {
		enabled: Boolean(baseUrl),
		/** @returns {Promise<{token: string, seed: number, difficulty: string, issuedAt: number}>} */
		issueRun: (difficulty) => request('POST', '/api/runs', { difficulty }),
		/** @returns {Promise<{id: string, score: number, rank: number}>} */
		submit: (run) => request('POST', '/api/scores', run),
		/** @returns {Promise<Array<{id: string, name: string, score: number, ticks: number, createdAt: number}>>} */
		top: async (difficulty) => (await request('GET', `/api/leaderboard?difficulty=${encodeURIComponent(difficulty)}`)).entries,
	};
}

const ERROR_TEXT = {
	network: 'Немає зв’язку з сервером таблиці.',
	'bad-name': 'Ім’я: 2–16 символів — літери, цифри, пробіл, крапка, дефіс.',
	'reserved-name': 'Це ім’я схоже на системне повідомлення. Оберіть інше.',
	'name-taken': 'Це ім’я вже зайняте іншим гравцем. Оберіть інше або, якщо воно ваше, вставте код гравця з іншого пристрою.',
	'bad-key': 'Оновіть сторінку, щоб надіслати результат.',
	'rate-limited': 'Забагато спроб. Спробуйте за хвилину.',
	'already-submitted': 'Цей результат уже в таблиці.',
	'ticket-expired': 'Гра тривала надто довго, щоб потрапити в таблицю.',
	'too-fast': 'Сервер не прийняв результат: гра пройшла швидше, ніж можливо.',
	'zero-score': 'Потрібно набрати хоча б одне очко.',
};

export function errorText(code) {
	if (ERROR_TEXT[code]) return ERROR_TEXT[code];
	if (code?.startsWith('replay-') || code === 'score-mismatch') return 'Сервер не зміг підтвердити цей результат.';
	return 'Не вдалося зберегти результат. Спробуйте ще раз.';
}
