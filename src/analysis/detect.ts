import type {
  DetectionOptions,
  FitLap,
  FitWorkout,
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
/** Maximale Lap-Dauer, die noch als einzelner Belastungsblock gilt. */
const MAX_LAP_INTERVAL_SECONDS = 3600;
/** Ab dieser Blockdauer werden interne Leistungssprünge annotiert. */
const MIN_STEP_BLOCK_SECONDS = 480;
/** Jedes Niveau muss mindestens so lange stabil gehalten werden. */
const MIN_STEP_SEGMENT_SECONDS = 150;
/** Vergleichsfenster links/rechts eines Sprungs. */
const STEP_WINDOW_SECONDS = 45;
const MAX_STEPS = 3;
/** Kurz-Blöcke, die an Stufen zerlegt werden dürfen (in Sekunden). */
const SPLIT_SHORT_RUNS_MIN_SECONDS = 90;
const SPLIT_SHORT_RUNS_MAX_SECONDS = 240;
/** Blöcke, die an markanten Leistungseinbrüchen geteilt werden (Sekunden). */
const SPLIT_LONG_RUN_MIN_SECONDS = 300;
/** Mindestdauer jedes Teilstücks bei der Langblock-Teilung. */
const SPLIT_LONG_RUN_MIN_SEGMENT_SECONDS = 60;
/** Ein Dip muss mindestens so lange unter dem Blockniveau bleiben. */
const SPLIT_LONG_RUN_DIP_MIN_SECONDS = 30;
/** Ein Dip zählt als Trennung, wenn er mindestens diesen Anteil unter dem
 * Block-Mittelwert liegt (z. B. 0.35 = 35 % darunter). */
const SPLIT_LONG_RUN_DIP_RATIO = 0.35;
/** Kurze, aber sehr starke Intervalle (Sprints) werden ab dieser Dauer gerettet. */
const SPRINT_MIN_SECONDS = 5;
/** Darling: nur echte Sprints – längere Blöcke gehören in den Hauptpfad. */
const SPRINT_MAX_SECONDS = 30;
/** Mindest-Deckung (0–1), damit ein Lap als durch Power bestätigt gilt. */
const LAP_POWER_OVERLAP_RATIO = 0.5;
/** Konsens-Schwelle: ab dieser Deckung gewinnen die exakten Lap-Grenzen. */
const LAP_CONSENSUS_MIN_MATCH = 0.5;
/** Anteil der niedrigsten Work-Leistung, ab dem ein Pausen-Lap eine Under-Phase ist. */
const UNDER_LAP_POWER_RATIO = 0.75;
/** Zusätzlich muss ein Under-Lap diese Quote des härteren Nachbar-Work-Laps halten. */
const UNDER_LAP_LOCAL_WORK_RATIO = 0.65;
/** Bis zu dieser Lap-Dauer verzerren Übergangssekunden den Leistungsschnitt. */
const LAP_EDGE_REFINE_MAX_SECONDS = 120;
/** Dauer-Toleranz, damit ein Leistungsintervall als derselbe Block gilt. */
const LAP_MATCH_DURATION_RATIO = 0.25;
/** Mindest-Überdeckung, damit ein Leistungsintervall den Lap bestätigt. */
const LAP_MATCH_MIN_OVERLAP_RATIO = 0.5;
/** Lücken-Dauer-Bereich für die Under-Phasen-Fusion (Sekunden). */
const GAP_PHASE_MIN_SECONDS = 10;
const GAP_PHASE_MAX_SECONDS = 900;
/** Mindestdauer eines geretteten Rampen-Plateaus (Sekunden). */
const MIN_PLATEAU_SECONDS = 45;
/** Wie dicht das Plateau am Rampen-Peak liegen muss (in W). */
const PLATEAU_LEVEL_WATTS = 15;

export interface DetectionResult {
  intervals: Interval[];
  sets: WorkoutSet[];
  phases: Phase[];
}

interface IntervalCore extends Omit<Interval, 'index' | 'setId'> {
  /** 'lap' wenn aus FIT-Laps, 'power' wenn aus der Leistungserkennung. */
  source: 'lap' | 'power';
  /** Active-Recovery-Phase unterhalb der Schwelle (Over-Under). */
  under?: boolean;
  /** Kontrast zur Erholung (0–1, 1 = stark abgesetzter Block). */
  contrast: number;
}

/** Ergebnis des Lap-Pfads inkl. Trennschärfe für die Konsens-Schicht. */
interface LapCandidate {
  /** Work- und Under-Intervalle in Reihenfolge. */
  intervals: IntervalCore[];
  /** Nur die Work-Intervalle (für die Power-Deckungsprüfung). */
  workIntervals: IntervalCore[];
  /** Niedrigste durchschnittliche Work-Lap-Leistung in W. */
  minWork: number;
  /** Höchste durchschnittliche Rest-Lap-Leistung in W. */
  maxRest: number;
}

/**
 * Erkennt Belastungsblöcke über eine Schwellenwert-Segmentierung mit
 * Hysterese:
 *
 * 1. Leistung glätten (zentrierter Mittelwert).
 * 2. Binärmaske anhand der ON-Schwelle bilden.
 * 3. Zu kurze ON-Blöcke verwerfen, zu kurze OFF-Lücken schließen.
 * 4. Intervalle über Pausen und Intensitätssprünge zu Sätzen gruppieren.
 *
 * Enthalten die FIT-Laps eine klar getrennte Work/Rest-Struktur (z. B. 45-s-
 * Steps eines strukturierten Workouts oder ein einzelner langer Tempoblock
 * zwischen Warm-up und Cool-down), werden sie als exakte Intervallgrenzen
 * bevorzugt. Ohne klare Trennung (Auto-Laps) greift die Leistungserkennung.
 * Wenn beide Pfade Intervalle liefern, entscheidet ein Konsens: decken sich
 * Lap- und Power-Intervals weitgehend, gewinnen die exakten Lap-Grenzen.
 */
export function detectIntervals(
  series: RideSeries,
  options: DetectionOptions,
  laps: readonly FitLap[] = [],
  workouts: readonly FitWorkout[] = [],
  thresholdConfidence = 0.5,
): DetectionResult {
  const points = series.points;
  const powers = points.map((point) => point.power ?? 0);
  const smoothed = movingAverage(
    powers,
    Math.max(1, Math.round(options.smoothingSeconds)),
  );

  const powerIntervals = buildPowerIntervals(
    series,
    options,
    powers,
    smoothed,
  );
  const lapCandidate = buildLapIntervals(
    series,
    options,
    laps,
    powerIntervals,
  );

  // Konsens-Schicht: Lap-Pfad vs. Power-Pfad. Der Lap-Pfad gewinnt, wenn
  // entweder die Power-Erkennung die Lap-Blöcke bestätigt (Deckung) oder die
  // Work/Rest-Trennung der Laps für sich spricht (dann ist die Lap-Struktur
  // plausibel, auch wenn die geschätzte Schwelle danebenliegt).
  let cores: IntervalCore[];
  let lapBased = false;
  if (lapCandidate != null && lapCandidate.intervals.length > 0) {
    const matchRatio = lapPowerMatchRatio(
      lapCandidate.workIntervals,
      powerIntervals,
    );
    const separation = lapCandidate.minWork - lapCandidate.maxRest;
    const minSeparation = Math.max(15, options.thresholdW * 0.08);
    const strongSeparation = separation >= minSeparation;

    if (matchRatio >= LAP_CONSENSUS_MIN_MATCH || strongSeparation) {
      cores = lapCandidate.intervals;
      lapBased = true;
    } else {
      cores = powerIntervals;
    }
  } else {
    cores = powerIntervals;
  }

  // Sprints retten: sehr kurze, aber überdurchschnittlich starke Antritte,
  // die durch minOnSeconds sonst verworfen würden. Nur beim Power-Pfad –
  // wenn die Laps die Struktur vorgeben, bleibt es dabei.
  if (!lapBased) {
    const sprintRescued = rescueSprints(cores, powers, options.thresholdW);
    if (sprintRescued.length > 0) {
      cores = [...cores, ...sprintRescued].sort((a, b) => a.start - b.start);
    }
  }

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
        confidence:
          Math.round(
            (core.source === 'lap' ? 0.9 : thresholdConfidence) *
              core.contrast *
              100,
          ) / 100,
      };
      intervals.push(interval);
      return interval;
    });
    sets.push(buildSet(setId, groupIntervals));
  });

  const phases = buildPhases(
    series.duration,
    sets,
    lapBased ? 'laps' : workouts.length > 0 ? 'workout' : undefined,
  );

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

  // Bekannte Belastungsbereiche maskieren, damit die Kontrast-Referenz
  // nicht die Nachbarblöcke selbst enthält (Steps, Over-Under-Sätze).
  const covered = new Uint8Array(powers.length);
  for (const [runStart, runEnd] of splitRuns) {
    covered.fill(
      1,
      Math.max(0, runStart),
      Math.min(covered.length, runEnd),
    );
  }

  const cores: IntervalCore[] = [];
  for (const [start, end] of splitRuns) {
    const interval = buildInterval(points, start, end);
    if (interval) {
      cores.push({
        ...interval,
        source: 'power',
        contrast: intervalContrast(powers, start, end, covered),
      });
    }
  }

  // Flache Endurance-Fahrten erzeugen an einer niedrigen Schwelle viele
  // Pseudo-Intervalle. Nur Blöcke, die sich deutlich von ihrer Umgebung
  // abheben, werden als strukturierte Belastung übernommen.
  const filtered = filterIsolatedShortIntervals(
    filterByContrast(powers, cores),
    options.thresholdW,
  );

  // Over-Unter-Fusion: Pausen mit hoher Leistung (aktive Under-Phasen)
  // gehören zum Satz dazu, statt die Work-Runen zu isolieren.
  return mergeGapPhases(filtered, powers, options.thresholdW);
}

