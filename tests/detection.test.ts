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

  it('behält einen einzelnen langen Block mit Rampen-Schultern', () => {
    // Warm-up-Rampe endet knapp unter dem Blockniveau, der Cool-down startet
    // knapp darunter: die unmittelbaren Schulterfenster liegen daher fast auf
    // der Blockleistung. Die weite Referenz (bis 600 s) muss den Block retten.
    const start = Date.UTC(2026, 5, 2, 8, 0, 0);
    const records = Array.from({ length: 3600 }, (_, second) => {
      let power: number;
      if (second < 900) power = 150 + (75 * second) / 900;
      else if (second < 2700) power = 230;
      else power = 185 - (60 * (second - 2700)) / 900;
      return { timestamp: start + second * 1000, power };
    });

    const result = analyzeRide(
      buildSeries(records),
      { ...DEFAULT_OPTIONS, autoThreshold: false, thresholdW: 200 },
      null,
    );

    expect(result.intervals).toHaveLength(1);
    expect(result.sets).toHaveLength(1);
    expect(result.intervals[0].avgPower).toBeGreaterThan(215);
    // Konstantes Plateau → keine Stufen-Annotation.
    expect(result.intervals[0].steps).toBeUndefined();
  });
});

describe('Schritt-Annotation in langen Blöcken', () => {
  it('annotiert nachhaltige Leistungssprünge als Stufen', () => {
    const start = Date.UTC(2026, 5, 3, 8, 0, 0);
    const records = Array.from({ length: 3000 }, (_, second) => {
      let power: number;
      if (second < 300) power = 150;
      else if (second < 900) power = 200;
      else if (second < 1500) power = 220;
      else if (second < 2100) power = 200;
      else power = 140;
      return { timestamp: start + second * 1000, power };
    });

    const result = analyzeRide(
      buildSeries(records),
      { ...DEFAULT_OPTIONS, autoThreshold: false, thresholdW: 180 },
      null,
    );

    expect(result.intervals).toHaveLength(1);
    const steps = result.intervals[0].steps;
    expect(steps).toBeDefined();
    expect(steps!.length).toBe(3);
    expect(steps![0].power).toBeCloseTo(200, 0);
    expect(steps![1].power).toBeCloseTo(220, 0);
    expect(steps![2].power).toBeCloseTo(200, 0);
    expect(Math.abs(steps![1].at - 900)).toBeLessThanOrEqual(15);
    expect(Math.abs(steps![2].at - 1500)).toBeLessThanOrEqual(15);
  });

  it('annotiert keine Stufen bei konstantem Block mit Rauschen', () => {
    const start = Date.UTC(2026, 5, 4, 8, 0, 0);
    const records = Array.from({ length: 3600 }, (_, second) => {
      let power: number;
      if (second < 600) power = 150;
      else if (second < 2400) power = 240 + ((second * 37) % 5) - 2;
      else power = 150;
      return { timestamp: start + second * 1000, power };
    });

    const result = analyzeRide(
      buildSeries(records),
      { ...DEFAULT_OPTIONS, autoThreshold: false, thresholdW: 200 },
      null,
    );

    expect(result.intervals).toHaveLength(1);
    expect(result.intervals[0].steps).toBeUndefined();
  });

  it('annotiert keine Stufen bei kurzen Blöcken', () => {
    const start = Date.UTC(2026, 5, 5, 8, 0, 0);
    const records = Array.from({ length: 1800 }, (_, second) => {
      const power = second < 600 ? 150 : second < 960 ? 250 : 150;
      return { timestamp: start + second * 1000, power };
    });

    const result = analyzeRide(
      buildSeries(records),
      { ...DEFAULT_OPTIONS, autoThreshold: false, thresholdW: 200 },
      null,
    );

    expect(result.intervals).toHaveLength(1);
    expect(result.intervals[0].steps).toBeUndefined();
  });

  it('ignoriert Rampen innerhalb eines langen Blocks', () => {
    // Block mit anhaltender Rampe (keine flachen Niveaus) → keine Stufen.
    const start = Date.UTC(2026, 5, 6, 8, 0, 0);
    const records = Array.from({ length: 3600 }, (_, second) => {
      let power: number;
      if (second < 600) power = 140;
      else if (second < 2400) power = 200 + (40 * (second - 600)) / 1800;
      else power = 140;
      return { timestamp: start + second * 1000, power };
    });

    const result = analyzeRide(
      buildSeries(records),
      { ...DEFAULT_OPTIONS, autoThreshold: false, thresholdW: 190 },
      null,
    );

    expect(result.intervals).toHaveLength(1);
    expect(result.intervals[0].steps).toBeUndefined();
  });
});

