import { redact } from './privacy.js';

/** Keep the original exception/stack at owned background boundaries, never command input. */
export function errorMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return redact(`${code ? `${code}: ` : ''}${error instanceof Error ? error.message : String(error)}`).slice(0, 1000);
}
export function logError(boundary: string, error: unknown): string {
  const message = errorMessage(error);
  const stack = error instanceof Error ? redact(error.stack || message).slice(0, 6000) : message;
  console.error(`${new Date().toISOString()} [${boundary}] ${stack}`);
  return message;
}
