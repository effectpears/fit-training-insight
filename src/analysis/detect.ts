import type {
  DetectionOptions,
  FitLap,
  Interval,
  Phase,
  PowerStep,
  RideSeries,
  WorkoutSet,
} from '../types';
import { mean, median, movingAverage, roundTo } from './math';

/** Erholungsfenster für die Kontrast-Referenz um einen Block herum. */
const RECOVERY_WINDOW_SECONDS = 120;
/** Weiteres Referenzfenster für lange Einzel-Blöcke (Rampen-Schultern). */
const WIDE_RECOVERY_WINDOW_SECONDS = 600;
/** Ab dieser Dauer gilt das weite Referenzfenster im Einzel-Block-Fall. */
const MIN_WIDE_BLOCK_SECONDS = 900;
/** Ab dieser Blockdauer werden interne Leistungssprünge annotiert. */
const MIN_STEP_BLOCK_SECONDS = 480;
/** Jedes Niveau muss mindestens so lange stabil gehalten werden. */
const MIN_STEP_SEGMENT_SECONDS = 150;
/** Vergleichsfenster links/rechts eines Sprungs. */
const STEP_WINDOW_SECONDS = 45;
const MAX_STEPS = 3;

export interface DetectionResult {
  intervals: Interval[];
  sets: WorkoutSet[];
  phases: Phase[];
}

interface IntervalCore extends Omit<Interval, 'index' | 'setId'> {}

/**
 * Erkennt Belastungsblöcke über eine Schwellenwert-Segmentierung mit
 * Hysterese:
 *
 * 1. Leistung glätten (zentrierter Mittelwert).
 * 2. Binärmaske anhand der ON-Schwelle bilden.
 * 3. Zu kurze ON-Blöcke verwerfen, zu kurze OFF-Lücken schließen.
 * 4. Intervalle über Pausen und Intensitätssprünge zu Sätzen gruppieren.
 *
 * Enthält die FIT-Datei klare, kurze Lap-Marker (z. B. 45-s-Steps eines
 * strukturierten Workouts), werden diese als exakte Intervallgrenzen genutzt.
 */
export function detectIntervals(
  series: RideSeries,
  options: DetectionOptions,
  laps: readonly FitLap[] = [],
): DetectionResult {
  const points = series.points;
  const powers = points.map((point) => point.power ?? 0);
  const smoothed = movingAverage(
    powers,
    Math.max(1, Math.round(options.smoothingSeconds)),
  );

  const lapIntervals = buildLapIntervals(series, options, laps);
  const cores = lapIntervals ?? buildPowerIntervals(series, options, powers, smoothed);

  // Interne Leistungssprünge in langen Blöcken annotieren (z. B. Tempo-
  // stufen 236 → 246 → 236 W). Das verändert keine Intervallgrenzen.
  for (const core of cores) {
    if (core.duration >= MIN_STEP_BLOCK_SECONDS) {
      core.steps = detectSteps(smoothed, core.start, core.end);
    }
  }

  const groups = groupIntervals(cores, options.setBreakSeconds);
  const intervals: Interval[] = [];
  const sets: WorkoutSet[] = [];

  groups.forEach((group, groupIndex) => {
    const setId = groupIndex + 1;
    const groupIntervals: Interval[] = group.map((core) => {
      const interval: Interval = {
        ...core,
        index: intervals.length + 1,
        setId,
      };
      intervals.push(interval);
      return interval;
    });
    sets.push(buildSet(setId, groupIntervals));
  });

  const phases = buildPhases(series.duration, sets);

  return { intervals, sets, phases };
}

