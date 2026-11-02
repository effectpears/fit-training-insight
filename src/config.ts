import type { DetectionOptions } from './types';

export const DEFAULT_OPTIONS: DetectionOptions = {
  thresholdW: 250,
  autoThreshold: true,
  smoothingSeconds: 5,
  minOnSeconds: 10,
  minOffSeconds: 10,
  setBreakSeconds: 90,
  ftp: undefined,
};

export const MAX_FILE_SIZE = 80 * 1024 * 1024;
