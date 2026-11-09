import type { AnalysisResult, RideData, SeriesPoint } from '../types';
import { buildChartConfig, CHART_FONT } from './chartConfig';
import { Chart } from './setup';
import { formatDateShort, formatDecimal, formatDuration, formatNumber } from '../utils/format';
import { baseFileName, downloadBlob } from '../utils/download';

const OUTPUT_WIDTH = 2000;
const OUTPUT_HEIGHT = 1360;
const SCALE = 2;
const CHART_WIDTH = 1840;
const CHART_HEIGHT = 800;

/**
 * Rendert eine eigene, hochauflösende Chart-Instanz und komponiert sie mit
 * Kopfzeile, Kennzahlen und Strukturübersicht zu einem PNG. Da die Annotationen
 * auf demselben Canvas liegen, sind Klammern, Phasen und Schwellenlinie
 * verlustfrei enthalten.
 */
export async function exportAnalysisPng(
  ride: RideData,
  analysis: AnalysisResult,
  rows: readonly SeriesPoint[],
): Promise<void> {
  await document.fonts?.ready;

  const chartCanvas = document.createElement('canvas');
  chartCanvas.width = CHART_WIDTH;
  chartCanvas.height = CHART_HEIGHT;
  chartCanvas.style.width = `${CHART_WIDTH}px`;
  chartCanvas.style.height = `${CHART_HEIGHT}px`;

  const chart = new Chart(
    chartCanvas,
    buildChartConfig(analysis, rows, { exportMode: true }),
  );
  chart.update('none');
  chart.draw();
  await nextFrame();

  const output = document.createElement('canvas');
  output.width = OUTPUT_WIDTH * SCALE;
  output.height = OUTPUT_HEIGHT * SCALE;
  const ctx = output.getContext('2d');
  if (!ctx) throw new Error('Canvas-Kontext konnte nicht erstellt werden.');
  ctx.scale(SCALE, SCALE);

  drawBackground(ctx);
  drawHeader(ctx, ride);
  drawKpis(ctx, analysis);
  drawChartPanel(ctx, chartCanvas);
  drawStructure(ctx, analysis);
  drawFooter(ctx, analysis);

  chart.destroy();

  const blob = await new Promise<Blob | null>((resolve) =>
    output.toBlob(resolve, 'image/png'),
  );
  if (!blob) throw new Error('PNG konnte nicht erzeugt werden.');

  const start =
    ride.session.startTime ?? ride.records[0]?.timestamp ?? Date.now();
  const date = formatDateShort(start);
  const name = `fit-insight_${baseFileName(ride.fileName)}_${date.replace(/\./g, '-')}.png`;
  downloadBlob(blob, name);
}

