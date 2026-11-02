import { describe, expect, it } from 'vitest';
import { buildSeries } from '../src/analysis/series';
import type { FitRecord } from '../src/types';

const START = Date.UTC(2026, 0, 1, 8, 0, 0);

function record(offsetSeconds: number, power?: number): FitRecord {
  return { timestamp: START + offsetSeconds * 1000, power };
}

describe('buildSeries', () => {
  it('interpoliert unregelmäßige Messpunkte auf 1 Hz', () => {
    const series = buildSeries([record(0, 100), record(2, 200)]);
    expect(series.points.map((point) => point.power)).toEqual([100, 150, 200]);
  });

  it('lässt lange Sensorlücken als null stehen', () => {
    const series = buildSeries([record(0, 200), record(1, 210), record(30, 220)]);
    expect(series.points[0].power).toBe(200);
    expect(series.points[5].power).toBeNull();
    expect(series.points[20].power).toBeNull();
    expect(series.points[30].power).toBe(220);
  });

  it('verwirft unsortierte und ungültige Werte korrekt', () => {
    const series = buildSeries([
      record(3, 300),
      record(0, 100),
      record(1, -50),
      record(2, Number.NaN),
    ]);
    expect(series.points[0].power).toBe(100);
    expect(series.points[1].power).toBeCloseTo(166.67, 1);
    expect(series.points[3].power).toBe(300);
  });

  it('nutzt den letzten Wert bei doppeltem Zeitstempel', () => {
    const series = buildSeries([
      { timestamp: START, power: 100 },
      { timestamp: START, power: 250 },
      { timestamp: START + 1000, power: 260 },
    ]);
    expect(series.points[0].power).toBe(250);
  });
});