function buildPowerIntervals(
  series: RideSeries,
  options: DetectionOptions,
  powers: readonly number[],
  smoothed: readonly number[],
): IntervalCore[] {
  const points = series.points;
  const mask = new Uint8Array(smoothed.length);
  for (let i = 0; i < smoothed.length; i++) {
    mask[i] = smoothed[i] >= options.thresholdW ? 1 : 0;
  }

  applyHysteresis(mask, options.minOnSeconds, options.minOffSeconds);

  const runs = refineRuns(
    powers,
    findRuns(mask, 1),
    options.thresholdW,
    Math.ceil(options.smoothingSeconds / 2) + 2,
  );

  const splitRuns = splitShortRuns(smoothed, runs, options);

  const cores: IntervalCore[] = [];
  for (const [start, end] of splitRuns) {
    const interval = buildInterval(points, start, end);
    if (interval) cores.push(interval);
  }

  // Flache Endurance-Fahrten erzeugen an einer niedrigen Schwelle viele
  // Pseudo-Intervalle. Nur Blöcke, die sich deutlich von ihrer Umgebung
  // abheben, werden als strukturierte Belastung übernommen.
  return filterIsolatedShortIntervals(
    filterByContrast(powers, cores),
    options.thresholdW,
  );
}

/**
 * Zerlegt kurze ON-Blöcke an ausgeprägten Leistungsstufen. Workouts wie
 * 5 × 45/45/45 werden sonst zu einem einzigen 2:15-Block verschmolzen, weil
 * alle drei Stufen über der ON-Schwelle liegen.
 */
function splitShortRuns(
  smoothed: readonly number[],
  runs: ReadonlyArray<[number, number]>,
  options: DetectionOptions,
): Array<[number, number]> {
  const result: Array<[number, number]> = [];

  for (const [start, end] of runs) {
    const duration = end - start;
    if (duration < 90 || duration > 240) {
      result.push([start, end]);
      continue;
    }
    if (isRamp(smoothed, start, end)) continue;

    const splits = findChangePoints(smoothed, start, end, options);
    if (splits.length === 0) {
      result.push([start, end]);
      continue;
    }

    let cursor = start;
    for (const split of splits) {
      result.push([cursor, split]);
      cursor = split;
    }
    result.push([cursor, end]);
  }

  return result;
}

function isRamp(
  values: readonly number[],
  start: number,
  end: number,
): boolean {
  const length = end - start;
  const window = Math.max(5, Math.round(length * 0.2));
  if (length < window * 3) return false;
  const first = mean(values.slice(start, start + window));
  const middle = mean(values.slice(start + window, end - window));
  const last = mean(values.slice(end - window, end));
  const runMean = mean(values.slice(start, end));
  const change = Math.abs(last - first);
  const monotonic =
    (first <= middle && middle <= last) ||
    (first >= middle && middle >= last);
  return change > 50 && change > runMean * 0.2 && monotonic;
}

function findChangePoints(
  values: readonly number[],
  start: number,
  end: number,
  options: DetectionOptions,
): number[] {
  const minSegment = Math.max(20, Math.round(options.minOnSeconds));
  const window = Math.max(8, Math.round(options.smoothingSeconds * 1.5));
  const runMean = mean(values.slice(start, end));
  const minScore = Math.max(30, runMean * 0.12);

  const candidates: Array<{ index: number; score: number }> = [];
  for (let i = start + minSegment; i <= end - minSegment; i++) {
    const left = mean(values.slice(Math.max(start, i - window), i));
    const right = mean(values.slice(i, Math.min(end, i + window)));
    candidates.push({ index: i, score: Math.abs(right - left) });
  }

  const peaks = candidates.filter(
    (candidate, index) =>
      candidate.score >= minScore &&
      candidate.score >= (candidates[index - 1]?.score ?? 0) &&
      candidate.score >= (candidates[index + 1]?.score ?? 0),
  );
  peaks.sort((a, b) => b.score - a.score);

  const picked: number[] = [];
  for (const peak of peaks) {
    if (picked.every((index) => Math.abs(index - peak.index) >= minSegment)) {
      picked.push(peak.index);
    }
  }

  return picked.sort((a, b) => a - b).slice(0, 3);
}

/**
 * Entfernt kurze, isolierte Blöcke dicht über der Schwelle. Sie entstehen
 * typischerweise beim Ausrollen oder in Übergängen und sind keine Intervalle.
 */
