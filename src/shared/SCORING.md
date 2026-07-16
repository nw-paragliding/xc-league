# XC League Scoring

## Overview

Scoring is based on a simplified GAP (Glide And Aim for Paragliding) model with no task validity, no leading points, and no arrival points. Every task is normalized so the winner scores **1000 points**.

---

## Components

### Distance Points

Every pilot who crosses the SSS receives distance points.

| Pilot | Formula |
|---|---|
| Reached goal | `1000` |
| Did not reach goal | `1000 × √(dist / bestDist)` |

- `dist` — the pilot's best distance along the optimal route from SSS to goal
- `bestDist` — the furthest distance flown by any pilot on the task (= task distance if anyone reached goal)

The square root curve rewards pilots who fly further but does not linearly scale, providing some separation among non-goal pilots.

### Time Points

Only goal pilots receive time points. The curve is the FAI Sporting Code S7F §12.2 formula:

```
SpeedFraction = max(0, 1 - ((t − t_best) / √t_best)^(5/6))
timePoints    = 1000 × SpeedFraction
```

- `t` — this pilot's task time **in hours** (ESS crossing if the task has an ESS, else goal crossing, measured from the SSS crossing)
- `t_best` — the fastest task time among pilots who reached goal, in hours

The cutoff is absolute, anchored to the winner: a pilot scores zero time points only when
their time is at or beyond `t_best + √t_best` (e.g. best time 1h → zero at 2h; best time
4h → zero at 6h). A sole finisher is their own `t_best` and scores the full 1000.

Non-goal pilots receive **0 time points**.

### Total (raw)

```
totalPoints = distancePoints + timePoints
```

For the fastest goal pilot this is `1000 + 1000 = 2000` before normalization.

---

## Normalization

After scoring, all scores are scaled so the highest-scoring pilot gets exactly **1000 points**:

```
scale = 1000 / winnerTotal
finalPoints = round(rawPoints × scale)
```

This means:
- The winner always scores 1000 regardless of how many pilots flew or whether anyone reached goal.
- Relative gaps between pilots are preserved.
- Tasks with only distance scoring (no goal finishers) and tasks with both distance + time scoring are comparable on the same 0–1000 scale.

A custom `normalized_score` can be set per task to override the default 1000 cap.

---

## When Nobody Reaches Goal

If no pilot crosses the ESS/goal:
- All pilots receive distance points only (no time points).
- The furthest pilot gets `1000 × √(bestDist/bestDist) = 1000` before normalization, which normalizes to **1000**.
- Everyone else scales down from there.

---

## Standings

The season standings sum each pilot's best result per task. If a pilot has multiple submissions for the same task (re-flies), only the highest-scoring attempt counts.

Pilots are ranked by total points descending. Tie-breaking is not currently implemented.

---

## Rescoring

Time points are recalculated every time a new result is submitted while a task is open. Because the §12.2 formula depends only on the fastest goal time, a pilot's time points change only when someone submits a *faster* goal time (shifting `t_best`); slower finishers arriving later never affect existing scores. Scores are finalized when an admin freezes the task.
