-- Capture each turnpoint's ground elevation so the pipeline can evaluate AGL
-- during the hike-and-fly ground-confirmation check. Speed alone is not enough:
-- a pilot in a headwind can hover at near-zero ground speed without landing.
-- Combining speed + AGL closes that gap.
--
-- Populated from the CUP `elev` field or the XCTSK `altSmoothed` on import.
-- Left nullable so older rows (and XCTSK files without a usable altitude)
-- keep working — classifyGroundState falls back to speed-only when unknown.

ALTER TABLE turnpoints ADD COLUMN elevation_m REAL;
