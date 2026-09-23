import { describe, expect, it } from 'vitest';
import { fmtDuration, fmtHours } from '../client/src/util';

/**
 * Hour quantities on the Analytics tab and the Metrics page are hours, never
 * rolled into days; fmtDuration keeps the d/h form for elapsed-time chips.
 */
describe('fmtHours', () => {
  it('never aggregates hours into days', () => {
    expect(fmtHours(60)).toBe('60h');
    expect(fmtHours(79)).toBe('79h');
    expect(fmtHours(505.7)).toBe('505.7h');
    expect(fmtHours(619)).toBe('619h');
    expect(fmtDuration(60)).toBe('2d 12h'); // the contrast this formatter exists for
  });

  it('keeps one decimal below 1,000 and drops it when whole', () => {
    expect(fmtHours(18.7)).toBe('18.7h');
    expect(fmtHours(18.74)).toBe('18.7h');
    expect(fmtHours(36.25)).toBe('36.3h');
    expect(fmtHours(1)).toBe('1h');
    expect(fmtHours(999.96)).toBe('1,000h');
  });

  it('rounds to whole hours with thousands separators from 1,000', () => {
    expect(fmtHours(1240)).toBe('1,240h');
    expect(fmtHours(1240.6)).toBe('1,241h');
    expect(fmtHours(12_345.4)).toBe('12,345h');
  });

  it('uses minutes only under one hour', () => {
    expect(fmtHours(0.6)).toBe('36m');
    expect(fmtHours(0.2)).toBe('12m');
    expect(fmtHours(0.004)).toBe('0m');
    expect(fmtHours(0.9999)).toBe('1h');
  });

  it('is a dash for missing or nonsense input', () => {
    expect(fmtHours(null)).toBe('—');
    expect(fmtHours(undefined)).toBe('—');
    expect(fmtHours(Number.NaN)).toBe('—');
    expect(fmtHours(-2)).toBe('—');
  });
});
