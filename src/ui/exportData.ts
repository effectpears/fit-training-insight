import type { AnalysisResult, RideData } from '../types';
import { downloadText, baseFileName } from '../utils/download';
import { formatDateShort } from '../utils/format';

export function exportIntervalsCsv(ride: RideData, analysis: AnalysisResult): void {
  const header = [
    'interval',
    'set',
    'start_s',
    'end_s',
    'duration_s',
    'avg_power_w',
    'max_power_w',
    'avg_hr_bpm',
    'avg_cadence_rpm',
    'work_kj',
  ];
  const lines = [header.join(',')];
  for (const interval of analysis.intervals) {
    lines.push(
      [
        interval.index,
        interval.setId,
        interval.start,
        interval.end,
        interval.duration,
        interval.avgPower.toFixed(1),
        interval.maxPower,
        interval.avgHeartRate?.toFixed(1) ?? '',
        interval.avgCadence?.toFixed(1) ?? '',
        interval.workKJ.toFixed(2),
      ].join(','),
    );
  }

  const start = ride.session.startTime ?? ride.records[0]?.timestamp ?? Date.now();
  const name = `fit-insight_${baseFileName(ride.fileName)}_${formatDateShort(start)
    .replace(/\./g, '-')}_intervalle.csv`;
  downloadText(`\ufeff${lines.join('\r\n')}`, name, 'text/csv');
}

export function exportAnalysisJson(ride: RideData, analysis: AnalysisResult): void {
  const payload = {
    file: {
      name: ride.fileName,
      size: ride.fileSize,
      startTime: ride.session.startTime ?? ride.records[0]?.timestamp,
      sport: ride.session.sport,
      device: ride.session.device,
      warnings: ride.warnings,
    },
    settings: {
      thresholdW: analysis.thresholdW,
      autoThreshold: analysis.options.autoThreshold,
      smoothingSeconds: analysis.options.smoothingSeconds,
      minOnSeconds: analysis.options.minOnSeconds,
      minOffSeconds: analysis.options.minOffSeconds,
      setBreakSeconds: analysis.options.setBreakSeconds,
      ftp: analysis.options.ftp ?? null,
    },
    metrics: analysis.metrics,
    sets: analysis.sets.map(({ intervals, ...set }) => ({
      ...set,
      intervalIndexes: intervals.map((interval) => interval.index),
    })),
    intervals: analysis.intervals,
  };

  const start = ride.session.startTime ?? ride.records[0]?.timestamp ?? Date.now();
  const name = `fit-insight_${baseFileName(ride.fileName)}_${formatDateShort(start)
    .replace(/\./g, '-')}.json`;
  downloadText(JSON.stringify(payload, null, 2), name, 'application/json');
}
