import { COLS, ROWS, DIFFICULTIES, THEMES } from './config.js';
import { createGame, queueDirection, start, togglePause, pause, tick, tickMs, cellMap } from './game.js';
import { createRenderer } from './renderer.js';
import { bindKeyboard, bindSwipe, bindButtons } from './input.js';
import { loadBestScores, saveBestScores, loadSettings, saveSettings, loadPlayerCode, savePlayerCode } from './storage.js';
import { createRecorder } from './replay.js';
import { randomSeed } from './rng.js';
import {
	createLeaderboardClient, resolveApiBase, errorText, submitResultText, isOwnEntry, newPlayerCode, parsePlayerCode,
} from './leaderboard.js';
import {
	isTouchDevice, createWakeLock, vibrate, fullscreenSupported, toggleFullscreen,
	onFullscreenChange, onRotate, registerServiceWorker,
} from './device.js';

const $ = (id) => document.getElementById(id);
const els = {
	board: $('board'),
	boardWrap: $('board-wrap'),
	btnFullscreen: $('btn-fullscreen'),
	boardStatus: $('board-status'),
	rankedBadge: $('ranked-badge'),
	score: $('score'),
	best: $('best-score'),
	btnNew: $('btn-new'),
	btnPause: $('btn-pause'),
	difficulty: $('difficulty'),
	theme: $('theme'),
	overlay: $('overlay'),
	overlayTitle: $('overlay-title'),
	overlayReason: $('overlay-reason'),
	finalScore: $('final-score'),
	finalDifficulty: $('final-difficulty'),
	newRecord: $('new-record'),
	submitForm: $('submit-form'),
	playerName: $('player-name'),
	btnSubmit: $('btn-submit'),
	submitStatus: $('submit-status'),
	btnRestart: $('btn-restart'),
	btnClose: $('btn-close'),
	dpad: $('dpad'),
	lbTabs: $('lb-tabs'),
	lbList: $('lb-list'),
	lbStatus: $('lb-status'),
	playerCode: $('player-code'),
	playerCodeValue: $('player-code-value'),
	btnCopyCode: $('btn-copy-code'),
	restoreForm: $('restore-form'),
	restoreCode: $('restore-code'),
	codeStatus: $('code-status'),
	restoreInline: $('restore-inline'),
	restoreInlineCode: $('restore-inline-code'),
};

const CRASH_TEXT = {
	wall: 'Змійка врізалась у межу графіка.',
	self: 'Змійка вкусила сама себе.',
	outage: 'Змійка потрапила у відключення.',
	tempwall: 'Змійка врізалась у тимчасову стіну.',
};

const isTouch = isTouchDevice();
const wakeLock = createWakeLock();
const renderer = createRenderer(els.board, { cols: COLS, rows: ROWS });
const settings = loadSettings();
const bestScores = loadBestScores();
const api = createLeaderboardClient(resolveApiBase());
// Proves this device owns the names it has played under (see "Код гравця" under the board).
let playerCode = parsePlayerCode(loadPlayerCode());
if (!playerCode) {
	playerCode = newPlayerCode();
	savePlayerCode(playerCode);
}

let game;
let recorder;
let ticket = null; // server ticket this game is seeded with (null = unranked)
let rafId = null;
let lastTs = null;
let acc = 0;
let recordBeaten = false;
let lastSubmittedId = null;
let boardDifficulty = settings.difficulty;

// --- Themes -----------------------------------------------------------------

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
	const t = settings.theme === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : settings.theme;
	document.documentElement.dataset.theme = t;
}

function buildThemePicker() {
	for (const [value, label] of Object.entries(THEMES)) {
		els.theme.append(new Option(label, value, false, value === settings.theme));
	}
	els.theme.addEventListener('change', () => {
		settings.theme = els.theme.value;
		saveSettings(settings);
		applyTheme();
		els.theme.blur();
	});
	darkQuery.addEventListener('change', applyTheme);
	applyTheme();
}

// --- Difficulty -------------------------------------------------------------

function buildDifficultyPicker() {
	for (const [value, preset] of Object.entries(DIFFICULTIES)) {
		const label = document.createElement('label');
		label.className = 'seg';
		const input = document.createElement('input');
		input.type = 'radio';
		input.name = 'difficulty';
		input.value = value;
		input.checked = value === settings.difficulty;
		const span = document.createElement('span');
		span.textContent = preset.label;
		label.append(input, span);
		els.difficulty.append(label);
	}
	els.difficulty.addEventListener('change', (e) => {
		settings.difficulty = e.target.value;
		saveSettings(settings);
		e.target.blur(); // give arrow keys back to the game
		newGame();
		showBoard(settings.difficulty);
	});
}