/**
 * Fügt Lücken zwischen Work-Intervallen als Under-Phasen ein, wenn in der
 * Lücke deutlich über Erholungsniveau gefahren wurde (z. B. 229 W zwischen
 * zwei 277 W-Blöcken). Die Lücke wird zum Intervall und die Work-Blöcke
 * damit zu einem zusammenhängenden Satz.
 */
function mergeGapPhases(
  cores: readonly IntervalCore[],
  powers: readonly number[],
  thresholdW: number,
): IntervalCore[] {
  if (cores.length < 2) return [...cores];

  // Work-Blöcke maskieren: Die Erholungsreferenz eines Under-Intervalls
  // darf nicht aus den flankierenden Belastungsblöcken selbst bestehen.
  const covered = new Uint8Array(powers.length);
  for (const core of cores) {
    covered.fill(
      1,
      Math.max(0, core.start),
      Math.min(covered.length, core.end),
    );
  }

  const result: IntervalCore[] = [cores[0]];
  for (let i = 1; i < cores.length; i++) {
    const previous = cores[i - 1];
    const current = cores[i];
    const gapStart = previous.end;
    const gapEnd = current.start;
    const gap = gapEnd - gapStart;
    if (gap >= GAP_PHASE_MIN_SECONDS && gap <= GAP_PHASE_MAX_SECONDS) {
      const gapPowers = powers
        .slice(gapStart, gapEnd)
        .filter((value) => Number.isFinite(value));
      if (gapPowers.length >= gap * 0.5) {
        const gapMean = mean(gapPowers);
        const workReference = Math.min(previous.avgPower, current.avgPower);
        if (
          gapMean >= workReference * UNDER_LAP_POWER_RATIO &&
          gapMean >= thresholdW * 0.7
        ) {
          const under = buildIntervalFromPowers(powers, gapStart, gapEnd);
          if (under != null) {
            result.push({
              ...under,
              under: true,
              contrast: intervalContrast(powers, gapStart, gapEnd, covered),
            });
          }
        }
      }
    }
    result.push(current);
  }
  return result;
}

