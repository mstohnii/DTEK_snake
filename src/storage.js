// Safe localStorage wrappers: storage can be missing or throw (private mode, blocked cookies).
import { DIFFICULTIES, DEFAULT_DIFFICULTY, THEMES } from './config.js';

const BEST_KEY = 'dtek_snake_best_v3';
const BEST_V2_KEY = 'dtek_snake_best_v2';
const LEGACY_BEST_KEY = 'dtek_snake_best';
export const SETTINGS_KEY = 'dtek_snake_settings';
const PLAYER_CODE_KEY = 'dtek_snake_player_code';

function read(key) {
	try { return window.localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
	try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
}
function readJson(key) {
	try { return JSON.parse(read(key) ?? 'null'); } catch { return null; }
}

/** Personal best per difficulty: { easy: 12, normal: 30, ... } */
export function loadBestScores() {
	const scores = readJson(BEST_KEY);
	if (scores && typeof scores === 'object') return scores;
	// Migrate older saves (v1 single score, v2 "walls" mode) into "normal".
	const v2 = readJson(BEST_V2_KEY);
	const legacy = parseInt(read(LEGACY_BEST_KEY) ?? '', 10);
	const normal = Math.max(Number(v2?.walls) || 0, Number.isFinite(legacy) ? legacy : 0);
	return normal > 0 ? { normal } : {};
}

export function saveBestScores(scores) {
	write(BEST_KEY, JSON.stringify(scores));
}

/** The device's player code (proves ownership of names on the leaderboard), or null. */
export function loadPlayerCode() {
	return read(PLAYER_CODE_KEY);
}

export function savePlayerCode(code) {
	write(PLAYER_CODE_KEY, code);
}

export function loadSettings() {
	const s = readJson(SETTINGS_KEY) ?? {};
	return {
		difficulty: Object.hasOwn(DIFFICULTIES, s.difficulty) ? s.difficulty : DEFAULT_DIFFICULTY,
		theme: Object.hasOwn(THEMES, s.theme) ? s.theme : 'auto',
		playerName: typeof s.playerName === 'string' ? s.playerName.slice(0, 16) : '',
	};
}

export function saveSettings(settings) {
	write(SETTINGS_KEY, JSON.stringify({
		difficulty: settings.difficulty,
		theme: settings.theme,
		playerName: settings.playerName,
	}));
}
