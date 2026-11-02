import type { AnalysisResult, PowerStep, RideData } from '../types';
import {
  formatClock,
  formatDecimal,
  formatDuration,
  formatNumber,
} from '../utils/format';

export function renderKpis(container: HTMLElement, analysis: AnalysisResult): void {
  const { metrics } = analysis;
  const distance =
    metrics.distanceM != null
      ? `${formatDecimal(metrics.distanceM / 1000, 1)} km`
      : 'Distanz unbekannt';

  const cards = [
    {
      label: 'Dauer',
      value: formatDuration(metrics.duration),
      sub: distance,
    },
    {
      label: 'Ø Leistung',
      value: `${formatNumber(metrics.avgPower)} W`,
      sub: `Max ${formatNumber(metrics.maxPower)} W`,
    },
    {
      label: 'Normalized Power',
      value: `${formatNumber(metrics.normalizedPower)} W`,
      sub:
        metrics.intensityFactor != null
          ? `IF ${metrics.intensityFactor.toFixed(2)}`
          : 'FTP für IF eingeben',
      accent: metrics.intensityFactor != null,
    },
    {
      label: 'Arbeit',
      value: `${formatNumber(metrics.workKJ)} kJ`,
      sub: `${analysis.intervals.length} Intervalle`,
    },
    {
      label: 'Ø Herzfrequenz',
      value:
        metrics.avgHeartRate != null
          ? `${formatNumber(metrics.avgHeartRate)} bpm`
          : '–',
      sub:
        metrics.maxHeartRate != null
          ? `Max ${formatNumber(metrics.maxHeartRate)} bpm`
          : 'Keine HF-Daten',
    },
    {
      label: 'Sätze',
      value: `${analysis.sets.length}`,
      sub: `${analysis.intervals.length} Intervalle`,
    },
    {
      label: 'TSS',
      value: metrics.tss != null ? `${formatNumber(metrics.tss)} TSS` : '–',
      sub:
        metrics.tss != null
          ? 'aus FTP berechnet'
          : analysis.options.ftp
            ? 'FTP zu niedrig'
            : 'FTP eingeben',
      accent: metrics.tss != null,
    },
  ];

  container.innerHTML = cards
    .map(
      (card) => `
        <div class="kpi">
          <span class="kpi-label">${card.label}</span>
          <span class="kpi-value">${card.value}</span>
          <span class="kpi-sub${card.accent ? ' accent' : ''}">${card.sub}</span>
        </div>`,
    )
    .join('');
}

