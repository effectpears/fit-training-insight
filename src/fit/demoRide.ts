import type { FitRecord, RideData } from '../types';
import { normalizedPower } from '../analysis/math';

const START = Date.UTC(2026, 4, 18, 7, 30, 0);

interface Stage {
  seconds: number;
  /** Leistung in Abhängigkeit von der Sekunde innerhalb der Stage. */
  power: (second: number) => number;
  cadence: number;
}

/**
 * Erzeugt eine deterministische Demo-Fahrt mit drei unterschiedlichen Sätzen
 * (6×30/30, 4×60/60, 3×30/30). Sie dient als Testfixture und als sofort
 * ausprobierbares Beispiel ohne echte FIT-Datei.
 */
export function createDemoRide(): RideData {
  const rng = mulberry32(0x5eed);
  const stages: Stage[] = [];

  stages.push({
    seconds: 600,
    power: (second) => 95 + (second / 600) * 115,
    cadence: 84,
  });

  addRepeats(stages, 6, 30, 30, 315, 145, 96, 80);
  stages.push({ seconds: 180, power: () => 150, cadence: 82 });
  addRepeats(stages, 4, 60, 60, 285, 140, 94, 79);
  stages.push({ seconds: 240, power: () => 145, cadence: 81 });
  addRepeats(stages, 3, 30, 30, 395, 120, 99, 78);
  stages.push({
    seconds: 420,
    power: (second) => 140 - (second / 420) * 55,
    cadence: 82,
  });

  const records: FitRecord[] = [];
  let heartRate = 96;
  let distance = 0;
  let clock = 0;

  for (const stage of stages) {
    for (let second = 0; second < stage.seconds; second++) {
      const noise = (rng() - 0.5) * 6;
      const target = Math.max(0, Math.round(stage.power(second) + noise));
      const targetHeartRate = Math.min(190, 88 + target * 0.235);
      heartRate += (targetHeartRate - heartRate) * (1 / 18);
      const cadence = Math.max(50, Math.round(stage.cadence + (rng() - 0.5) * 3));
      const speed = 5.9 + target * 0.011 + (rng() - 0.5) * 0.3;
      distance += speed;

      records.push({
        timestamp: START + clock * 1000,
        power: target,
        heartRate: Math.round(heartRate),
        cadence,
        speed,
        distance,
      });
      clock += 1;
    }
  }

  const powers = records.map((record) => record.power ?? 0);
  const heartRates = records.map((record) => record.heartRate ?? 0);
  const cadences = records.map((record) => record.cadence ?? 0);
  const work = powers.reduce((sum, power) => sum + power, 0);

  return {
    fileName: 'demo-3x30-30.fit',
    fileSize: 0,
    records,
    laps: [],
    workouts: [],
    warnings: [],
    session: {
      sport: 'cycling',
      startTime: START,
      totalElapsedTime: records.length,
      totalTimerTime: records.length,
      totalDistance: distance,
      avgPower: work / powers.length,
      maxPower: Math.max(...powers),
      normalizedPower: normalizedPower(powers),
      avgHeartRate: heartRates.reduce((sum, value) => sum + value, 0) / heartRates.length,
      maxHeartRate: Math.max(...heartRates),
      avgCadence: cadences.reduce((sum, value) => sum + value, 0) / cadences.length,
      totalWork: work,
      device: 'FIT Insight Demo',
    },
  };
}

function addRepeats(
  stages: Stage[],
  reps: number,
  onSeconds: number,
  offSeconds: number,
  onPower: number,
  offPower: number,
  onCadence: number,
  offCadence: number,
): void {
  for (let rep = 0; rep < reps; rep++) {
    stages.push({ seconds: onSeconds, power: () => onPower, cadence: onCadence });
    stages.push({ seconds: offSeconds, power: () => offPower, cadence: offCadence });
  }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
