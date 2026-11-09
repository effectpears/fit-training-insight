import type { DetectionOptions, RideMetrics, RideSeries, ZoneShare } from '../types';
import { mean, normalizedPower } from './math';

const ZONES: Array<{ id: string; name: string; color: string; max: number }> = [
  { id: 'z1', name: 'Recovery', color: '#64748b', max: 0.55 },
  { id: 'z2', name: 'Endurance', color: '#3b82f6', max: 0.75 },
  { id: 'z3', name: 'Tempo', color: '#22c55e', max: 0.9 },
  { id: 'z4', name: 'Threshold', color: '#eab308', max: 1.05 },
  { id: 'z5', name: 'VO₂max', color: '#f97316', max: 1.2 },
  { id: 'z6', name: 'Anaerob', color: '#ef4444', max: Number.POSITIVE_INFINITY },
];

export function computeMetrics(
  series: RideSeries,
  options: DetectionOptions,
  thresholdW: number,
  distanceM: number | null,
): RideMetrics {
  const points = series.points;
  const powers = points.map((point) => point.power ?? 0);
  const explicitFtp = options.ftp != null && options.ftp > 0 ? options.ftp : null;

  let powerSum = 0;
  let powerCount = 0;
  let maxPower = 0;
  let work = 0;
  let movingTime = 0;
  let stoppedSeconds = 0;
  const heartRates: number[] = [];
  const cadences: number[] = [];

  for (const point of points) {
    if (point.power != null) {
      powerSum += point.power;
      powerCount += 1;
      maxPower = Math.max(maxPower, point.power);
      work += point.power;
      if (point.power > 0) movingTime += 1;
    }
    if (point.heartRate != null) heartRates.push(point.heartRate);
    if (point.cadence != null) cadences.push(point.cadence);
    // Stillstand: keine Bewegung (speed = 0) und keine Anstrengung
    // (power = 0 oder fehlend). Lücken in den Daten zählen nicht als
    // Stillstand, sondern werden ignoriert.
    // Stillstand: explizit Null-Geschwindigkeit und keine Leistung
    // (Power-Meter zeichnet 0 W im Stillstand auf). Datenlücken
    // (fehlende Werte) zählen nicht als Stillstand.
    const speed = point.speed;
    const power = point.power;
    if (speed != null && power != null && speed <= 0 && power <= 0) {
      stoppedSeconds += 1;
    }
  }

  const avgPower = powerCount > 0 ? powerSum / powerCount : 0;
  const np = normalizedPower(powers, series.sampleRate);
  const intensityFactor = explicitFtp != null && explicitFtp > 0 ? np / explicitFtp : null;
  const tss =
    explicitFtp != null && explicitFtp > 0 && intensityFactor != null
      ? (series.duration * np * intensityFactor) / (explicitFtp * 3600) * 100
      : null;

  // Ohne FTP dient die ON-Schwelle als Näherung an die Threshold-Leistung.
  const zoneReference = explicitFtp ?? thresholdW / 0.95;
  const zoneSeconds = new Map<string, number>(ZONES.map((zone) => [zone.id, 0]));
  for (const point of points) {
    if (point.power == null) continue;
    const ratio = point.power / Math.max(1, zoneReference);
    const zone = ZONES.find((entry) => ratio <= entry.max) ?? ZONES[ZONES.length - 1];
    zoneSeconds.set(zone.id, (zoneSeconds.get(zone.id) ?? 0) + 1);
  }

  const zones: ZoneShare[] = ZONES.map((zone) => ({
    id: zone.id,
    name: zone.name,
    color: zone.color,
    seconds: zoneSeconds.get(zone.id) ?? 0,
  })).filter((zone) => zone.seconds > 0);

  return {
    duration: series.duration,
    movingTime,
    stoppedSeconds,
    distanceM,
    avgPower,
    maxPower,
    normalizedPower: np,
    workKJ: work / 1000,
    avgHeartRate: heartRates.length > 0 ? mean(heartRates) : null,
    maxHeartRate: heartRates.length > 0 ? Math.max(...heartRates) : null,
    avgCadence: cadences.length > 0 ? mean(cadences) : null,
    intensityFactor,
    tss,
    zones,
    ftpReference: zoneReference,
  };
}
