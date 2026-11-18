// Pure game logic: no DOM, no timers, no Math.random. All randomness comes from
// `state.rng`, seeded at creation, so a run is fully reproducible from
// (seed, difficulty, inputs). The leaderboard server relies on that to replay runs.
import {
	COLS, ROWS, INPUT_BUFFER,
	OUTAGE_LENGTH, OUTAGE_MAX_BLOCKS, SAFE_DISTANCE,
	BONUS_CHANCE, BONUS_POINTS, BONUS_BLINK_TICKS,
	DIFFICULTIES, DEFAULT_DIFFICULTY,
} from './config.js';
import { mulberry32 } from './rng.js';

export const DIRECTIONS = Object.freeze({
	up: Object.freeze({ x: 0, y: -1 }),
	down: Object.freeze({ x: 0, y: 1 }),
	left: Object.freeze({ x: -1, y: 0 }),
	right: Object.freeze({ x: 1, y: 0 }),
});

// Max outage blocks in one row / one 3-hour column slot, so outages never wall off the board.
const OUTAGE_MAX_PER_LINE = 3;

export function rulesFor(difficulty, overrides = {}) {
	const base = DIFFICULTIES[difficulty];
	if (!base) throw new Error(`Unknown difficulty: ${difficulty}`);
	return { ...base, ...overrides };
}

export function tickMs(eaten, rules = DIFFICULTIES[DEFAULT_DIFFICULTY]) {
	const { base, min, decay } = rules.speed;
	return Math.round(min + (base - min) * decay ** eaten);
}

/**
 * @param {object} opts
 * @param {string} [opts.difficulty]
 * @param {number} [opts.seed]   uint32; same seed + inputs = same game
 * @param {() => number} [opts.rng] overrides the seeded generator (tests)
 * @param {object} [opts.rules]  per-field overrides of the difficulty preset (tests)
 */
export function createGame({
	cols = COLS, rows = ROWS, difficulty = DEFAULT_DIFFICULTY, seed = 1, rng, rules: overrides,
} = {}) {
	if (cols < 5 || rows < 1) throw new Error('Board too small');
	const rules = rulesFor(difficulty, overrides);
	const y = Math.floor(rows / 2);
	const state = {
		cols,
		rows,
		difficulty,
		rules,
		seed: seed >>> 0,
		rng: rng ?? mulberry32(seed),
		snake: [{ x: 4, y }, { x: 3, y }, { x: 2, y }],
		dir: 'right',
		queue: [],
		food: null,
		bonus: null, // { x, y, ttl }
		obstacles: new Set(), // permanent outage cells (indexes)
		tempWalls: [], // { cells: [{x,y}], phase: 'warn' | 'solid', ttl }
		nextTempWall: rules.tempWalls ? rules.tempWalls.every : Infinity,
		score: 0,
		eaten: 0,
		ticks: 0,
		status: 'ready', // ready | running | paused | over | won
	};
	state.food = placeFood(state);
	return state;
}

export const cellIndex = (state, x, y) => y * state.cols + x;

const isOpposite = (a, b) =>
	DIRECTIONS[a].x === -DIRECTIONS[b].x && DIRECTIONS[a].y === -DIRECTIONS[b].y;

export function queueDirection(state, name) {
	if (!Object.hasOwn(DIRECTIONS, name)) return false;
	if (state.status === 'over' || state.status === 'won') return false;
	const last = state.queue.at(-1) ?? state.dir;
	if (name === last || isOpposite(name, last)) return false;
	if (state.queue.length >= INPUT_BUFFER) return false;
	state.queue.push(name);
	return true;
}

export function start(state) {
	if (state.status !== 'ready') return false;
	state.status = 'running';
	return true;
}

export function togglePause(state) {
	if (state.status === 'running') state.status = 'paused';
	else if (state.status === 'paused') state.status = 'running';
	else return false;
	return true;
}

export function pause(state) {
	if (state.status !== 'running') return false;
	state.status = 'paused';
	return true;
}

