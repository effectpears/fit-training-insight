import type { Chart, ChartArea, Plugin } from 'chart.js';
import type { AnalysisResult } from '../types';

const FONT =
  '"Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/**
 * Zeichnet ON-Balken, Satz-Klammern über den Belastungsspitzen und
 * Phasenlabels direkt auf den Canvas. Dadurch landen alle Annotationen
 * automatisch auch im PNG-Export.
 */
export function createPhaseOverlayPlugin(
  analysis: AnalysisResult,
  compact = false,
): Plugin<'line'> {
  return {
    id: 'fitPhaseOverlay',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      const xScale = chart.scales.x;
      const powerScale = chart.scales.power;
      if (!chartArea || !xScale || !powerScale) return;

      ctx.save();
      clipToChartArea(ctx, chartArea);

      // ON-Balken am oberen Rand des Plotbereichs.
      ctx.fillStyle = 'rgba(0, 229, 255, 0.58)';
      for (const interval of analysis.intervals) {
        const x0 = xScale.getPixelForValue(interval.start);
        const x1 = xScale.getPixelForValue(interval.end);
        ctx.fillRect(x0, chartArea.top + 2, Math.max(1, x1 - x0), 3);
      }

      drawPhaseLabels(ctx, chart, analysis, compact);
      ctx.restore();

      drawSetBrackets(ctx, chart, analysis, compact);
    },
  };
}

function drawPhaseLabels(
  ctx: CanvasRenderingContext2D,
  chart: Chart<'line'>,
  analysis: AnalysisResult,
  compact: boolean,
): void {
  const { chartArea } = chart;
  const xScale = chart.scales.x;
  const powerScale = chart.scales.power;
  if (!chartArea || !xScale || !powerScale) return;

  for (const phase of analysis.phases) {
    if (phase.kind === 'set' || phase.kind === 'ride') continue;

    const x0 = xScale.getPixelForValue(phase.start);
    const x1 = xScale.getPixelForValue(phase.end);
    const width = x1 - x0;
    if (width < 44) continue;

    if (phase.kind === 'warmup' || phase.kind === 'cooldown') {
      // Gestrichelte Phasengrenze wie in der grafischen Vorlage.
      const boundary = phase.kind === 'warmup' ? phase.end : phase.start;
      const xBoundary = xScale.getPixelForValue(boundary);
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(xBoundary, chartArea.top);
      ctx.lineTo(xBoundary, chartArea.bottom);
      ctx.stroke();
      ctx.restore();

      ctx.font = `700 9px ${FONT}`;
      ctx.fillStyle = '#94a3b8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(
        phase.label.toUpperCase(),
        (x0 + x1) / 2,
        chartArea.bottom - 8,
      );
      continue;
    }

    if (compact || width < 44) continue;

    // Erholung: amberfarbenes Pausen-Label am unteren Rand des Erholungsbands.
    // Der feste Platz verhindert eine Kollision mit der Schwellelinie, die
    // ebenfalls in der Mitte des Erholungstals liegen kann.
    const centerX = (x0 + x1) / 2;
    drawPillLabel(
      ctx,
      `${formatAxisDuration(phase.end - phase.start)} Pause`,
      centerX,
      chartArea.bottom - 34,
    );
  }
}

function drawSetBrackets(
  ctx: CanvasRenderingContext2D,
  chart: Chart<'line'>,
  analysis: AnalysisResult,
  compact: boolean,
): void {
  const { chartArea } = chart;
  const xScale = chart.scales.x;
  const powerScale = chart.scales.power;
  if (!chartArea || !xScale || !powerScale || analysis.sets.length === 0) return;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';

  for (const set of analysis.sets) {
    const x0 = xScale.getPixelForValue(set.start);
    const x1 = xScale.getPixelForValue(set.end);
    const width = x1 - x0;
    if (width < 18) continue;

    // Klammer direkt über der Belastungsspitze des Satzes.
    const peakY = powerScale.getPixelForValue(set.maxPower);
    const bracketY = clamp(peakY - 26, chartArea.top + 34, chartArea.bottom - 30);

    ctx.strokeStyle = 'rgba(0, 229, 255, 0.72)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(x0, bracketY + 6);
    ctx.lineTo(x0, bracketY);
    ctx.lineTo(x1, bracketY);
    ctx.lineTo(x1, bracketY + 6);
    ctx.stroke();

    const detail = set.patternSeconds?.length
      ? `${set.reps}× (${set.patternSeconds.map(formatAxisDuration).join('/')}${
          set.offSeconds > 0
            ? ` + ${formatAxisDuration(set.offSeconds)} Pause`
            : ''
        })`
      : set.offSeconds > 0
        ? `${set.reps}× (${formatAxisDuration(set.onSeconds)} / ${formatAxisDuration(
            set.offSeconds,
          )})`
        : `${set.reps}× ${formatAxisDuration(set.onSeconds)}`;
    const full = `SET ${set.id}: ${detail}`;
    const short = `SET ${set.id}`;

    ctx.font = `700 11px ${FONT}`;
    const label =
      !compact && ctx.measureText(full).width + 10 < width
        ? full
        : !compact && ctx.measureText(short).width + 8 < width
          ? short
          : `S${set.id}`;
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(label, (x0 + x1) / 2, bracketY - 4);

    if (!compact && width > 54) {
      ctx.font = `500 9.5px ${FONT}`;
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`@ ${Math.round(set.targetPower)} W`, (x0 + x1) / 2, bracketY - 17);
    }
  }

  ctx.restore();
}

function drawPillLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  centerY: number,
): void {
  ctx.save();
  ctx.font = `600 9.5px ${FONT}`;
  const textWidth = ctx.measureText(text).width;
  const width = textWidth + 12;
  const height = 17;
  const x = centerX - width / 2;
  const y = centerY - height / 2;

  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 8);
  ctx.fillStyle = 'rgba(18, 18, 22, 0.82)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(245, 158, 11, 0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = '#fbbf24';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, centerX, centerY + 0.5);
  ctx.restore();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clipToChartArea(
  ctx: CanvasRenderingContext2D,
  chartArea: ChartArea,
): void {
  ctx.beginPath();
  ctx.rect(chartArea.left, chartArea.top, chartArea.width, chartArea.height);
  ctx.clip();
}

function formatAxisDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total <= 90) return `${total}s`;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