// --- Run tickets (online, ranked games) ---------------------------------------

// Server accepts tickets up to 6h old at submit time; leave plenty of room for the game itself.
const TICKET_MAX_AGE_MS = 60 * 60 * 1000;
const tickets = new Map(); // difficulty -> ticket | Promise

function prefetchTicket(difficulty) {
	if (!api.enabled || tickets.has(difficulty)) return;
	const p = api.issueRun(difficulty)
		.then((t) => {
			tickets.set(difficulty, { ...t, fetchedAt: Date.now() });
			// The current game hasn't started yet: re-seed it so it counts.
			if (!ticket && game?.status === 'ready' && game.difficulty === difficulty && recorder.inputs.length === 0) newGame();
		})
		.catch(() => tickets.delete(difficulty));
	tickets.set(difficulty, p);
}

function takeTicket(difficulty) {
	const t = tickets.get(difficulty);
	if (!t || t instanceof Promise) return null;
	tickets.delete(difficulty);
	return Date.now() - t.fetchedAt < TICKET_MAX_AGE_MS ? t : null;
}

// --- Game lifecycle ---------------------------------------------------------------

function newGame() {
	stopLoop();
	ticket = takeTicket(settings.difficulty);
	game = createGame({ cols: COLS, rows: ROWS, difficulty: settings.difficulty, seed: ticket?.seed ?? randomSeed() });
	recorder = createRecorder();
	recordBeaten = false;
	closeOverlay();
	updateHud();
	draw();
	prefetchTicket(settings.difficulty);
}

function draw() {
	renderer.render(cellMap(game));
}

function currentBest() {
	return bestScores[game.difficulty] ?? 0;
}

function updateHud() {
	els.score.textContent = String(game.score);
	els.best.textContent = String(Math.max(currentBest(), game.score));

	const s = game.status;
	els.btnPause.textContent = s === 'paused' ? 'Продовжити' : s === 'running' ? 'Пауза' : 'Старт';
	els.btnPause.disabled = s === 'over' || s === 'won';

	if (s === 'running') wakeLock.acquire();
	else wakeLock.release();

	const locked = s === 'running' || s === 'paused';
	for (const input of els.difficulty.querySelectorAll('input')) input.disabled = locked;

	const msg =
		s === 'ready' ? (isTouch ? 'Проведіть пальцем, щоб почати' : 'Натисніть стрілку, WASD або пробіл, щоб почати')
		: s === 'paused' ? (isTouch ? 'Пауза — торкніться тут' : 'Пауза — пробіл, щоб продовжити')
		: '';
	els.boardStatus.textContent = msg;
	els.boardStatus.hidden = !msg;

	els.rankedBadge.hidden = !api.enabled;
	els.rankedBadge.textContent = ticket ? 'Рейтингова гра' : 'Без рейтингу';
	els.rankedBadge.classList.toggle('on', Boolean(ticket));
	els.rankedBadge.title = ticket ? 'Результат можна надіслати в таблицю лідерів' : 'Немає зв’язку з сервером — результат не потрапить у таблицю';
}

// --- Loop -------------------------------------------------------------------------

function startLoop() {
	if (rafId !== null) return;
	lastTs = null;
	acc = 0;
	rafId = requestAnimationFrame(loop);
}

function stopLoop() {
	if (rafId !== null) cancelAnimationFrame(rafId);
	rafId = null;
}

function loop(ts) {
	rafId = null;
	if (game.status !== 'running') return;
	if (lastTs !== null) acc += ts - lastTs;
	lastTs = ts;

	const step = tickMs(game.eaten, game.rules);
	acc = Math.min(acc, step * 2); // never "catch up" more than one extra step after a hitch
	let changed = false;
	while (acc >= step && game.status === 'running') {
		acc -= step;
		handleEvents(tick(game));
		changed = true;
	}
	if (changed) draw();
	if (game.status === 'running') rafId = requestAnimationFrame(loop);
}

function handleEvents(events) {
	for (const ev of events) {
		switch (ev.type) {
			case 'eat':
				onScore(false);
				break;
			case 'bonus':
				vibrate([15, 40, 15]);
				onScore(true);
				break;
			case 'outage':
			case 'tempwall-solid':
				flashBoard();
				break;
			case 'crash':
				vibrate(120);
				endGame(CRASH_TEXT[ev.cause]);
				break;
			case 'win':
				endGame('Ви заповнили весь графік!', true);
				break;
		}
	}
}

function flashBoard() {
	els.board.classList.remove('flash');
	void els.board.offsetWidth; // restart the animation
	els.board.classList.add('flash');
}

