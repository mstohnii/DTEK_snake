// Upgrade test: a database created by the first two migrations, holding the same
// rows as production, must keep every run after 0003 and show the expected board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHandler } from '../server/src/worker.js';
import { nameKey } from '../src/names.js';

const migration = (name) => readFileSync(new URL(`../server/migrations/${name}`, import.meta.url), 'utf8');

// Snapshot of production on 2026-11-18 (names, scores, ticks), before the upgrade.
const PROD_ROWS = [
	['insane', 'povir', 13, 180], ['insane', 'мяу', 4, 102],
	['normal', 'povir', 52, 864], ['normal', 'Софія', 34, 435], ['normal', 'empty', 22, 321],
	['normal', 'null', 21, 185], ['normal', 'Dominic Torrent', 20, 308], ['normal', 'povir', 18, 200],
	['normal', 'povir', 16, 272], ['normal', 'error occured...', 14, 190], ['normal', 'MCP', 11, 102],
	['normal', 'None', 8, 96],
];

function legacyDb() {
	const db = new DatabaseSync(':memory:');
	db.exec(migration('0001_create_scores.sql'));
	db.exec(migration('0002_rate_events.sql'));
	const ins = db.prepare('INSERT INTO scores (run_id, name, difficulty, score, ticks, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
	PROD_ROWS.forEach(([d, name, score, ticks], i) => ins.run(`run-${i}`, name, d, score, ticks, `ip-${i}`, 1_700_000_000_000 + i));
	return db;
}

const snapshot = (db) => db.prepare('SELECT run_id, name, difficulty, score, ticks, ip_hash, created_at FROM scores ORDER BY run_id').all();

function d1(db) {
	return {
		prepare(sql) {
			const stmt = db.prepare(sql);
			let args = [];
			const api = {
				bind(...a) { args = a; return api; },
				async first() { return stmt.get(...args) ?? null; },
				async all() { return { results: stmt.all(...args) }; },
				async run() { const r = stmt.run(...args); return { meta: { changes: Number(r.changes) } }; },
			};
			return api;
		},
	};
}

async function board(db, difficulty) {
	const api = createHandler({ now: () => 1_800_000_000_000 });
	const res = await api.fetch(new Request(`https://x/api/leaderboard?difficulty=${difficulty}`), { DB: d1(db), TOKEN_SECRET: 's' });
	return (await res.json()).entries.map((e) => [e.name, e.score]);
}

test('0003 keeps every existing run unchanged', () => {
	const db = legacyDb();
	const before = snapshot(db);
	db.exec(migration('0003_player_key_and_hidden.sql'));
	assert.deepEqual(snapshot(db), before);
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scores').get().n, PROD_ROWS.length);
});

test('0003 hides exactly the system-looking names', () => {
	const db = legacyDb();
	db.exec(migration('0003_player_key_and_hidden.sql'));
	const hidden = db.prepare('SELECT name FROM scores WHERE hidden = 1 ORDER BY name').all().map((r) => r.name);
	assert.deepEqual(hidden, ['None', 'empty', 'error occured...', 'null']);
});

test('0003 backfills lowercase player keys (incl. Cyrillic capitals)', () => {
	const db = legacyDb();
	db.exec(migration('0003_player_key_and_hidden.sql'));
	for (const { name, player_key } of db.prepare('SELECT name, player_key FROM scores').all()) {
		assert.equal(player_key, name.trim().toLowerCase(), name);
	}
});

test('after the upgrade the production board shows one row per real player', async () => {
	const db = legacyDb();
	db.exec(migration('0003_player_key_and_hidden.sql'));
	db.exec(migration('0004_players.sql'));
	assert.deepEqual(await board(db, 'normal'), [['povir', 52], ['Софія', 34], ['Dominic Torrent', 20], ['MCP', 11]]);
	assert.deepEqual(await board(db, 'insane'), [['povir', 13], ['мяу', 4]]);
});

test('0003 can be applied to an empty database', () => {
	const db = new DatabaseSync(':memory:');
	for (const m of ['0001_create_scores.sql', '0002_rate_events.sql', '0003_player_key_and_hidden.sql']) db.exec(migration(m));
	const cols = db.prepare('PRAGMA table_info(scores)').all().map((c) => c.name);
	assert.ok(cols.includes('player_key') && cols.includes('hidden'));
});

test('0004 adds the players table and keeps runs and board as they were', async () => {
	const db = legacyDb();
	db.exec(migration('0003_player_key_and_hidden.sql'));
	const before = snapshot(db);
	const boardBefore = await board(db, 'normal');
	db.exec(migration('0004_players.sql'));
	assert.deepEqual(snapshot(db), before);
	assert.deepEqual(await board(db, 'normal'), boardBefore);
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM players').get().n, 0, 'existing names start unclaimed');
	db.exec(migration('0004_players.sql')); // re-running is harmless
});

test('0004 folds stored keys exactly like the Worker (nameKey), incl. lookalikes', () => {
	const db = legacyDb();
	db.exec(migration('0003_player_key_and_hidden.sql'));
	// Rows the previous Worker wrote between 0003 and 0004: JS-lowercased keys, lookalike spellings.
	const ins = db.prepare('INSERT INTO scores (run_id, name, player_key, difficulty, score, ticks, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
	for (const [i, name] of ['роvіr', 'P0VIR', 'ΜCΡ', 'Coфія'].entries()) ins.run(`late-${i}`, name, name.toLowerCase(), 'normal', 1, 10, 'ip', 1_800_000_000_000 + i);
	db.exec(migration('0004_players.sql'));
	for (const { name, player_key } of db.prepare('SELECT name, player_key FROM scores').all()) {
		assert.equal(player_key, nameKey(name), name);
	}
});
