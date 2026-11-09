import { Encoder, Profile } from '@garmin/fitsdk';
import type {
  Encodable,
  FileIdMesg,
  RecordMesg,
  SessionMesg,
  WorkoutMesg,
  WorkoutStepMesg,
} from '@garmin/fitsdk';
import { describe, expect, it } from 'vitest';
import { parseFitBuffer } from '../src/fit/parseFit';

const START = Date.UTC(2026, 0, 1, 8, 0, 0);

function writeWorkout(
  encoder: Encoder,
  steps: Array<{
    durationSeconds: number;
    targetPower?: number;
    intensity?: string;
  }>,
): void {
  const workout: Encodable<WorkoutMesg> = {
    mesgNum: Profile.MesgNum.WORKOUT,
    numValidSteps: steps.length,
    wktName: 'Test Workout',
  };
  encoder.writeMesg(workout);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepMesg: Encodable<WorkoutStepMesg> = {
      mesgNum: Profile.MesgNum.WORKOUT_STEP,
      messageIndex: i,
      durationType: 'time',
      durationValue: step.durationSeconds,
      targetType: step.targetPower != null ? 'power' : undefined,
      targetValue: step.targetPower,
      intensity: (step.intensity ?? 'active') as
        | 'active'
        | 'rest'
        | 'warmup'
        | 'cooldown'
        | 'recovery',
    };
    encoder.writeMesg(stepMesg);
  }
}

function buildWorkoutFit(): Uint8Array {
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

  // Warmup 300 s @ 150 W, dann 4 × 45 s Arbeit @ 280 W / 60 s Rest @ 150 W, Cooldown 120 s @ 140 W.
  const total = 300 + 4 * (45 + 60) + 120;
  for (let second = 0; second < total; second++) {
    let power = 150;
    const offset = second - 300;
    if (offset >= 0 && offset < 4 * 105) {
      const rep = Math.floor(offset / 105);
      const phase = offset - rep * 105;
      power = phase < 45 ? 280 : 150;
    } else if (offset >= 4 * 105) {
      power = 140;
    }
    const record: Encodable<RecordMesg> = {
      mesgNum: Profile.MesgNum.RECORD,
      timestamp: new Date(START + second * 1000),
      power,
      heartRate: 130,
      cadence: 85,
      speed: 8,
      distance: second * 8,
    };
    encoder.writeMesg(record);
  }

  const session: Encodable<SessionMesg> = {
    mesgNum: Profile.MesgNum.SESSION,
    timestamp: new Date(START + (total - 1) * 1000),
    startTime: new Date(START),
    sport: 'cycling',
    totalElapsedTime: total,
    totalTimerTime: total,
    totalDistance: total * 8,
    avgPower: 175,
    maxPower: 280,
    avgHeartRate: 135,
    maxHeartRate: 150,
    totalWork: 175 * total,
  };
  encoder.writeMesg(session);

  writeWorkout(encoder, [
    { durationSeconds: 300, targetPower: 150 },
    ...[45, 60, 45, 60, 45, 60, 45, 60].map(
      (seconds) => ({
        durationSeconds: seconds,
        targetPower: seconds === 45 ? 280 : 150,
      } as const),
    ),
    { durationSeconds: 120, targetPower: 140 },
  ]);

  return encoder.close();
}

describe('FIT-Parser mit Workout-Schritten', () => {
  it('liest workout_mesg und workout_step_mesg aus der Datei', () => {
    const bytes = buildWorkoutFit();
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const ride = parseFitBuffer(buffer, 'test-workout.fit', bytes.length);

    expect(ride.workouts.length).toBeGreaterThan(0);
    const workout = ride.workouts[0];
    expect(workout.steps.length).toBe(10);
    // Arbeitsschritte (45 s @ 280 W) haben targetPower 280.
    const workSteps = workout.steps.filter((step) => step.targetPower === 280);
    expect(workSteps).toHaveLength(4);
    expect(workSteps.every((step) => step.durationValue === 45)).toBe(true);
  });
});
