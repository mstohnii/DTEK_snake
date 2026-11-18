// Run recording and server-side replay.
//
// The browser records only the turns it accepted, as [tick, directionCode] pairs,
// where `tick` is state.ticks at the moment the turn was queued. Replaying those
// against a fresh game with the same seed and difficulty must reproduce the run
// exactly, so the server computes the score itself instead of trusting the client.
import { DIFFICULTIES } from './config.js';
import { createGame, queueDirection, start, tick, tickMs } from './game.js';

export const DIR_CODES = Object.freeze(['up', 'right', 'down', 'left']);
export const MAX_TICKS = 100_000;
export const MAX_INPUTS = 20_000;

export function createRecorder() {
	const inputs = [];
	return {
		inputs,
		/** Call after queueDirection() returned true. */
		record(state, dir) {
			inputs.push([state.ticks, DIR_CODES.indexOf(dir)]);
		},
	};
}

const fail = (reason) => ({ ok: false, reason });

/**
 * @returns {{ok: true, score: number, ticks: number, eaten: number, minDurationMs: number}
 *          | {ok: false, reason: string}}
 */
export function replay({ seed, difficulty, inputs, endTick }) {
	if (!Object.hasOwn(DIFFICULTIES, difficulty)) return fail('bad-difficulty');
	if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return fail('bad-seed');
	if (!Number.isInteger(endTick) || endTick < 1 || endTick > MAX_TICKS) return fail('bad-end-tick');
	if (!Array.isArray(inputs) || inputs.length > MAX_INPUTS) return fail('bad-inputs');

	let prev = 0;
	for (const item of inputs) {
		if (!Array.isArray(item) || item.length !== 2) return fail('bad-inputs');
		const [t, code] = item;
		if (!Number.isInteger(t) || t < prev || t >= endTick) return fail('bad-inputs');
		if (!Number.isInteger(code) || code < 0 || code >= DIR_CODES.length) return fail('bad-inputs');
		prev = t;
	}

	const game = createGame({ seed, difficulty });
	start(game);
	let i = 0;
	let minDurationMs = 0;

	while (game.status === 'running' && game.ticks < endTick) {
		while (i < inputs.length && inputs[i][0] === game.ticks) {
			if (!queueDirection(game, DIR_CODES[inputs[i][1]])) return fail('impossible-input');
			i++;
		}
		minDurationMs += tickMs(game.eaten, game.rules);
		tick(game);
	}

	if (game.status !== 'over' && game.status !== 'won') return fail('not-finished');
	if (game.ticks !== endTick) return fail('end-mismatch');
	if (i !== inputs.length) return fail('unused-inputs');

	return { ok: true, score: game.score, ticks: game.ticks, eaten: game.eaten, minDurationMs };
}
