// Local leaderboard API for development and QA: runs the real Worker handler on Node,
// with node:sqlite standing in for D1. No Cloudflare account needed.
//   node server/dev-server.mjs                 → http://localhost:8787, DB in server/.local/dev.sqlite
// Env: PORT, DEV_DB (file path or ":memory:"), TOKEN_SECRET, ALLOWED_ORIGINS, QUIET=1,
//      DEV_CLOCK=1 → POST /__dev/clock?advance=<ms> moves the server clock and the
//      x-test-ip header picks the client IP (QA only; neither exists in the deployed Worker).
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createHandler } from './src/worker.js';

const PORT = Number(process.env.PORT ?? 8787);
const QA = process.env.DEV_CLOCK === '1';
const localDir = new URL('./.local/', import.meta.url);
mkdirSync(localDir, { recursive: true });
const db = new DatabaseSync(process.env.DEV_DB ?? fileURLToPath(new URL('dev.sqlite', localDir)));

// Apply each migration once, in order, and record it (same idea as `d1 migrations apply`).
db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT)');
const migrationsDir = new URL('./migrations/', import.meta.url);
const applied = new Set(db.prepare('SELECT name FROM d1_migrations').all().map((r) => r.name));
for (const name of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
	if (applied.has(name)) continue;
	try {
		db.exec(readFileSync(new URL(name, migrationsDir), 'utf8'));
	} catch (e) {
		// Dev DBs created before migrations were tracked may already contain these changes.
		if (!/already exists|duplicate column/i.test(String(e.message))) throw e;
	}
	db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, datetime('now'))").run(name);
	console.log('migrated', name);
}

const D1 = {
	prepare(sql) {
		const stmt = db.prepare(sql);
		let args = [];
		const api = {
			bind: (...a) => { args = a; return api; },
			first: async () => stmt.get(...args) ?? null,
			all: async () => ({ results: stmt.all(...args) }),
			run: async () => { const r = stmt.run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
		};
		return api;
	},
};

const env = {
	DB: D1,
	TOKEN_SECRET: process.env.TOKEN_SECRET ?? 'local-dev-secret',
	ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173',
};
let skewMs = 0;
const handler = createHandler({ now: () => Date.now() + skewMs });

createServer(async (req, res) => {
	if (QA && req.url.startsWith('/__dev/clock')) {
		skewMs += Number(new URL(req.url, 'http://x').searchParams.get('advance') ?? 0);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ skewMs }));
		return;
	}
	const chunks = [];
	for await (const c of req) chunks.push(c);
	const body = chunks.length ? Buffer.concat(chunks) : undefined;
	const ip = (QA && req.headers['x-test-ip']) || req.socket.remoteAddress || 'local';
	const request = new Request(`http://localhost:${PORT}${req.url}`, {
		method: req.method,
		headers: { ...req.headers, 'cf-connecting-ip': ip },
		body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
	});
	const response = await handler.fetch(request, env);
	res.writeHead(response.status, Object.fromEntries(response.headers));
	res.end(Buffer.from(await response.arrayBuffer()));
	if (!process.env.QUIET) console.log(req.method, req.url, response.status);
}).listen(PORT, () => console.log(`Leaderboard dev API on http://localhost:${PORT}`));
