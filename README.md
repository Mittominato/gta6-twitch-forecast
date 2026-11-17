# GTA VI launch-day Twitch forecast

[![make.fun](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/c/gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Mittominato/gta6-twitch-forecast/rank.svg)](https://make.fun/c/gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Mittominato/gta6-twitch-forecast/reward.svg)](https://make.fun/c/gta6-twitch-ccu-forecast-01)

Entry for [gta6-twitch-ccu-forecast-01](https://make.fun/c/gta6-twitch-ccu-forecast-01):
forecast, hour by hour, how many people watch Grand Theft Auto VI live on
Twitch over the 24 UTC hours of its release day, 2026-11-19, from everything
recorded up to the end of the first hour. `main.ts` (Node 22, standard library
only) reads every `*.in` case in `$MAKEFUN_INPUT_DIR` (else `/input`) and
writes one `<id>.out` per case to `$MAKEFUN_OUTPUT_DIR` (else `/output`):
23 rows, hours 2–24, five quantiles each (0.05, 0.25, 0.5, 0.75, 0.95).

## Method

A launch day's hourly curve is not a random walk around hour 1. Rolling-
midnight console launches share a stable UTC-day shape — a quiet 01:00–04:00
dip, a midday lull, then a big prime-time rise — and the level of that shape
is set better by the previous evening's audience than by the 00:00 UTC
hour-1 print alone, because hour 1 is a low-traffic hour.

For each comparable past launch the program takes its log curve relative to
its own previous-evening peak (the max hourly average 20:00–23:00 UTC the day
before its release day), takes a weighted median across comparables per hour,
and re-anchors that median on this case's previous-evening peak. The spread
per hour is the cross-comparable dispersion of the same log-ratios, shrunk
by 0.7 and floored at 0.08 log units.

Comparables are weighted toward similar launches:

- tier from the unlock note: `comparable` 1.0, `early-access-contaminated`
  0.4, `weak` 0.3; the GTA VI category's own pre-release history
  (`target-history`) is never used as a launch curve;
- ×1.5 for a midnight-local rolling unlock, ×1.25 for a console-only launch;
- a Gaussian kernel (width 0.5 log units) on how close the comparable's
  previous-evening peak is in size to this case's;
- left out when hour 1 is under 2% of the comparable's own day peak (a
  simultaneous global unlock still ramping — its hour-1-normalised curve
  would be noise).

Fallbacks keep every case valid: with no previous-evening anchor the median
is taken on hour-1-normalised curves instead; with no usable comparable at
all the forecast is persistence with a widening spread. No randomness, no
clock, no network — two runs on the same inputs are byte-identical.

## Why the previous evening?

On the practice cases, anchoring on hour 1 alone scores 0.2700 (weighted
median of hour-1-normalised curves, comparables with a still-ramping hour 1
left out). Re-anchoring the same median on the previous evening's peak
scores 0.1994, and adding the size-matching kernel and the midnight/console
similarity weights brings it to 0.1617. The evening peak is a better level
because hour 1 (00:00–01:00 UTC) is a low-traffic hour while the evening
before already holds the early-region launch audience plus the hype
audience, so it tracks how big the launch day will be. The spread is
calibrated the same way: the cross-comparable dispersion, shrunk by 0.7,
lands the 90% coverage at 0.93 on practice, close to the honest 0.90.

## Practice results

Scored with the contest's pinball loss on the log scale against the
historical hourly counts (SullyGnome) for hours 2–24:

| case | game | loss | typical miss | 90% coverage |
| ---- | ---- | ---- | ------------ | ------------ |
| p00 | Marvel's Wolverine | 0.2202 | 40.4% | 0.91 |
| p01 | Red Dead Redemption 2 | 0.1475 | 26.7% | 0.96 |
| p02 | God of War Ragnarök | 0.1102 | 18.2% | 0.91 |
| p03 | Marvel's Spider-Man 2 | 0.1687 | 30.2% | 0.91 |
| **mean** | | **0.1617** | **28.9%** | **0.93** |

The house baseline scores about 0.387 on the same practice cases.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Runs in ~0.3 s for the four practice cases, far inside the 8 s per-case cap.
Each output is a single `{"hours": [...]}` object, 23 rows, hours 2–24,
quantiles non-decreasing, each above 0 and at most 1e9, file about 1.5 KB
(well under the 65,536-byte cap).

On the final case the program reads the same shape: 42 comparables (the
practice launches included) and the GTA VI category's own pre-release
history, which is excluded from the launch curves by its `target-history`
tier and only ever used as level information through the case's own
previous-evening peak.

## Files

- `main.ts` — the entrypoint.
- `LICENSE` — MIT.
- `.makefun/owner.json` — the wallet this entry belongs to.
