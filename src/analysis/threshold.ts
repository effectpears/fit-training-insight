import { clamp, percentile } from './math';

/**
 * Schätzt eine sinnvolle ON-Schwelle aus dem Leistungsprofil.
 *
 * Zuerst wird Otsu auf einem 1-W-Histogramm verwendet. Ist die Verteilung nicht
 * klar zweigipflig (z. B. gleichmäßige Endurance-Fahrt), fällt die Schätzung auf
 * das obere Perzentil zurück. So entstehen keine hunderte Pseudo-Intervalle.
 */
export function suggestThreshold(powers: readonly number[]): number {
  const values = powers
    .filter((value) => Number.isFinite(value))
    .map((value) => clamp(value, 0, 3000));

  if (values.length === 0) return 200;

  const positive = values.filter((value) => value >= 20);
  if (positive.length < 10) return 150;

  const p50 = percentile(positive, 0.5);
  const p85 = percentile(positive, 0.85);
  const p95 = percentile(positive, 0.95);
  const maxValue = percentile(positive, 1);
  if (maxValue <= 0) return 150;

  const bins = Math.max(1, Math.ceil(maxValue));
  const histogram = new Uint32Array(bins);
  let total = 0;
  let sum = 0;
  for (const value of values) {
    const bin = Math.min(bins - 1, Math.max(0, Math.round(value)));
    histogram[bin] += 1;
    total += 1;
    sum += value;
  }

  const meanValue = sum / total;
  let varianceTotal = 0;
  for (let i = 0; i < bins; i++) {
    if (histogram[i] === 0) continue;
    varianceTotal += histogram[i] * (i - meanValue) ** 2;
  }

  let weightBackground = 0;
  let sumBackground = 0;
  let bestVariance = 0;
  let bestThreshold = 0;
  for (let i = 0; i < bins; i++) {
    const count = histogram[i];
    if (count === 0) continue;
    weightBackground += count;
    if (weightBackground === total) break;
    sumBackground += i * count;
    const weightForeground = total - weightBackground;
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const between =
      weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (between > bestVariance) {
      bestVariance = between;
      bestThreshold = i;
    }
  }

  const eta = varianceTotal > 0 ? bestVariance / varianceTotal : 0;
  const onFraction = values.filter((value) => value >= bestThreshold).length / total;

  let threshold = bestThreshold;
  const notBimodal = eta < 0.55 || onFraction > 0.68 || onFraction < 0.015;
  if (notBimodal) threshold = p85 * 0.95;
  if (values.filter((value) => value >= threshold).length / total > 0.65) {
    threshold = percentile(positive, 0.9);
  }

  // Fällt die Schätzung in den Grundrauschbereich, auf die Medianleistung anheben.
  threshold = Math.max(threshold, p50 * 0.85);
  threshold = clamp(threshold, 40, p95 * 1.08);

  return Math.max(10, Math.round(threshold / 5) * 5);
}
