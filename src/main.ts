import './fonts.css';
import './styles.css';
import type {
  AnalysisResult,
  AppState,
  DetectionOptions,
  RideData,
  SeriesPoint,
} from './types';
import { Chart } from './chart/setup';
import { analyzeRide } from './analysis/analyze';
import { buildSeries } from './analysis/series';
import { buildChartConfig } from './chart/chartConfig';
import { downsampleSeries } from './chart/downsample';
import { exportAnalysisPng } from './chart/exportPng';
import { createDemoRide } from './fit/demoRide';
import { parseFitFile } from './fit/parseFit';
import { DEFAULT_OPTIONS, MAX_FILE_SIZE } from './config';
import { exportAnalysisJson, exportIntervalsCsv } from './ui/exportData';
import {
  renderIntervals,
  renderKpis,
  renderRideMeta,
  renderSets,
  renderWarnings,
  renderZones,
} from './ui/render';
import { showToast } from './ui/toast';
import { byId } from './ui/dom';

const els = {
  progress: byId<HTMLDivElement>('progress'),
  dropzone: byId<HTMLElement>('dropzone'),
  fileInput: byId<HTMLInputElement>('file-input'),
  demoBtn: byId<HTMLButtonElement>('demo-btn'),
  dashboard: byId<HTMLElement>('dashboard'),
  newFileBtn: byId<HTMLButtonElement>('new-file-btn'),
  exportBtn: byId<HTMLButtonElement>('export-btn'),
  fileChip: byId<HTMLSpanElement>('file-chip'),
  rideName: byId<HTMLElement>('ride-name'),
  rideSub: byId<HTMLElement>('ride-sub'),
  warnings: byId<HTMLDivElement>('warnings'),
  kpis: byId<HTMLDivElement>('kpis'),
  sets: byId<HTMLDivElement>('sets'),
  setCount: byId<HTMLSpanElement>('set-count'),
  intervals: byId<HTMLTableSectionElement>('interval-body'),
  intervalCount: byId<HTMLSpanElement>('interval-count'),
  zones: byId<HTMLDivElement>('zones'),
  zoneRef: byId<HTMLSpanElement>('zone-ref'),
  csvBtn: byId<HTMLButtonElement>('csv-btn'),
  jsonBtn: byId<HTMLButtonElement>('json-btn'),
  resetControls: byId<HTMLButtonElement>('reset-controls'),
  threshold: byId<HTMLInputElement>('threshold'),
  thresholdOut: byId<HTMLOutputElement>('threshold-out'),
  thresholdHint: byId<HTMLOutputElement>('threshold-hint'),
  autoThreshold: byId<HTMLInputElement>('auto-threshold'),
  smoothing: byId<HTMLInputElement>('smoothing'),
  smoothingOut: byId<HTMLOutputElement>('smoothing-out'),
  minOn: byId<HTMLInputElement>('min-on'),
  minOnOut: byId<HTMLOutputElement>('min-on-out'),
  minOff: byId<HTMLInputElement>('min-off'),
  minOffOut: byId<HTMLOutputElement>('min-off-out'),
  setBreak: byId<HTMLInputElement>('set-break'),
  setBreakOut: byId<HTMLOutputElement>('set-break-out'),
  ftp: byId<HTMLInputElement>('ftp'),
  chart: byId<HTMLCanvasElement>('chart'),
};

const state: AppState = {
  ride: null,
  series: null,
  analysis: null,
  options: { ...DEFAULT_OPTIONS },
  chartPoints: [],
};

let chart: Chart | null = null;
let analysisTimer: number | undefined;
let dragDepth = 0;

init();

function init(): void {
  syncControls();
  bindControls();
  bindDropzone();
  bindActions();
  paintAllRanges();

  if (window.location.hash === '#demo') {
    loadDemo();
  }
}

function bindControls(): void {
  els.threshold.addEventListener('input', () => {
    if (els.autoThreshold.checked) els.autoThreshold.checked = false;
    paintRange(els.threshold);
    updateOutputs();
    scheduleAnalysis();
  });

  els.autoThreshold.addEventListener('change', () => {
    paintRange(els.threshold);
    updateOutputs();
    scheduleAnalysis(40);
  });

  for (const input of [els.smoothing, els.minOn, els.minOff, els.setBreak]) {
    input.addEventListener('input', () => {
      paintRange(input);
      updateOutputs();
      scheduleAnalysis();
    });
  }

  els.ftp.addEventListener('input', () => {
    scheduleAnalysis(450);
  });

  els.resetControls.addEventListener('click', () => {
    state.options = { ...DEFAULT_OPTIONS };
    syncControls();
    if (state.series) runAnalysis();
  });
}