function filterIsolatedShortIntervals(
  intervals: readonly IntervalCore[],
  thresholdW: number,
): IntervalCore[] {
  return intervals.filter((interval, index) => {
    if (interval.duration >= 60 || interval.avgPower >= thresholdW * 1.12) {
      return true;
    }
    const previous = intervals[index - 1];
    const next = intervals[index + 1];
    return (
      (previous != null && interval.start - previous.end <= 30) ||
      (next != null && next.start - interval.end <= 30)
    );
  });
}

/**
 * Erkennt nachhaltige Leistungssprünge innerhalb eines langen Blocks und
 * gibt sie als Stufenprofil zurück (erster Eintrag = Anfangsniveau). Es werden
 * nur Sprünge zwischen zwei stabilen Niveaus annotiert – Rampen und Rauschen
 * bleiben unberücksichtigt. Die Intervallgrenzen selbst ändern sich nicht.
 */
function detectSteps(
  smoothed: readonly number[],
  start: number,
  end: number,
): PowerStep[] | undefined {
  const duration = end - start;
  if (duration < MIN_STEP_BLOCK_SECONDS) return undefined;

  const blockMean = mean(smoothed.slice(start, end));
  if (!Number.isFinite(blockMean) || blockMean <= 0) return undefined;

  // Nur klar über dem Rauschen liegende Sprünge (min. 6 W bzw. 2,5 %).
  const minScore = Math.max(6, blockMean * 0.025);
  const lo = start + MIN_STEP_SEGMENT_SECONDS;
  const hi = end - MIN_STEP_SEGMENT_SECONDS;
  if (hi <= lo) return undefined;

  const window = STEP_WINDOW_SECONDS;
  const candidates: Array<{ index: number; score: number }> = [];
  for (let i = lo; i <= hi; i++) {
    const left = mean(smoothed.slice(Math.max(start, i - window), i));
    const right = mean(smoothed.slice(i, Math.min(end, i + window)));
    const leftOuter = mean(smoothed.slice(Math.max(start, i - 2 * window), i - window));
    const rightOuter = mean(
      smoothed.slice(i + window, Math.min(end, i + 2 * window)),
    );
    if (
      !Number.isFinite(left) ||
      !Number.isFinite(right) ||
      !Number.isFinite(leftOuter) ||
      !Number.isFinite(rightOuter)
    ) {
      continue;
    }
    const score = right - left;
    if (Math.abs(score) < minScore) continue;
    // Flach-zu-flach: die Niveaus müssen links und rechts des Sprungs stabil
    // sein. Dadurch werden Rampen und Ausreißer nicht als Stufe annotiert.
    const leftStable = Math.abs(left - leftOuter) < minScore * 0.5;
    const rightStable = Math.abs(right - rightOuter) < minScore * 0.5;
    if (leftStable && rightStable) {
      candidates.push({ index: i, score });
    }
  }
  if (candidates.length === 0) return undefined;

  // Stärkste lokale Betragsmaxima, mindestens ein Segment auseinander.
  const peaks = candidates.filter(
    (candidate, index) =>
      Math.abs(candidate.score) >= Math.abs(candidates[index - 1]?.score ?? 0) &&
      Math.abs(candidate.score) >= Math.abs(candidates[index + 1]?.score ?? 0),
  );
  peaks.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  const picked: number[] = [];
  for (const peak of peaks) {
    if (picked.every((index) => Math.abs(index - peak.index) >= MIN_STEP_SEGMENT_SECONDS)) {
      picked.push(peak.index);
    }
    if (picked.length >= MAX_STEPS) break;
  }
  if (picked.length === 0) return undefined;
  picked.sort((a, b) => a - b);

  // Niveaus als Mittelwert der Abschnitte zwischen den Sprüngen.
  const boundaries = [start, ...picked, end];
  const steps: PowerStep[] = [];
  for (let k = 0; k < boundaries.length - 1; k++) {
    const level = mean(smoothed.slice(boundaries[k], boundaries[k + 1]));
    if (!Number.isFinite(level)) return undefined;
    steps.push({ at: boundaries[k], power: roundTo(level, 5) });
  }
  return steps.length >= 2 ? steps : undefined;
}

