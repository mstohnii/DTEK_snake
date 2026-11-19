// Player identity, shared by the page and the leaderboard Worker.

// Letters from other scripts that look like Latin ones (after lowercasing), plus 0 → o.
// server/migrations/0004_players.sql folds stored keys with this same table.
export const LOOKALIKES = {
	а: 'a', в: 'b', е: 'e', ё: 'e', є: 'e', з: '3', і: 'i', ї: 'i', ј: 'j', к: 'k', м: 'm', н: 'h', о: 'o',
	п: 'n', р: 'p', с: 'c', т: 't', у: 'y', ү: 'y', х: 'x', ѕ: 's', ԁ: 'd', ь: 'b', һ: 'h', ӏ: 'l',
	α: 'a', β: 'b', γ: 'y', ε: 'e', η: 'n', ι: 'i', κ: 'k', μ: 'u', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x',
	0: 'o',
};

/**
 * Who a name belongs to: case-insensitive with lookalikes folded, so "povir", "POVIR" and
 * "роvіr" (Cyrillic р, о, і) are one player: one row on the board, one owner.
 */
export const nameKey = (name) => [...name.trim().toLowerCase()].map((c) => LOOKALIKES[c] ?? c).join('');