function onScore(isBonus) {
	if (game.score > currentBest()) {
		bestScores[game.difficulty] = game.score;
		saveBestScores(bestScores);
		recordBeaten = true;
	}
	const box = els.score.parentElement;
	box.classList.remove('bump', 'bump-bonus');
	void box.offsetWidth;
	box.classList.add(isBonus ? 'bump-bonus' : 'bump');
	updateHud();
}

function endGame(reason, won = false) {
	stopLoop();
	draw();
	updateHud();
	els.overlayTitle.textContent = won ? 'Перемога!' : 'Гра закінчилась';
	els.overlayReason.textContent = reason;
	els.finalScore.textContent = String(game.score);
	els.finalDifficulty.textContent = `· ${DIFFICULTIES[game.difficulty].label}`;
	els.newRecord.hidden = !recordBeaten;

	const canSubmit = Boolean(ticket) && game.score > 0;
	els.submitForm.hidden = !canSubmit;
	els.btnSubmit.disabled = false;
	els.playerName.value = settings.playerName;
	els.submitStatus.textContent =
		!api.enabled || game.score === 0 ? ''
		: ticket ? ''
		: 'Ця гра була без рейтингу (немає зв’язку з сервером), тож у таблицю вона не потрапить.';
	els.submitStatus.className = 'submit-status';
	els.restoreInline.hidden = true;
	els.restoreInlineCode.value = '';

	els.overlay.hidden = false;
	(canSubmit && !settings.playerName ? els.playerName : els.btnRestart).focus();
}

function closeOverlay() {
	els.overlay.hidden = true;
}

async function submitScore() {
	const name = els.playerName.value.trim();
	settings.playerName = name;
	saveSettings(settings);
	els.btnSubmit.disabled = true;
	els.restoreInline.hidden = true;
	els.submitStatus.className = 'submit-status';
	els.submitStatus.textContent = 'Перевіряємо гру на сервері…';
	try {
		const res = await api.submit({
			token: ticket.token,
			name,
			key: playerCode,
			inputs: recorder.inputs,
			endTick: game.ticks,
			score: game.score,
		});
		lastSubmittedId = res.id;
		ticket = null; // used
		els.submitForm.hidden = true;
		els.submitStatus.classList.add('ok');
		els.submitStatus.textContent = submitResultText(res, DIFFICULTIES[game.difficulty].label);
		showBoard(game.difficulty);
		els.btnRestart.focus();
	} catch (e) {
		els.btnSubmit.disabled = e.code === 'already-submitted';
		els.submitStatus.classList.add('error');
		els.submitStatus.textContent = errorText(e.code);
		if (e.code === 'name-taken') els.restoreInline.hidden = false;
	}
}

// --- Player code ------------------------------------------------------------------------

function useCode(text, statusEl) {
	const code = parsePlayerCode(text);
	const say = (msg, kind) => { statusEl.textContent = msg; statusEl.className = `${statusEl.classList[0]} ${kind}`; };
	if (!code) { say('Це не схоже на код гравця: скопіюйте його повністю.', 'error'); return false; }
	if (code === playerCode) { say('Це вже код цього пристрою.', 'error'); return false; }
	playerCode = code;
	savePlayerCode(code);
	els.playerCodeValue.value = code;
	say('Код застосовано: ваші імена тепер доступні й на цьому пристрої.', 'ok');
	return true;
}

els.playerCode.addEventListener('toggle', () => { if (els.playerCode.open) els.playerCodeValue.value = playerCode; });
els.playerCodeValue.addEventListener('focus', () => els.playerCodeValue.select());
els.btnCopyCode.addEventListener('click', async () => {
	els.playerCodeValue.value = playerCode;
	let copied = false;
	try {
		await navigator.clipboard.writeText(playerCode);
		copied = true;
	} catch {
		els.playerCodeValue.select();
		try { copied = document.execCommand('copy'); } catch { /* not supported */ }
	}
	els.codeStatus.className = `code-status ${copied ? 'ok' : ''}`;
	els.codeStatus.textContent = copied ? 'Скопійовано. Нікому не передавайте цей код.' : 'Виділіть код і скопіюйте вручну.';
});
els.restoreForm.addEventListener('submit', (e) => {
	e.preventDefault();
	if (useCode(els.restoreCode.value, els.codeStatus)) els.restoreCode.value = '';
});
els.restoreInline.addEventListener('submit', (e) => {
	e.preventDefault();
	if (useCode(els.restoreInlineCode.value, els.submitStatus)) submitScore();
});

// --- Leaderboard panel ----------------------------------------------------------------

function buildBoardTabs() {
	for (const [value, preset] of Object.entries(DIFFICULTIES)) {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'lb-tab';
		b.setAttribute('role', 'tab');
		b.dataset.difficulty = value;
		b.textContent = preset.label;
		clickThenBlur(b, () => showBoard(value));
		els.lbTabs.append(b);
	}
}

