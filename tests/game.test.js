import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	createGame, queueDirection, start, togglePause, tick, tickMs,
	spawnOutage, cellMap, cellIndex, randomFreeCell,
} from '../src/game.js';
import { BONUS_POINTS, DIFFICULTIES } from '../src/config.js';

const NORMAL = DIFFICULTIES.normal;
const BONUS_TTL = NORMAL.bonusTtl;
const OUTAGE_EVERY = 4;

// Deterministic PRNG for reproducible tests.
function seeded(seed = 1) {
	return () => {
		seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function running(opts = {}) {
	const g = createGame({ rng: seeded(), ...opts });
	start(g);
	return g;
}

test('new game starts ready, 3 segments, food not on snake', () => {
	const g = createGame({ rng: seeded() });
	assert.equal(g.status, 'ready');
	assert.equal(g.snake.length, 3);
	assert.ok(g.food);
	assert.ok(!g.snake.some((s) => s.x === g.food.x && s.y === g.food.y));
});

test('tick does nothing unless running', () => {
	const g = createGame({ rng: seeded() });
	assert.deepEqual(tick(g), []);
	assert.equal(g.snake[0].x, 4);
});

test('snake moves one cell per tick', () => {
	const g = running();
	g.food = { x: 0, y: 0 };
	tick(g);
	assert.deepEqual(g.snake[0], { x: 5, y: 3 });
	assert.equal(g.snake.length, 3);
});

test('two quick turns cannot reverse the snake into itself (v1 bug)', () => {
	const g = running();
	g.food = { x: 0, y: 0 };
	assert.equal(queueDirection(g, 'up'), true);
	assert.equal(queueDirection(g, 'left'), true); // valid relative to "up"
	tick(g);
	assert.deepEqual(g.snake[0], { x: 4, y: 2 });
	tick(g);
	assert.deepEqual(g.snake[0], { x: 3, y: 2 });
	assert.equal(g.status, 'running');
});

test('direct reverse and duplicate turns are ignored', () => {
	const g = running();
	assert.equal(queueDirection(g, 'left'), false);
	assert.equal(queueDirection(g, 'right'), false);
	assert.equal(queueDirection(g, 'up'), true);
	assert.equal(queueDirection(g, 'down'), false);
	assert.equal(queueDirection(g, 'nope'), false);
});

test('input buffer holds at most two turns', () => {
	const g = running();
	assert.ok(queueDirection(g, 'up'));
	assert.ok(queueDirection(g, 'left'));
	assert.equal(queueDirection(g, 'down'), false);
	assert.equal(g.queue.length, 2);
});

test('hitting a wall ends the game', () => {
	const g = running();
	g.food = { x: 0, y: 0 };
	g.snake = [{ x: 23, y: 3 }, { x: 22, y: 3 }, { x: 21, y: 3 }];
	const ev = tick(g);
	assert.deepEqual(ev, [{ type: 'crash', cause: 'wall' }]);
	assert.equal(g.status, 'over');
});

test('wrap mode passes through the edge', () => {
	const g = running({ rules: { wrap: true } });
	g.food = { x: 10, y: 0 };
	g.snake = [{ x: 23, y: 3 }, { x: 22, y: 3 }, { x: 21, y: 3 }];
	tick(g);
	assert.deepEqual(g.snake[0], { x: 0, y: 3 });
	assert.equal(g.status, 'running');
});

test('moving into the vacating tail cell is allowed', () => {
	const g = running();
	g.food = { x: 0, y: 0 };
	// 2x2 loop: head at (5,3) going down-left-up chases its tail.
	g.snake = [{ x: 5, y: 3 }, { x: 5, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 3 }];
	g.dir = 'up';
	g.queue = ['left'];
	tick(g); // head -> (4,3) which was the tail
	assert.equal(g.status, 'running');
	assert.deepEqual(g.snake[0], { x: 4, y: 3 });
});

test('running into the body ends the game', () => {
	const g = running();
	g.food = { x: 0, y: 0 };
	g.snake = [{ x: 5, y: 3 }, { x: 5, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 3 }, { x: 3, y: 3 }];
	g.dir = 'up';
	g.queue = ['left'];
	assert.deepEqual(tick(g), [{ type: 'crash', cause: 'self' }]);
});

test('eating food grows the snake, scores and respawns food', () => {
	const g = running();
	g.food = { x: 5, y: 3 };
	const ev = tick(g);
	assert.equal(ev[0].type, 'eat');
	assert.equal(g.score, 1);
	assert.equal(g.eaten, 1);
	assert.equal(g.snake.length, 4);
	assert.notDeepEqual(g.food, { x: 5, y: 3 });
});

test('filling the board wins', () => {
	const g = createGame({ cols: 5, rows: 1, rng: seeded() });
	start(g);
	g.snake = [{ x: 3, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 }];
	g.food = { x: 4, y: 0 };
	const ev = tick(g);
	assert.deepEqual(ev.map((e) => e.type), ['eat', 'win']);
	assert.equal(g.status, 'won');
});

test('bonus gives extra points and expires after its TTL', () => {
	const g = running();
	g.food = { x: 0, y: 0 };
	g.bonus = { x: 6, y: 3, ttl: BONUS_TTL };
	tick(g);
	const ev = tick(g);
	assert.deepEqual(ev, [{ type: 'bonus', points: BONUS_POINTS }]);
	assert.equal(g.score, BONUS_POINTS);
	assert.equal(g.bonus, null);

	g.bonus = { x: 0, y: 6, ttl: 2 };
	tick(g);
	assert.equal(g.bonus.ttl, 1);
	assert.deepEqual(tick(g), [{ type: 'bonus-expire' }]);
	assert.equal(g.bonus, null);
});

test('bonus spawns when rng rolls under the chance', () => {
	const g = createGame({ rng: () => 0 });
	start(g);
	g.food = { x: 5, y: 3 };
	const ev = tick(g);
	assert.ok(ev.some((e) => e.type === 'bonus-spawn'));
	assert.equal(g.bonus.ttl, BONUS_TTL);
});

test(`outage block appears every ${OUTAGE_EVERY} items, only with outages on`, () => {
	for (const outages of [false, true]) {
		const g = running({ rules: { outageEvery: outages ? OUTAGE_EVERY : 0 } });
		g.eaten = OUTAGE_EVERY - 1;
		g.food = { x: 5, y: 3 };
		const ev = tick(g);
		assert.equal(ev.some((e) => e.type === 'outage'), outages);
		assert.equal(g.obstacles.size, outages ? 3 : 0);
	}
});

test('outages are 3 cells, aligned to 3-hour slots, away from the head, not on snake/food', () => {
	const g = running({ rules: { outageEvery: OUTAGE_EVERY } });
	for (let i = 0; i < 8; i++) {
		const cells = spawnOutage(g);
		assert.ok(cells, `block ${i} should fit`);
		assert.equal(cells.length, 3);
		assert.equal(cells[0].x % 3, 0);
		assert.ok(cells.every((c) => c.y === cells[0].y));
		const head = g.snake[0];
		assert.ok(cells.every((c) => Math.abs(c.x - head.x) + Math.abs(c.y - head.y) >= 4));
		assert.ok(cells.every((c) => !(c.x === g.food.x && c.y === g.food.y)));
	}
	assert.equal(spawnOutage(g), null, 'capped at 8 blocks');
});

test('outages never fill a whole row', () => {
	const g = running({ rules: { outageEvery: OUTAGE_EVERY } });
	for (let i = 0; i < 8; i++) spawnOutage(g);
	const perRow = new Map();
	for (const i of g.obstacles) {
		const y = Math.floor(i / g.cols);
		perRow.set(y, (perRow.get(y) ?? 0) + 1);
	}
	for (const n of perRow.values()) assert.ok(n <= 9);
});

test('crashing into an outage ends the game', () => {
	const g = running({ rules: { outageEvery: OUTAGE_EVERY } });
	g.food = { x: 0, y: 0 };
	g.obstacles.add(cellIndex(g, 5, 3));
	assert.deepEqual(tick(g), [{ type: 'crash', cause: 'outage' }]);
});

test('food never spawns on obstacles', () => {
	const g = createGame({ cols: 6, rows: 1, rng: seeded(7) });
	for (let x = 0; x < 6; x++) if (x !== 5) g.obstacles.add(x);
	g.snake = [];
	g.food = null;
	for (let i = 0; i < 20; i++) assert.deepEqual(randomFreeCell(g), { x: 5, y: 0 });
});

test('pause toggles only while playing', () => {
	const g = createGame({ rng: seeded() });
	assert.equal(togglePause(g), false);
	start(g);
	togglePause(g);
	assert.equal(g.status, 'paused');
	assert.deepEqual(tick(g), []);
	togglePause(g);
	assert.equal(g.status, 'running');
});

test('speed curve: starts at base, decreases smoothly, never below min', () => {
	assert.equal(tickMs(0, NORMAL), NORMAL.speed.base);
	assert.ok(tickMs(15, NORMAL) > NORMAL.speed.min + 30, 'still room to speed up after 15 items');
	assert.ok(tickMs(10, NORMAL) > tickMs(11, NORMAL));
	assert.ok(tickMs(500, NORMAL) >= NORMAL.speed.min);
});

test('cellMap marks head, body, food, bonus and outages', () => {
	const g = createGame({ rng: seeded() });
	g.food = { x: 0, y: 0 };
	g.bonus = { x: 1, y: 0, ttl: 2 };
	g.obstacles.add(cellIndex(g, 2, 0));
	const m = cellMap(g);
	assert.equal(m[cellIndex(g, 4, 3)], 'head head-right');
	assert.equal(m[cellIndex(g, 3, 3)], 'snake');
	assert.equal(m[0], 'food');
	assert.equal(m[1], 'bonus expiring');
	assert.equal(m[2], 'outage');
	assert.equal(m.filter(Boolean).length, 6);
});
