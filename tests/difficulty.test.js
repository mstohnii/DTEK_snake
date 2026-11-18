import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	createGame, start, tick, tickMs, cellMap, cellIndex,
	spawnTempWall, placeFood, blockedNeighbours, foodHardness, distance,
} from '../src/game.js';
import { DIFFICULTIES } from '../src/config.js';

function running(opts) {
	const g = createGame(opts);
	start(g);
	return g;
}

test('every difficulty preset creates a playable game', () => {
	for (const difficulty of Object.keys(DIFFICULTIES)) {
		const g = running({ difficulty, seed: 42 });
		assert.equal(g.difficulty, difficulty);
		assert.deepEqual(g.rules, { ...DIFFICULTIES[difficulty] });
		assert.ok(g.food);
		assert.equal(tickMs(0, g.rules), DIFFICULTIES[difficulty].speed.base);
	}
});

test('harder levels are faster at every stage', () => {
	const order = ['easy', 'normal', 'hard', 'insane'];
	for (const eaten of [0, 10, 30]) {
		const speeds = order.map((d) => tickMs(eaten, DIFFICULTIES[d]));
		for (let i = 1; i < speeds.length; i++) assert.ok(speeds[i] < speeds[i - 1], `${order[i]} @${eaten}`);
	}
});

test('same seed gives the same game, different seeds differ', () => {
	const a = createGame({ seed: 123, difficulty: 'hard' });
	const b = createGame({ seed: 123, difficulty: 'hard' });
	assert.deepEqual(a.food, b.food);
	const foods = new Set([999, 1000, 1001, 1002, 1003].map((seed) => JSON.stringify(createGame({ seed }).food)));
	assert.ok(foods.size > 1, 'different seeds place food differently');
});

test('easy wraps around the edges', () => {
	const g = running({ difficulty: 'easy', seed: 1 });
	g.food = { x: 0, y: 0 };
	g.snake = [{ x: 23, y: 3 }, { x: 22, y: 3 }, { x: 21, y: 3 }];
	tick(g);
	assert.deepEqual(g.snake[0], { x: 0, y: 3 });
});

test('temp walls: warn (passable) → solid (deadly) → gone', () => {
	const cfg = { every: 5, warn: 3, life: 4, minLen: 2, maxLen: 2, max: 1 };
	const g = running({ seed: 7, rules: { tempWalls: cfg, foodPicks: 1 } });
	g.food = { x: 0, y: 0 };
	g.snake = [{ x: 2, y: 0 }, { x: 1, y: 0 }]; // keep the snake out of the way
	g.dir = 'right';
	// Drive the snake along row 0 without dying: put the head back each tick.
	const park = () => { g.snake = [{ x: 2, y: 0 }, { x: 1, y: 0 }]; g.dir = 'right'; };

	let warnAt = null;
	for (let i = 0; i < 6 && warnAt === null; i++) {
		park();
		const ev = tick(g);
		if (ev.some((e) => e.type === 'tempwall-warn')) warnAt = g.ticks;
	}
	assert.equal(warnAt, 5, 'first wall spawns after `every` ticks');
	assert.equal(g.tempWalls.length, 1);
	assert.equal(g.tempWalls[0].phase, 'warn');
	assert.equal(g.tempWalls[0].cells.length, 2);
	assert.ok(cellMap(g).includes('tempwall-warn'));

	for (let i = 0; i < cfg.warn; i++) { park(); tick(g); }
	assert.equal(g.tempWalls[0].phase, 'solid');
	assert.ok(cellMap(g).includes('tempwall'));

	for (let i = 0; i < cfg.life; i++) { park(); tick(g); }
	assert.equal(g.tempWalls.filter((w) => w.phase === 'solid').length, 0, 'solid wall expired');
});

