-- Rename wind_rating to wing_rating (the EN A/B/C/D/CCC column is a paraglider
-- wing certification, not a wind rating — the original name was a typo).
ALTER TABLE users RENAME COLUMN wind_rating TO wing_rating;
