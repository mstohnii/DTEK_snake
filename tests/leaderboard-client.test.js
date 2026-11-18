import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiBase, submitResultText, isOwnEntry, errorText } from '../src/leaderboard.js';

const doc = (content) => ({ querySelector: () => (content == null ? null : { content }) });

test('localhost always talks to the local dev API, never production', () => {
	assert.equal(resolveApiBase(doc('https://prod.example'), { hostname: 'localhost' }), 'http://localhost:8787');
	assert.equal(resolveApiBase(doc('https://prod.example'), { hostname: '127.0.0.1' }), 'http://localhost:8787');
});

test('deployed sites use the meta tag; empty meta means offline', () => {
	assert.equal(resolveApiBase(doc('https://api.example/'), { hostname: 'dtek.mstohnii.com' }), 'https://api.example');
	assert.equal(resolveApiBase(doc(''), { hostname: 'dtek.mstohnii.com' }), '');
	assert.equal(resolveApiBase(doc(null), { hostname: 'dtek.mstohnii.com' }), '');
});

test('submit message: new personal best vs. weaker repeat', () => {
	assert.equal(submitResultText({ score: 30, best: 30, rank: 2 }, 'Звичайний'), 'Збережено! Ви на 2-му місці («Звичайний»).');
	assert.equal(
		submitResultText({ score: 16, best: 52, rank: 1 }, 'Звичайний'),
		'Збережено! Ваш рекорд — 52, з ним ви на 1-му місці («Звичайний»).',
	);
	// Older API responses without `best` still read correctly.
	assert.equal(submitResultText({ score: 5, rank: 3 }, 'Легкий'), 'Збережено! Ви на 3-му місці («Легкий»).');
});

test('own row: matched by last run id or by the player name, case-insensitive', () => {
	const entry = { id: 'r1', name: 'Povir' };
	assert.equal(isOwnEntry(entry, { lastId: 'r1', playerName: '' }), true);
	assert.equal(isOwnEntry(entry, { lastId: null, playerName: ' povir ' }), true);
	assert.equal(isOwnEntry(entry, { lastId: 'r2', playerName: 'Софія' }), false);
	assert.equal(isOwnEntry({ id: 'x', name: 'СОФІЯ' }, { playerName: 'софія' }), true);
	assert.equal(isOwnEntry(entry, { lastId: null, playerName: '' }), false);
});

test('every server error code has a Ukrainian message', () => {
	for (const code of ['network', 'bad-name', 'reserved-name', 'rate-limited', 'already-submitted', 'ticket-expired', 'too-fast', 'zero-score', 'replay-end-mismatch', 'score-mismatch', 'something-new']) {
		const text = errorText(code);
		assert.ok(text && /[А-Яа-яЄєІіЇїҐґ]/.test(text), code);
	}
	assert.equal(errorText('reserved-name'), 'Це ім’я схоже на системне повідомлення. Оберіть інше.');
});
