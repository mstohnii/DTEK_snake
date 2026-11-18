export const COLS = 24; // hours
export const ROWS = 7; // days

// Max queued turns between ticks (lets fast players chain two turns).
export const INPUT_BUFFER = 2;

// Outage blocks (permanent obstacles) are 3 hours long, aligned to the 3-hour dividers.
export const OUTAGE_LENGTH = 3;
export const OUTAGE_MAX_BLOCKS = 8;
// Nothing hostile (outages, temporary walls) spawns closer than this to the head.
export const SAFE_DISTANCE = 4;

export const BONUS_CHANCE = 0.2;
export const BONUS_POINTS = 3;
export const BONUS_BLINK_TICKS = 8;

/**
 * Difficulty presets. Everything that changes the rules lives here, so the
 * server can replay a run with exactly the same rules as the browser.
 *
 * - speed:     tick length = min + (base - min) * decay^eaten
 * - wrap:      snake passes through the board edge
 * - outageEvery: a permanent 3-hour outage block appears every N items (0 = never)
 * - tempWalls: short walls that blink as a warning, turn solid, then vanish
 * - foodPicks: candidates sampled for each new item; the hardest one wins (1 = random)
 */
export const DIFFICULTIES = Object.freeze({
	easy: Object.freeze({
		label: 'Легкий',
		speed: { base: 260, min: 120, decay: 0.96 },
		wrap: true,
		outageEvery: 0,
		tempWalls: null,
		foodPicks: 1,
		bonusTtl: 40,
	}),
	normal: Object.freeze({
		label: 'Звичайний',
		speed: { base: 240, min: 75, decay: 0.93 },
		wrap: false,
		outageEvery: 0,
		tempWalls: null,
		foodPicks: 1,
		bonusTtl: 30,
	}),
	hard: Object.freeze({
		label: 'Складний',
		speed: { base: 210, min: 65, decay: 0.92 },
		wrap: false,
		outageEvery: 5,
		tempWalls: { every: 55, warn: 12, life: 45, minLen: 2, maxLen: 4, max: 2 },
		foodPicks: 3,
		bonusTtl: 25,
	}),
	insane: Object.freeze({
		label: 'Пекельний',
		speed: { base: 180, min: 55, decay: 0.91 },
		wrap: false,
		outageEvery: 3,
		tempWalls: { every: 30, warn: 10, life: 70, minLen: 3, maxLen: 5, max: 4 },
		foodPicks: 6,
		bonusTtl: 20,
	}),
});

export const DEFAULT_DIFFICULTY = 'normal';

export const THEMES = Object.freeze({
	auto: 'Авто',
	light: 'Світла',
	dark: 'Темна',
	blackout: 'Блекаут',
	lcd: 'Ретро LCD',
	contrast: 'Висока контрастність',
});

export const DAY_NAMES = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота', 'Неділя'];
export const DAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