/**
 * Nutzt die FIT-Laps als Intervallgrenzen, wenn sie die Workout-Struktur
 * abbilden. Entscheidend ist die Leistung pro Lap: Laps über der ON-Schwelle
 * sind Belastungen, Laps darunter Pausen/Warm-up/Cool-down. Das funktioniert
 * sowohl für kurze Steps (5 × 45 s) als auch für lange Blöcke (8/8/10 min).
 */
function buildLapIntervals(
  series: RideSeries,
  options: DetectionOptions,
  laps: readonly FitLap[],
): IntervalCore[] | null {
  if (laps.length < 3) return null;

  const points = series.points;
  const minDuration = Math.max(10, Math.round(options.minOnSeconds));
  const candidates = laps
    .filter((lap) => lap.duration >= minDuration && lap.duration <= 1800)
    .map((lap) => ({
      lap,
      interval: buildInterval(points, lap.start, lap.end),
    }))
    .filter(
      (entry): entry is { lap: FitLap; interval: IntervalCore } =>
        entry.interval != null,
    );

  const work = candidates.filter(
    (entry) => entry.interval.avgPower >= options.thresholdW,
  );
  const rest = candidates.filter(
    (entry) => entry.interval.avgPower < options.thresholdW,
  );

  // Ohne echte Pausenlaps wäre die Lap-Struktur nicht von automatischen
  // Runden zu unterscheiden; dann bleibt die Leistungserkennung zuständig.
  if (work.length < 2 || rest.length < 2) return null;

  return work.map((entry) => entry.interval);
}

function applyHysteresis(
  mask: Uint8Array,
  minOnSeconds: number,
  minOffSeconds: number,
): void {
  const minOn = Math.max(1, Math.round(minOnSeconds));
  const minOff = Math.max(1, Math.round(minOffSeconds));

  // Mehrere Durchläufe, weil das Schließen einer Lücke neue kurze ON-Blöcke
  // zusammenführen kann.
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;

    for (const [start, end] of findRuns(mask, 0)) {
      if (start > 0 && end < mask.length && end - start < minOff) {
        mask.fill(1, start, end);
        changed = true;
      }
    }

    for (const [start, end] of findRuns(mask, 1)) {
      if (end - start < minOn) {
        mask.fill(0, start, end);
        changed = true;
      }
    }

    if (!changed) break;
  }
}

function findRuns(mask: Uint8Array, value: 0 | 1): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === value && start === -1) start = i;
    if (mask[i] !== value && start !== -1) {
      runs.push([start, i]);
      start = -1;
    }
  }
  if (start !== -1) runs.push([start, mask.length]);
  return runs;
}

/**
 * Korrigiert die durch Glättung verschobenen Flanken anhand der Rohleistung.
 * Erst werden unplausible Randsekunden entfernt, dann innerhalb des halben
 * Abstands zum Nachbarintervall wieder bis zur echten Schwellenflanke ergänzt.
 */
function refineRuns(
  powers: readonly number[],
  runs: ReadonlyArray<[number, number]>,
  threshold: number,
  maxAdjust: number,
): Array<[number, number]> {
  const low = threshold * 0.9;
  const trimmed = runs.map(([start, end]) => {
    let s = start;
    let e = end;
    for (let i = 0; i < maxAdjust && s < e - 1; i++) {
      if ((powers[s] ?? 0) >= low) break;
      s += 1;
    }
    for (let i = 0; i < maxAdjust && e > s + 1; i++) {
      if ((powers[e - 1] ?? 0) >= low) break;
      e -= 1;
    }
    return [s, e] as [number, number];
  });

  return trimmed.map(([start, end], index) => {
    const previousEnd = index > 0 ? trimmed[index - 1][1] : 0;
    const nextStart = index < trimmed.length - 1 ? trimmed[index + 1][0] : powers.length;
    const lowerBound = Math.max(previousEnd, start - maxAdjust);
    const upperBound = Math.min(nextStart, end + maxAdjust);

    let s = start;
    let e = end;
    while (s > lowerBound && (powers[s - 1] ?? 0) >= low) s -= 1;
    while (e < upperBound && (powers[e] ?? 0) >= low) e += 1;
    return [s, e] as [number, number];
  });
}

