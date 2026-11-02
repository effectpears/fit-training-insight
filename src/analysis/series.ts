import type { FitRecord, RideSeries, SeriesPoint } from '../types';

/** Lücken bis zu dieser Länge werden linear interpoliert, längere bleiben leer. */
const MAX_INTERPOLATION_GAP = 15;

interface Anchor {
  t: number;
  value: number;
}

type Channel = Pick<SeriesPoint, 'power' | 'heartRate' | 'cadence' | 'speed'>;

/**
 * Bringt unregelmäßige FIT-Records auf ein 1-Hz-Raster und interpoliert
 * Messlücken. Längere Ausfälle bleiben `null`, damit sie im Chart sichtbar
 * und in der Analyse als 0 W behandelt werden.
 */
export function buildSeries(records: readonly FitRecord[]): RideSeries {
  const sorted = [...records].sort((a, b) => a.timestamp - b.timestamp);
  if (sorted.length < 2) {
    throw new Error('Die FIT-Datei enthält zu wenige Messpunkte.');
  }

  const start = sorted[0].timestamp;
  const end = sorted[sorted.length - 1].timestamp;
  const duration = Math.max(1, Math.round((end - start) / 1000));

  const anchors = {
    power: makeAnchors(sorted, start, (r) => r.power, 0, 3000),
    heartRate: makeAnchors(sorted, start, (r) => r.heartRate, 20, 260),
    cadence: makeAnchors(sorted, start, (r) => r.cadence, 0, 260),
    speed: makeAnchors(sorted, start, (r) => r.speed, 0, 45),
  };

  const points: SeriesPoint[] = new Array(duration + 1);
  for (let t = 0; t <= duration; t++) {
    const channel: Channel = {
      power: sampleAt(anchors.power, t),
      heartRate: sampleAt(anchors.heartRate, t),
      cadence: sampleAt(anchors.cadence, t),
      speed: sampleAt(anchors.speed, t),
    };
    points[t] = { t, ...channel };
  }

  return { points, duration, sampleRate: 1 };
}

function makeAnchors(
  records: readonly FitRecord[],
  startMs: number,
  pick: (record: FitRecord) => number | undefined,
  min: number,
  max: number,
): Anchor[] {
  const anchors: Anchor[] = [];
  let lastT = Number.NaN;

  for (const record of records) {
    const value = pick(record);
    if (value == null || !Number.isFinite(value) || value < min || value > max) continue;
    const t = (record.timestamp - startMs) / 1000;
    if (t < 0) continue;

    if (t === lastT) {
      anchors[anchors.length - 1].value = value;
      continue;
    }
    anchors.push({ t, value });
    lastT = t;
  }
  return anchors;
}

function sampleAt(anchors: readonly Anchor[], t: number): number | null {
  if (anchors.length === 0) return null;
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (t < first.t || t > last.t) return null;

  let lo = 0;
  let hi = anchors.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (anchors[mid].t < t) lo = mid + 1;
    else hi = mid;
  }

  const right = anchors[lo];
  if (right.t === t) return right.value;
  if (lo === 0) return null;

  const left = anchors[lo - 1];
  const gap = right.t - left.t;
  if (gap > MAX_INTERPOLATION_GAP) return null;
  const ratio = (t - left.t) / gap;
  return left.value + (right.value - left.value) * ratio;
}
