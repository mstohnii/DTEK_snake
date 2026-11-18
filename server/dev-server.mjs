// Local leaderboard API for development: runs the real Worker handler on Node,
// with node:sqlite standing in for D1. No Cloudflare account needed.
//   node server/dev-server.mjs        → http://localhost:8787
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createHandler } from './src/worker.js';

const PORT = Number(process.env.PORT ?? 8787);
const dir = new URL('./.local/', import.meta.url);
mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(fileURLToPath(new URL('dev.sqlite', dir)));
for (const m of ['0001_create_scores.sql', '0002_rate_events.sql']) {
	db.exec(readFileSync(new URL(`./migrations/${m}`, import.meta.url), 'utf8'));
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
const handler = createHandler();

createServer(async (req, res) => {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	const body = chunks.length ? Buffer.concat(chunks) : undefined;
	const request = new Request(`http://localhost:${PORT}${req.url}`, {
		method: req.method,
		headers: { ...req.headers, 'cf-connecting-ip': req.socket.remoteAddress ?? 'local' },
		body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
	});
	const response = await handler.fetch(request, env);
	res.writeHead(response.status, Object.fromEntries(response.headers));
	res.end(Buffer.from(await response.arrayBuffer()));
	console.log(req.method, req.url, response.status);
}).listen(PORT, () => console.log(`Leaderboard dev API on http://localhost:${PORT}`));