/**
 * Behält nur Intervalle, die sich klar von der umgebenden Erholung abheben.
 * Pausen (Leistung < 20 W) und andere Intervalle zählen nicht als
 * Erholungsreferenz, damit Sensorlücken oder Stopps keinen falschen
 * Kontrast erzeugen.
 */
function filterByContrast(
  powers: readonly number[],
  intervals: readonly IntervalCore[],
): IntervalCore[] {
  if (intervals.length === 0) return [];

  const covered = new Uint8Array(powers.length);
  for (const interval of intervals) {
    covered.fill(1, Math.max(0, interval.start), Math.min(covered.length, interval.end));
  }

  const scored = intervals.map((interval) =>
    scoreInterval(powers, covered, interval, RECOVERY_WINDOW_SECONDS),
  );

  const kept = scored.filter((entry) => entry.keep);
  if (kept.length !== 1) return kept.map((entry) => entry.interval);

  // Ein einzelner Block muss sich deutlich abheben. Bei langen Blöcken
  // (≥ 15 min) können die unmittelbaren 120-s-Schulterfenster noch Rampen-
  // anteile des Warm-ups bzw. Cool-downs enthalten und die Referenz künstlich
  // nah an die Blockleistung ziehen – die Referenz wird dann aus einem weiten
  // Umfeld (bis 600 s) gezogen. Kurze Einzelblöcke behalten die strenge lokale
  // Bewertung, damit flache Fahrten mit kurzen Anstiegen keine Pseudoblöcke
  // produzieren.
  const only = kept[0];
  if (only.interval.duration < MIN_WIDE_BLOCK_SECONDS) {
    return only.strong ? [only.interval] : [];
  }
  const wide = scoreInterval(powers, covered, only.interval, WIDE_RECOVERY_WINDOW_SECONDS);
  return wide.keep && wide.strong ? [only.interval] : [];
}

function scoreInterval(
  powers: readonly number[],
  covered: Uint8Array,
  interval: IntervalCore,
  windowSeconds: number,
): { interval: IntervalCore; keep: boolean; strong: boolean } {
  const before = meanOfRecovery(powers, covered, interval.start, -1, windowSeconds);
  const after = meanOfRecovery(powers, covered, interval.end, 1, windowSeconds);
  const baseline =
    before != null && after != null ? (before + after) / 2 : (before ?? after);
  if (baseline == null) {
    return { interval, keep: true, strong: true };
  }

  const delta = interval.avgPower - baseline;
  const ratio = interval.avgPower / Math.max(1, baseline);
  return {
    interval,
    keep: delta >= 12 && (ratio >= 1.18 || delta >= 40),
    strong: ratio >= 1.3 || delta >= 45,
  };
}

/**
 * Mittlere Leistung der nächsten erholten Umgebung. Sucht bis zu
 * `windowSeconds` in Richtung `direction` und überspringt dabei alle
 * Intervallbereiche.
 */
function meanOfRecovery(
  powers: readonly number[],
  covered: Uint8Array,
  start: number,
  direction: -1 | 1,
  windowSeconds: number,
): number | null {
  let sum = 0;
  let count = 0;
  let index = direction === -1 ? start - 1 : start;
  const limit =
    direction === -1
      ? Math.max(0, start - windowSeconds)
      : Math.min(powers.length, start + windowSeconds);

  while (direction === -1 ? index >= limit : index < limit) {
    if (covered[index] === 0) {
      const power = powers[index];
      if (Number.isFinite(power) && power >= 20) {
        sum += power;
        count += 1;
      }
    }
    index += direction;
  }
  return count >= 5 ? sum / count : null;
}