/** Advance one step. Returns a list of events for the UI. */
export function tick(state) {
	if (state.status !== 'running') return [];
	state.ticks += 1;
	if (state.queue.length) state.dir = state.queue.shift();

	const d = DIRECTIONS[state.dir];
	const head = state.snake[0];
	let nx = head.x + d.x;
	let ny = head.y + d.y;

	if (state.rules.wrap) {
		nx = (nx + state.cols) % state.cols;
		ny = (ny + state.rows) % state.rows;
	} else if (nx < 0 || nx >= state.cols || ny < 0 || ny >= state.rows) {
		return crash(state, 'wall');
	}

	const key = cellIndex(state, nx, ny);
	if (state.obstacles.has(key)) return crash(state, 'outage');
	if (solidTempWallCells(state).has(key)) return crash(state, 'tempwall');

	const eatsFood = samePos(state.food, nx, ny);
	const eatsBonus = samePos(state.bonus, nx, ny);
	const grows = eatsFood || eatsBonus;

	// The tail moves out of the way this tick unless the snake grows.
	const bodyLen = grows ? state.snake.length : state.snake.length - 1;
	for (let i = 0; i < bodyLen; i++) {
		if (state.snake[i].x === nx && state.snake[i].y === ny) return crash(state, 'self');
	}

	state.snake.unshift({ x: nx, y: ny });
	if (!grows) state.snake.pop();

	const events = [];

	if (eatsBonus) {
		state.score += BONUS_POINTS;
		state.eaten += 1;
		state.bonus = null;
		events.push({ type: 'bonus', points: BONUS_POINTS });
	} else if (state.bonus) {
		state.bonus.ttl -= 1;
		if (state.bonus.ttl <= 0) {
			state.bonus = null;
			events.push({ type: 'bonus-expire' });
		}
	}

	if (eatsFood) {
		state.score += 1;
		state.eaten += 1;
		events.push({ type: 'eat', points: 1 });

		state.food = placeFood(state);
		if (!state.food) {
			state.status = 'won';
			events.push({ type: 'win' });
			return events;
		}
		const every = state.rules.outageEvery;
		if (every > 0 && state.eaten % every === 0) {
			const cells = spawnOutage(state);
			if (cells) events.push({ type: 'outage', cells });
		}
		if (!state.bonus && state.rng() < BONUS_CHANCE) {
			const cell = randomFreeCell(state);
			if (cell) {
				state.bonus = { ...cell, ttl: state.rules.bonusTtl };
				events.push({ type: 'bonus-spawn' });
			}
		}
	}

	updateTempWalls(state, events);
	return events;
}

function crash(state, cause) {
	state.status = 'over';
	return [{ type: 'crash', cause }];
}

function samePos(p, x, y) {
	return p != null && p.x === x && p.y === y;
}

// --- Occupancy helpers -----------------------------------------------------

function solidTempWallCells(state) {
	const set = new Set();
	for (const w of state.tempWalls) {
		if (w.phase === 'solid') for (const c of w.cells) set.add(cellIndex(state, c.x, c.y));
	}
	return set;
}

/** Cells nothing new may be placed on: snake, items, outages, temp walls in any phase. */
function occupiedSet(state) {
	const set = new Set(state.obstacles);
	for (const s of state.snake) set.add(cellIndex(state, s.x, s.y));
	if (state.food) set.add(cellIndex(state, state.food.x, state.food.y));
	if (state.bonus) set.add(cellIndex(state, state.bonus.x, state.bonus.y));
	for (const w of state.tempWalls) for (const c of w.cells) set.add(cellIndex(state, c.x, c.y));
	return set;
}

function freeCells(state) {
	const occupied = occupiedSet(state);
	const free = [];
	for (let i = 0; i < state.cols * state.rows; i++) {
		if (!occupied.has(i)) free.push(i);
	}
	return free;
}

const toPos = (state, i) => ({ x: i % state.cols, y: Math.floor(i / state.cols) });

export function randomFreeCell(state) {
	const free = freeCells(state);
	if (free.length === 0) return null;
	return toPos(state, free[Math.floor(state.rng() * free.length)]);
}

