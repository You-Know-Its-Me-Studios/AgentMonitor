/** Convert a source timestamp into one UTC instant. Never infer a local offset. */
export function normalizeTimestamp(value: unknown, naive: 'utc' | 'reject' = 'reject'): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === 'number' || (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()))) {
    const number = typeof value === 'number' ? value : Number(value.trim());
    if (!Number.isFinite(number)) return null;
    // Current native records use Unix seconds (10 digits) or milliseconds (13).
    // Conversion happens here only; consumers compare the returned UTC instant.
    const milliseconds = Math.abs(number) < 100_000_000_000 ? number * 1000 : number;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value !== 'string') return null;
  const input = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(input);
  if (!match || (!match[8] && naive === 'reject')) return null;
  const [, year, month, day, hour, minute, seconds] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth || Number(hour) > 23 || Number(minute) > 59 || Number(seconds ?? 0) > 59) return null;
  const normalized = input.replace(' ', 'T') + (match[8] ? '' : 'Z');
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

export function epochMilliseconds(value: unknown, naive: 'utc' | 'reject' = 'reject'): number | null {
  const normalized = normalizeTimestamp(value, naive);
  return normalized === null ? null : Date.parse(normalized);
}

/** Ascending chronological order, with missing/ambiguous timestamps last. */
export function compareTimestamps(a: unknown, b: unknown): number {
  const left = epochMilliseconds(a), right = epochMilliseconds(b);
  return left === null ? (right === null ? 0 : 1) : right === null ? -1 : left - right;
}

export function detectedTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
export function validTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone.trim()) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(); return true; } catch { return false; }
}
export function resolveTimeZone(zone?: string | null): string { return validTimeZone(zone) ? zone : detectedTimeZone(); }

export function formatTimestamp(value: unknown, zone?: string | null, options?: Intl.DateTimeFormatOptions): string {
  const milliseconds = epochMilliseconds(value);
  if (milliseconds === null) return 'Not reported';
  const defaults: Intl.DateTimeFormatOptions = options ?? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };
  const hasClock = Boolean(defaults.hour || defaults.minute || defaults.second);
  return new Intl.DateTimeFormat('en-US', { hourCycle: 'h23', ...(hasClock ? { timeZoneName: 'short' } : {}), ...defaults, timeZone: resolveTimeZone(zone) }).format(milliseconds);
}

export function relativeAge(value: unknown, now: unknown = Date.now()): string {
  const at = epochMilliseconds(value), current = epochMilliseconds(now);
  if (at === null || current === null) return 'Not reported';
  const delta = current - at;
  const seconds = Math.floor(Math.abs(delta) / 1000);
  if (seconds < 1) return 'Just now';
  const age = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m` : `${Math.floor(seconds / 86400)}d ${Math.floor(seconds / 3600) % 24}h`;
  return delta < 0 ? `in ${age}` : `${age} ago`;
}
