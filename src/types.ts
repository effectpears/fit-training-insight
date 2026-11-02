/** Gemeinsame Datentypen für Parser, Analyse, Chart und UI. */

/** Ein einzelner Messpunkt aus der FIT-Datei (Zeitstempel in epoch ms). */
export interface FitRecord {
  timestamp: number;
  power?: number;
  heartRate?: number;
  cadence?: number;
  speed?: number;
  distance?: number;
  altitude?: number;
}

export interface FitSessionSummary {
  sport?: string;
  subSport?: string;
  startTime?: number;
  totalElapsedTime?: number;
  totalTimerTime?: number;
  totalDistance?: number;
  avgPower?: number;
  maxPower?: number;
  normalizedPower?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  avgCadence?: number;
  totalWork?: number;
  device?: string;
}

/** Eine Lap aus der FIT-Datei, relativ zum ersten Record in Sekunden. */
export interface FitLap {
  start: number;
  end: number;
  duration: number;
}

export interface RideData {
  fileName: string;
  fileSize: number;
  records: FitRecord[];
  session: FitSessionSummary;
  /** Explizite Rundenmarker, z. B. aus strukturierten Garmin-Workouts. */
  laps: FitLap[];
  warnings: string[];
}

/** Auf eine 1-Hz-Rasterlinie gebrachte Zeitreihe. */
export interface SeriesPoint {
  /** Sekunden seit Fahrtbeginn. */
  t: number;
  power: number | null;
  heartRate: number | null;
  cadence: number | null;
  speed: number | null;
}

export interface RideSeries {
  points: SeriesPoint[];
  duration: number;
  sampleRate: number;
}

export interface DetectionOptions {
  /** Leistungsschwelle, ab der ein Abschnitt als "ON" gilt. */
  thresholdW: number;
  /** Schwelle automatisch aus dem Leistungsprofil schätzen. */
  autoThreshold: boolean;
  /** Gleitender Mittelwert in Sekunden (1 = roh). */
  smoothingSeconds: number;
  /** Kürzere Belastungen werden verworfen. */
  minOnSeconds: number;
  /** Kürzere Erholungen werden geschlossen. */
  minOffSeconds: number;
  /** Längere Pausen trennen Sätze. */
  setBreakSeconds: number;
  /** Optionale FTP für IF/TSS und Zonen. */
  ftp?: number;
}

export type PhaseKind = 'warmup' | 'set' | 'recovery' | 'cooldown' | 'ride';

export interface Phase {
  kind: PhaseKind;
  start: number;
  end: number;
  label: string;
  setId?: number;
}

/**
 * Leistungsstufe innerhalb eines langen Blocks (z. B. 236 → 246 → 236 W).
 * Der erste Eintrag trägt das Anfangsniveau (at = Blockstart), alle weiteren
 * den Zeitpunkt des Sprungs und das neue Niveau.
 */
export interface PowerStep {
  at: number;
  power: number;
}

export interface Interval {
  index: number;
  setId: number;
  start: number;
  end: number;
  duration: number;
  avgPower: number;
  maxPower: number;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  avgCadence: number | null;
  workKJ: number;
  /** Interne Leistungssprünge bei langen Blöcken (≥ 8 min). */
  steps?: PowerStep[];
}

export interface WorkoutSet {
  id: number;
  start: number;
  end: number;
  reps: number;
  onSeconds: number;
  offSeconds: number;
  /**
   * Dauer der Teilstufen innerhalb einer Wiederholung, z. B. `[45, 45, 45]`
   * für 5 × (45 s / 45 s / 45 s + 60 s Pause). Leer bei uniformen Sätzen.
   */
  patternSeconds?: number[];
  targetPower: number;
  avgPower: number;
  maxPower: number;
  avgHeartRate: number | null;
  workKJ: number;
  label: string;
  intervals: Interval[];
}

export interface ZoneShare {
  id: string;
  name: string;
  color: string;
  seconds: number;
}

export interface RideMetrics {
  duration: number;
  movingTime: number;
  distanceM: number | null;
  avgPower: number;
  maxPower: number;
  normalizedPower: number;
  workKJ: number;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  avgCadence: number | null;
  intensityFactor: number | null;
  tss: number | null;
  zones: ZoneShare[];
  ftpReference: number | null;
}

export interface AnalysisResult {
  series: RideSeries;
  intervals: Interval[];
  sets: WorkoutSet[];
  phases: Phase[];
  metrics: RideMetrics;
  /** Tatsächlich verwendete Schwelle (bei Auto-Modus die geschätzte). */
  thresholdW: number;
  options: DetectionOptions;
}

export interface AppState {
  ride: RideData | null;
  series: RideSeries | null;
  analysis: AnalysisResult | null;
  options: DetectionOptions;
  chartPoints: SeriesPoint[];
}
