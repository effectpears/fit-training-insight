import type {
  AnalysisResult,
  DetectionOptions,
  FitLap,
  RideSeries,
} from '../types';
import { detectIntervals } from './detect';
import { computeMetrics } from './metrics';
import { suggestThreshold } from './threshold';

/**
 * Führt die komplette Analyse aus. Im Auto-Modus wird die Schwelle aus der
 * aktuellen Zeitreihe geschätzt; der Rückgabewert enthält die tatsächlich
 * verwendete Schwelle.
 */
export function analyzeRide(
  series: RideSeries,
  options: DetectionOptions,
  distanceM: number | null = null,
  laps: readonly FitLap[] = [],
): AnalysisResult {
  const thresholdW = options.autoThreshold
    ? suggestThreshold(series.points.map((point) => point.power ?? 0))
    : Math.max(10, Math.round(options.thresholdW));

  const resolved: DetectionOptions = { ...options, thresholdW };
  const { intervals, sets, phases } = detectIntervals(series, resolved, laps);
  const metrics = computeMetrics(series, resolved, thresholdW, distanceM);

  return {
    series,
    intervals,
    sets,
    phases,
    metrics,
    thresholdW,
    options: resolved,
  };
}
