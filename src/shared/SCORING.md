# XC League Scoring

## Overview

Scoring is based on a simplified GAP (Glide And Aim for Paragliding) model with no task validity, no leading points, and no arrival points. Every task is normalized so the winner scores **1000 points**.

---

## Components

### Distance/Time Split (FAI S7F §11)

The 1000 raw points available on a task are split between distance and time by the task's goal ratio:

```
GoalRatio      = pilots with ≥ 1 goal-reaching attempt / pilots with ≥ 1 attempt
DistanceWeight = 0.9 − 1.665·GR + 1.713·GR² − 0.587·GR³
TimeWeight     = 1 − DistanceWeight

availableDistancePoints = DistanceWeight × 1000
availableTimePoints     = TimeWeight × 1000
```

Full FAI PG carves only a LeadingTimeRatio share (default 26%) out of the `1 − DistanceWeight` remainder — arrival points are always 0 for paragliding, and at GR = 0 FAI gives leading the *entire* remainder (FAI PG time weight is 0 there). Because leading points are deliberately dropped here, **time absorbs the full remainder**, which makes this deviation largest at low goal ratios. Reference points: GR = 0 → 900/100, GR = 0.5 → 422.375/577.625, GR = 1 → 361/639.

### Distance Points

Every pilot who crosses the SSS receives distance points.

| Pilot | Formula |
|---|---|
| Reached goal | `availableDistancePoints` |
| Did not reach goal | `availableDistancePoints × √(dist / bestDist)` |

- `dist` — the pilot's best distance along the optimal route from SSS to goal
- `bestDist` — the furthest distance flown by any pilot on the task (= task distance if anyone reached goal)

The square root curve is a **deliberate departure from FAI S7F §12.1**, which prescribes purely
linear distance points for paragliding (`dist / bestDist`). The sqrt curve compresses the top and
stretches the bottom, giving meaningful separation among non-goal pilots in the small async fields
this league flies — a 30 km flight against a 60 km best scores 70.7% of the distance pool here
versus 50% under FAI linear.

### Time Points

Only goal pilots receive time points. The curve is the FAI Sporting Code S7F §12.2 formula:

```
SpeedFraction = max(0, 1 - ((t − t_best) / √t_best)^(5/6))
timePoints    = availableTimePoints × SpeedFraction
```

- `t` — this pilot's task time **in hours** (ESS crossing if the task has an ESS, else goal crossing, measured from the SSS crossing)
- `t_best` — the fastest task time among pilots who reached goal, in hours

The cutoff is absolute, anchored to the winner: a pilot scores zero time points only when
their time is at or beyond `t_best + √t_best` (e.g. best time 1h → zero at 2h; best time
4h → zero at 6h). A sole finisher is their own `t_best` and scores the full available time pool.

Because this is an **async league**, `t_best` pools task times across different flying days and
conditions — FAI GAP assumes a single race day. This is inherent to the format: the fastest time
flown at any point in the task window anchors everyone's time points.

Non-goal pilots receive **0 time points**.

### Total (raw)

```
totalPoints = distancePoints + timePoints
```

For the fastest goal pilot this is `availableDistancePoints + availableTimePoints = 1000` before normalization.

---

## Normalization

After scoring, all scores are scaled so the highest-scoring pilot gets exactly **1000 points**.
Rounding to one decimal happens exactly once, on the scaled values:

```
scale           = 1000 / winnerRawTotal        (raw totals kept at full precision)
distancePoints  = round1(rawDistance × scale)
timePoints      = round1(rawTime × scale)
totalPoints     = round1(distancePoints + timePoints)
```

This means:
- The winner always scores 1000 regardless of how many pilots flew or whether anyone reached goal.
- Relative gaps between pilots are preserved.
- **Caveat (deliberate, non-FAI):** normalization erases absolute task quality. A 5 km scratch-fest
  where nobody leaves the hill and a 100 km epic both award the winner 1000. FAI task validity
  (chapter 10) would scale these differently; this league drops validity and instead lets admins
  weight tasks manually via `normalized_score`.

A custom `normalized_score` can be set per task to override the default 1000 cap. Editing it
rebuilds the task's results immediately.

---

## When Nobody Reaches Goal

If no pilot crosses the ESS/goal:
- All pilots receive distance points only (no time points).
- The goal ratio is 0, so the distance pool is `0.9 × 1000 = 900` raw points.
- The furthest pilot gets `900 × √(bestDist/bestDist) = 900` before normalization, which
  normalizes to **1000**.
- Everyone else scales down from there.

---

## Standings

The season standings sum each pilot's best result per task. If a pilot has multiple submissions for the same task (re-flies), only the highest-scoring attempt counts.

Pilots are ranked by total points descending. Within a task, pilots with equal (rounded) totals
share a rank (competition ranking: 1, 1, 3); season standings have no tie-break.

---

## Rescoring

The entire task rescores every time a result is submitted or deleted while the task is open —
`task_results` is rebuilt from scratch from the stored attempts. A new submission can move any of
the shared inputs, and with them everyone's points:

- `t_best` — someone submits a faster goal time → every goal pilot's time points drop.
- `bestDist` — someone flies further → every non-goal pilot's distance points shrink.
- The goal ratio — a new pilot in goal (or a new non-goal pilot) shifts the §11 distance/time
  split for the whole field.
- The normalization scale — any change to the winner's raw total rescales everyone.

There is no separate freeze step: submissions are only accepted while `now < close_date`, so
scores settle naturally once the task closes. (An earlier `scores_frozen_at` mechanism was removed
in migration 0013.) Scores can still change after close if an admin deletes a submission or edits
the task's `normalized_score` — both trigger a rebuild.
