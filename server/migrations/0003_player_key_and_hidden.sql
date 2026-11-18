-- Non-destructive: adds columns, keeps every existing run.
--  * player_key: case-insensitive player identity, so the board shows one (best) row per player.
--  * hidden: moderation flag; hidden runs stay stored but are left off the board.

ALTER TABLE scores ADD COLUMN player_key TEXT NOT NULL DEFAULT '';
ALTER TABLE scores ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

-- Backfill. SQLite lower() only folds ASCII, so Cyrillic capitals (incl. Ґ, Є, І, Ї) are folded
-- with replace() to match the Worker, which uses JS toLowerCase() for new rows.
UPDATE scores SET player_key = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(trim(name)), 'Ѐ', 'ѐ'), 'Ё', 'ё'), 'Ђ', 'ђ'), 'Ѓ', 'ѓ'), 'Є', 'є'), 'Ѕ', 'ѕ'), 'І', 'і'), 'Ї', 'ї'), 'Ј', 'ј'), 'Љ', 'љ'), 'Њ', 'њ'), 'Ћ', 'ћ'), 'Ќ', 'ќ'), 'Ѝ', 'ѝ'), 'Ў', 'ў'), 'Џ', 'џ'), 'А', 'а'), 'Б', 'б'), 'В', 'в'), 'Г', 'г'), 'Д', 'д'), 'Е', 'е'), 'Ж', 'ж'), 'З', 'з'), 'И', 'и'), 'Й', 'й'), 'К', 'к'), 'Л', 'л'), 'М', 'м'), 'Н', 'н'), 'О', 'о'), 'П', 'п'), 'Р', 'р'), 'С', 'с'), 'Т', 'т'), 'У', 'у'), 'Ф', 'ф'), 'Х', 'х'), 'Ц', 'ц'), 'Ч', 'ч'), 'Ш', 'ш'), 'Щ', 'щ'), 'Ъ', 'ъ'), 'Ы', 'ы'), 'Ь', 'ь'), 'Э', 'э'), 'Ю', 'ю'), 'Я', 'я'), 'Ґ', 'ґ');

-- Hide names that look like app output (the Worker now rejects these for new runs).
UPDATE scores SET hidden = 1
WHERE lower(trim(name)) IN ('null', 'none', 'nil', 'undefined', 'nan', 'empty', 'unknown', 'admin', 'administrator', 'system', 'root', 'moderator')
   OR lower(trim(name)) LIKE 'error%'
   OR lower(trim(name)) LIKE 'exception%';

CREATE INDEX IF NOT EXISTS idx_scores_player_best ON scores (difficulty, hidden, player_key, score DESC, ticks ASC, created_at ASC);
