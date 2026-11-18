// Test helper: a greedy bot that plays a real game and records it like the browser does.
import { createGame, queueDirection, start, tick, DIRECTIONS, cellIndex, distance } from '../src/game.js';
import { createRecorder } from '../src/replay.js';

const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

function nextCell(g, dir) {
	const d = DIRECTIONS[dir];
	let x = g.snake[0].x + d.x;
	let y = g.snake[0].y + d.y;
	if (g.rules.wrap) {
		x = (x + g.cols) % g.cols;
		y = (y + g.rows) % g.rows;
	} else if (x < 0 || x >= g.cols || y < 0 || y >= g.rows) {
		return null;
	}
	return { x, y };
}

function isSafe(g, c) {
	if (!c) return false;
	const k = cellIndex(g, c.x, c.y);
	if (g.obstacles.has(k)) return false;
	for (const w of g.tempWalls) if (w.cells.some((p) => p.x === c.x && p.y === c.y)) return false;
	return !g.snake.slice(0, -1).some((s) => s.x === c.x && s.y === c.y);
}

function chooseDir(g) {
	const target = g.bonus ?? g.food;
	let best = null;
	let bestDist = Infinity;
	for (const dir of ['up', 'right', 'down', 'left']) {
		if (dir === OPPOSITE[g.dir]) continue;
		const c = nextCell(g, dir);
		if (!isSafe(g, c)) continue;
		const dist = target ? distance(g, c, target) : 0;
		if (dist < bestDist || (dist === bestDist && dir === g.dir)) {
			best = dir;
			bestDist = dist;
		}
	}
	return best;
}

export function playRun({ seed, difficulty, maxTicks = 20_000 }) {
	const g = createGame({ seed, difficulty });
	const rec = createRecorder();
	start(g);
	let sawTempWall = false;
	while (g.status === 'running') {
		if (g.ticks >= maxTicks) throw new Error('bot never finished');
		const dir = chooseDir(g);
		if (dir && dir !== g.dir && queueDirection(g, dir)) rec.record(g, dir);
		const events = tick(g);
		if (events.some((e) => e.type === 'tempwall-warn')) sawTempWall = true;
	}
	return { inputs: rec.inputs, endTick: g.ticks, score: g.score, sawTempWall };
}
