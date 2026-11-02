import type { SeriesPoint } from '../types';

/**
 * LTTB-Downsampling, segmentweise angewendet. Lücken (null-Leistung) werden
 * nicht überbrückt, damit Sensorausfälle im Chart als Lücke sichtbar bleiben.
 */
export function downsampleSeries(
  points: readonly SeriesPoint[],
  target = 2400,
): SeriesPoint[] {
  if (points.length <= target) return [...points];

  const segments: SeriesPoint[][] = [];
  let current: SeriesPoint[] = [];
  for (const point of points) {
    if (point.power == null) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    current.push(point);
  }
  if (current.length > 0) segments.push(current);
  if (segments.length === 0) return [...points];

  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  const result: SeriesPoint[] = [];

  for (const segment of segments) {
    const budget = Math.max(
      3,
      Math.min(segment.length, Math.round((target * segment.length) / total)),
    );
    const sampled = largestTriangleThreeBuckets(segment, budget);
    if (result.length > 0) {
      result.push({
        t: sampled[0].t - 0.001,
        power: null,
        heartRate: null,
        cadence: null,
        speed: null,
      });
    }
    result.push(...sampled);
  }

  return result;
}

function largestTriangleThreeBuckets(
  points: readonly SeriesPoint[],
  threshold: number,
): SeriesPoint[] {
  const length = points.length;
  if (length <= 2 || threshold >= length) return [...points];
  if (threshold <= 1) return [points[0]];
  if (threshold === 2) return [points[0], points[length - 1]];

  const sampled: SeriesPoint[] = [points[0]];
  const every = (length - 2) / (threshold - 2);
  let a = 0;

  for (let i = 0; i < threshold - 2; i++) {
    const averageStart = Math.floor((i + 1) * every) + 1;
    const averageEnd = Math.min(Math.floor((i + 2) * every) + 1, length);
    let averageX = 0;
    let averageY = 0;
    let averageCount = 0;

    for (let j = averageStart; j < averageEnd; j++) {
      averageX += points[j].t;
      averageY += points[j].power ?? 0;
      averageCount += 1;
    }
    if (averageCount === 0) {
      const last = points[length - 1];
      averageX = last.t;
      averageY = last.power ?? 0;
    } else {
      averageX /= averageCount;
      averageY /= averageCount;
    }

    const rangeStart = Math.floor(i * every) + 1;
    const rangeEnd = Math.min(Math.floor((i + 1) * every) + 1, length - 1);
    const ax = points[a].t;
    const ay = points[a].power ?? 0;

    let maxArea = -1;
    let nextA = Math.min(rangeStart, length - 2);

    for (let j = rangeStart; j < rangeEnd; j++) {
      const px = points[j].t;
      const py = points[j].power ?? 0;
      const area = Math.abs(
        (ax - averageX) * (py - ay) - (ax - px) * (averageY - ay),
      );
      if (area > maxArea) {
        maxArea = area;
        nextA = j;
      }
    }

    sampled.push(points[nextA]);
    a = nextA;
  }

  sampled.push(points[length - 1]);
  return sampled;
}