function buildInterval(
  points: RideSeries['points'],
  start: number,
  end: number,
): IntervalCore | null {
  const duration = end - start;
  if (duration <= 0) return null;

  let powerSum = 0;
  let powerCount = 0;
  let maxPower = 0;
  let work = 0;
  const heartRates: number[] = [];
  const cadences: number[] = [];

  for (let i = start; i < end && i < points.length; i++) {
    const point = points[i];
    if (point.power != null) {
      powerSum += point.power;
      powerCount += 1;
      work += point.power;
      maxPower = Math.max(maxPower, point.power);
    }
    if (point.heartRate != null) heartRates.push(point.heartRate);
    if (point.cadence != null) cadences.push(point.cadence);
  }

  const avgPower = powerCount > 0 ? powerSum / powerCount : 0;
  if (avgPower <= 0) return null;

  return {
    start,
    end,
    duration,
    avgPower,
    maxPower,
    avgHeartRate: heartRates.length > 0 ? mean(heartRates) : null,
    maxHeartRate: heartRates.length > 0 ? Math.max(...heartRates) : null,
    avgCadence: cadences.length > 0 ? mean(cadences) : null,
    workKJ: work / 1000,
  };
}

function groupIntervals(
  intervals: readonly IntervalCore[],
  setBreakSeconds: number,
): IntervalCore[][] {
  if (intervals.length === 0) return [];

  const groups: IntervalCore[][] = [];
  let current: IntervalCore[] = [intervals[0]];

  for (let i = 1; i < intervals.length; i++) {
    const previous = current[current.length - 1];
    const interval = intervals[i];
    const gap = interval.start - previous.end;
    const target = median(current.map((entry) => entry.avgPower));
    const intensityDelta = Math.abs(interval.avgPower - target) / Math.max(1, target);
    const split = gap > setBreakSeconds || intensityDelta > 0.3;

    if (split) {
      groups.push(current);
      current = [interval];
    } else {
      current.push(interval);
    }
  }

  groups.push(current);
  return groups;
}

interface SetStructure {
  reps: number;
  onSeconds: number;
  offSeconds: number;
  patternSeconds?: number[];
}

function resolveSetStructure(intervals: readonly Interval[]): SetStructure {
  const groups = groupConsecutiveIntervals(intervals, 2);
  const hasSubSteps = groups.length >= 2 && groups.some((group) => group.length >= 2);

  if (hasSubSteps) {
    const pattern = groups[0].map((interval) => Math.round(interval.duration));
    const consistent = groups.every(
      (group) =>
        group.length === pattern.length &&
        group.every(
          (interval, index) => Math.abs(interval.duration - pattern[index]) <= 3,
        ),
    );

    if (consistent) {
      const gaps: number[] = [];
      for (let i = 1; i < groups.length; i++) {
        const previous = groups[i - 1][groups[i - 1].length - 1];
        gaps.push(Math.max(0, groups[i][0].start - previous.end));
      }
      return {
        reps: groups.length,
        onSeconds: median(intervals.map((interval) => interval.duration)),
        offSeconds: gaps.length > 0 ? median(gaps) : 0,
        patternSeconds: pattern,
      };
    }
  }

  const gaps: number[] = [];
  for (let i = 1; i < intervals.length; i++) {
    gaps.push(Math.max(0, intervals[i].start - intervals[i - 1].end));
  }
  return {
    reps: intervals.length,
    onSeconds: median(intervals.map((interval) => interval.duration)),
    offSeconds: gaps.length > 0 ? median(gaps) : 0,
  };
}

function groupConsecutiveIntervals(
  intervals: readonly Interval[],
  maxGapSeconds: number,
): Interval[][] {
  if (intervals.length === 0) return [];
  const groups: Interval[][] = [[intervals[0]]];
  for (let i = 1; i < intervals.length; i++) {
    const previous = intervals[i - 1];
    const current = intervals[i];
    if (current.start - previous.end <= maxGapSeconds) {
      groups[groups.length - 1].push(current);
    } else {
      groups.push([current]);
    }
  }
  return groups;
}

