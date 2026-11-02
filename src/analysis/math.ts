/** Kleine numerische Helfer, bewusst ohne externe Abhängigkeiten. */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Median; verändert das Eingabe-Array nicht. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Lineare Perzentile (q zwischen 0 und 1). */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = clamp(q, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (pos - lower);
}

export function roundTo(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.round(value / step) * step;
}

/**
 * Zentrierter gleitender Mittelwert.
 * `window` ist die Fensterbreite in Samples; gerade Werte werden auf die
 * nächstgrößere ungerade Zahl erweitert, damit die Zentrierung symmetrisch ist.
 */
export function movingAverage(values: readonly number[], window: number): number[] {
  const size = Math.max(1, Math.round(window));
  if (size <= 1 || values.length === 0) return [...values];
  const half = Math.floor(size / 2);
  const prefix = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i++) prefix[i + 1] = prefix[i] + values[i];

  const out = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length, i + half + 1);
    out[i] = (prefix[hi] - prefix[lo]) / (hi - lo);
  }
  return out;
}

/**
 * Normalized Power (30-s-Fenster, vierte Potenz). Gaps werden als 0 W gewertet,
 * weil sie in der Praxis Leistungsabbrüche sind.
 */
export function normalizedPower(powers: readonly number[], sampleRate = 1): number {
  if (powers.length === 0) return 0;
  const window = Math.max(1, Math.round(30 * sampleRate));
  if (powers.length < window) return mean(powers);

  const prefix = new Float64Array(powers.length + 1);
  for (let i = 0; i < powers.length; i++) prefix[i + 1] = prefix[i] + powers[i];

  let fourthSum = 0;
  for (let i = 0; i < powers.length; i++) {
    const lo = Math.max(0, i - window + 1);
    const avg = (prefix[i + 1] - prefix[lo]) / (i + 1 - lo);
    fourthSum += avg ** 4;
  }
  return (fourthSum / powers.length) ** 0.25;
}