describe('Bevorzugte Lap-Erkennung', () => {
  it('übernimmt die exakten Lap-Grenzen statt der Leistungskanten', () => {
    const start = Date.UTC(2026, 6, 1, 8, 0, 0);
    // Die Leistung steigt erst bei 600 s, die Laps beginnen aber 30 s früher
    // und enden 30 s später → nur der Lap-Pfad trifft diese Grenzen exakt.
    const records = Array.from({ length: 3600 }, (_, second) => ({
      timestamp: start + second * 1000,
      power: second >= 600 && second < 2400 ? 240 : 150,
    }));
    const laps = [
      { start: 0, end: 570, duration: 570 },
      { start: 570, end: 2430, duration: 1860 },
      { start: 2430, end: 3600, duration: 1170 },
    ];

    const result = analyzeRide(
      buildSeries(records),
      { ...DEFAULT_OPTIONS, autoThreshold: false, thresholdW: 200 },
      null,
      laps,
    );

    expect(result.intervals).toHaveLength(1);
    expect(result.intervals[0].start).toBe(570);
    expect(result.intervals[0].end).toBe(2430);
    expect(result.intervals[0].duration).toBe(1860);
  });

  it('erkennt einen einzelnen langen Block auch ohne zweiten Work-Lap', () => {
    // 10 min Warm-up, 30 min Tempo, 20 min Cool-down – je eine Lap.
    const start = Date.UTC(2026, 6, 2, 8, 0, 0);
    const records = Array.from({ length: 3600 }, (_, second) => ({
      timestamp: start + second * 1000,
      power: second < 600 ? 150 : second < 2400 ? 240 : 150,
    }));
    const laps = [
      { start: 0, end: 600, duration: 600 },
      { start: 600, end: 2400, duration: 1800 },
      { start: 2400, end: 3600, duration: 1200 },
    ];

    const result = analyzeRide(
      buildSeries(records),
      { ...DEFAULT_OPTIONS, autoThreshold: false, thresholdW: 200 },
      null,
      laps,
    );

    expect(result.intervals).toHaveLength(1);
    expect(result.intervals[0].start).toBe(600);
    expect(result.intervals[0].end).toBe(2400);
    expect(result.sets).toHaveLength(1);
    expect(result.phases.map((phase) => phase.kind)).toEqual([
      'warmup',
      'set',
      'cooldown',
    ]);
  });

  it('verwirft Auto-Laps, die nur knapp um die Schwelle pendeln', () => {
    // Gleichmäßige Fahrt; die Laps wechseln minimal über/unter die Schwelle.
    const start = Date.UTC(2026, 6, 3, 8, 0, 0);
    const records = Array.from({ length: 3600 }, (_, second) => ({
      timestamp: start + second * 1000,
      power: Math.floor(second / 600) % 2 === 0 ? 161 : 159,
    }));
    const laps = Array.from({ length: 6 }, (_, index) => ({
      start: index * 600,
      end: (index + 1) * 600,
      duration: 600,
    }));

    const result = analyzeRide(
      buildSeries(records),
      { ...DEFAULT_OPTIONS, autoThreshold: false, thresholdW: 160 },
      null,
      laps,
    );

    expect(result.intervals).toHaveLength(0);
    expect(result.sets).toHaveLength(0);
  });

  it('gruppiert klassische Lap-Intervalle weiterhin zu Sätzen', () => {
    // 5 min Warm-up, 5 min Belastung, 5 min Pause, 5 min Belastung, 5 min Cool-down.
    const start = Date.UTC(2026, 6, 4, 8, 0, 0);
    const records = Array.from({ length: 1500 }, (_, second) => {
      const inWork =
        (second >= 300 && second < 600) || (second >= 900 && second < 1200);
      return { timestamp: start + second * 1000, power: inWork ? 260 : 150 };
    });
    const laps = [
      { start: 0, end: 300, duration: 300 },
      { start: 300, end: 600, duration: 300 },
      { start: 600, end: 900, duration: 300 },
      { start: 900, end: 1200, duration: 300 },
      { start: 1200, end: 1500, duration: 300 },
    ];

    const result = analyzeRide(
      buildSeries(records),
      { ...DEFAULT_OPTIONS, autoThreshold: false, thresholdW: 200 },
      null,
      laps,
    );

    expect(result.intervals).toHaveLength(2);
    expect(
      result.intervals.map((interval) => [interval.start, interval.end]),
    ).toEqual([
      [300, 600],
      [900, 1200],
    ]);
  });
});