export function renderSets(container: HTMLElement, analysis: AnalysisResult): void {
  if (analysis.sets.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <strong>Keine strukturierten Intervalle erkannt</strong>
        Die Fahrt ist gleichmäßig oder die ON-Schwelle liegt zu hoch. Senke die
        Schwelle, wenn auch kleinere Belastungsblöcke sichtbar sein sollen.
      </div>`;
    return;
  }

  container.innerHTML = analysis.sets
    .map((set) => {
      const reps = set.patternSeconds?.length
        ? `${set.reps} × (${set.patternSeconds
            .map((seconds) => Math.round(seconds))
            .join('/')} s)`
        : set.offSeconds > 0
          ? `${set.reps} × ${formatSeconds(set.onSeconds)} / ${formatSeconds(set.offSeconds)}`
          : `${set.reps} × ${formatSeconds(set.onSeconds)}`;
      const pause =
        set.patternSeconds?.length && set.offSeconds > 0
          ? `+ ${formatSeconds(set.offSeconds)} Pause · `
          : '';
      return `
        <article class="set-card">
          <div class="set-card-top">
            <span class="set-badge">SET ${set.id}</span>
            <span class="set-time">${formatClock(set.start)} – ${formatClock(set.end)}</span>
          </div>
          <h3>${reps}</h3>
          <p class="set-target">${pause}@ ${formatNumber(set.targetPower)} W</p>
          ${stepLine(set)}
          <dl class="set-stats">
            <div><dt>Ø Leistung</dt><dd>${formatNumber(set.avgPower)} W</dd></div>
            <div><dt>Max</dt><dd>${formatNumber(set.maxPower)} W</dd></div>
            <div><dt>Ø HF</dt><dd>${set.avgHeartRate != null ? `${formatNumber(set.avgHeartRate)} bpm` : '–'}</dd></div>
            <div><dt>Arbeit</dt><dd>${formatNumber(set.workKJ)} kJ</dd></div>
          </dl>
        </article>`;
    })
    .join('');
}

export function renderIntervals(container: HTMLElement, analysis: AnalysisResult): void {
  if (analysis.intervals.length === 0) {
    container.innerHTML = `
      <tr>
        <td colspan="10">
          <div class="empty-state">Keine Intervalle erkannt – Schwellenwerte anpassen.</div>
        </td>
      </tr>`;
    return;
  }

  container.innerHTML = analysis.intervals
    .map(
      (interval) => `
        <tr>
          <td>${interval.index}</td>
          <td><span class="set-chip">S${interval.setId}</span></td>
          <td>${formatClock(interval.start)}</td>
          <td>${formatSeconds(interval.duration)}</td>
          <td class="num strong">${formatNumber(interval.avgPower)}</td>
          <td class="num">${formatNumber(interval.maxPower)}</td>
          <td class="steps"${interval.steps?.length ? ` title="${stepChanges(interval.steps)}"` : ''}>${
            interval.steps?.length ? stepLevels(interval.steps) : '–'
          }</td>
          <td class="num">${interval.avgHeartRate != null ? formatNumber(interval.avgHeartRate) : '–'}</td>
          <td class="num">${interval.avgCadence != null ? formatNumber(interval.avgCadence) : '–'}</td>
          <td class="num">${formatDecimal(interval.workKJ, 1)}</td>
        </tr>`,
    )
    .join('');
}

export function renderZones(
  container: HTMLElement,
  reference: HTMLElement,
  analysis: AnalysisResult,
): void {
  const { zones, ftpReference } = analysis.metrics;
  const total = zones.reduce((sum, zone) => sum + zone.seconds, 0);

  if (analysis.options.ftp != null && analysis.options.ftp > 0) {
    reference.textContent = `FTP ${formatNumber(analysis.options.ftp)} W`;
    reference.title = 'Zonen bezogen auf die eingegebene FTP.';
  } else if (ftpReference != null) {
    reference.textContent = `Ref. ${formatNumber(ftpReference)} W`;
    reference.title = 'FTP nicht gesetzt – Zonen relativ zur geschätzten Threshold-Leistung.';
  } else {
    reference.textContent = '–';
  }

  if (total === 0 || zones.length === 0) {
    container.innerHTML = '<div class="empty-state">Keine Leistungsdaten für die Zonenverteilung.</div>';
    return;
  }

  const segments = zones
    .map(
      (zone) => `
        <span
          class="zone-segment"
          style="width:${(zone.seconds / total) * 100}%;background:${zone.color}"
          title="${zone.name}: ${formatDuration(zone.seconds)}"
        ></span>`,
    )
    .join('');

  const legend = zones
    .map(
      (zone) => `
        <span class="zone-chip">
          <span class="zone-dot" style="background:${zone.color}"></span>
          <strong>${zone.name}</strong>
          <span>${formatDuration(zone.seconds)} · ${Math.round((zone.seconds / total) * 100)} %</span>
        </span>`,
    )
    .join('');

  container.innerHTML = `
    <div class="zone-bar" role="img" aria-label="Zeitverteilung über die Leistungszonen">${segments}</div>
    <div class="zone-legend">${legend}</div>`;
}

export function renderRideMeta(
  nameElement: HTMLElement,
  subElement: HTMLElement,
  chipElement: HTMLElement,
  ride: RideData,
): void {
  const session = ride.session;
  nameElement.textContent = ride.fileName;
  const date = session.startTime
    ? new Intl.DateTimeFormat('de-DE', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(session.startTime))
    : '';
  const parts = [
    date,
    session.totalDistance != null
      ? `${formatDecimal(session.totalDistance / 1000, 1)} km`
      : '',
    formatSport(session.sport),
    session.device ?? '',
  ].filter(Boolean);
  subElement.textContent = parts.join(' · ');
  chipElement.textContent = ride.fileSize > 0 ? ride.fileName : 'Demo-Fahrt';
  chipElement.title = ride.fileName;
}

export function renderWarnings(container: HTMLElement, warnings: readonly string[]): void {
  if (warnings.length === 0) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }

  const list = document.createElement('ul');
  for (const warning of warnings) {
    const item = document.createElement('li');
    item.textContent = warning;
    list.append(item);
  }
  container.replaceChildren(list);
  container.hidden = false;
}

const SPORT_LABELS: Record<string, string> = {
  cycling: 'Radfahren',
  indoor_cycling: 'Indoor-Rad',
  e_biking: 'E-Bike',
  running: 'Laufen',
  swimming: 'Schwimmen',
  walking: 'Gehen',
  hiking: 'Wandern',
  rowing: 'Rudern',
};

function formatSport(sport: string | undefined): string {
  if (!sport) return '';
  return SPORT_LABELS[sport.toLowerCase()] ?? sport;
}

function formatSeconds(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 90) return `${rounded} s`;
  return formatClock(rounded);
}

/** Stufenzeile in der Satzkarte, z. B. „Stufen: 236 → 246 → 236 W“. */
function stepLine(set: { intervals: readonly { steps?: readonly PowerStep[] }[] }): string {
  const withSteps = set.intervals.find((interval) => interval.steps?.length);
  if (!withSteps?.steps) return '';
  return `<p class="set-steps" title="${stepChanges(withSteps.steps)}">Stufen: ${stepLevels(
    withSteps.steps,
  )} W</p>`;
}

function stepLevels(steps: readonly PowerStep[]): string {
  return steps.map((step) => Math.round(step.power)).join(' → ');
}

function stepChanges(steps: readonly PowerStep[]): string {
  return steps
    .slice(1)
    .map((step, index) => {
      const up = step.power > steps[index].power;
      return `${formatClock(step.at)} ${up ? '↗' : '↘'} ${Math.round(step.power)} W`;
    })
    .join(' · ');
}
