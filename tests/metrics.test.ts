import { describe, expect, it } from 'vitest';
import { computeMetrics } from '../src/analysis/metrics';
import { buildSeries } from '../src/analysis/series';
import { DEFAULT_OPTIONS } from '../src/config';
import type { FitRecord } from '../src/types';

const START = Date.UTC(2026, 0, 1, 8, 0, 0);

function record(
  second: number,
  overrides: Partial<FitRecord> = {},
): FitRecord {
  return {
    timestamp: START + second * 1000,
    power: 200,
    heartRate: 140,
    cadence: 85,
    speed: 9,
    ...overrides,
  };
}

describe('Ride-Metriken (Stillstand / HR-only)', () => {
  it('zählt Stillstand über speed=0 und power=0', () => {
    const records: FitRecord[] = [];
    // 60 s Fahrt, davon 10 s Stillstand am Ende.
    for (let second = 0; second < 50; second++) records.push(record(second));
    for (let second = 50; second < 60; second++)
      records.push(record(second, { speed: 0, power: 0 }));

    const series = buildSeries(records);
    const metrics = computeMetrics(
      series,
      { ...DEFAULT_OPTIONS, thresholdW: 200, autoThreshold: false },
      200,
      null,
    );

    expect(metrics.duration).toBe(59);
    expect(metrics.movingTime).toBe(50);
    expect(metrics.stoppedSeconds).toBe(10);
  });

  it('ignoriert Datenlücken als Stillstand', () => {
    const records: FitRecord[] = [];
    for (let second = 0; second < 30; second++) records.push(record(second));
    // Lücke ohne Messwerte.
    for (let second = 30; second < 40; second++)
      records.push(record(second, { speed: undefined, power: undefined }));

    const series = buildSeries(records);
    const metrics = computeMetrics(
      series,
      { ...DEFAULT_OPTIONS, thresholdW: 200, autoThreshold: false },
      200,
      null,
    );

    expect(metrics.stoppedSeconds).toBe(0);
  });
});
