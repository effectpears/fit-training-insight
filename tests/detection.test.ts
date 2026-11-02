import { describe, expect, it } from 'vitest';
import { analyzeRide } from '../src/analysis/analyze';
import { buildSeries } from '../src/analysis/series';
import { DEFAULT_OPTIONS } from '../src/config';
import { createDemoRide } from '../src/fit/demoRide';

describe('Intervallererkennung – Demo-Fahrt', () => {
  const ride = createDemoRide();
  const series = buildSeries(ride.records);
  const analysis = analyzeRide(
    series,
    { ...DEFAULT_OPTIONS },
    ride.session.totalDistance ?? null,
  );

  it('baut eine vollständige 1-Hz-Zeitreihe', () => {
    expect(series.sampleRate).toBe(1);
    expect(series.points.length).toBe(ride.records.length);
    expect(series.duration).toBeGreaterThan(2400);
    expect(series.duration).toBeLessThan(2500);
  });

  it('erkennt genau drei Sätze', () => {
    expect(analysis.sets).toHaveLength(3);
    expect(analysis.sets.map((set) => set.reps)).toEqual([6, 4, 3]);
  });

  it('trifft die Zielleistungen der Sätze', () => {
    const [first, second, third] = analysis.sets;
    expect(first.targetPower).toBeGreaterThanOrEqual(300);
    expect(first.targetPower).toBeLessThanOrEqual(325);
    expect(second.targetPower).toBeGreaterThanOrEqual(270);
    expect(second.targetPower).toBeLessThanOrEqual(300);
    expect(third.targetPower).toBeGreaterThanOrEqual(380);
    expect(third.targetPower).toBeLessThanOrEqual(410);
  });

  it('erkennt 30/30- und 60/60-Strukturen', () => {
    expect(analysis.sets[0].onSeconds).toBeGreaterThan(28);
    expect(analysis.sets[0].onSeconds).toBeLessThan(32);
    expect(analysis.sets[0].offSeconds).toBeGreaterThan(28);
    expect(analysis.sets[0].offSeconds).toBeLessThan(32);
    expect(analysis.sets[1].onSeconds).toBeGreaterThan(58);
    expect(analysis.sets[1].offSeconds).toBeGreaterThan(58);
  });

  it('berechnet plausible Kennzahlen', () => {
    expect(analysis.metrics.avgPower).toBeGreaterThan(170);
    expect(analysis.metrics.maxPower).toBeGreaterThan(390);
    expect(analysis.metrics.normalizedPower).toBeGreaterThan(
      analysis.metrics.avgPower,
    );
    expect(analysis.metrics.workKJ).toBeGreaterThan(400);
    expect(analysis.thresholdW).toBeGreaterThan(180);
    expect(analysis.thresholdW).toBeLessThan(300);
  });

  it('erzeugt Warm-up, Satz- und Cool-down-Phasen', () => {
    expect(analysis.phases[0].kind).toBe('warmup');
    expect(analysis.phases.some((phase) => phase.kind === 'set')).toBe(true);
    expect(analysis.phases.at(-1)?.kind).toBe('cooldown');
  });
});

describe('Kontrastprüfung', () => {
  it('behält einen einzelnen deutlich abgesetzten Block', () => {
    const start = Date.UTC(2026, 5, 1, 8, 0, 0);
    const records = Array.from({ length: 1800 }, (_, second) => ({
      timestamp: start + second * 1000,
      power: second < 600 ? 100 : second < 1200 ? 300 : 100,
    }));

    const result = analyzeRide(
      buildSeries(records),
      {
        ...DEFAULT_OPTIONS,
        autoThreshold: false,
        thresholdW: 200,
        minOnSeconds: 10,
        minOffSeconds: 10,
      },
      null,
    );

    expect(result.sets).toHaveLength(1);
    expect(result.intervals).toHaveLength(1);
    expect(result.sets[0].targetPower).toBe(300);
  });
});
