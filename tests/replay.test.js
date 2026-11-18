import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, queueDirection, start, tick } from '../src/game.js';
import { createRecorder, replay } from '../src/replay.js';
import { playRun } from './helpers.js';

test('a recorded run replays to the same score and length', () => {
	for (const difficulty of ['easy', 'normal', 'hard', 'insane']) {
		for (const seed of [1, 99, 123456]) {
			const run = playRun({ seed, difficulty });
			const r = replay({ seed, difficulty, inputs: run.inputs, endTick: run.endTick });
			assert.equal(r.ok, true, `${difficulty}/${seed}: ${r.reason}`);
			assert.equal(r.score, run.score);
			assert.equal(r.ticks, run.endTick);
			assert.ok(r.minDurationMs > 0);
		}
	}
});

test('the bot actually scores, so replays cover eating, outages and temp walls', () => {
	const run = playRun({ seed: 2024, difficulty: 'insane' });
	assert.ok(run.score >= 5, `score ${run.score}`);
	assert.ok(run.sawTempWall, 'a temp wall appeared during the run');
});

test('tampered runs are rejected', () => {
	const seed = 77;
	const difficulty = 'hard';
	const run = playRun({ seed, difficulty });

	assert.equal(replay({ seed: seed + 1, difficulty, inputs: run.inputs, endTick: run.endTick }).ok, false, 'other seed');
	assert.equal(replay({ seed, difficulty: 'easy', inputs: run.inputs, endTick: run.endTick }).ok, false, 'other difficulty');
	assert.equal(replay({ seed, difficulty, inputs: run.inputs, endTick: run.endTick + 50 }).reason, 'end-mismatch');
	assert.equal(replay({ seed, difficulty, inputs: run.inputs, endTick: run.endTick - 1 }).ok, false);

	const reversed = run.inputs.map(([t, c]) => [t, (c + 2) % 4]);
	assert.equal(replay({ seed, difficulty, inputs: reversed, endTick: run.endTick }).ok, false, 'edited inputs');
});

test('malformed input is rejected before simulating', () => {
	const base = { seed: 1, difficulty: 'normal', endTick: 10 };
	assert.equal(replay({ ...base, difficulty: 'god' }).reason, 'bad-difficulty');
	assert.equal(replay({ ...base, inputs: [], seed: -1 }).reason, 'bad-seed');
	assert.equal(replay({ ...base, inputs: [], endTick: 0 }).reason, 'bad-end-tick');
	assert.equal(replay({ ...base, inputs: 'x' }).reason, 'bad-inputs');
	assert.equal(replay({ ...base, inputs: [[3, 0], [2, 1]] }).reason, 'bad-inputs', 'not sorted');
	assert.equal(replay({ ...base, inputs: [[1, 9]] }).reason, 'bad-inputs', 'bad code');
	assert.equal(replay({ ...base, inputs: [[10, 0]] }).reason, 'bad-inputs', 'input at/after end');
	assert.equal(replay({ ...base, inputs: [[0, 3]] }).reason, 'impossible-input', 'reverse into self');
});

test('a game that never crashes cannot be submitted as finished', () => {
	// Straight right on normal crashes at the wall after 20 ticks.
	assert.equal(replay({ seed: 1, difficulty: 'normal', inputs: [], endTick: 20 }).ok, true);
	assert.equal(replay({ seed: 1, difficulty: 'normal', inputs: [], endTick: 19 }).reason, 'not-finished');
});

test('recorder stores the tick a turn was queued at', () => {
	const g = createGame({ seed: 1 });
	const rec = createRecorder();
	start(g);
	tick(g);
	tick(g);
	assert.ok(queueDirection(g, 'up'));
	rec.record(g, 'up');
	assert.deepEqual(rec.inputs, [[2, 0]]);
});