function repAveragePowers(intervals: readonly Interval[]): number[] {
  return groupConsecutiveIntervals(intervals, 2).map((group) => {
    const duration = group.reduce((sum, interval) => sum + interval.duration, 0);
    if (duration <= 0) return 0;
    return (
      group.reduce((sum, interval) => sum + interval.avgPower * interval.duration, 0) /
      duration
    );
  });
}

function buildSet(id: number, intervals: Interval[]): WorkoutSet {
  const start = intervals[0].start;
  const end = intervals[intervals.length - 1].end;
  const totalDuration = intervals.reduce((sum, interval) => sum + interval.duration, 0);
  const structure = resolveSetStructure(intervals);
  const { reps, onSeconds, offSeconds } = structure;
  const targetPower = roundTo(
    median(
      structure.patternSeconds
        ? repAveragePowers(intervals)
        : intervals.map((interval) => interval.avgPower),
    ),
    5,
  );
  const avgPower =
    totalDuration > 0
      ? intervals.reduce((sum, interval) => sum + interval.avgPower * interval.duration, 0) /
        totalDuration
      : 0;

  const heartRates = intervals
    .filter((interval) => interval.avgHeartRate != null)
    .map((interval) => ({
      value: interval.avgHeartRate as number,
      duration: interval.duration,
    }));
  const heartDuration = heartRates.reduce((sum, entry) => sum + entry.duration, 0);
  const avgHeartRate =
    heartDuration > 0
      ? heartRates.reduce((sum, entry) => sum + entry.value * entry.duration, 0) /
        heartDuration
      : null;

  let label: string;
  if (structure.patternSeconds) {
    const pattern = structure.patternSeconds.map(formatSeconds).join('/');
    const pause =
      offSeconds > 0 ? ` + ${formatSeconds(offSeconds)} Pause` : '';
    label = `${reps} × (${pattern}${pause}) @ ${targetPower} W`;
  } else if (intervals.length > 1) {
    label = `${intervals.length} × (${formatSeconds(onSeconds)} ON / ${formatSeconds(
      offSeconds,
    )} OFF) @ ${targetPower} W`;
  } else {
    label = `1 × ${formatSeconds(onSeconds)} @ ${targetPower} W`;
  }

  return {
    id,
    start,
    end,
    reps,
    onSeconds,
    offSeconds,
    patternSeconds: structure.patternSeconds,
    targetPower,
    avgPower,
    maxPower: Math.max(...intervals.map((interval) => interval.maxPower)),
    avgHeartRate,
    workKJ: intervals.reduce((sum, interval) => sum + interval.workKJ, 0),
    label,
    intervals,
  };
}

function buildPhases(duration: number, sets: readonly WorkoutSet[]): Phase[] {
  if (sets.length === 0) {
    return [{ kind: 'ride', start: 0, end: duration, label: 'Fahrt' }];
  }

  const phases: Phase[] = [];
  const first = sets[0];
  const last = sets[sets.length - 1];

  if (first.start > 1) {
    phases.push({ kind: 'warmup', start: 0, end: first.start, label: 'Warm-up' });
  }

  sets.forEach((set, index) => {
    phases.push({
      kind: 'set',
      start: set.start,
      end: set.end,
      label: `Satz ${set.id}`,
      setId: set.id,
    });
    if (index < sets.length - 1) {
      const next = sets[index + 1];
      if (next.start > set.end + 1) {
        phases.push({
          kind: 'recovery',
          start: set.end,
          end: next.start,
          label: 'Erholung',
        });
      }
    }
  });

  if (last.end < duration - 1) {
    phases.push({
      kind: 'cooldown',
      start: last.end,
      end: duration,
      label: 'Cool-down',
    });
  }

  return phases;
}

function formatSeconds(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 90) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0 ? `${minutes}min` : `${minutes}:${String(rest).padStart(2, '0')}`;
}
