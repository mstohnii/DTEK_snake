(() => {
	// Config
	const COLS = 24; // hours
	const ROWS = 7;  // days
	const BASE_TICK_MS = 240; // start slower
	const MIN_TICK_MS = 70;   // don't go faster than this
	const HIGHLIGHT_ROW = 2; // 0=Mon ... 2=Wed like screenshot

	// DOM
	const gridEl = document.getElementById('grid');
	const hoursHeaderEl = document.getElementById('hours-header');
	const daysHeaderEl = document.getElementById('days-header');
	const scoreEl = document.getElementById('score');
	const bestScoreEl = document.getElementById('best-score');
	const overlayEl = document.getElementById('overlay');
	const finalScoreEl = document.getElementById('final-score');
	const overlayTitleEl = document.getElementById('overlay-title');
	const overlayMsgEl = document.getElementById('overlay-msg');
	const btnNew = document.getElementById('btn-new');
	const btnPause = document.getElementById('btn-pause');
	const btnRestart = document.getElementById('btn-restart');
	const btnClose = document.getElementById('btn-close');

	// State
	let snake = [];
	let dir = { x: 1, y: 0 };
	let nextDir = { x: 1, y: 0 };
	let food = null;
	let score = 0;
	let bestScore = 0;
	let playing = false;
	let paused = false;
	let rafId = null;
	let lastTick = 0;

	// Helpers
	const idx = (x, y) => y * COLS + x;
	const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
	const getTickMs = () => Math.max(MIN_TICK_MS, BASE_TICK_MS - score * 12);
	function syncSquares() {
		// Make rows match the first cell width to enforce perfect squares
		const firstCell = gridEl.firstElementChild;
		if (!firstCell) return;
		const w = firstCell.getBoundingClientRect().width || 0;
		if (w <= 0) return;
		gridEl.style.gridTemplateRows = `repeat(${ROWS}, ${w}px)`;
		for (const day of daysHeaderEl.children) {
			day.style.height = w + 'px';
			day.style.lineHeight = w + 'px';
		}
	}

	// Build headers
	function buildHeaders() {
		hoursHeaderEl.innerHTML = '';
		for (let h = 0; h < COLS; h++) {
			const el = document.createElement('div');
			el.className = 'hour';
			const start = String(h).padStart(2, '0');
			const end = String((h + 1) % 24).padStart(2, '0');
			el.textContent = `${start}-${end}`;
			hoursHeaderEl.appendChild(el);
		}
		daysHeaderEl.innerHTML = '';
		const dayNames = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота', 'Неділя'];
		for (let d = 0; d < ROWS; d++) {
			const el = document.createElement('div');
			el.className = 'day' + (d === HIGHLIGHT_ROW ? ' highlight' : '');
			el.textContent = dayNames[d];
			daysHeaderEl.appendChild(el);
		}
		// ensure initial heights align once grid exists
		requestAnimationFrame(syncSquares);
	}

	// Build grid cells
	function buildGrid() {
		gridEl.innerHTML = '';
		for (let y = 0; y < ROWS; y++) {
			for (let x = 0; x < COLS; x++) {
				const cell = document.createElement('div');
				const classes = ['cell', ((x + y) % 2 ? 'pattern-on' : 'pattern-off')];
				if (x % 3 === 0 && x !== 0) classes.push('col-div'); // thicker divider each 3 hours
				cell.className = classes.join(' ');
				if (y === ROWS - 1) cell.classList.add('cell-row-end');
				gridEl.appendChild(cell);
			}
		}
		// After grid renders, sync day heights to square width
		requestAnimationFrame(syncSquares);
	}

	function cellAt(x, y) {
		return gridEl.children[idx(x, y)];
	}

	function resetGame() {
		score = 0;
		scoreEl.textContent = '0';
		bestScoreEl.textContent = String(bestScore);
		dir = { x: 1, y: 0 };
		nextDir = { x: 1, y: 0 };
		const startX = 4;
		const startY = 3;
		snake = [
			{ x: startX, y: startY },
			{ x: startX - 1, y: startY },
			{ x: startX - 2, y: startY }
		];
		// Clear visuals
		for (const child of gridEl.children) {
			child.innerHTML = '';
		}
		placeFood();
		drawSnake();
	}

	function drawSnake() {
		// Clear
		for (const child of gridEl.children) {
			// Remove dynamic children
			while (child.firstChild) child.removeChild(child.firstChild);
		}
		// Draw food
		if (food) {
			const f = document.createElement('div');
			f.className = 'food';
			const icon = document.createElement('div');
			icon.className = 'tile-icon';
			f.appendChild(icon);
			cellAt(food.x, food.y).appendChild(f);
		}
		// Draw snake
		for (let i = 0; i < snake.length; i++) {
			const seg = snake[i];
			const el = document.createElement('div');
			el.className = 'segment' + (i === 0 ? ' head' : '');
			const icon = document.createElement('div');
			icon.className = 'tile-icon';
			el.appendChild(icon);
			cellAt(seg.x, seg.y).appendChild(el);
		}
	}

	function randomEmptyCell() {
		const all = [];
		for (let y = 0; y < ROWS; y++) {
			for (let x = 0; x < COLS; x++) {
				all.push({ x, y });
			}
		}
		const snakeSet = new Set(snake.map(s => `${s.x},${s.y}`));
		const empties = all.filter(p => !snakeSet.has(`${p.x},${p.y}`));
		if (empties.length === 0) return null;
		return empties[Math.floor(Math.random() * empties.length)];
	}

	function placeFood() {
		food = randomEmptyCell();
		if (!food) {
			endGame(true);
		}
	}

	function setDir(nx, ny) {
		// Prevent reversing directly
		if (nx === -dir.x && ny === -dir.y) return;
		nextDir = { x: nx, y: ny };
	}

	function step() {
		dir = nextDir;
		const head = snake[0];
		const nx = head.x + dir.x;
		const ny = head.y + dir.y;

		// Collision: walls
		if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) {
			endGame(false);
			return;
		}
		// Collision: self
		for (let i = 0; i < snake.length; i++) {
			if (snake[i].x === nx && snake[i].y === ny) {
				endGame(false);
				return;
			}
		}
		// Move
		snake.unshift({ x: nx, y: ny });
		// Eat
		if (food && nx === food.x && ny === food.y) {
			score += 1;
			scoreEl.textContent = String(score);
			// Update best score immediately to feel responsive
			if (score > bestScore) {
				bestScore = score;
				bestScoreEl.textContent = String(bestScore);
				try { localStorage.setItem('dtek_snake_best', String(bestScore)); } catch {}
			}
			placeFood();
		} else {
			snake.pop();
		}
		drawSnake();
	}

	function gameLoop(ts) {
		if (!playing || paused) return;
		if (ts - lastTick >= getTickMs()) {
			lastTick = ts;
			step();
		}
		rafId = requestAnimationFrame(gameLoop);
	}

	function startGame() {
		resetGame();
		playing = true;
		paused = false;
		lastTick = 0;
		cancelAnimationFrame(rafId);
		rafId = requestAnimationFrame(gameLoop);
		btnPause.textContent = 'Pause';
		overlayEl.hidden = true;
	}

	function pauseGame() {
		if (!playing) return;
		paused = !paused;
		if (!paused) {
			lastTick = 0;
			cancelAnimationFrame(rafId);
			rafId = requestAnimationFrame(gameLoop);
			btnPause.textContent = 'Pause';
		} else {
			btnPause.textContent = 'Resume';
		}
	}

	function endGame(win) {
		playing = false;
		cancelAnimationFrame(rafId);
		finalScoreEl.textContent = String(score);
		overlayTitleEl.textContent = win ? 'Ви заповнили сітку!' : 'Гра закінчилась';
		overlayMsgEl.innerHTML = `Ваш рахунок: <strong id="final-score">${score}</strong>`;
		overlayEl.hidden = false;
	}

	// Input: keyboard
	window.addEventListener('keydown', (e) => {
		const code = e.code;
		const k = e.key;
		// Support browsers that localize `code` (e.g., 'KeyЦ', 'KeyФ', etc.)
		const isUp    = code === 'ArrowUp'   || code === 'KeyW' || code === 'KeyЦ' || k === 'w' || k === 'W' || k === 'ц' || k === 'Ц';
		const isDown  = code === 'ArrowDown' || code === 'KeyS' || code === 'KeyІ' || code === 'KeyЫ' || k === 's' || k === 'S' || k === 'і' || k === 'І' || k === 'ы' || k === 'Ы';
		const isLeft  = code === 'ArrowLeft' || code === 'KeyA' || code === 'KeyФ' || k === 'a' || k === 'A' || k === 'ф' || k === 'Ф';
		const isRight = code === 'ArrowRight'|| code === 'KeyD' || code === 'KeyВ' || k === 'd' || k === 'D' || k === 'в' || k === 'В';
		const isPause = code === 'Space' || k === ' ';

		if (isUp) {
			e.preventDefault(); setDir(0, -1);
		} else if (isDown) {
			e.preventDefault(); setDir(0, 1);
		} else if (isLeft) {
			e.preventDefault(); setDir(-1, 0);
		} else if (isRight) {
			e.preventDefault(); setDir(1, 0);
		} else if (isPause) {
			e.preventDefault(); pauseGame();
		}
	});

	// Input: swipe
	let touchStart = null;
	gridEl.addEventListener('touchstart', (e) => {
		const t = e.changedTouches[0];
		touchStart = { x: t.clientX, y: t.clientY };
	}, { passive: true });
	gridEl.addEventListener('touchend', (e) => {
		if (!touchStart) return;
		const t = e.changedTouches[0];
		const dx = t.clientX - touchStart.x;
		const dy = t.clientY - touchStart.y;
		const adx = Math.abs(dx), ady = Math.abs(dy);
		if (adx > 24 || ady > 24) {
			if (adx > ady) {
				setDir(dx > 0 ? 1 : -1, 0);
			} else {
				setDir(0, dy > 0 ? 1 : -1);
			}
		}
		touchStart = null;
	}, { passive: true });

	// Buttons
	btnNew.addEventListener('click', startGame);
	btnRestart.addEventListener('click', startGame);
	btnPause.addEventListener('click', pauseGame);
	btnClose.addEventListener('click', () => {
		overlayEl.hidden = true;
	});

	// Init
	try {
		const saved = parseInt(localStorage.getItem('dtek_snake_best') || '0', 10);
		if (!Number.isNaN(saved)) bestScore = saved;
	} catch {}
	buildHeaders();
	buildGrid();
	resetGame();
	window.addEventListener('resize', syncSquares);
})();