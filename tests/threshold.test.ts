import { describe, expect, it } from 'vitest';
import { suggestThreshold } from '../src/analysis/threshold';

describe('suggestThreshold', () => {
  it('findet die Lücke zwischen zwei Leistungsmodi', () => {
    const powers = [
      ...Array.from({ length: 240 }, (_, index) => 130 + (index % 20)),
      ...Array.from({ length: 120 }, (_, index) => 300 + (index % 20)),
    ];
    const threshold = suggestThreshold(powers);
    expect(threshold).toBeGreaterThanOrEqual(145);
    expect(threshold).toBeLessThan(300);
  });

  it('liefert bei konstanter Fahrt eine Schwelle im oberen Bereich', () => {
    const powers = Array.from({ length: 600 }, (_, index) =>
      190 + Math.sin(index / 10) * 12,
    );
    const threshold = suggestThreshold(powers);
    expect(threshold).toBeGreaterThan(150);
    expect(threshold).toBeLessThan(230);
  });

  it('fällt bei fehlenden Daten auf einen Default zurück', () => {
    expect(suggestThreshold([])).toBe(200);
    expect(suggestThreshold([0, 0, 0, 0])).toBe(150);
  });
});