function drawBackground(ctx: CanvasRenderingContext2D): void {
  const gradient = ctx.createLinearGradient(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
  gradient.addColorStop(0, '#0e1115');
  gradient.addColorStop(0.55, '#121212');
  gradient.addColorStop(1, '#0b0e12');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);

  const glow = ctx.createRadialGradient(180, 0, 0, 180, 0, 900);
  glow.addColorStop(0, 'rgba(0, 229, 255, 0.10)');
  glow.addColorStop(1, 'rgba(0, 229, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, OUTPUT_WIDTH, 700);

  ctx.fillStyle = '#00E5FF';
  ctx.fillRect(0, 0, OUTPUT_WIDTH, 5);
}

function drawHeader(ctx: CanvasRenderingContext2D, ride: RideData): void {
  const start = ride.session.startTime ?? ride.records[0]?.timestamp;
  const accent = ctx.createLinearGradient(60, 0, 64, 0);
  accent.addColorStop(0, '#00E5FF');
  accent.addColorStop(1, '#00E5FF');
  ctx.fillStyle = accent;
  ctx.fillRect(60, 54, 4, 42);

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#f4f8fb';
  ctx.font = `700 34px ${CHART_FONT}`;
  ctx.fillText('FIT INSIGHT', 82, 76);

  ctx.fillStyle = '#8492a1';
  ctx.font = `400 15px ${CHART_FONT}`;
  const device = ride.session.device ? ` · ${ride.session.device}` : '';
  const date = start ? ` · ${formatDateShort(start)}` : '';
  ctx.fillText(`Intervallanalyse · ${ride.fileName}${date}${device}`, 82, 100);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#5f6c7a';
  ctx.font = `500 12px ${CHART_FONT}`;
  ctx.fillText('LOKAL ANALYSIERT · KEIN UPLOAD', OUTPUT_WIDTH - 60, 76);
}

function drawKpis(ctx: CanvasRenderingContext2D, analysis: AnalysisResult): void {
  const { metrics } = analysis;
  const distance =
    metrics.distanceM != null
      ? `${formatDecimal(metrics.distanceM / 1000, 1)} km`
      : '';
  const cards = [
    { label: 'DAUER', value: formatDuration(metrics.duration), sub: distance },
    { label: 'Ø LEISTUNG', value: `${formatNumber(metrics.avgPower)} W` },
    { label: 'NORMALIZED POWER', value: `${formatNumber(metrics.normalizedPower)} W` },
    { label: 'ARBEIT', value: `${formatNumber(metrics.workKJ)} kJ` },
    {
      label: 'Ø HERZFREQUENZ',
      value:
        metrics.avgHeartRate != null ? `${formatNumber(metrics.avgHeartRate)} bpm` : '–',
    },
    {
      label: 'STRUKTUR',
      value: `${analysis.sets.length} Sätze`,
      sub: `${analysis.intervals.length} Intervalle`,
    },
  ];

  const left = 60;
  const right = OUTPUT_WIDTH - 60;
  const width = (right - left) / cards.length;

  cards.forEach((card, index) => {
    const x = left + width * index;
    if (index > 0) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
      ctx.fillRect(x - 12, 148, 1, 58);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = '#6f7d8c';
    ctx.font = `600 10px ${CHART_FONT}`;
    ctx.fillText(card.label, x, 160);

    ctx.fillStyle = '#f4f8fb';
    ctx.font = `600 27px ${CHART_FONT}`;
    ctx.fillText(card.value, x, 192);

    if (card.sub) {
      ctx.fillStyle = '#00E5FF';
      ctx.font = `500 11px ${CHART_FONT}`;
      ctx.fillText(card.sub, x, 208);
    }
  });

  // Ride-Datum wird im Header gezeigt, hier nur eine feine Trennlinie.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.fillRect(60, 230, OUTPUT_WIDTH - 120, 1);
}

function drawChartPanel(ctx: CanvasRenderingContext2D, chartCanvas: HTMLCanvasElement): void {
  fillRoundRect(ctx, 60, 238, 1880, 850, 18, 'rgba(22, 25, 30, 0.9)');
  strokeRoundRect(ctx, 60, 238, 1880, 850, 18, 'rgba(255, 255, 255, 0.08)');
  ctx.drawImage(chartCanvas, 80, 258, CHART_WIDTH, CHART_HEIGHT);
}

function drawStructure(ctx: CanvasRenderingContext2D, analysis: AnalysisResult): void {
  ctx.textAlign = 'left';
  ctx.fillStyle = '#6f7d8c';
  ctx.font = `600 10px ${CHART_FONT}`;
  ctx.fillText('ERKANNTE STRUKTUR', 60, 1138);

  const summary =
    analysis.sets.length > 0
      ? analysis.sets
          .map((set) => `SET ${set.id} · ${set.label}`)
          .join('     •     ')
      : 'Keine strukturierten Intervalle erkannt – Schwellenwerte im Dashboard anpassen.';

  let size = 18;
  ctx.font = `500 ${size}px ${CHART_FONT}`;
  while (size > 11 && ctx.measureText(summary).width > OUTPUT_WIDTH - 120) {
    size -= 1;
    ctx.font = `500 ${size}px ${CHART_FONT}`;
  }
  ctx.fillStyle = analysis.sets.length > 0 ? '#dce6ef' : '#7f8b99';
  ctx.fillText(summary, 60, 1170);
}

function drawFooter(ctx: CanvasRenderingContext2D, analysis: AnalysisResult): void {
  ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.fillRect(60, 1272, OUTPUT_WIDTH - 120, 1);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#5f6c7a';
  ctx.font = `400 12px ${CHART_FONT}`;
  const confidenceLine = analysis.thresholdInfo.confidence
    ? ` · Konfidenz ${Math.round(
        analysis.thresholdInfo.confidence * 100,
      )}% (${analysis.thresholdInfo.method})`
    : '';
  ctx.fillText(
    `FIT Insight · ON-Schwelle ${analysis.thresholdW} W · Glättung ${analysis.options.smoothingSeconds} s · min. ON ${analysis.options.minOnSeconds} s${confidenceLine}`,
    60,
    1304,
  );

  ctx.textAlign = 'right';
  ctx.fillStyle = '#3f4b57';
  ctx.font = `500 12px ${CHART_FONT}`;
  ctx.fillText('Leistungsprofil mit automatischen Intervallen', OUTPUT_WIDTH - 60, 1304);
}

function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fill: string,
): void {
  roundRectPath(ctx, x, y, width, height, radius);
  ctx.fillStyle = fill;
  ctx.fill();
}

function strokeRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  stroke: string,
): void {
  roundRectPath(ctx, x, y, width, height, radius);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}
