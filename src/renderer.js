// DOM rendering. The board is built once; each frame only changed cells are touched.
import { DAY_NAMES, DAY_SHORT } from './config.js';

const pad = (n) => String(n).padStart(2, '0');

export function createRenderer(boardEl, { cols, rows }) {
	boardEl.style.setProperty('--cols', String(cols));
	boardEl.replaceChildren();

	const corner = document.createElement('div');
	corner.className = 'corner';
	corner.textContent = 'Часові проміжки';
	boardEl.append(corner);

	const hourEls = [];
	for (let h = 0; h < cols; h++) {
		const el = document.createElement('div');
		el.className = 'hour' + (h === 0 ? ' first-col' : h % 3 === 0 ? ' col-div' : '');
		el.textContent = `${pad(h)}-${pad((h + 1) % 24)}`;
		boardEl.append(el);
		hourEls.push(el);
	}

	const dayEls = [];
	const cells = [];
	const baseClass = [];
	for (let y = 0; y < rows; y++) {
		const day = document.createElement('div');
		day.className = 'day' + (y === 0 ? ' first-row' : '');
		day.innerHTML = '<span class="day-full"></span><span class="day-short" aria-hidden="true"></span>';
		day.firstChild.textContent = DAY_NAMES[y] ?? '';
		day.lastChild.textContent = DAY_SHORT[y] ?? '';
		boardEl.append(day);
		dayEls.push(day);

		for (let x = 0; x < cols; x++) {
			const cell = document.createElement('div');
			let cls = 'cell';
			if (x === 0) cls += ' first-col';
			else if (x % 3 === 0) cls += ' col-div';
			if (y === 0) cls += ' first-row';
			cell.className = cls;
			cell.setAttribute('aria-hidden', 'true');
			boardEl.append(cell);
			cells.push(cell);
			baseClass.push(cls);
		}
	}

	let prev = new Array(cells.length).fill(null);

	return {
		render(map) {
			for (let i = 0; i < cells.length; i++) {
				if (map[i] === prev[i]) continue;
				cells[i].className = map[i] ? `${baseClass[i]} ${map[i]}` : baseClass[i];
			}
			prev = map;
		},
		/** Highlight today's row label and the current hour column. */
		markNow(date = new Date()) {
			const today = (date.getDay() + 6) % 7; // Monday = 0
			const hour = date.getHours();
			dayEls.forEach((el, i) => el.classList.toggle('today', i === today));
			hourEls.forEach((el, i) => el.classList.toggle('now', i === hour));
		},
	};
}