test('running into a solid temp wall ends the game; a warning wall is passable', () => {
	const g = running({ seed: 1, rules: { tempWalls: { every: 999, warn: 5, life: 5, minLen: 1, maxLen: 1, max: 1 } } });
	g.food = { x: 0, y: 0 };
	g.tempWalls = [{ cells: [{ x: 5, y: 3 }], phase: 'warn', ttl: 5 }];
	tick(g);
	assert.equal(g.status, 'running');
	assert.deepEqual(g.snake[0], { x: 5, y: 3 });

	g.tempWalls = [{ cells: [{ x: 6, y: 3 }], phase: 'solid', ttl: 5 }];
	assert.deepEqual(tick(g), [{ type: 'crash', cause: 'tempwall' }]);
});

test('a wall never turns solid on top of the snake', () => {
	const g = running({ seed: 1, rules: { tempWalls: { every: 999, warn: 1, life: 5, minLen: 1, maxLen: 1, max: 2 } } });
	g.food = { x: 0, y: 0 };
	// Wall warns on (5,3) and (4,3); after this tick the snake covers both.
	g.tempWalls = [{ cells: [{ x: 5, y: 3 }, { x: 4, y: 3 }, { x: 10, y: 5 }], phase: 'warn', ttl: 1 }];
	tick(g);
	assert.equal(g.tempWalls[0].phase, 'solid');
	assert.deepEqual(g.tempWalls[0].cells, [{ x: 10, y: 5 }]);
});

test('temp walls spawn away from the head and not straight ahead', () => {
	const cfg = DIFFICULTIES.insane.tempWalls;
	for (let seed = 1; seed <= 200; seed++) {
		const g = running({ seed, difficulty: 'insane' });
		const cells = spawnTempWall(g, cfg);
		if (!cells) continue;
		const head = g.snake[0];
		assert.ok(cells.length >= cfg.minLen && cells.length <= cfg.maxLen);
		for (const c of cells) {
			assert.ok(c.x >= 0 && c.x < g.cols && c.y >= 0 && c.y < g.rows);
			assert.ok(distance(g, head, c) >= 4);
			assert.ok(!(c.y === head.y && c.x > head.x && c.x <= head.x + 6), 'not in the path ahead');
			assert.ok(!g.snake.some((s) => s.x === c.x && s.y === c.y));
		}
		const xs = new Set(cells.map((c) => c.x));
		const ys = new Set(cells.map((c) => c.y));
		assert.ok(xs.size === 1 || ys.size === 1, 'straight line');
	}
});

test('no temp walls on easy/normal', () => {
	for (const difficulty of ['easy', 'normal']) {
		const g = running({ difficulty, seed: 3 });
		for (let i = 0; i < 300 && g.status === 'running'; i++) {
			g.snake = [{ x: 2, y: 0 }, { x: 1, y: 0 }];
			g.dir = 'right';
			g.food = { x: 0, y: 6 };
			tick(g);
		}
		assert.equal(g.tempWalls.length, 0);
	}
});

test('hard placement prefers awkward cells over random placement', () => {
	const avg = (difficulty) => {
		let sum = 0;
		for (let seed = 1; seed <= 300; seed++) {
			const g = createGame({ seed, difficulty });
			sum += foodHardness(g, g.food);
		}
		return sum / 300;
	};
	const normal = avg('normal');
	const hard = avg('hard');
	const insane = avg('insane');
	assert.ok(hard > normal + 1, `hard ${hard} vs normal ${normal}`);
	assert.ok(insane > hard, `insane ${insane} vs hard ${hard}`);
});

test('hard placement never picks a dead end when another option exists', () => {
	const g = createGame({ seed: 5, difficulty: 'insane', cols: 6, rows: 3 });
	// Box in the corner (0,0): (1,0) and (0,1) blocked → 4 blocked sides with the walls.
	g.obstacles.add(cellIndex(g, 1, 0));
	g.obstacles.add(cellIndex(g, 0, 1));
	for (let i = 0; i < 100; i++) {
		g.food = null;
		const pos = placeFood(g);
		assert.ok(blockedNeighbours(g, pos) < 3, `dead end chosen: ${JSON.stringify(pos)}`);
	}
});
