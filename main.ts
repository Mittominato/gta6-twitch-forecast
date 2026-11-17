// GTA VI launch-day Twitch forecast (gta6-twitch-ccu-forecast-01).
//
// Idea: a launch day's hourly curve is not a random walk around hour 1. For
// rolling-midnight console launches the UTC day has a stable shape - a quiet
// 01:00-04:00 UTC dip, a midday lull, then a big prime-time rise - and the
// level of that shape is set better by the previous evening's audience than
// by the 00:00 UTC hour-1 print alone (hour 1 is a low-traffic hour). So for
// each comparable past launch we take its log curve relative to its own
// previous-evening peak, take a weighted median across comparables per hour,
// and re-anchor that median on this case's previous-evening peak. The spread
// per hour is the cross-comparable dispersion of the same log-ratios, shrunk
// a little, so the quantiles stay honest without paying for width at every
// hour. Comparables are weighted toward similar launches: console-only
// midnight-local rollouts get a bonus, early-access-contaminated and weak
// analogues are down-weighted, and launches whose previous-evening audience
// is close in size to this case's count most. The GTA VI category's own
// pre-release history is never used as a launch curve.
//
// Node 22, standard library only, no network, no randomness, no clock: two
// runs on the same inputs are byte-identical.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

// Quantile levels the contest scores, in the order each row lists them.
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
// Standard normal quantiles at those levels.
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

// Weight of a comparable by the tier its unlock note declares.
const TIER_WEIGHT: Record<string, number> = {
  comparable: 1.0,
  "early-access-contaminated": 0.4,
  weak: 0.3,
  "target-history": 0,
};

// Bonus for a launch that unlocked at midnight local time, rolling.
const MIDNIGHT_BONUS = 1.5;
// Bonus for a console-only launch (no PC in its platform list).
const CONSOLE_BONUS = 1.25;
// Gaussian kernel width (log units) for matching previous-evening size.
const SIZE_KERNEL = 0.5;
// A comparable whose hour-1 print is below this share of its own day peak
// is still ramping (e.g. a simultaneous global unlock later in the day):
// its hour-1-normalised curve would be noise, so it is left out.
const MIN_HOUR1_SHARE = 0.02;
// Spread shrink and floor (log units) applied to the cross-comparable
// dispersion before it becomes the quantile spread.
const SPREAD_SHRINK = 0.7;
const SPREAD_FLOOR = 0.08;
// The previous-evening window: the hourly points from 4 h to 1 h before
// the release day starts (20:00-23:00 UTC the day before). Hour indices
// here are 1-based on day start, so the [23:00, 00:00) hour is index 0
// and [20:00, 21:00) is index -3.
const PRE_WINDOW_START_H = -3;
const PRE_WINDOW_END_H = 0;
// Fallback persistence spread (log units per sqrt hour) when no comparable
// can be used at all.
const FALLBACK_SIGMA = 0.15;

interface HourRow {
  from: string;
  viewers: number;
  channels?: number | null;
}

interface Comparable {
  name: string;
  day_start: string;
  unlock: string;
  platforms: string;
  hourly: HourRow[];
}

interface CaseFile {
  id: string;
  day_start: string;
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  history_hourly: HourRow[];
  comparables: Comparable[];
}

const HOUR_MS = 3600_000;

function hourIndex(from: string, dayStartMs: number): number {
  return Math.round((Date.parse(from) - dayStartMs) / HOUR_MS) + 1;
}

function tierOf(unlock: string): string {
  const m = /Tier:\s*([a-z-]+)/.exec(unlock ?? "");
  return m ? m[1] : "comparable";
}

function weightedMedian(pairs: Array<[number, number]>): number {
  const sorted = pairs.slice().sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((s, p) => s + p[1], 0);
  let acc = 0;
  for (const [value, weight] of sorted) {
    acc += weight;
    if (acc >= 0.5 * total) return value;
  }
  return sorted[sorted.length - 1][0];
}

function weightedMean(pairs: Array<[number, number]>): number {
  const total = pairs.reduce((s, p) => s + p[1], 0);
  return pairs.reduce((s, p) => s + p[0] * p[1], 0) / total;
}

function weightedStd(pairs: Array<[number, number]>, mean: number): number {
  const total = pairs.reduce((s, p) => s + p[1], 0);
  const variance =
    pairs.reduce((s, p) => s + p[1] * (p[0] - mean) * (p[0] - mean), 0) / total;
  return Math.sqrt(Math.max(variance, 0));
}

function gaussianKernel(logDistance: number, width: number): number {
  const d = logDistance / width;
  return Math.exp(-0.5 * d * d);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Previous-evening peak: max viewers over the window before day start. */
function previousEveningPeak(
  rows: HourRow[],
  dayStartMs: number,
): number | null {
  let peak: number | null = null;
  for (const row of rows) {
    const h = hourIndex(row.from, dayStartMs);
    if (h >= PRE_WINDOW_START_H && h <= PRE_WINDOW_END_H) {
      const v = row.viewers;
      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        peak = peak === null ? v : Math.max(peak, v);
      }
    }
  }
  return peak;
}

interface PreparedComparable {
  weight: number;
  // ln(viewers_h / pre) for h = 1..24; null when the comparable has no
  // previous-evening window to anchor on (it can still serve the hour-1
  // fallback below).
  logRatiosPre: number[] | null;
  logRatiosHour1: number[]; // ln(viewers_h / viewers_1) for h = 1..24
  pre: number | null;
  hour1: number;
}

