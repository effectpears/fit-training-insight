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

/** Eine einzelne Stufe eines strukturierten FIT-Workouts (workout_step_mesg). */
export interface FitWorkoutStep {
  /** Index der Stufe innerhalb des Workouts (Sortierreihenfolge). */
  messageIndex: number;
  name?: string;
  /** Geplante Dauer, meist in Sekunden (bei durationType = time/open). */
  durationValue?: number;
  durationType?: string;
  targetType?: string;
  targetValueLow?: number;
  targetValueHigh?: number;
  /** warmup | interval | recovery | cooldown | rest (Garmin-Intensity-Enum). */
  intensity?: string;
  /** Vereinfachtes Leistungsziel, falls targetType darauf hindeutet. */
  targetPower?: number;
}

/** Strukturiertes Workout aus der FIT-Datei (workout_mesg + zugehörige Steps). */
export interface FitWorkout {
  name?: string;
  description?: string;
  sport?: string;
  numValidSteps?: number;
  steps: FitWorkoutStep[];
}

export interface RideData {
  fileName: string;
  fileSize: number;
  records: FitRecord[];
  session: FitSessionSummary;
  /** Explizite Rundenmarker, z. B. aus strukturierten Garmin-Workouts. */
  laps: FitLap[];
  /** Strukturierte Workout-Schritte, falls in der Datei enthalten. */
  workouts: FitWorkout[];
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
  /** Schwelle senken, wenn auch schwächere Belastungsblöcke erkannt werden sollen. */
  thresholdBoost?: number;
  /** Aufgeblasene Schätzung für schwach kontrastierte Fahrt (Laps bevorzugen). */
  thresholdHint?: number;
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
  /** Wann die Phase zuletzt überarbeitet wurde (Debug/Export). */
  source?: 'laps' | 'workout' | 'sets';
}

/** Eintrittswert einer Schwelle bei Hysterese. */
export interface ThresholdInfo {
  /** Für die Erkennung verwendete Schwelle in Watt. */
  thresholdW: number;
  /** Ob die Schwelle automatisch geschätzt wurde. */
  auto: boolean;
  /** Score 0–1, wie klar die Leistung bimodal verteilt ist (1 = sehr klar). */
  confidence: number;
  /** Anteil der Zeit über der Schwelle (0–1). */
  onFraction: number;
  /** Verwendete Methode: 'two-means', 'otsu', 'percentile' oder 'manual'. */
  method: 'two-means' | 'otsu' | 'percentile' | 'manual';
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
  /** 'lap' wenn aus FIT-Laps, 'power' wenn aus der Leistungserkennung. */
  source?: 'lap' | 'power';
  /** Active-Recovery-Phase unterhalb der Schwelle innerhalb eines Satzes (Over-Under). */
  under?: boolean;
  /** Kontrast zur Erholung (0–1, 1 = stark abgesetzter Block). */
  contrast?: number;
  /** Konfidenz der Erkennung für diesen Block (0–1). */
  confidence?: number;
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
  /** Art des Satzes: 'uniform' (alle Reps gleich) oder 'over-under' (wechselnde Reps). */
  kind: 'uniform' | 'over-under';
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
  stoppedSeconds: number;
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
  /** Info zur Schwellen-Schätzung (Methode, Konfidenz, …). */
  thresholdInfo: ThresholdInfo;
  options: DetectionOptions;
}

export interface AppState {
  ride: RideData | null;
  series: RideSeries | null;
  analysis: AnalysisResult | null;
  options: DetectionOptions;
  chartPoints: SeriesPoint[];
}