export function distance(state, a, b) {
	let dx = Math.abs(a.x - b.x);
	let dy = Math.abs(a.y - b.y);
	if (state.rules.wrap) {
		dx = Math.min(dx, state.cols - dx);
		dy = Math.min(dy, state.rows - dy);
	}
	return dx + dy;
}

// --- Food placement ----------------------------------------------------------

/** Number of the 4 neighbours that are permanently or temporarily blocked (walls, outages, temp walls). */
export function blockedNeighbours(state, { x, y }) {
	const blocked = new Set(state.obstacles);
	for (const w of state.tempWalls) for (const c of w.cells) blocked.add(cellIndex(state, c.x, c.y));
	let n = 0;
	for (const d of Object.values(DIRECTIONS)) {
		let nx = x + d.x;
		let ny = y + d.y;
		if (state.rules.wrap) {
			nx = (nx + state.cols) % state.cols;
			ny = (ny + state.rows) % state.rows;
		} else if (nx < 0 || nx >= state.cols || ny < 0 || ny >= state.rows) {
			n++;
			continue;
		}
		if (blocked.has(cellIndex(state, nx, ny))) n++;
	}
	return n;
}

/** How awkward a cell is to reach: far from the head and hugging walls/obstacles. */
export function foodHardness(state, pos) {
	return distance(state, state.snake[0], pos) + 3 * blockedNeighbours(state, pos);
}

/**
 * Place the next item. With foodPicks > 1, sample that many free cells and keep the
 * hardest, but never a dead end (a cell needs at least two open sides to get in and out).
 */
export function placeFood(state) {
	const free = freeCells(state);
	if (free.length === 0) return null;
	const picks = Math.max(1, state.rules.foodPicks | 0);
	if (picks === 1) return toPos(state, free[Math.floor(state.rng() * free.length)]);

	let best = null;
	let bestScore = -Infinity;
	for (let i = 0; i < picks; i++) {
		const pos = toPos(state, free[Math.floor(state.rng() * free.length)]);
		const deadEnd = blockedNeighbours(state, pos) >= 3;
		const score = deadEnd ? -1 : foodHardness(state, pos);
		if (score > bestScore) {
			best = pos;
			bestScore = score;
		}
	}
	return best;
}

// --- Permanent outages ---------------------------------------------------------

/** Place a 3-hour outage block aligned to the 3-hour dividers. Returns its cells or null. */
export function spawnOutage(state) {
	const blocks = state.obstacles.size / OUTAGE_LENGTH;
	if (blocks >= OUTAGE_MAX_BLOCKS) return null;

	const occupied = occupiedSet(state);
	const head = state.snake[0];
	const perRow = new Map();
	const perSlot = new Map();
	for (const i of state.obstacles) {
		const x = i % state.cols;
		if (x % OUTAGE_LENGTH !== 0) continue; // count each block once, by its first cell
		const y = Math.floor(i / state.cols);
		perRow.set(y, (perRow.get(y) ?? 0) + 1);
		perSlot.set(x, (perSlot.get(x) ?? 0) + 1);
	}

	const candidates = [];
	for (let y = 0; y < state.rows; y++) {
		if ((perRow.get(y) ?? 0) >= OUTAGE_MAX_PER_LINE) continue;
		for (let x0 = 0; x0 + OUTAGE_LENGTH <= state.cols; x0 += OUTAGE_LENGTH) {
			if ((perSlot.get(x0) ?? 0) >= OUTAGE_MAX_PER_LINE) continue;
			const cells = [];
			let ok = true;
			for (let x = x0; x < x0 + OUTAGE_LENGTH && ok; x++) {
				ok = !occupied.has(cellIndex(state, x, y)) && distance(state, head, { x, y }) >= SAFE_DISTANCE;
				cells.push({ x, y });
			}
			if (ok) candidates.push(cells);
		}
	}
	if (candidates.length === 0) return null;
	const cells = candidates[Math.floor(state.rng() * candidates.length)];
	for (const c of cells) state.obstacles.add(cellIndex(state, c.x, c.y));
	return cells;
}

