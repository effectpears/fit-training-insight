import { Encoder, Profile } from '@garmin/fitsdk';
import type {
  Encodable,
  FileIdMesg,
  RecordMesg,
  SessionMesg,
} from '@garmin/fitsdk';
import { describe, expect, it } from 'vitest';
import { analyzeRide } from '../src/analysis/analyze';
import { buildSeries } from '../src/analysis/series';
import { DEFAULT_OPTIONS } from '../src/config';
import { parseFitBuffer } from '../src/fit/parseFit';

const START = Date.UTC(2026, 0, 1, 8, 0, 0);

function buildTestFit(): Uint8Array {
  const encoder = new Encoder();
  const fileId: Encodable<FileIdMesg> = {
    mesgNum: Profile.MesgNum.FILE_ID,
    type: 'activity',
    manufacturer: 'development',
    product: 1,
    serialNumber: 4242,
    timeCreated: new Date(START),
  };
  encoder.writeMesg(fileId);

  for (let second = 0; second < 160; second++) {
    const phase = second % 40;
    const power = phase < 20 ? 320 : 100;
    const record: Encodable<RecordMesg> = {
      mesgNum: Profile.MesgNum.RECORD,
      timestamp: new Date(START + second * 1000),
      power,
      heartRate: phase < 20 ? 165 : 125,
      cadence: phase < 20 ? 95 : 78,
      speed: 9,
      distance: second * 9,
    };
    encoder.writeMesg(record);
  }

  const session: Encodable<SessionMesg> = {
    mesgNum: Profile.MesgNum.SESSION,
    timestamp: new Date(START + 159 * 1000),
    startTime: new Date(START),
    sport: 'cycling',
    totalElapsedTime: 160,
    totalTimerTime: 160,
    totalDistance: 1440,
    avgPower: 210,
    maxPower: 320,
    avgHeartRate: 145,
    maxHeartRate: 165,
    totalWork: 33600,
  };
  encoder.writeMesg(session);

  return encoder.close();
}

describe('FIT-Parser', () => {
  it('dekodiert Records und Session-Metadaten', () => {
    const bytes = buildTestFit();
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const ride = parseFitBuffer(buffer, 'test-4x20.fit', bytes.length);

    expect(ride.records).toHaveLength(160);
    expect(ride.records[0].power).toBe(320);
    expect(ride.records[20].power).toBe(100);
    expect(ride.records[0].heartRate).toBe(165);
    expect(ride.session.sport).toBe('cycling');
    expect(ride.session.totalDistance).toBe(1440);
    expect(ride.session.device).toContain('development');
    expect(ride.warnings).toHaveLength(0);
  });

  it('erkennt das Intervallmuster aus einer echten FIT-Struktur', () => {
    const bytes = buildTestFit();
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const ride = parseFitBuffer(buffer, 'test-4x20.fit', bytes.length);
    const series = buildSeries(ride.records);
    const analysis = analyzeRide(series, {
      ...DEFAULT_OPTIONS,
      autoThreshold: false,
      thresholdW: 250,
      smoothingSeconds: 3,
      minOnSeconds: 10,
      minOffSeconds: 5,
    });

    expect(analysis.intervals).toHaveLength(4);
    expect(analysis.sets).toHaveLength(1);
    expect(analysis.sets[0].reps).toBe(4);
    expect(analysis.sets[0].targetPower).toBe(320);
  });

  it('weist Nicht-FIT-Dateien zurück', () => {
    const buffer = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    expect(() => parseFitBuffer(buffer, 'kaputt.fit', 5)).toThrow(
      /keine gültige FIT-Datei/i,
    );
  });
});