let boardRequest = 0;
async function showBoard(difficulty) {
	boardDifficulty = difficulty;
	for (const tab of els.lbTabs.children) {
		const active = tab.dataset.difficulty === difficulty;
		tab.classList.toggle('active', active);
		tab.setAttribute('aria-selected', String(active));
	}
	if (!api.enabled) {
		els.lbList.replaceChildren();
		els.lbStatus.textContent = 'Онлайн-таблиця не підключена. Ваш рекорд на цьому пристрої: ' + (bestScores[difficulty] ?? 0) + '.';
		return;
	}
	const req = ++boardRequest;
	els.lbStatus.textContent = 'Завантаження…';
	try {
		const entries = await api.top(difficulty);
		if (req !== boardRequest) return;
		renderBoard(entries);
		els.lbStatus.textContent = entries.length ? '' : 'Ще ніхто не грав на цьому рівні. Будьте першими!';
	} catch {
		if (req !== boardRequest) return;
		els.lbList.replaceChildren();
		els.lbStatus.textContent = 'Не вдалося завантажити таблицю. Перевірте з’єднання.';
	}
}

function renderBoard(entries) {
	els.lbList.replaceChildren(...entries.map((e, i) => {
		const li = document.createElement('li');
		if (isOwnEntry(e, { lastId: lastSubmittedId, playerName: settings.playerName })) li.className = 'mine';
		const place = document.createElement('span');
		place.className = 'lb-place';
		place.textContent = String(i + 1);
		const name = document.createElement('span');
		name.className = 'lb-name';
		name.textContent = e.name; // textContent: names are user input
		const score = document.createElement('span');
		score.className = 'lb-score';
		score.textContent = String(e.score);
		li.append(place, name, score);
		return li;
	}));
}

// --- Actions ------------------------------------------------------------------------

function resume() {
	if (game.status === 'paused') togglePause(game);
	if (game.status === 'ready') start(game);
	if (game.status === 'running') startLoop();
	updateHud();
}

function onAction(action) {
	const s = game.status;
	if (action === 'restart') {
		if (s === 'ready') resume();
		else newGame();
		return;
	}
	if (action === 'pause') {
		if (s === 'over' || s === 'won') newGame();
		else if (s === 'running') { togglePause(game); stopLoop(); updateHud(); }
		else resume();
		return;
	}
	// Direction
	if (s === 'over' || s === 'won') return;
	if (queueDirection(game, action)) recorder.record(game, action);
	if (s === 'ready' || s === 'paused') resume();
}

bindKeyboard(onAction);
bindSwipe(els.boardWrap, onAction); // the whole board area, including the status pill
bindButtons(els.dpad, onAction);

els.boardStatus.addEventListener('click', () => resume());

// Mouse clicks shouldn't leave focus on buttons (Space would re-click them).
const clickThenBlur = (el, fn) => el.addEventListener('click', (e) => { fn(); if (e.detail > 0) el.blur(); });
clickThenBlur(els.btnNew, newGame);
clickThenBlur(els.btnPause, () => onAction('pause'));
els.btnRestart.addEventListener('click', newGame);
els.btnClose.addEventListener('click', closeOverlay);
els.submitForm.addEventListener('submit', (e) => { e.preventDefault(); submitScore(); });
els.overlay.addEventListener('keydown', (e) => {
	if (e.key === 'Escape') { e.stopPropagation(); closeOverlay(); }
});

function autoPause() {
	if (pause(game)) {
		stopLoop();
		updateHud();
	}
}
document.addEventListener('visibilitychange', () => { if (document.hidden) autoPause(); });
// Rotating the device reflows the whole layout; don't let the snake run blind meanwhile.
if (isTouch) onRotate(autoPause); // on desktop this would fire on window resizes

if (isTouch && fullscreenSupported()) {
	els.btnFullscreen.hidden = false;
	els.btnFullscreen.addEventListener('click', () => { toggleFullscreen(); els.btnFullscreen.blur(); });
	onFullscreenChange((on) => {
		els.btnFullscreen.setAttribute('aria-label', on ? 'Вийти з повноекранного режиму' : 'На весь екран');
		els.btnFullscreen.title = els.btnFullscreen.getAttribute('aria-label');
		els.btnFullscreen.classList.toggle('active', on);
	});
}

registerServiceWorker();

buildThemePicker();
buildDifficultyPicker();
buildBoardTabs();
renderer.markNow();
setInterval(() => renderer.markNow(), 30_000);
newGame();
showBoard(boardDifficulty);
