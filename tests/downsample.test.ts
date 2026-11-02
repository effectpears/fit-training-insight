import { describe, expect, it } from 'vitest';
import { downsampleSeries } from '../src/chart/downsample';
import type { SeriesPoint } from '../src/types';

function point(t: number, power: number | null): SeriesPoint {
  return { t, power, heartRate: 140, cadence: 90, speed: 8 };
}

describe('downsampleSeries', () => {
  it('behält Start, Ende und Lücken', () => {
    const points = Array.from({ length: 100 }, (_, index) =>
      point(index, index === 50 ? null : 180 + index),
    );
    const result = downsampleSeries(points, 30);

    expect(result.length).toBeLessThan(points.length);
    expect(result[0].t).toBe(0);
    expect(result.at(-1)?.t).toBe(99);
    expect(result.some((entry) => entry.power === null)).toBe(true);
  });

  it('lässt kurze Reihen unverändert', () => {
    const points = Array.from({ length: 10 }, (_, index) => point(index, 200));
    expect(downsampleSeries(points, 30)).toHaveLength(10);
  });
});