function prepareComparable(
  comp: Comparable,
  targetPre: number | null,
): PreparedComparable | null {
  const dayStartMs = Date.parse(comp.day_start);
  if (!Number.isFinite(dayStartMs)) return null;
  const byHour = new Map<number, number>();
  for (const row of comp.hourly ?? []) {
    const h = hourIndex(row.from, dayStartMs);
    if (h >= PRE_WINDOW_START_H && h <= 24) {
      const v = row.viewers;
      if (typeof v === "number" && Number.isFinite(v)) byHour.set(h, v);
    }
  }
  const viewers: number[] = [];
  for (let h = 1; h <= 24; h++) {
    const v = byHour.get(h);
    if (v === undefined) return null; // need the full launch day
    viewers.push(Math.max(v, 1));
  }
  const hour1 = viewers[0];
  const dayMax = Math.max(...viewers);
  if (hour1 < MIN_HOUR1_SHARE * dayMax) return null;
  let pre: number | null = null;
  for (let h = PRE_WINDOW_START_H; h <= PRE_WINDOW_END_H; h++) {
    const v = byHour.get(h);
    if (v !== undefined && v > 0) pre = pre === null ? v : Math.max(pre, v);
  }

  let weight = TIER_WEIGHT[tierOf(comp.unlock)] ?? 0.5;
  if (weight <= 0) return null;
  if (/midnight local/i.test(comp.unlock ?? "")) weight *= MIDNIGHT_BONUS;
  if (!/PC/.test(comp.platforms ?? "")) weight *= CONSOLE_BONUS;
  if (targetPre !== null && targetPre > 0 && pre !== null) {
    weight *= gaussianKernel(Math.log(pre) - Math.log(targetPre), SIZE_KERNEL);
  }
  return {
    weight,
    logRatiosPre: pre === null ? null : viewers.map((v) => Math.log(v / pre)),
    logRatiosHour1: viewers.map((v) => Math.log(v / hour1)),
    pre,
    hour1,
  };
}

function forecastCase(c: CaseFile): { hours: Array<{ hour: number; q: number[] }> } {
  const dayStartMs = Date.parse(c.day_start);
  const knownRow = (c.known ?? []).find((r) => r.hour === 1);
  let p1 = knownRow && Number.isFinite(knownRow.viewers) ? knownRow.viewers : NaN;
  if (!Number.isFinite(p1) || p1 <= 0) {
    // Fall back to the last whole-hour mean before the checkpoint: that is
    // hour 1 itself when history_hourly reaches the checkpoint.
    const hourly = c.history_hourly ?? [];
    const last = hourly[hourly.length - 1];
    p1 = last && Number.isFinite(last.viewers) && last.viewers > 0 ? last.viewers : 1;
  }
  p1 = Math.max(p1, 1);

  const hours = (c.forecast ?? []).map((r) => r.hour).filter((h) => h >= 2 && h <= 24);
  const targetHours = hours.length === 23 ? hours : Array.from({ length: 23 }, (_, i) => i + 2);

  const targetPre = Number.isFinite(dayStartMs)
    ? previousEveningPeak(c.history_hourly ?? [], dayStartMs)
    : null;

  const prepared: PreparedComparable[] = [];
  for (const comp of c.comparables ?? []) {
    const pc = prepareComparable(comp, targetPre);
    if (pc) prepared.push(pc);
  }

  const rows: Array<{ hour: number; q: number[] }> = [];
  for (const h of targetHours) {
    const idx = h - 1;
    let medianLog: number;
    let spread: number;
    const usePre = targetPre !== null && targetPre > 0 && prepared.length > 0;
    if (usePre) {
      const withPre = prepared.filter((pc) => pc.logRatiosPre !== null);
      if (withPre.length > 0) {
        const pairs: Array<[number, number]> = withPre.map((pc) => [
          (pc.logRatiosPre as number[])[idx],
          pc.weight,
        ]);
        const med = weightedMedian(pairs);
        medianLog = Math.log(targetPre / p1) + med;
        spread = weightedStd(pairs, weightedMean(pairs));
      } else {
        const pairs: Array<[number, number]> = prepared.map((pc) => [
          pc.logRatiosHour1[idx],
          pc.weight,
        ]);
        medianLog = weightedMedian(pairs);
        spread = weightedStd(pairs, weightedMean(pairs));
      }
    } else if (prepared.length > 0) {
      // No previous-evening anchor available: fall back to hour-1 ratios.
      const pairs: Array<[number, number]> = prepared.map((pc) => [
        pc.logRatiosHour1[idx],
        pc.weight,
      ]);
      medianLog = weightedMedian(pairs);
      spread = weightedStd(pairs, weightedMean(pairs));
    } else {
      // No comparable at all: persistence with a widening spread.
      medianLog = 0;
      spread = FALLBACK_SIGMA * Math.sqrt(h - 1);
    }
    spread = Math.max(spread * SPREAD_SHRINK, SPREAD_FLOOR);
    const q = Z.map((z) => {
      const v = p1 * Math.exp(medianLog + z * spread);
      return Math.min(Math.max(round2(v), 1), 1e9);
    });
    // Rounding can only break monotonicity by a cent; enforce the order.
    for (let i = 1; i < q.length; i++) {
      if (q[i] < q[i - 1]) q[i] = q[i - 1];
    }
    rows.push({ hour: h, q });
  }
  return { hours: rows };
}

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const files = readdirSync(INPUT_DIR)
    .filter((f) => f.endsWith(".in"))
    .sort();
  for (const file of files) {
    const id = file.slice(0, -3);
    const text = readFileSync(join(INPUT_DIR, file), "utf8");
    const parsed = JSON.parse(text) as CaseFile;
    const out = forecastCase(parsed);
    writeFileSync(join(OUTPUT_DIR, `${id}.out`), JSON.stringify(out));
  }
}

main();