/**
 * Kontrast eines Blocks zur umgebenden Erholung (0–1).
 * `covered` maskiert die bekannten Belastungsbereiche, damit bei
 * dicht aufeinanderfolgenden Blöcken (45/45/45-Steps, Over-Under-Sätze)
 * nicht die Nachbarblöcke als Erholungsreferenz dienen. Ist keine
 * Referenz ermittelbar, gilt der Block als nicht abgrenzbar und bekommt
 * den vollen Kontrast (wie bei der Kontrast-Filterung auch).
 */
function intervalContrast(
  powers: readonly number[],
  start: number,
  end: number,
  covered?: Uint8Array,
): number {
  const before = meanOfRecovery(
    powers,
    start,
    -1,
    RECOVERY_WINDOW_SECONDS,
    covered,
  );
  const after = meanOfRecovery(
    powers,
    end,
    1,
    RECOVERY_WINDOW_SECONDS,
    covered,
  );
  const reference =
    before != null && after != null ? (before + after) / 2 : (before ?? after);
  const avgPower = mean(powers.slice(start, end));
  if (reference == null || reference <= 0) return 1;
  return Math.min(1, Math.max(0, (avgPower - reference) / Math.max(1, reference)));
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
    if (
      duration < SPLIT_SHORT_RUNS_MIN_SECONDS ||
      duration > SPLIT_SHORT_RUNS_MAX_SECONDS
    ) {
      result.push([start, end]);
      continue;
    }
    if (isRamp(smoothed, start, end)) {
      // Rampe: Ein stabiler Anschluss-Block (Warm-up, das in das erste
      // Intervall hineinführt, bzw. ein Block mit Rampen-Ausklang) wird
      // gerettet. Der rein rampenförmige Anteil bleibt verworfen.
      const plateau = salvageRampPlateau(smoothed, start, end);
      if (plateau != null) result.push(plateau);
      continue;
    }

    if (duration > SPLIT_LONG_RUN_MIN_SECONDS) {
      const dips = findLongRunDips(smoothed, start, end);
      if (dips.length > 0) {
        let cursor = start;
        for (const dip of dips) {
          if (dip[0] - cursor >= SPLIT_LONG_RUN_MIN_SEGMENT_SECONDS) {
            result.push([cursor, dip[0]]);
          }
          cursor = dip[1];
        }
        if (end - cursor >= SPLIT_LONG_RUN_MIN_SEGMENT_SECONDS) {
          result.push([cursor, end]);
        }
        continue;
      }
    }

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

/**
 * Rettet den stabilen Block-Anteil eines Rampen-Runs. Gesucht wird der
 * längste flache Suffix (Rampe steigt in einen Block hinein, z. B. Warm-up
 * in das erste Intervall) oder das längste flache Präfix (Block klingt in
 * eine Rampe ab). Der Block muss das maximale Rampen-Niveau erreichen –
 * das flache Ende einer Rampe, die erst am Peak ankommt, wird so nicht
 * zum Intervall.
 */
function salvageRampPlateau(
  values: readonly number[],
  start: number,
  end: number,
): [number, number] | null {
  const runMax = Math.max(...values.slice(start, end));
  for (let p = start; p <= end - MIN_PLATEAU_SECONDS; p++) {
    if (isPlateau(values, p, end) && isAtRunLevel(values, p, end, runMax)) {
      return [p, end];
    }
  }
  for (let p = end; p >= start + MIN_PLATEAU_SECONDS; p--) {
    if (isPlateau(values, start, p) && isAtRunLevel(values, start, p, runMax)) {
      return [start, p];
    }
  }
  return null;
}

/**
 * Erkennt markante Leistungseinbrüche ("Dips") innerhalb eines langen
 * ON-Blocks (> 5 min). Ein Dip ist ein zusammenhängender Abschnitt, der
 * mindestens `SPLIT_LONG_RUN_DIP_MIN_SECONDS` deutlich unter dem
 * Block-Mittelwert bleibt (≥ `SPLIT_LONG_RUN_DIP_RATIO` unter dem Mittel).
 * Solche Dips trennen den Block in mehrere Intervalle (z. B. ein langer
 * Tempoblock mit Erholungsphase in der Mitte).
 */
function findLongRunDips(
  values: readonly number[],
  start: number,
  end: number,
): Array<[number, number]> {
  const blockMean = mean(values.slice(start, end));
  if (!Number.isFinite(blockMean) || blockMean <= 0) return [];

  const dipLevel = blockMean * (1 - SPLIT_LONG_RUN_DIP_RATIO);
  const dips: Array<[number, number]> = [];
  let inDip = false;
  let dipStart = start;

  for (let i = start; i < end; i++) {
    const power = values[i];
    const below = power != null && power < dipLevel;
    if (below && !inDip) {
      inDip = true;
      dipStart = i;
    } else if (!below && inDip) {
      if (i - dipStart >= SPLIT_LONG_RUN_DIP_MIN_SECONDS) {
        dips.push([dipStart, i]);
      }
      inDip = false;
    }
  }
  if (inDip && end - dipStart >= SPLIT_LONG_RUN_DIP_MIN_SECONDS) {
    dips.push([dipStart, end]);
  }

  return dips;
}

/** Flacher Abschnitt: die Randfenster weichen kaum voneinander ab. */
function isPlateau(
  values: readonly number[],
  start: number,
  end: number,
): boolean {
  const duration = end - start;
  const window = Math.max(5, Math.round(duration * 0.2));
  if (duration < window * 2) return false;
  const first = mean(values.slice(start, start + window));
  const last = mean(values.slice(end - window, end));
  const segmentMean = mean(values.slice(start, end));
  if (!Number.isFinite(segmentMean) || segmentMean <= 0) return false;
  return Math.abs(last - first) <= Math.max(8, segmentMean * 0.04);
}

/** Der Block erreicht das maximale Rampen-Niveau (nicht nur die Rampe). */
function isAtRunLevel(
  values: readonly number[],
  start: number,
  end: number,
  runMax: number,
): boolean {
  const segmentMean = mean(values.slice(start, end));
  return segmentMean >= runMax - PLATEAU_LEVEL_WATTS;
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
 * Retten sehr kurzer, starker Antritte (Sprints), die durch minOnSeconds
 * verworfen würden. Ein Sprint wird nur hinzugefügt, wenn er nicht bereits
 * Teil eines erkannten Intervalls ist, deutlich über der Schwelle liegt,
 * kurz genug für einen Sprint ist und sich als lokale Spitze deutlich von
 * seiner Umgebung abhebt. Letzteres verhindert, dass Rampen-Anteile des
 * Warm-ups (die der Hauptpfad korrekt verworfen hat) zu Intervallen werden.
 */
function rescueSprints(
  cores: IntervalCore[],
  powers: readonly number[],
  thresholdW: number,
): IntervalCore[] {
  const covered = new Uint8Array(powers.length);
  for (const core of cores) {
    covered.fill(1, Math.max(0, core.start), Math.min(covered.length, core.end));
  }

  const minOn = Math.max(1, SPRINT_MIN_SECONDS);
  const sprintThreshold = Math.max(thresholdW * 1.2, thresholdW + 40);

  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < powers.length; i++) {
    const on = powers[i] >= sprintThreshold && !covered[i];
    if (on && start === -1) start = i;
    if ((!on || i === powers.length - 1) && start !== -1) {
      const end = !on ? i : i + 1;
      if (end - start >= minOn && end - start <= SPRINT_MAX_SECONDS) {
        runs.push([start, end]);
      }
      start = -1;
    }
  }

  const rescued: IntervalCore[] = [];
  for (const [start, end] of runs) {
    const interval = buildIntervalFromPowers(powers, start, end);
    if (interval == null) continue;

    const baseline = rescueBaseline(powers, covered, start, end);
    if (baseline != null) {
      const ratio = interval.avgPower / Math.max(1, baseline);
      const delta = interval.avgPower - baseline;
      if (ratio < 1.5 || delta < 40) continue;
    }

    rescued.push({ ...interval, source: 'power', contrast: 1, under: undefined });
  }
  return rescued;
}

/**
 * Mittlere Leistung der unbedeckten Umgebung (±90 s) eines geretteten
 * Sprints. Intervall-Bereiche und Unter-20-W-Sekunden zählen nicht.
 */
function rescueBaseline(
  powers: readonly number[],
  covered: Uint8Array,
  start: number,
  end: number,
): number | null {
  let sum = 0;
  let count = 0;
  const scan = (from: number, to: number) => {
    for (let i = Math.max(0, from); i < Math.min(powers.length, to); i++) {
      if (covered[i] !== 0) continue;
      const power = powers[i];
      if (Number.isFinite(power) && power >= 20) {
        sum += power;
        count += 1;
      }
    }
  };
  scan(start - 90, start);
  scan(end, end + 90);
  return count >= 5 ? sum / count : null;
}

function buildIntervalFromPowers(
  powers: readonly number[],
  start: number,
  end: number,
): IntervalCore | null {
  const duration = end - start;
  if (duration <= 0) return null;

  let powerSum = 0;
  let maxPower = 0;

  for (let i = start; i < end && i < powers.length; i++) {
    const power = powers[i];
    if (Number.isFinite(power)) {
      powerSum += power;
      maxPower = Math.max(maxPower, power);
    }
  }

  const avgPower = powerSum / duration;
  if (avgPower <= 0) return null;

  return {
    start,
    end,
    duration,
    avgPower,
    maxPower,
    avgHeartRate: null,
    maxHeartRate: null,
    avgCadence: null,
    workKJ: powerSum / 1000,
    source: 'power',
    contrast: 1,
  };
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
 *
 * Laps unterhalb der Schwelle, die zwischen Work-Laps liegen und dabei
 * deutlich über dem Erholungsniveau bleiben, sind aktive Under-Phasen
 * (Over-Under-Workouts) und werden ebenfalls als Intervalle übernommen.
 *
 * Die Trennschärfe (min. Work-Leistung − max. Rest-Leistung) wird mit
 * geliefert, damit die Konsens-Schicht sie gegen die Power-Erkennung
 * abwägen kann.
 */
function buildLapIntervals(
  series: RideSeries,
  options: DetectionOptions,
  laps: readonly FitLap[],
  powerIntervals: readonly IntervalCore[],
): LapCandidate | null {
  if (laps.length < 2) return null;

  const points = series.points;
  const minDuration = Math.max(10, Math.round(options.minOnSeconds));
  const candidates = laps
    .filter(
      (lap) => lap.duration >= minDuration && lap.duration <= MAX_LAP_INTERVAL_SECONDS,
    )
    .map((lap) => {
      const interval = buildInterval(points, lap.start, lap.end);
      return {
        lap,
        interval:
          interval == null
            ? null
            : refineLapIntervalPower(interval, points, powerIntervals),
      };
    })
    .filter(
      (entry): entry is { lap: FitLap; interval: IntervalCore } =>
        entry.interval != null,
    );

  const work = candidates.filter(
    (entry) => entry.interval.avgPower >= options.thresholdW,
  );
  const below = candidates.filter(
    (entry) => entry.interval.avgPower < options.thresholdW,
  );

  // Ohne Belastungs- und Pausenlaps wäre die Lap-Struktur nicht von
  // automatischen Runden zu unterscheiden; dann bleibt die Leistungserkennung
  // zuständig.
  if (work.length === 0 || below.length === 0) return null;

  const minWork = Math.min(...work.map((entry) => entry.interval.avgPower));

  // Under-Laps: Pausenlaps zwischen dem ersten und letzten Work-Lap, die
  // noch deutlich über der Erholung liegen, sind aktive Under-Phasen – keine
  // Erholung. Die Referenz ist bewusst *lokal* (der härtere umliegende
  // Work-Lap): Ein 185-W-Lap zwischen zwei 300-W-Intervallen ist Erholung,
  // auch wenn er global über 75 % des schwächsten Work-Laps liegt. Ein
  // 198-W-Lap zwischen 297/294 W ist dagegen eine echte Under-Phase.
  const workPowers = candidates.map((entry) =>
    entry.interval.avgPower >= options.thresholdW
      ? entry.interval.avgPower
      : null,
  );
  const prevWorkPower: (number | null)[] = [];
  const nextWorkPower: (number | null)[] = [];
  let lastWork: number | null = null;
  for (let i = 0; i < candidates.length; i += 1) {
    prevWorkPower[i] = lastWork;
    if (workPowers[i] != null) lastWork = workPowers[i];
  }
  let followingWork: number | null = null;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    nextWorkPower[i] = followingWork;
    if (workPowers[i] != null) followingWork = workPowers[i];
  }
  const firstWorkIndex = candidates.indexOf(work[0]);
  const lastWorkIndex = candidates.lastIndexOf(work[work.length - 1]);
  const underMinPower = minWork * UNDER_LAP_POWER_RATIO;
  const localWorkPower = (index: number): number => {
    const prev = prevWorkPower[index];
    const next = nextWorkPower[index];
    if (prev != null && next != null) return Math.max(prev, next);
    return prev ?? next ?? minWork;
  };
  const isUnder = (index: number, avgPower: number): boolean =>
    index > firstWorkIndex &&
    index < lastWorkIndex &&
    avgPower >= underMinPower &&
    avgPower >= localWorkPower(index) * UNDER_LAP_LOCAL_WORK_RATIO;

  // Führende Warmup-Rampe: Steigen die ersten Laps monoton an, kreuzen dabei
  // die Schwelle und fallen anschließend auf Erholungsniveau, sind die
  // Work-Laps dieser Rampe Warmup – keine Intervalle. Ein einzelner Work-Lap
  // am Rampenende (z. B. der erste Over-Under-Rep) bleibt erhalten, damit
  // strukturierte Workouts nicht beschnitten werden.
  const isRestLap = (index: number): boolean =>
    candidates[index].interval.avgPower < options.thresholdW &&
    !isUnder(index, candidates[index].interval.avgPower);
  const warmupWorkIndices = new Set<number>();
  {
    let end = 0;
    while (end < candidates.length - 1) {
      const current = candidates[end].interval.avgPower;
      const next = candidates[end + 1].interval.avgPower;
      if (next < current * 0.97) break;
      end += 1;
    }
    if (end < candidates.length - 1 && isRestLap(end + 1)) {
      const prefix = candidates.slice(0, end + 1);
      const workIndices = prefix
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.interval.avgPower >= options.thresholdW)
        .map(({ index }) => index);
      const hasBelow = prefix.some(
        (entry) => entry.interval.avgPower < options.thresholdW,
      );
      if (hasBelow && workIndices.length >= 2) {
        for (const index of workIndices) warmupWorkIndices.add(index);
      }
    }
  }

  const restEntries = candidates.filter(
    (entry, index) =>
      entry.interval.avgPower < options.thresholdW &&
      !isUnder(index, entry.interval.avgPower),
  );
  const referenceEntries =
    restEntries.length > 0 ? restEntries : below;
  const maxRest = Math.max(
    ...referenceEntries.map((entry) => entry.interval.avgPower),
  );

  // Laps sind nur dann eine verlässliche Workout-Struktur, wenn Belastung
  // und Erholung klar getrennt sind. Auto-Laps auf gleichmäßigen Fahrten
  // liegen dagegen dicht an der Schwelle und dürfen keine Intervalle
  // erzeugen. Das gilt auch für den Einzelblock-Fall (z. B. ein 30-min-
  // Tempoblock zwischen Warm-up und Cool-down).
  const minSeparation = Math.max(15, options.thresholdW * 0.08);
  if (minWork - maxRest < minSeparation) return null;

  const intervals: IntervalCore[] = [];
  const workIntervals: IntervalCore[] = [];

  // Under-Laps beziehen ihren Kontrast auf die echte Erholungsumgebung
  // (Work-Laps maskiert), nicht auf die stärkste Pausenlap – die ist bei
  // Over-Under-Workouts selbst eine Under-Lap, was den Kontrast auf 0
  // drücken würde. Der Rand des Masks wird um wenige Sekunden gepuffert,
  // damit Übergangsproben an Lap-Grenzen (inkl. Mikro-Laps) nicht als
  // Erholungsreferenz durchrutschen.
  const powers = points.map((point) => point.power ?? 0);
  const workCovered = new Uint8Array(powers.length);
  const pad = Math.max(3, Math.round(options.smoothingSeconds));
  for (const entry of candidates) {
    if (entry.interval.avgPower >= options.thresholdW) {
      workCovered.fill(
        1,
        Math.max(0, entry.interval.start - pad),
        Math.min(workCovered.length, entry.interval.end + pad),
      );
    }
  }

  candidates.forEach((entry, index) => {
    if (warmupWorkIndices.has(index)) return;
    const isWork = entry.interval.avgPower >= options.thresholdW;
    const under = !isWork && isUnder(index, entry.interval.avgPower);
    if (!isWork && !under) return;
    const core: IntervalCore = {
      ...entry.interval,
      source: 'lap',
      under: under || undefined,
      contrast: isWork
        ? lapContrast(entry.interval.avgPower, maxRest)
        : intervalContrast(
            powers,
            entry.interval.start,
            entry.interval.end,
            workCovered,
          ),
    };
    intervals.push(core);
    if (isWork) workIntervals.push(core);
  });

  return { intervals, workIntervals, minWork, maxRest };
}

