-- Drop the optimised_distance_km column from tasks.
-- Distance is now computed on the fly from turnpoints using the shared task-engine.
ALTER TABLE tasks DROP COLUMN optimised_distance_km;
