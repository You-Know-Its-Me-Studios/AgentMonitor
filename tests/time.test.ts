import { afterEach, describe, expect, it } from 'vitest';
import { compareTimestamps, compareTimestampsNewestFirst, epochMilliseconds, formatTimestamp, normalizeTimestamp, relativeAge, validTimeZone } from '../src/shared/time.js';

const originalTZ = process.env.TZ;
afterEach(() => { if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ; });
describe('source instants and local display', () => {
  it('normalizes Z, explicit offsets and Unix seconds/milliseconds to one instant', () => {
    const iso = '2026-11-04T01:02:00.000Z';
    const milliseconds = Date.parse(iso);
    expect(normalizeTimestamp('2026-11-03T20:02:00-05:00')).toBe(iso);
    expect(normalizeTimestamp('2026-11-04T01:02:00Z')).toBe(iso);
    expect(normalizeTimestamp(milliseconds)).toBe(iso);
    expect(normalizeTimestamp(milliseconds / 1000)).toBe(iso);
    expect(normalizeTimestamp(String(milliseconds))).toBe(iso);
    expect(normalizeTimestamp(iso)).toBe(iso);
    expect(epochMilliseconds(iso)).toBe(milliseconds);
  });
  it('shows November 4 UTC as November 3 New York with a ten-second occurrence age', () => {
    const now = '2026-11-04T01:02:00Z';
    const occurrence = '2026-11-04T01:01:50Z';
    expect(formatTimestamp(now, 'America/New_York')).toBe('Nov 3, 8:02:00 PM EST');
    expect(formatTimestamp(now, 'America/New_York', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })).toBe('November 3, 2026 at 8:02 PM EST');
    expect(formatTimestamp(occurrence, 'America/New_York')).toBe('Nov 3, 8:01:50 PM EST');
    expect(relativeAge(occurrence, now)).toBe('10s ago');
  });
  it('uses daylight saving time and preserves ordering through the repeated fall hour', () => {
    expect(formatTimestamp('2026-07-04T01:02:00Z', 'America/New_York')).toBe('Jul 3, 9:02:00 PM EDT');
    const before = '2026-11-01T01:30:00-04:00', after = '2026-11-01T01:30:00-05:00';
    expect(compareTimestamps(before, after)).toBe(-3600000);
    expect(compareTimestampsNewestFirst(before, after)).toBe(3600000);
    expect(compareTimestampsNewestFirst(null, after)).toBeGreaterThan(0);
    expect(formatTimestamp(before, 'America/New_York')).toContain('1:30:00 AM EDT');
    expect(formatTimestamp(after, 'America/New_York')).toContain('1:30:00 AM EST');
  });
  it('rejects ambiguous local strings unless the source contract explicitly says UTC', () => {
    expect(normalizeTimestamp('2026-11-04T01:02:00')).toBeNull();
    expect(normalizeTimestamp('11/04/2026 01:02')).toBeNull();
    expect(normalizeTimestamp('2026-11-04')).toBeNull();
    expect(normalizeTimestamp('2026-11-04 01:02:00', 'utc')).toBe('2026-11-04T01:02:00.000Z');
    expect(normalizeTimestamp('2026-02-30T01:02:00Z')).toBeNull();
    expect(normalizeTimestamp('2026-11-04T25:02:00Z')).toBeNull();
  });
  it('normalization and an explicit display zone are invariant under backend TZ', () => {
    const outputs = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo'].map(zone => {
      process.env.TZ = zone;
      return [normalizeTimestamp('2026-11-03T20:02:00-05:00'), formatTimestamp('2026-11-04T01:02:00Z', 'America/New_York'), relativeAge('2026-11-04T01:01:50Z', '2026-11-04T01:02:00Z')];
    });
    expect(outputs[0]).toEqual(outputs[1]); expect(outputs[1]).toEqual(outputs[2]);
  });
  it('keeps missing instants unavailable and future clock skew explicit', () => {
    expect(normalizeTimestamp(null)).toBeNull();
    expect(normalizeTimestamp(Infinity)).toBeNull();
    expect(formatTimestamp('invalid', 'America/New_York')).toBe('Not reported');
    expect(relativeAge('2026-11-04T01:02:10Z', '2026-11-04T01:02:00Z')).toBe('in 10s');
    expect(compareTimestamps(null, '2026-11-04T01:02:00Z')).toBeGreaterThan(0);
    expect(validTimeZone('America/New_York')).toBe(true); expect(validTimeZone('New_York-ish')).toBe(false);
  });
});
