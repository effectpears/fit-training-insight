import type {
  AnalysisResult,
  DetectionOptions,
  FitLap,
  FitWorkout,
  RideSeries,
  ThresholdInfo,
} from '../types';
import { detectIntervals } from './detect';
import { computeMetrics } from './metrics';
import { estimateThreshold } from './threshold';

/**
 * Führt die komplette Analyse aus. Im Auto-Modus wird die Schwelle aus der
 * aktuellen Zeitreihe geschätzt (2-Means mit Konfidenz); der Rückgabewert
 * enthält die tatsächlich verwendete Schwelle sowie die Schätz-Info.
 */
export function analyzeRide(
  series: RideSeries,
  options: DetectionOptions,
  distanceM: number | null = null,
  laps: readonly FitLap[] = [],
  workouts: readonly FitWorkout[] = [],
): AnalysisResult {
  const powers = series.points.map((point) => point.power ?? 0);

  let thresholdW: number;
  let thresholdInfo: ThresholdInfo;

  if (options.autoThreshold) {
    const estimate = estimateThreshold(powers);
    thresholdW = estimate.thresholdW;
    thresholdInfo = {
      thresholdW: estimate.thresholdW,
      auto: true,
      confidence: estimate.confidence,
      onFraction: estimate.onFraction,
      method: estimate.method,
    };
  } else {
    thresholdW = Math.max(10, Math.round(options.thresholdW));
    thresholdInfo = {
      thresholdW,
      auto: false,
      confidence: 1,
      onFraction:
        powers.filter((value) => value >= thresholdW).length / Math.max(1, powers.length),
      method: 'manual',
    };
  }

  const resolved: DetectionOptions = { ...options, thresholdW };
  const { intervals, sets, phases } = detectIntervals(
    series,
    resolved,
    laps,
    workouts,
    thresholdInfo.confidence,
  );
  const metrics = computeMetrics(series, resolved, thresholdW, distanceM);

  return {
    series,
    intervals,
    sets,
    phases,
    metrics,
    thresholdW,
    thresholdInfo,
    options: resolved,
  };
}
