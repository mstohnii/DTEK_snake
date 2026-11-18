import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyToAction, swipeDirection } from '../src/input.js';

test('arrows and WASD map to directions by physical key', () => {
	assert.equal(keyToAction({ code: 'ArrowUp', key: 'ArrowUp' }), 'up');
	assert.equal(keyToAction({ code: 'KeyA', key: 'ф' }), 'left'); // Ukrainian layout
	assert.equal(keyToAction({ code: 'KeyS', key: 'і' }), 'down');
	assert.equal(keyToAction({ code: 'KeyD', key: 'D' }), 'right');
});

test('falls back to the produced character when code is unknown', () => {
	assert.equal(keyToAction({ code: '', key: 'Ц' }), 'up');
	assert.equal(keyToAction({ code: '', key: 'ы' }), 'down');
	assert.equal(keyToAction({ code: '', key: 'В' }), 'right');
});

test('space/P/Escape pause, Enter restarts', () => {
	assert.equal(keyToAction({ code: 'Space', key: ' ' }), 'pause');
	assert.equal(keyToAction({ code: 'KeyP', key: 'p' }), 'pause');
	assert.equal(keyToAction({ code: 'Escape', key: 'Escape' }), 'pause');
	assert.equal(keyToAction({ code: 'Enter', key: 'Enter' }), 'restart');
});

test('modifier shortcuts and unrelated keys are ignored', () => {
	assert.equal(keyToAction({ code: 'KeyD', key: 'd', ctrlKey: true }), null);
	assert.equal(keyToAction({ code: 'KeyR', key: 'r', metaKey: true }), null);
	assert.equal(keyToAction({ code: 'KeyQ', key: 'q' }), null);
	assert.equal(keyToAction({ code: 'Tab', key: 'Tab' }), null);
});

test('swipe direction uses the dominant axis and a threshold', () => {
	assert.equal(swipeDirection(5, 3), null);
	assert.equal(swipeDirection(40, 10), 'right');
	assert.equal(swipeDirection(-40, 10), 'left');
	assert.equal(swipeDirection(10, 40), 'down');
	assert.equal(swipeDirection(10, -40), 'up');
});
