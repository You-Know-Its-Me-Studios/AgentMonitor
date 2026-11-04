export function redact(value: string): string {
  return value.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b/g, '[redacted]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;"']{6,}/gi, '$1[redacted]');
}
export function sanitize<T>(value: T): T {
  if (typeof value === 'string') return redact(value).slice(0, 4000) as T;
  if (Array.isArray(value)) return value.map(sanitize) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, sanitize(v)])) as T;
  return value;
}
