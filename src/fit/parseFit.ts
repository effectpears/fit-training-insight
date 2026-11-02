import { Decoder, Stream } from '@garmin/fitsdk';
import type { FitLap, FitRecord, FitSessionSummary, RideData } from '../types';

const READ_OPTIONS = {
  applyScaleAndOffset: true,
  expandComponents: true,
  convertTypesToStrings: true,
  convertDateTimesToDates: true,
} as const;

export async function parseFitFile(file: File): Promise<RideData> {
  const buffer = await file.arrayBuffer();
  return parseFitBuffer(buffer, file.name, file.size);
}

/**
 * Dekodiert eine FIT-Datei vollständig im Browser. Es werden nur Aktivitäts-
 * Records mit gültigem Zeitstempel übernommen; Duplikate werden dedupliziert.
 */
export function parseFitBuffer(
  buffer: ArrayBuffer,
  fileName: string,
  fileSize: number,
): RideData {
  const probe = Stream.fromArrayBuffer(buffer);
  if (!Decoder.isFIT(probe)) {
    throw new Error('Die Datei ist keine gültige FIT-Datei (Header nicht erkannt).');
  }

  const warnings: string[] = [];
  let integrityOk = true;
  try {
    integrityOk = new Decoder(Stream.fromArrayBuffer(buffer)).checkIntegrity();
  } catch {
    integrityOk = false;
  }
  if (!integrityOk) {
    warnings.push('CRC-Prüfung fehlgeschlagen – die Datei kann unvollständig sein.');
  }

  const decoder = new Decoder(Stream.fromArrayBuffer(buffer));
  let decoded: ReturnType<Decoder['read']>;
  try {
    decoded = decoder.read(READ_OPTIONS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`FIT-Datei konnte nicht dekodiert werden: ${message}`);
  }

  for (const error of decoded.errors.slice(0, 3)) {
    warnings.push(`Decoder: ${error.message}`);
  }
  if (decoded.errors.length > 3) {
    warnings.push(`${decoded.errors.length - 3} weitere Decoder-Hinweise ausgeblendet.`);
  }

  const byTimestamp = new Map<number, FitRecord>();
  let skipped = 0;

  for (const mesg of decoded.messages.recordMesgs ?? []) {
    const timestamp = toEpoch(mesg.timestamp);
    if (timestamp == null) {
      skipped += 1;
      continue;
    }
    byTimestamp.set(timestamp, {
      timestamp,
      power: toNumber(mesg.power),
      heartRate: toNumber(mesg.heartRate),
      cadence: toNumber(mesg.cadence),
      speed: toNumber(mesg.speed),
      distance: toNumber(mesg.distance),
      altitude: toNumber(mesg.altitude),
    });
  }

  if (skipped > 0) {
    warnings.push(`${skipped} Record(s) ohne gültigen Zeitstempel übersprungen.`);
  }

  const records = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  if (records.length < 2) {
    throw new Error(
      'Die FIT-Datei enthält keine auswertbaren Aktivitätsdaten (zu wenige Records).',
    );
  }
  if (!records.some((record) => record.power != null)) {
    warnings.push('Keine Leistungsdaten gefunden – Intervallererkennung nicht möglich.');
  }

  const laps = extractLaps(
    decoded.messages.lapMesgs ?? [],
    records[0].timestamp,
    records[records.length - 1].timestamp,
  );

  const sessionMesg = decoded.messages.sessionMesgs?.[0];
  const fileIdMesg = decoded.messages.fileIdMesgs?.[0];
  const session: FitSessionSummary = {
    sport: toStringValue(sessionMesg?.sport),
    subSport: toStringValue(sessionMesg?.subSport),
    startTime: toEpoch(sessionMesg?.startTime),
    totalElapsedTime: toNumber(sessionMesg?.totalElapsedTime),
    totalTimerTime: toNumber(sessionMesg?.totalTimerTime),
    totalDistance: toNumber(sessionMesg?.totalDistance),
    avgPower: toNumber(sessionMesg?.avgPower),
    maxPower: toNumber(sessionMesg?.maxPower),
    normalizedPower: toNumber(sessionMesg?.normalizedPower),
    avgHeartRate: toNumber(sessionMesg?.avgHeartRate),
    maxHeartRate: toNumber(sessionMesg?.maxHeartRate),
    avgCadence: toNumber(sessionMesg?.avgCadence),
    totalWork: toNumber(sessionMesg?.totalWork),
    device: [toStringValue(fileIdMesg?.manufacturer), toStringValue(fileIdMesg?.productName ?? fileIdMesg?.product)]
      .filter(Boolean)
      .join(' '),
  };

  if (session.totalDistance == null) {
    const last = records[records.length - 1];
    if (last.distance != null) session.totalDistance = last.distance;
  }

  return { fileName, fileSize, records, session, laps, warnings };
}

/**
 * Wandelt FIT-Laps in Sekunden relativ zum ersten Record um. Die Laps werden
 * für strukturierte Workouts mit kurzen, wiederkehrenden Steps genutzt.
 */
function extractLaps(
  mesgs: readonly unknown[],
  rideStartMs: number,
  rideEndMs: number,
): FitLap[] {
  const laps: FitLap[] = [];
  const durationSeconds = Math.max(1, Math.round((rideEndMs - rideStartMs) / 1000));

  for (const mesg of mesgs) {
    const lap = mesg as {
      startTime?: unknown;
      timestamp?: unknown;
      totalTimerTime?: unknown;
      totalElapsedTime?: unknown;
    };
    const total =
      toNumber(lap.totalTimerTime) ?? toNumber(lap.totalElapsedTime);
    const startMs = toEpoch(lap.startTime) ?? toEpoch(lap.timestamp);
    if (startMs == null || total == null || total < 2) continue;

    const start = clamp(
      Math.round((startMs - rideStartMs) / 1000),
      0,
      durationSeconds,
    );
    const end = clamp(
      Math.round((startMs + total * 1000 - rideStartMs) / 1000),
      start,
      durationSeconds,
    );
    if (end - start < 2) continue;
    laps.push({ start, end, duration: end - start });
  }

  return laps;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function toEpoch(value: unknown): number | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  return undefined;
}

function toStringValue(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return undefined;
}
