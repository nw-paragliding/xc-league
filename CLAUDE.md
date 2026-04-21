# XC League — Claude Code Notes

## Scoring rules reference

The canonical source for GAP scoring rules is the FAI Sporting Code Section 7F:

**FAI Sporting Code S7F — XC Scoring 2025 v1.0**
https://www.fai.org/sites/default/files/civl/documents/sporting_code_s7_f_-_xc_scoring_2025_v1.0.pdf

Key rules relevant to this codebase:

### Cylinder crossing (§6.2.1, §9.2.1)
- Crossing direction is **irrelevant** — entry OR exit counts.
- "Enter" / "exit" designations are advisory for task setters only; pilots are not bound by them.

### Goal line observation zone (§6.2.3.1, §9.2.3)
- The goal line is perpendicular to the vector from **p** (optimised route point on the last
  control zone before goal) to **c** (goal centre). This is a **2025 change** — prior versions
  used raw turnpoint centres, not the optimised touch point.
- The line extends **l/2** from the goal centre in each direction, so the optimised route
  always bisects it symmetrically.
- The full control zone is a **D-shape**: the chord (the line) plus a semi-circle of radius r
  on the **outbound** side — "behind the goal line when coming from p" means the FAR side
  from p (the side a pilot is on *after* crossing the chord). The flat face of the D faces p.
  Both the chord and the semi-circle are part of the valid goal zone.
- Goal can be reached **from any direction** (§9.2.3). Directionality was removed for
  virtual/tracklog goals. The physical goal line (§9.2.3.1) still requires correct direction.
- Tolerance is applied separately to the straight portion and to the semi-circle (§9.1.3).

### Useful implementation references
- XCTrack observation zone XML spec: `type="line"` / `type="cylinder"`, `radius` attribute
- XCTSK v2 JSON format (QR codes): `g: { t: "LINE" }` sets goal type; `o: { r, a1: 180 }`
  per-turnpoint observation zone

## Hike-and-fly turnpoints

HAF seasons (`seasons.competition_type = 'HIKE_AND_FLY'`) support ground-only
turnpoints — a pilot must arrive on foot rather than in the air. Role
(SSS/ESS/goal/intermediate) and ground-ness are orthogonal: any role can be
ground-only.

- **Naming convention**: prefix the turnpoint name with `[GND]`
  (case-insensitive, optional leading whitespace). Example: `[GND] Summit`.
- The prefix is parsed at import time and sets `turnpoints.force_ground = 1`;
  the marker stays in the stored name so exporters round-trip it transparently.
- Ground confirmation is done by the pipeline Stage 4 speed check: a
  crossing is `ground_confirmed` when max GPS speed in a ±30s window is
  below 15 km/h. Failing that threshold adds `⚑` to the attempt's
  `hasFlaggedCrossings`.
- Stage 4 is a no-op for XC seasons, so `[GND]` on an XC task is harmless
  but also meaningless — the flag is never exercised.