/** Kontrast eines Work-Laps zur stärksten Erholungslap (0–1). */
function lapContrast(avgPower: number, maxRest: number): number {
  const reference = Math.max(1, maxRest);
  return clamp01((avgPower - reference) / reference);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Deckung der Lap-Intervalle durch die Power-Intervalle (0–1). Die Overlaps
 * aller Power-Intervalle pro Lap werden aufsummiert (die Power-Erkennung darf
 * eine Lap auch in mehrere Intervalle zerlegen). Liegt die Vereinigung hoch,
 * bestätigen sich beide Pfade gegenseitig und die exakten Lap-Grenzen gewinnen.
 */
function lapPowerMatchRatio(
  lapIntervals: IntervalCore[],
  powerIntervals: IntervalCore[],
): number {
  if (lapIntervals.length === 0) return 0;
  let coveredSeconds = 0;
  let lapSeconds = 0;
  for (const lap of lapIntervals) {
    lapSeconds += lap.duration;
    let overlap = 0;
    for (const power of powerIntervals) {
      overlap += Math.max(
        0,
        Math.min(lap.end, power.end) - Math.max(lap.start, power.start),
      );
    }
    if (overlap > lap.duration * LAP_POWER_OVERLAP_RATIO) {
      coveredSeconds += lap.duration;
    }
  }
  return lapSeconds > 0 ? coveredSeconds / lapSeconds : 0;
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
    covered.fill(
      1,
      Math.max(0, interval.start),
      Math.min(covered.length, interval.end),
    );
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
  const wide = scoreInterval(
    powers,
    covered,
    only.interval,
    WIDE_RECOVERY_WINDOW_SECONDS,
  );
  return wide.keep && wide.strong ? [only.interval] : [];
}

function scoreInterval(
  powers: readonly number[],
  covered: Uint8Array,
  interval: IntervalCore,
  windowSeconds: number,
): { interval: IntervalCore; keep: boolean; strong: boolean } {
  const before = meanOfRecovery(powers, interval.start, -1, windowSeconds, covered);
  const after = meanOfRecovery(powers, interval.end, 1, windowSeconds, covered);
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
 * Intervallbereiche (falls `covered` übergeben wird).
 */
function meanOfRecovery(
  powers: readonly number[],
  start: number,
  direction: -1 | 1,
  windowSeconds: number,
  covered?: Uint8Array,
): number | null {
  let sum = 0;
  let count = 0;
  let index = direction === -1 ? start - 1 : start;
  const limit =
    direction === -1
      ? Math.max(0, start - windowSeconds)
      : Math.min(powers.length, start + windowSeconds);

  while (direction === -1 ? index >= limit : index < limit) {
    if (covered != null && covered[index] !== 0) {
      index += direction;
      continue;
    }
    const power = powers[index];
    if (Number.isFinite(power) && power >= 20) {
      sum += power;
      count += 1;
    }
    index += direction;
  }
  return count >= 5 ? sum / count : null;
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
    const nextStart =
      index < trimmed.length - 1 ? trimmed[index + 1][0] : powers.length;
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
 * Korrigiert den Leistungsschnitt eines kurzen Lap-Intervalls um die
 * Übergangssekunden an den Rändern. ERG-Trainer und Leistungsmesser folgen
 * einer neuen Vorgabe mit ~2–3 s Verzögerung: Der Lap beginnt bereits, während
 * die Leistung noch auf dem alten Niveau liegt (bzw. umgekehrt). Dadurch
 * mittelt z. B. ein 40-s-Lap bei 360 W nur ~350 W.
 *
 * Wenn der Leistungspfad denselben Block als eigenes Intervall erkennt, wird
 * der Schnitt über die Schnittmenge beider Fenster gebildet. So bleiben
 * Lap-Grenzen und -Dauer unverändert, aber die Übergangssekunden fließen nicht
 * in die Leistung ein. Lange Blöcke und zusammengefasste Over-Under-Blöcke
 * (Leistungsintervall deutlich länger als der Lap) bleiben unberührt.
 */
function refineLapIntervalPower(
  interval: IntervalCore,
  points: RideSeries['points'],
  powerIntervals: readonly IntervalCore[],
): IntervalCore {
  if (interval.duration > LAP_EDGE_REFINE_MAX_SECONDS) return interval;

  let best: { reference: IntervalCore; overlap: number } | null = null;
  for (const reference of powerIntervals) {
    const overlap =
      Math.min(interval.end, reference.end) -
      Math.max(interval.start, reference.start);
    if (overlap <= 0) continue;
    const tolerance = Math.max(6, interval.duration * LAP_MATCH_DURATION_RATIO);
    if (Math.abs(reference.duration - interval.duration) > tolerance) continue;
    if (overlap < interval.duration * LAP_MATCH_MIN_OVERLAP_RATIO) continue;
    if (best == null || overlap > best.overlap) best = { reference, overlap };
  }
  if (best == null) return interval;

  const start = Math.max(interval.start, best.reference.start);
  const end = Math.min(interval.end, best.reference.end);
  if (end - start < interval.duration * LAP_MATCH_MIN_OVERLAP_RATIO) {
    return interval;
  }

  let powerSum = 0;
  let powerCount = 0;
  for (let i = start; i < end && i < points.length; i++) {
    const power = points[i].power;
    if (power != null) {
      powerSum += power;
      powerCount += 1;
    }
  }
  if (powerCount === 0) return interval;

  const avgPower = powerSum / powerCount;
  return {
    ...interval,
    avgPower,
    workKJ: (avgPower * interval.duration) / 1000,
  };
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
  const heartRates: number[] = [];
  const cadences: number[] = [];

  for (let i = start; i < end && i < points.length; i++) {
    const point = points[i];
    if (point.power != null) {
      powerSum += point.power;
      powerCount += 1;
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
    workKJ: powerSum / 1000,
    source: 'power',
    contrast: 0,
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
    // Over-Under-Erkennung: starke, aber unterschiedliche Reps (z. B. 300/220 W)
    // bleiben im selben Satz, solange die Pause kurz bleibt und das Muster
    // wechselnd hoch/tief ist. Ein großer Intensitätssprung allein spaltet nicht.
    const split = gap > setBreakSeconds || intensityDelta > 0.5;

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
  /** Durchschnittliche Leistung pro Rep (Paar bzw. Step-Gruppe). */
  repPowers: number[];
}

function resolveSetStructure(
  intervals: readonly Interval[],
): SetStructure {
  const groups = groupConsecutiveIntervals(intervals, 2);
  const hasSubSteps = groups.length >= 2 && groups.some((group) => group.length >= 2);

  if (hasSubSteps) {
    const pattern = groups[0].map((interval) => Math.round(interval.duration));
    const consistent = groups.every(
      (group) =>
        group.length === pattern.length &&
        group.every(
          (interval, index) =>
            Math.abs(interval.duration - pattern[index]) <=
            Math.max(6, pattern[index] * 0.1),
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
        repPowers: groups.map((group) => durationWeightedPower(group)),
      };
    }
  }

  // Over-Unter-Struktur: die Intervalle wechseln hoch/tief und liegen
  // direkt aneinander (eine Rep = hoch + tief). Ein unvollständiges
  // Schluss-Rep (nur der hohe Anteil) wird toleriert.
  if (isOverUnder(intervals)) {
    const pairCount = Math.floor(intervals.length / 2);
    const pairs: Interval[][] = [];
    for (let i = 0; i < pairCount; i++) {
      pairs.push([intervals[i * 2], intervals[i * 2 + 1]]);
    }
    const trailing =
      intervals.length % 2 === 1 ? intervals[intervals.length - 1] : null;

    // Pattern aus den Median-Dauern je Position – einzelne abweichende
    // Reps (z. B. 181 s statt 180 s) vermasseln so nicht das Muster.
    const pattern = [0, 1].map((position) =>
      Math.round(median(pairs.map((pair) => pair[position].duration))),
    );
    const consistent = pairs.every((pair) =>
      pair.every(
        (interval, index) =>
          Math.abs(interval.duration - pattern[index]) <=
          Math.max(6, pattern[index] * 0.1),
      ),
    );

    if (consistent) {
      const gaps: number[] = [];
      for (let i = 1; i < pairs.length; i++) {
        const previous = pairs[i - 1][pairs[i - 1].length - 1];
        gaps.push(Math.max(0, pairs[i][0].start - previous.end));
      }
      const repPowers = pairs.map((pair) => durationWeightedPower(pair));
      if (trailing != null) repPowers.push(trailing.avgPower);
      return {
        reps: pairCount + (trailing != null ? 1 : 0),
        onSeconds: median(intervals.map((interval) => interval.duration)),
        offSeconds: gaps.length > 0 ? median(gaps) : 0,
        patternSeconds: pattern,
        repPowers,
      };
    }
  }

  // Ein einzelner, durchgehender Block aus mehreren Laps (keine Pause
  // dazwischen) ist eine Wiederholung mit Unter-Schritten, keine Sammlung
  // von Reps. Beispiel: ein Over-Under-Block 120/120/45/90/45/120/120.
  // Over-Under-Sätze mit wiederholtem Hoch/Tief-Muster wurden oben bereits
  // in Paare zerlegt.
  if (groups.length === 1 && groups[0].length >= 3) {
    return {
      reps: 1,
      onSeconds: median(intervals.map((interval) => interval.duration)),
      offSeconds: 0,
      patternSeconds: groups[0].map((interval) => Math.round(interval.duration)),
      repPowers: [durationWeightedPower(groups[0])],
    };
  }

  const gaps: number[] = [];
  for (let i = 1; i < intervals.length; i++) {
    gaps.push(Math.max(0, intervals[i].start - intervals[i - 1].end));
  }
  return {
    reps: intervals.length,
    onSeconds: median(intervals.map((interval) => interval.duration)),
    offSeconds: gaps.length > 0 ? median(gaps) : 0,
    repPowers: intervals.map((interval) => interval.avgPower),
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

/** Dauer-gewichtete Mittelleistung einer Rep-Gruppe (Paar bzw. Steps). */
function durationWeightedPower(
  intervals: readonly Interval[],
): number {
  const duration = intervals.reduce((sum, interval) => sum + interval.duration, 0);
  if (duration <= 0) return 0;
  return (
    intervals.reduce(
      (sum, interval) => sum + interval.avgPower * interval.duration,
      0,
    ) / duration
  );
}

/**
 * Erkennt Over-Under-Sätze: wechselnde hohe und niedrige Leistungen innerhalb
 * eines Satzes (z. B. 3 min über / 3 min unter einem mittleren Niveau).
 *
 * Das Zentrum wird aus der Trennstelle der beiden Leistungsgruppen bestimmt
 * (Maximum der unteren Hälfte, Minimum der oberen Hälfte). Ein Median versagt
 * bei ungleichen Gruppengrößen: 6 × 277 W + 5 × 229 W hätten den Median 277,
 * sodass keine Hoch-Gruppe mehr gefunden würde.
 */
function isOverUnder(intervals: readonly Interval[]): boolean {
  if (intervals.length < 3) return false;
  const powers = intervals.map((interval) => interval.avgPower);
  const sorted = [...powers].sort((a, b) => a - b);
  const lowerHalf = sorted.slice(0, Math.floor(sorted.length / 2));
  const upperHalf = sorted.slice(Math.ceil(sorted.length / 2));
  const center = (Math.max(...lowerHalf) + Math.min(...upperHalf)) / 2;
  const highBand = center * 1.08;
  const lowBand = center * 0.92;
  const highs = powers.filter((power) => power > highBand);
  const lows = powers.filter((power) => power < lowBand);
  if (highs.length < 2 || lows.length < 2) return false;
  // Wechselt hoch/tief mindestens zweimal?
  let alternations = 0;
  for (let i = 1; i < powers.length; i++) {
    const prevHigh = powers[i - 1] > highBand;
    const currHigh = powers[i] > highBand;
    if (prevHigh !== currHigh) alternations += 1;
  }
  return alternations >= 2;
}

function buildSet(
  id: number,
  intervals: Interval[],
): WorkoutSet {
  const start = intervals[0].start;
  const end = intervals[intervals.length - 1].end;
  const totalDuration = intervals.reduce((sum, interval) => sum + interval.duration, 0);
  const structure = resolveSetStructure(intervals);
  const { reps, onSeconds, offSeconds } = structure;
  const targetPower = roundTo(median(structure.repPowers), 5);
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

  const hasUnderStep =
    structure.patternSeconds != null &&
    structure.patternSeconds.length >= 3 &&
    intervals.some((interval) => interval.under === true);
  const kind =
    isOverUnder(intervals) || hasUnderStep ? 'over-under' : 'uniform';

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
    kind,
    targetPower,
    avgPower,
    maxPower: Math.max(...intervals.map((interval) => interval.maxPower)),
    avgHeartRate,
    workKJ: intervals.reduce((sum, interval) => sum + interval.workKJ, 0),
    label,
    intervals,
  };
}

function buildPhases(
  duration: number,
  sets: readonly WorkoutSet[],
  source?: 'laps' | 'workout',
): Phase[] {
  if (sets.length === 0) {
    return [{ kind: 'ride', start: 0, end: duration, label: 'Fahrt', source }];
  }

  const phases: Phase[] = [];
  const first = sets[0];
  const last = sets[sets.length - 1];

  if (first.start > 1) {
    phases.push({
      kind: 'warmup',
      start: 0,
      end: first.start,
      label: 'Warm-up',
      source,
    });
  }

  sets.forEach((set, index) => {
    phases.push({
      kind: 'set',
      start: set.start,
      end: set.end,
      label: `Satz ${set.id}`,
      setId: set.id,
      source,
    });
    if (index < sets.length - 1) {
      const next = sets[index + 1];
      if (next.start > set.end + 1) {
        phases.push({
          kind: 'recovery',
          start: set.end,
          end: next.start,
          label: 'Erholung',
          source,
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
      source,
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