function bindDropzone(): void {
  els.dropzone.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('button')) return;
    els.fileInput.click();
  });

  els.dropzone.addEventListener('keydown', (event) => {
    if (event.target !== els.dropzone) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    els.fileInput.click();
  });

  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files?.[0];
    els.fileInput.value = '';
    if (file) void loadFitFile(file);
  });

  els.dropzone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    els.dropzone.classList.add('dragging');
  });

  els.dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });

  els.dropzone.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) els.dropzone.classList.remove('dragging');
  });

  els.dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    els.dropzone.classList.remove('dragging');
    const file = event.dataTransfer?.files?.[0];
    if (file) void loadFitFile(file);
  });

  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => {
    if (!els.dropzone.contains(event.target as Node)) event.preventDefault();
  });
}

function bindActions(): void {
  els.demoBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    loadDemo();
  });

  els.newFileBtn.addEventListener('click', resetToUpload);

  els.dashboard.addEventListener('dragover', (event) => event.preventDefault());
  els.dashboard.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) void loadFitFile(file);
  });

  els.exportBtn.addEventListener('click', () => {
    void handleExport();
  });

  els.csvBtn.addEventListener('click', () => {
    if (state.ride && state.analysis) {
      exportIntervalsCsv(state.ride, state.analysis);
      showToast('Intervalle als CSV exportiert.');
    }
  });

  els.jsonBtn.addEventListener('click', () => {
    if (state.ride && state.analysis) {
      exportAnalysisJson(state.ride, state.analysis);
      showToast('Analyse als JSON exportiert.');
    }
  });
}

async function loadFitFile(file: File): Promise<void> {
  if (!/\.fit$/i.test(file.name)) {
    showToast('Bitte eine Datei mit der Endung .fit auswählen.', 'error');
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    showToast('Die Datei ist größer als 80 MB.', 'error');
    return;
  }

  setBusy(true);
  try {
    const ride = await parseFitFile(file);
    startRide(ride);
    const warningText =
      ride.warnings.length > 0 ? ` (${ride.warnings.length} Hinweis(e))` : '';
    showToast(`${ride.fileName} analysiert${warningText}.`);
  } catch (error) {
    showToast(messageOf(error), 'error');
  } finally {
    setBusy(false);
  }
}

function loadDemo(): void {
  try {
    startRide(createDemoRide());
    showToast('Demo-Fahrt geladen: 3 Sätze, 13 Intervalle.');
  } catch (error) {
    showToast(messageOf(error), 'error');
  }
}

