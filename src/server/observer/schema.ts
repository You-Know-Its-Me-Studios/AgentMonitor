import type { AssessmentContent } from '../../shared/observer.js';
import { ObserverWorkerError } from './process.js';
import { redact } from '../privacy.js';

const states = ['active','blocked','complete','idle','paused','unknown'] as const;
const confidence = ['low','medium','high'] as const;
const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const list = (maxItems: number, maxLength: number) => ({ type: 'array', maxItems, items: text(maxLength) });
export const assessmentSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    taskSummary: text(1600), taskState: { type: 'string', enum: states }, stage: text(200),
    remainingSteps: list(16,700), etaMinSeconds: { type: ['number','null'], minimum: 0, maximum: 31_536_000 },
    etaMaxSeconds: { type: ['number','null'], minimum: 0, maximum: 31_536_000 },
    confidence: { type: 'string', enum: confidence }, basis: text(2400), blockers: list(12,700), supportingEvidenceIds: list(24,512)
  },
  required: ['taskSummary','taskState','stage','remainingSteps','etaMinSeconds','etaMaxSeconds','confidence','basis','blockers','supportingEvidenceIds']
} as const;

export function validateAssessment(value: unknown, evidenceIds: Iterable<string>): AssessmentContent {
  const fail = (message: string): never => { throw new ObserverWorkerError('invalid-output',message); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Observer output must be a JSON object.');
  const data = value as Record<string,unknown>; const required = assessmentSchema.required as readonly string[];
  if (Object.keys(data).some(key => !required.includes(key)) || required.some(key => !Object.hasOwn(data,key))) return fail('Observer output does not match the required assessment fields.');
  const string = (key: string,max: number) => { const v = data[key]; if (typeof v !== 'string' || !v.trim() || v.length > max) return fail(`Observer ${key} is missing or exceeds its limit.`); return redact(v.trim()); };
  const strings = (key: string,maxItems: number,maxLength: number) => { const v = data[key]; if (!Array.isArray(v) || v.length > maxItems || v.some(x => typeof x !== 'string' || !x.trim() || x.length > maxLength)) return fail(`Observer ${key} is not a bounded text list.`); return (v as string[]).map(x => redact(x.trim())); };
  const seconds = (key: string) => { const v = data[key]; if (v === null) return null; if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 31_536_000) return fail(`Observer ${key} must be a finite nonnegative duration or null.`); return v; };
  if (!states.includes(data.taskState as typeof states[number]) || !confidence.includes(data.confidence as typeof confidence[number])) return fail('Observer task state or confidence is invalid.');
  const min = seconds('etaMinSeconds'), max = seconds('etaMaxSeconds');
  if ((min === null) !== (max === null) || (min !== null && max !== null && min > max)) return fail('Observer ETA must be a complete, ordered range.');
  if (data.taskState === 'active' && min === null) return fail('An active recovered task requires a finite estimated remaining-work range.');
  if (['complete','idle','paused'].includes(data.taskState as string) && min !== null) return fail('Completed, idle, or paused tasks cannot have an active ETA.');
  const known = new Set(evidenceIds); const ids = strings('supportingEvidenceIds',24,512);
  if (ids.some(id => !known.has(id)) || new Set(ids).size !== ids.length || (known.size > 0 && !ids.length)) return fail('Observer references missing, duplicate, or unknown evidence IDs.');
  return { taskSummary: string('taskSummary',1600), taskState: data.taskState as AssessmentContent['taskState'], stage: string('stage',200), remainingSteps: strings('remainingSteps',16,700), etaMinSeconds: min, etaMaxSeconds: max, confidence: data.confidence as AssessmentContent['confidence'], basis: string('basis',2400), blockers: strings('blockers',12,700), supportingEvidenceIds: ids };
}
