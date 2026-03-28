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

Only goal pilots receive time points.

| Condition | Formula |
|---|---|
| Sole finisher, or all goal pilots finish in the same time | `1000` |
| Otherwise | `1000 × (1 - ((t − t_min) / (t_max − t_min))^(2/3))` |

- `t` — this pilot's task time (SSS crossing → goal crossing)
- `t_min` — fastest goal time
- `t_max` — slowest goal time

The `^(2/3)` exponent gives more weight to the faster end — a pilot 50% of the way through the time spread loses much less than 500 points.

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

Time points are recalculated every time a new result is submitted while a task is open. This means a pilot's score can change when other pilots submit results that shift `t_min` or `t_max`. Scores are finalized when an admin freezes the task.
