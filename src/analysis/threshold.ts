import { clamp, percentile } from './math';

const MAX_WATT = 3000;

export interface ThresholdEstimate {
  thresholdW: number;
  /** 0–1: Wie klar die Leistung bimodal verteilt ist (1 = sehr klar). */
  confidence: number;
  /** Anteil der Zeit über der Schwelle (0–1). */
  onFraction: number;
  method: 'two-means' | 'otsu' | 'percentile';
}

/**
 * Schätzt eine sinnvolle ON-Schwelle aus dem Leistungsprofil.
 *
 * Kern ist ein eindimensionales 2-Means über ein 1-W-Histogramm: das globale
 * Optimum der Within-Cluster-Variation wird per Scan über alle Trennwerte
 * bestandlos bestimmt (identisch zum Otsu-Kriterium). Ein zusätzlicher
 * Lloyd-Lauf (2-Means mit p25/p75-Start) dient als Kreuzprüfung: stimmen
 * beide Trennwerte überein, ist die Zweimodalität besonders eindeutig.
 *
 * Die Konfidenz setzt sich aus dem erklärten Varianzanteil (η²), der
 * Trennschärfe der Cluster und der Kreuzprüfung zusammen. Ist die Verteilung
 * nicht klar zweigipflig (z. B. gleichmäßige Endurance-Fahrt), fällt die
 * Schätzung auf ein oberes Perzentil zurück und die Konfidenz sinkt – so
 * entstehen keine hunderte Pseudo-Intervalle.
 */
export function estimateThreshold(
  powers: readonly number[],
): ThresholdEstimate {
  const values = powers
    .filter((value) => Number.isFinite(value))
    .map((value) => clamp(value, 0, MAX_WATT));

  if (values.length === 0) {
    return { thresholdW: 200, confidence: 0, onFraction: 0, method: 'percentile' };
  }

  const positive = values.filter((value) => value >= 20);
  if (positive.length < 10) {
    return { thresholdW: 150, confidence: 0, onFraction: 0, method: 'percentile' };
  }

  const p50 = percentile(positive, 0.5);
  const p85 = percentile(positive, 0.85);
  const p90 = percentile(positive, 0.9);
  const p95 = percentile(positive, 0.95);
  const maxValue = percentile(positive, 1);
  if (maxValue <= 0) {
    return { thresholdW: 150, confidence: 0, onFraction: 0, method: 'percentile' };
  }

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

  // Anzahl der Werte ≥ t (für den ON-Anteil).
  const ge = new Uint32Array(bins + 1);
  for (let i = bins - 1; i >= 0; i--) ge[i] = ge[i + 1] + histogram[i];

  const meanValue = sum / total;
  let varianceTotal = 0;
  for (let i = 0; i < bins; i++) {
    if (histogram[i] === 0) continue;
    varianceTotal += histogram[i] * (i - meanValue) ** 2;
  }

  // Globaler 2-Means-Scan (Otsu-Kriterium): maximiere die Zwischenvarianz.
  let weightBackground = 0;
  let sumBackground = 0;
  let bestVariance = 0;
  let bestThreshold = 0;
  let bestMeanBackground = 0;
  let bestMeanForeground = 0;
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
      bestMeanBackground = meanBackground;
      bestMeanForeground = meanForeground;
    }
  }

  // η² = erklärter Varianzanteil der Zwei-Cluster-Aufteilung (0–1).
  const eta =
    varianceTotal > 0 && total > 0
      ? bestVariance / varianceTotal / total
      : 0;
  const etaSafe = Number.isFinite(eta) ? eta : 0;
  const onFractionOtsu = ge[Math.min(bins, bestThreshold)] / total;
  const separationOtsu =
    maxValue > 0
      ? (bestMeanForeground - bestMeanBackground) / maxValue
      : 0;

  // 2-Means (Lloyd) als Kreuzprüfung der Cluster-Zentren.
  const centers = twoMeansCenters(
    histogram,
    bins,
    percentile(positive, 0.25),
    percentile(positive, 0.75),
  );
  let agrees = false;
  if (centers != null) {
    const splitLloyd = (centers[0] + centers[1]) / 2;
    agrees = Math.abs(splitLloyd - bestThreshold) <= Math.max(15, bestThreshold * 0.15);
  }

  // Zweimalmodus-Guardrails wie bewährt: der ON-Anteil muss eine Minderheit
  // bleiben, sonst ist die "Struktur" nur Rauschen um den Mittelwert.
  const bimodal =
    etaSafe > 0.05 &&
    onFractionOtsu >= 0.015 &&
    onFractionOtsu <= 0.68;

  let threshold: number;
  let confidence: number;
  let method: ThresholdEstimate['method'];

  if (bimodal) {
    threshold = bestThreshold;
    method = agrees ? 'two-means' : 'otsu';
    confidence = clamp(
      etaSafe * 0.7 + Math.min(1, separationOtsu) * 0.5 + (agrees ? 0.1 : 0),
      0,
      1,
    );
  } else {
    // Fallback: leicht unter dem oberen Perzentil, geringe Konfidenz.
    threshold = p85 * 0.95;
    if (ge[Math.min(bins, Math.round(threshold))] / total > 0.65) {
      threshold = p90;
    }
    threshold = Math.max(threshold, p50 * 0.85);
    confidence = Math.min(0.3, 0.05 + etaSafe * 0.25);
    method = 'percentile';
  }

  threshold = clamp(threshold, 40, p95 * 1.08);
  const thresholdRounded = Math.max(10, Math.round(threshold / 5) * 5);
  const onFraction = ge[Math.min(bins, thresholdRounded)] / total;

  return {
    thresholdW: thresholdRounded,
    confidence: Math.round(confidence * 100) / 100,
    onFraction: Math.round(onFraction * 1000) / 1000,
    method,
  };
}

/**
 * Gewichteter 2-Means-Lauf (Lloyd) auf dem Histogramm. Startwerte sind das
 * untere und obere Quartil der positiven Leistungen.
 */
function twoMeansCenters(
  histogram: Uint32Array,
  bins: number,
  initLow: number,
  initHigh: number,
): [number, number] | null {
  if (!(initHigh > initLow)) return null;
  let c1 = initLow;
  let c2 = initHigh;

  for (let iteration = 0; iteration < 100; iteration++) {
    const boundary = (c1 + c2) / 2;
    let sum1 = 0;
    let count1 = 0;
    let sum2 = 0;
    let count2 = 0;
    for (let i = 0; i < bins; i++) {
      const count = histogram[i];
      if (count === 0) continue;
      if (i <= boundary) {
        sum1 += i * count;
        count1 += count;
      } else {
        sum2 += i * count;
        count2 += count;
      }
    }
    if (count1 === 0 || count2 === 0) return null;
    const next1 = sum1 / count1;
    const next2 = sum2 / count2;
    if (Math.abs(next1 - c1) < 0.25 && Math.abs(next2 - c2) < 0.25) {
      return [Math.min(next1, next2), Math.max(next1, next2)];
    }
    c1 = next1;
    c2 = next2;
  }
  return [Math.min(c1, c2), Math.max(c1, c2)];
}

/**
 * Kompatibilitäts-Wrapper für die bestehende Aufrufer-Signatur.
 * Liefert nur die Schwelle; die detaillierte Info ist in
 * `estimateThreshold` enthalten.
 */
export function suggestThreshold(powers: readonly number[]): number {
  return estimateThreshold(powers).thresholdW;
}