// --- Temporary walls ("planned outages") -------------------------------------

/**
 * Lifecycle: spawn as a blinking warning (passable) → turn solid → vanish.
 * A wall never turns solid on top of the snake: those cells are dropped.
 */
function updateTempWalls(state, events) {
	const cfg = state.rules.tempWalls;
	if (!cfg) return;

	for (const w of state.tempWalls) {
		w.ttl -= 1;
		if (w.ttl > 0) continue;
		if (w.phase === 'warn') {
			const snakeCells = new Set(state.snake.map((s) => cellIndex(state, s.x, s.y)));
			w.cells = w.cells.filter((c) => !snakeCells.has(cellIndex(state, c.x, c.y)));
			w.phase = 'solid';
			w.ttl = cfg.life;
			events.push({ type: 'tempwall-solid' });
		} else {
			w.cells = [];
		}
	}
	state.tempWalls = state.tempWalls.filter((w) => w.cells.length > 0);

	if (state.ticks >= state.nextTempWall) {
		// Jitter the interval ±25% so walls don't arrive on a predictable beat.
		state.nextTempWall = state.ticks + Math.round(cfg.every * (0.75 + state.rng() * 0.5));
		if (state.tempWalls.length < cfg.max) {
			const cells = spawnTempWall(state, cfg);
			if (cells) {
				state.tempWalls.push({ cells, phase: 'warn', ttl: cfg.warn });
				events.push({ type: 'tempwall-warn', cells });
			}
		}
	}
}

export function spawnTempWall(state, cfg = state.rules.tempWalls) {
	const occupied = occupiedSet(state);
	const head = state.snake[0];
	// Keep the cell straight ahead clear too, so a wall can't appear right in the snake's path.
	const d = DIRECTIONS[state.dir];
	const forbidden = new Set();
	for (let k = 1; k <= 6; k++) {
		const x = head.x + d.x * k;
		const y = head.y + d.y * k;
		if (x < 0 || x >= state.cols || y < 0 || y >= state.rows) break;
		forbidden.add(cellIndex(state, x, y));
	}

	for (let attempt = 0; attempt < 30; attempt++) {
		const len = cfg.minLen + Math.floor(state.rng() * (cfg.maxLen - cfg.minLen + 1));
		const horizontal = state.rng() < 0.5;
		const w = horizontal ? len : 1;
		const h = horizontal ? 1 : len;
		if (w > state.cols || h > state.rows) continue;
		const x0 = Math.floor(state.rng() * (state.cols - w + 1));
		const y0 = Math.floor(state.rng() * (state.rows - h + 1));
		const cells = [];
		let ok = true;
		for (let i = 0; i < len && ok; i++) {
			const c = horizontal ? { x: x0 + i, y: y0 } : { x: x0, y: y0 + i };
			const k = cellIndex(state, c.x, c.y);
			ok = !occupied.has(k) && !forbidden.has(k) && distance(state, head, c) >= SAFE_DISTANCE;
			cells.push(c);
		}
		if (ok) return cells;
	}
	return null;
}

// --- Rendering snapshot ----------------------------------------------------------

/** Flat array (one entry per cell) describing what to draw. Empty string = empty cell. */
export function cellMap(state) {
	const map = new Array(state.cols * state.rows).fill('');
	for (const i of state.obstacles) map[i] = 'outage';
	for (const w of state.tempWalls) {
		const cls = w.phase === 'warn' ? 'tempwall-warn' : 'tempwall';
		for (const c of w.cells) map[cellIndex(state, c.x, c.y)] = cls;
	}
	if (state.food) map[cellIndex(state, state.food.x, state.food.y)] = 'food';
	if (state.bonus) {
		map[cellIndex(state, state.bonus.x, state.bonus.y)] =
			state.bonus.ttl <= BONUS_BLINK_TICKS ? 'bonus expiring' : 'bonus';
	}
	state.snake.forEach((s, i) => {
		map[cellIndex(state, s.x, s.y)] = i === 0 ? `head head-${state.dir}` : 'snake';
	});
	return map;
}
