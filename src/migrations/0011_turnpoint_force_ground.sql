-- Make ground-ness orthogonal to turnpoint role.
-- Until now, turnpoints.type conflated role (SSS/ESS/GOAL/CYLINDER) with
-- ground-ness (GROUND_ONLY/AIR_OR_GROUND). In hike-and-fly any role can be
-- ground-constrained, so we split the axis: `type` keeps the five roles,
-- a new `force_ground` boolean captures the constraint.

ALTER TABLE turnpoints ADD COLUMN force_ground INTEGER NOT NULL DEFAULT 0;

UPDATE turnpoints SET force_ground = 1 WHERE type = 'GROUND_ONLY';

UPDATE turnpoints SET type = 'CYLINDER' WHERE type IN ('GROUND_ONLY', 'AIR_OR_GROUND');
