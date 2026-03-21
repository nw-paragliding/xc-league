-- Add pilot equipment fields to users table
ALTER TABLE users ADD COLUMN wind_rating       TEXT;   -- A, B, C, D, CCC
ALTER TABLE users ADD COLUMN glider_manufacturer TEXT;
ALTER TABLE users ADD COLUMN glider_model        TEXT;
