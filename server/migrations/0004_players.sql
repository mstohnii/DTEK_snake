-- Non-destructive: a new table, and existing runs only get their grouping key refined (names, scores untouched).
-- Name ownership. The first verified run under a name claims it for the device that sent it;
-- later runs under that name (or a lookalike of it) need the same device key.
--  * name_key: lowercase "skeleton" of the name, Cyrillic/Greek lookalikes folded to Latin.
--  * key_hash: SHA-256 of the device key; the key itself is never stored.
-- Names already on the board stay unclaimed until their next verified run.

CREATE TABLE IF NOT EXISTS players (
	name_key   TEXT PRIMARY KEY,
	name       TEXT NOT NULL,
	key_hash   TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

-- One row per player on the board: stored keys were lowercase only; fold lookalike letters too,
-- so they match src/names.js nameKey() (the same table, generated from it). Names stay as typed.
UPDATE scores SET player_key = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(player_key, '0', 'o'), 'а', 'a'), 'в', 'b'), 'е', 'e'), 'ё', 'e'), 'є', 'e'), 'з', '3'), 'і', 'i'), 'ї', 'i'), 'ј', 'j'), 'к', 'k'), 'м', 'm'), 'н', 'h'), 'о', 'o'), 'п', 'n'), 'р', 'p'), 'с', 'c'), 'т', 't'), 'у', 'y'), 'ү', 'y'), 'х', 'x'), 'ѕ', 's'), 'ԁ', 'd'), 'ь', 'b'), 'һ', 'h'), 'ӏ', 'l'), 'α', 'a'), 'β', 'b'), 'γ', 'y'), 'ε', 'e'), 'η', 'n'), 'ι', 'i'), 'κ', 'k'), 'μ', 'u'), 'ν', 'v'), 'ο', 'o'), 'ρ', 'p'), 'τ', 't'), 'υ', 'u'), 'χ', 'x');