function startRide(ride: RideData): void {
  const hasPower = ride.records.some((record) => record.power != null);
  const hasHeartRate = ride.records.some(
    (record) => record.heartRate != null,
  );
  if (!hasPower && !hasHeartRate) {
    throw new Error(
      'Die Datei enthält weder Leistungs- noch Herzfrequenzdaten. Für die '
        + 'Analyse werden ein Power-Meter oder ein Herzfrequenzsensor benötigt.',
    );
  }

  state.ride = ride;
  state.series = buildSeries(ride.records);
  state.analysis = null;
  state.options = { ...DEFAULT_OPTIONS };

  els.dropzone.hidden = true;
  els.dashboard.hidden = false;
  els.newFileBtn.hidden = false;
  els.fileChip.hidden = false;
  els.exportBtn.disabled = true;

  renderRideMeta(els.rideName, els.rideSub, els.fileChip, ride);
  renderWarnings(els.warnings, ride.warnings);
  syncControls();
  runAnalysis();

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetToUpload(): void {
  clearTimeout(analysisTimer);
  chart?.destroy();
  chart = null;
  state.ride = null;
  state.series = null;
  state.analysis = null;
  state.chartPoints = [];
  state.options = { ...DEFAULT_OPTIONS };

  els.dashboard.hidden = true;
  els.dropzone.hidden = false;
  els.newFileBtn.hidden = true;
  els.fileChip.hidden = true;
  els.exportBtn.disabled = true;
  els.warnings.hidden = true;
  els.fileInput.value = '';
  syncControls();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function scheduleAnalysis(delay = 140): void {
  if (!state.series) return;
  if (analysisTimer != null) window.clearTimeout(analysisTimer);
  analysisTimer = window.setTimeout(() => {
    analysisTimer = undefined;
    runAnalysis();
  }, delay);
}

function runAnalysis(): void {
  if (!state.series) return;

  try {
    const options = readControls();
    const analysis = analyzeRide(
      state.series,
      options,
      state.ride?.session.totalDistance ?? null,
      state.ride?.laps ?? [],
      state.ride?.workouts ?? [],
    );
    state.analysis = analysis;
    state.options = analysis.options;

    syncControls();
    renderKpis(els.kpis, analysis);
    renderThresholdHint(analysis);
    renderSets(els.sets, analysis);
    renderIntervals(els.intervals, analysis);
    renderZones(els.zones, els.zoneRef, analysis);
    els.setCount.textContent = `${analysis.sets.length}`;
    els.intervalCount.textContent = `${analysis.intervals.length}`;
    els.exportBtn.disabled = false;

    renderChart(analysis.series.points);
  } catch (error) {
    console.error(error);
    showToast(`Analyse fehlgeschlagen: ${messageOf(error)}`, 'error');
  }
}

function renderChart(points: readonly SeriesPoint[]): void {
  if (!state.analysis) return;
  state.chartPoints = downsampleSeries(points, 2400);
  chart?.destroy();
  chart = new Chart(
    els.chart,
    buildChartConfig(state.analysis, state.chartPoints),
  );
}

async function handleExport(): Promise<void> {
  if (!state.ride || !state.analysis) return;

  const original = els.exportBtn.innerHTML;
  els.exportBtn.disabled = true;
  els.exportBtn.textContent = 'Exportiere …';

  try {
    await exportAnalysisPng(state.ride, state.analysis, state.chartPoints);
    showToast('PNG mit allen Annotationen gespeichert.');
  } catch (error) {
    console.error(error);
    showToast(`PNG-Export fehlgeschlagen: ${messageOf(error)}`, 'error');
  } finally {
    els.exportBtn.innerHTML = original;
    els.exportBtn.disabled = false;
  }
}

function readControls(): DetectionOptions {
  const ftpRaw = els.ftp.value.trim();
  const ftp = ftpRaw === '' ? undefined : Number(ftpRaw);
  return {
    ...state.options,
    thresholdW: Number(els.threshold.value),
    autoThreshold: els.autoThreshold.checked,
    smoothingSeconds: Number(els.smoothing.value),
    minOnSeconds: Number(els.minOn.value),
    minOffSeconds: Number(els.minOff.value),
    setBreakSeconds: Number(els.setBreak.value),
    ftp: ftp != null && Number.isFinite(ftp) && ftp > 0 ? ftp : undefined,
  };
}

function syncControls(): void {
  els.threshold.max = String(
    Math.max(900, Math.ceil(state.options.thresholdW / 50) * 50),
  );
  els.threshold.value = String(Math.round(state.options.thresholdW));
  els.autoThreshold.checked = state.options.autoThreshold;
  els.smoothing.value = String(state.options.smoothingSeconds);
  els.minOn.value = String(state.options.minOnSeconds);
  els.minOff.value = String(state.options.minOffSeconds);
  els.setBreak.value = String(state.options.setBreakSeconds);
  els.ftp.value =
    state.options.ftp != null && state.options.ftp > 0
      ? String(Math.round(state.options.ftp))
      : '';
  updateOutputs();
  paintAllRanges();
}

function updateOutputs(): void {
  els.thresholdOut.textContent = `${Math.round(Number(els.threshold.value))} W`;
  els.smoothingOut.textContent = `${els.smoothing.value} s`;
  els.minOnOut.textContent = `${els.minOn.value} s`;
  els.minOffOut.textContent = `${els.minOff.value} s`;
  els.setBreakOut.textContent = `${els.setBreak.value} s`;
}

/** Zeigt einen Hinweis zur geschätzten Schwelle und deren Konfidenz. */
function renderThresholdHint(analysis: AnalysisResult): void {
  if (!els.autoThreshold.checked || !analysis.thresholdInfo) {
    els.thresholdHint.textContent = '–';
    return;
  }
  const pct = Math.round(analysis.thresholdInfo.confidence * 100);
  els.thresholdHint.textContent =
    pct > 0
      ? `geschätzt (${analysis.thresholdInfo.method}, Konfidenz ${pct} %)`
      : 'geschätzt (geringe Konfidenz)';
}

function paintAllRanges(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>(
    'input[type="range"]',
  )) {
    paintRange(input);
  }
}

function paintRange(input: HTMLInputElement): void {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value);
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--fill', `${Math.min(100, Math.max(0, percent))}%`);
}

function setBusy(busy: boolean): void {
  els.progress.hidden = !busy;
  els.dropzone.setAttribute('aria-busy', String(busy));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
