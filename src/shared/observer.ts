import type { Provider, Usage } from './types.js';

export interface EvidenceItem {
  id: string; kind: 'request' | 'correction' | 'plan' | 'progress' | 'tool' | 'result' | 'subagent' | 'summary' | 'blocker';
  occurredAt: string; ingestedAt: string; source: string; text: string;
  originalTimestamp?: string | number;
  turnId?: string; status?: string;
}
export interface TaskEvidence {
  id: string; revision: number; objective: string; startedAt: string; lastActivityAt: string;
  turnId: string | null; state: 'active' | 'complete' | 'paused' | 'unknown';
  items: EvidenceItem[]; coverage: string; instructionsRecovered: boolean;
}
export interface ObserverSettings {
  enabled: boolean; intervalSeconds: number; provider: Provider; model: string; effort: string;
  timeoutSeconds: number; timezone: string | null;
}
export interface AssessmentContent {
  taskSummary: string; taskState: 'active' | 'blocked' | 'complete' | 'idle' | 'paused' | 'unknown';
  stage: string; remainingSteps: string[]; etaMinSeconds: number | null; etaMaxSeconds: number | null;
  confidence: 'low' | 'medium' | 'high'; basis: string; blockers: string[]; supportingEvidenceIds: string[];
}
export interface ObserverAssessment extends AssessmentContent {
  id: string; sessionId: string; taskId: string; taskRevision: number; requestRevision: number;
  assessedAt: string; evidenceThrough: string; provider: Provider; model: string;
  durationMs: number; usage: Usage | null;
}
export interface ObserverFailure { code: 'authentication' | 'timeout' | 'invalid-output' | 'provider-error' | 'unavailable' | 'evidence-unavailable' | 'superseded'; message: string; at: string }
export interface ObserverSessionState {
  sessionId: string; taskId: string | null; inProgress: boolean; requestedAt: string | null;
  nextRefreshAt: string | null; assessment: ObserverAssessment | null; failure: ObserverFailure | null;
  usage: Usage | null; runs: number;
}
export interface ObserverCapabilities { provider: Provider; available: boolean; version: string | null; models: string[]; efforts: string[]; reason?: string }
export interface ObserverSnapshot {
  settings: ObserverSettings; selectedSessionId: string | null; sessions: Record<string, ObserverSessionState>;
  capabilities: ObserverCapabilities[];
}
export interface ObserverInput {
  sessionId: string; nativeId: string; provider: Provider; sessionName: string;
  task: TaskEvidence; evidence: EvidenceItem[]; previousAssessment: ObserverAssessment | null;
  collectedAt: string; runtime: string; collectionCondition: string;
  childSummary: string; measurements: string;
}
export interface WorkerResult { content: AssessmentContent; usage: Usage | null; model: string; durationMs: number }
export interface ObserverWorker {
  capabilities(): Promise<ObserverCapabilities[]>;
  run(input: ObserverInput, settings: ObserverSettings, signal?: AbortSignal): Promise<WorkerResult>;
  close(): Promise<void>;
}
export const defaultObserverSettings: ObserverSettings = { enabled: true, intervalSeconds: 60, provider: 'codex', model: '', effort: 'medium', timeoutSeconds: 90, timezone: null };
