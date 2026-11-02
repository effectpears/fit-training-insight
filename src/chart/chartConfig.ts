import type { ChartConfiguration } from 'chart.js';
import type { AnnotationOptions } from 'chartjs-plugin-annotation';
import type { AnalysisResult, PhaseKind, SeriesPoint } from '../types';
import { percentile } from '../analysis/math';
import { formatClock } from '../utils/format';
import { createPhaseOverlayPlugin } from './phasePlugin';

export const CHART_FONT =
  '"Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const PHASE_COLORS: Record<PhaseKind, string> = {
  warmup: 'rgba(126, 151, 176, 0.09)',
  set: 'rgba(0, 229, 255, 0.055)',
  recovery: 'rgba(74, 222, 128, 0.075)',
  cooldown: 'rgba(167, 139, 250, 0.09)',
  ride: 'rgba(255, 255, 255, 0.025)',
};

export interface ChartBuildOptions {
  exportMode?: boolean;
}

export function buildChartConfig(
  analysis: AnalysisResult,
  rows: readonly SeriesPoint[],
  options: ChartBuildOptions = {},
): ChartConfiguration<'line'> {
  const exportMode = options.exportMode ?? false;
  const compact =
    !exportMode && typeof window !== 'undefined' && window.innerWidth <= 620;
  const { series } = analysis;
  const hasHeartRate = series.points.some((point) => point.heartRate != null);
  const powers = series.points
    .map((point) => point.power)
    .filter((power): power is number => power != null);
  const p99 = powers.length > 0 ? percentile(powers, 0.99) : 0;
  const powerMax = Math.ceil(Math.max(p99 * 1.1, 250) / 50) * 50;

  const heartRates = series.points
    .map((point) => point.heartRate)
    .filter((heartRate): heartRate is number => heartRate != null);
  const hrMin = heartRates.length > 0 ? Math.floor((Math.min(...heartRates) - 10) / 10) * 10 : 60;
  const hrMax = heartRates.length > 0 ? Math.ceil((Math.max(...heartRates) + 10) / 10) * 10 : 180;

  const powerData = rows.map((point) => ({ x: point.t, y: point.power }));
  const heartRateData = rows.map((point) => ({ x: point.t, y: point.heartRate }));

  return {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Leistung',
          data: powerData,
          borderColor: '#00E5FF',
          backgroundColor: (context) => {
            const { ctx, chartArea } = context.chart;
            if (!chartArea) return 'rgba(0, 229, 255, 0.12)';
            const gradient = ctx.createLinearGradient(
              0,
              chartArea.top,
              0,
              chartArea.bottom,
            );
            gradient.addColorStop(0, 'rgba(0, 229, 255, 0.28)');
            gradient.addColorStop(0.55, 'rgba(0, 229, 255, 0.07)');
            gradient.addColorStop(1, 'rgba(0, 229, 255, 0.01)');
            return gradient;
          },
          borderWidth: 1.6,
          fill: 'origin',
          tension: 0.18,
          pointRadius: 0,
          pointHitRadius: 10,
          pointHoverRadius: 3,
          spanGaps: false,
          yAxisID: 'power',
          order: 1,
        },
        ...(hasHeartRate
          ? [
              {
                label: 'Herzfrequenz',
                data: heartRateData,
                borderColor: '#FF6B6B',
                backgroundColor: 'transparent',
                borderWidth: 1.25,
                fill: false,
                tension: 0.25,
                pointRadius: 0,
                pointHitRadius: 10,
                pointHoverRadius: 3,
                spanGaps: false,
                yAxisID: 'hr',
                order: 2,
              } satisfies ChartConfiguration<'line'>['data']['datasets'][number],
            ]
          : []),
      ],
    },
    options: {
      responsive: !exportMode,
      maintainAspectRatio: false,
      animation: exportMode ? false : { duration: 380 },
      normalized: true,
      devicePixelRatio: exportMode
        ? 2
        : Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, 2),
      interaction: { mode: 'index', intersect: false },
      layout: {
        padding: {
          top: compact ? 24 : 30,
          right: exportMode ? 30 : compact ? 10 : 16,
          bottom: 0,
          left: 0,
        },
      },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: series.duration,
          grid: { color: 'rgba(255, 255, 255, 0.05)', drawTicks: false },
          border: { color: 'rgba(255, 255, 255, 0.1)' },
          ticks: {
            color: '#7f8b99',
            font: { family: CHART_FONT, size: 10 },
            maxTicksLimit: exportMode ? 12 : compact ? 5 : 9,
            maxRotation: 0,
            autoSkip: true,
            callback: (value) => formatClock(Number(value)),
          },
        },
        power: {
          position: 'left',
          beginAtZero: true,
          suggestedMax: powerMax,
          grid: { color: 'rgba(255, 255, 255, 0.055)', drawTicks: false },
          border: { display: false },
          ticks: {
            color: '#8d9aa8',
            font: { family: CHART_FONT, size: 10 },
            padding: 5,
            maxTicksLimit: compact ? 6 : 9,
            callback: (value) => `${Math.round(Number(value))}`,
          },
          title: {
            display: !compact,
            text: 'Leistung (W)',
            color: '#6f7d8c',
            font: { family: CHART_FONT, size: 10, weight: 600 },
          },
        },
        ...(hasHeartRate
          ? {
              hr: {
                position: 'right' as const,
                min: hrMin,
                max: hrMax,
                grid: { display: false },
                border: { display: false },
                ticks: {
                  color: 'rgba(255, 139, 139, 0.85)',
                  font: { family: CHART_FONT, size: 10 },
                  padding: 5,
                  maxTicksLimit: compact ? 4 : 7,
                  callback: (value) => `${Math.round(Number(value))}`,
                },
                title: {
                  display: !compact,
                  text: 'HF (bpm)',
                  color: 'rgba(255, 139, 139, 0.7)',
                  font: { family: CHART_FONT, size: 10, weight: 600 },
                },
              },
            }
          : {}),
      },
      plugins: {
        legend: {
          display: !compact,
          position: 'top',
          align: 'end',
          labels: {
            color: '#c6d2de',
            usePointStyle: true,
            pointStyle: 'line',
            boxWidth: compact ? 14 : 22,
            boxHeight: 2,
            padding: compact ? 9 : 16,
            font: { family: CHART_FONT, size: compact ? 9 : 11 },
          },
        },
        tooltip: {
          enabled: !exportMode,
          backgroundColor: 'rgba(11, 14, 18, 0.96)',
          borderColor: 'rgba(255, 255, 255, 0.12)',
          borderWidth: 1,
          titleColor: '#f4f8fb',
          bodyColor: '#c6d2de',
          padding: 12,
          displayColors: true,
          boxPadding: 5,
          usePointStyle: true,
          callbacks: {
            title: (items) =>
              items.length > 0 ? formatClock(Number(items[0].parsed.x)) : '',
            label: (item) => {
              if (item.parsed.y == null) return '';
              const unit = item.dataset.yAxisID === 'hr' ? ' bpm' : ' W';
              return `${item.dataset.label}: ${Math.round(item.parsed.y)}${unit}`;
            },
            afterBody: (items) => {
              if (items.length === 0) return [];
              const index = items[0].dataIndex;
              const point = rows[index];
              const lines: string[] = [];
              if (point?.cadence != null) {
                lines.push(`Trittfrequenz: ${Math.round(point.cadence)} rpm`);
              }
              const time = Number(items[0].parsed.x);
              const set = analysis.sets.find(
                (entry) => time >= entry.start && time <= entry.end,
              );
              if (set) {
                lines.push(`Satz ${set.id}: ${set.label}`);
              } else {
                const phase = analysis.phases.find(
                  (entry) => time >= entry.start && time <= entry.end,
                );
                if (phase) lines.push(phase.label);
              }
              if (lines.length > 0) lines.unshift('');
              return lines;
            },
          },
        },
        annotation: {
          annotations: buildAnnotations(analysis, compact),
        },
      },
    },
    plugins: [createPhaseOverlayPlugin(analysis, compact)],
  };
}

function buildAnnotations(
  analysis: AnalysisResult,
  compact: boolean,
): Record<string, AnnotationOptions> {
  const annotations: Record<string, AnnotationOptions> = {};

  analysis.phases.forEach((phase, index) => {
    annotations[`phase-${index}`] = {
      type: 'box',
      xMin: phase.start,
      xMax: phase.end,
      backgroundColor: PHASE_COLORS[phase.kind],
      borderWidth: 0,
      drawTime: 'beforeDatasetsDraw',
    };
  });

  annotations.threshold = {
    type: 'line',
    yMin: analysis.thresholdW,
    yMax: analysis.thresholdW,
    borderColor: 'rgba(0, 229, 255, 0.4)',
    borderWidth: 1,
    borderDash: [5, 5],
    drawTime: 'afterDatasetsDraw',
    label: {
      display: !compact,
      content: `ON ≥ ${analysis.thresholdW} W`,
      position: 'center',
      backgroundColor: 'rgba(9, 12, 16, 0.82)',
      color: '#8ff6ff',
      font: { family: CHART_FONT, size: 10, weight: 600 },
      padding: { x: 6, y: 3 },
      borderRadius: 4,
      yAdjust: -3,
    },
  };

  return annotations;
}
