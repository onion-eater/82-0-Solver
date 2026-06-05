# Solver Algorithm

This document describes the scoring and solver behavior implemented by the
extension. The UI runs Standard scoring only.

## Source Contracts

- Roster slots are `PG`, `SG`, `SF`, `PF`, `C`.
- A player can be assigned to any slot in `player.positions`.
- Duplicate real players are disallowed by `baseSlug`.
- A player already on the roster may be moved to another eligible slot if that
  makes a new pick legal.
- Team and era switches can reroll to the current team or era, so self-rerolls
  are included in expectation calculations.

## Standard Scoring

Final team OVR:

```text
100 * (
  totalPPG / 133.4 * 0.46 +
  totalRPG / 39.7  * 0.25 +
  totalAPG / 29.3  * 0.18 +
  adjustedSPG / 6.1 * 0.07 +
  adjustedBPG / 3.2 * 0.04
)
```

Defensive stat adjustment:

```text
adjustedSPG = sum(non-null and > 0 SPG) * 5 / count(non-null and > 0 SPG)
adjustedBPG = sum(non-null and > 0 BPG) * 5 / count(non-null and > 0 BPG)
```

Wins:

```text
wins = round(82 * min(teamOvr / 110, 1) ^ 1.15)
```

The 82-0 goal is considered successful when `teamOvr >= 110`.

## Adjusted Helpers

`solver-core.js` still contains adjusted player-rating helpers for parity checks
and static lineup experiments. The extension overlay does not expose adjusted
mode.

Adjusted player OVR:

1. Select era baselines from `ERA_BASELINES`.
2. Select stat weights from the player's first listed position.
3. If SPG/BPG are missing, remove those weights and renormalize the remaining
   weights.
4. Compute stat ratios; above-baseline ratios use exponent `1.25`.
5. Convert to `60 + 40 * weighted_ratio_sum`.
6. Add extra-position and legacy-player bonuses.
7. Cap at `100` and round to one decimal.

Adjusted team OVR:

```text
teamOvr = round(1.1 * geometric_mean(player_ratings), 1)
wins = round(82 * min(teamOvr / 110, 1) ^ 2.2)
```

## EV Model

State:

```text
roster by slot
currentTeam
currentEra
teamSwitchUsed
eraSwitchUsed
```

Actions:

```text
pick legal player from current team/era
use team switch if unused
use era switch if unused
```

Transition:

- Pick: apply the roster assignment. If the roster is incomplete, average over
  every future live `team|era` roll.
- Team switch: average over every live team for the current era.
- Era switch: average over every live era for the current team.
- Terminal: score the completed roster.

The exact recurrence is:

```text
V(state) = max_action E[V(next_state)]
```

## Runtime Strategy

The full opening-game tree is too large for a browser button, so the extension
uses different methods by roster size.

First player:

- If the roster has `0` filled slots and both switches are unused, the extension
  uses `data/precomputed-depth2-standard-82.json` for the 82-0 estimate.
- This is keyed by current `team|era`, not by roll number.

Early game:

- With `0-2` filled slots, runtime uses a greedy all-combo tail estimate.
- The root evaluates a small top-candidate set for responsiveness.
- The result is marked as a greedy estimate, not exact.

Late game:

- With `3-4` filled slots, runtime uses exact DP for the remaining picks.
- Before exact late-game search completes, the worker emits a greedy interim
  recommendation and then updates the searched-state count about once per
  second.
- It handles player movement, duplicate `baseSlug` blocking, switches, and
  self-rerolls.

Terminal:

- With `5` filled slots, the roster is scored directly.

The worker reports separate recommendations for max expected OVR and for making
82-0 because those actions can differ.
