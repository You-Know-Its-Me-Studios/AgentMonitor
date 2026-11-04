export type Provider = 'codex' | 'claude';
export type Quality = 'reported' | 'derived' | 'estimated' | 'stale' | 'unavailable';
export interface Provenance { source: string; observedAt: string; scope: string; quality: Quality; reason?: string; originalTimestamp?: string | number; ingestedAt?: string }
export interface Metric<T> { value: T | null; provenance: Provenance }
export interface Usage {
  input: number | null; output: number | null; cachedInput: number | null;
  cacheCreation: number | null; reasoning: number | null; total: number | null;
}
export interface UsageSlice { model: string | null; usage: Usage; serviceTier: string | null; cacheCreation5m?: number | null; cacheCreation1h?: number | null }
export interface ToolSummary { name: string; category: string; calls: number; succeeded: number; failed: number; unknown: number; durationMs: number | null; retries: number | null; inFlight?: number; interrupted?: number }
export interface Activity { id: string; at: string; occurredAt?: string; ingestedAt?: string; originalTimestamp?: string | number; kind: 'turn' | 'tool' | 'edit' | 'status' | 'compaction' | 'usage'; label: string; detail?: string; outcome?: 'success' | 'failure' | 'unknown' }
export interface TrendPoint { at: string; input: number; output: number; tools: number }
export interface Allowance { id: string; label: string; accountKey: string; usedPercent: Metric<number>; windowMinutes: number | null; resetsAt: string | null }
export interface Timing { elapsedMs: Metric<number>; completedTurns: number; lastTurnMs: Metric<number>; averageTurnMs: Metric<number>; eta: Metric<{ lowMs: number; highMs: number; confidence: string; basis: string }>; checklist: { completed: number; total: number } | null }
export interface Diagnostic { provider?: Provider; namespace?: string; level: 'info' | 'warning' | 'error'; code: string; message: string; at: string }
export interface Session {
  id: string; provider: Provider; namespace: string; nativeId: string;
  name: string; nameSource: string; model: Metric<string>; effort: Metric<string>;
  cwd: string | null; project: string | null; branch: string | null;
  startedAt: string | null; lastActivityAt: string | null;
  parentId: string | null; forkedFromId: string | null; archived: boolean;
  runtime: { reachable: boolean; loaded: boolean; serverReachable?: boolean; openTurn?: boolean; attachment: 'known' | 'unknown'; pid: number | null; processStartedAt: string | null; observedAt: string | null };
  state: Metric<'running' | 'idle' | 'approval' | 'input' | 'complete' | 'historical' | 'unknown'>;
  latestActivity: string; usage: Metric<Usage>; turnUsage: Metric<Usage>;
  context: { used: Metric<number>; capacity: Metric<number> };
  allowanceIds: string[]; tools: ToolSummary[]; activities: Activity[]; trends: TrendPoint[];
  timing: Timing; edits: Metric<{ files: number; additions: number | null; deletions: number | null }>;
  cost: Metric<{ usd: number; label: string }>;
  costCoverage?: { pricedTokens: number; observedTokens: number | null; registryDate: string; reason: string };
  usageBreakdown?: UsageSlice[];
  task?: TaskEvidence;
  collection?: { lastCheckedAt: string; ingestedAt: string | null; evidenceAt: string | null; condition: 'current' | 'stale' | 'backfilling' | 'unavailable'; reason: string };
  workspaceBranch?: Metric<string>;
  aggregates?: { main: Usage | null; children: Usage | null; inclusive: Usage | null; childCount: number; partial: boolean; observedChildren?: Usage | null; observedInclusive?: Usage | null; knownChildren?: number };
  agentRole?: 'implementation' | 'approval-reviewer' | 'unknown';
  diagnostics: Diagnostic[];
}
export interface CollectorStatus {
  state: 'initializing' | 'ready' | 'degraded' | 'failed' | 'stopped';
  lastStartedAt: string | null; lastCompletedAt: string | null; lastError: string | null;
  cached: boolean;
}
export interface Snapshot { revision: number; observedAt: string; sessions: Session[]; allowances: Allowance[]; diagnostics: Diagnostic[]; collecting: boolean; observer?: ObserverSnapshot; build?: { id: string; builtAt: string }; instanceId?: string; collector?: CollectorStatus }
export function metric<T>(value: T | null, source: string, scope: string, quality: Quality = value === null ? 'unavailable' : 'reported', reason?: string, observedAt = new Date().toISOString()): Metric<T> {
  return { value, provenance: { source, scope, quality, reason, observedAt } };
}
export function emptyUsage(): Usage { return { input: null, output: null, cachedInput: null, cacheCreation: null, reasoning: null, total: null }; }
export function sessionKey(provider: Provider, namespace: string, nativeId: string): string { return `${provider}:${namespace}:${nativeId}`; }
export function emptySession(provider: Provider, namespace: string, nativeId: string, source: string, now = new Date().toISOString()): Session {
  const unavailable = <T>(reason: string) => metric<T>(null, source, 'session', 'unavailable', reason, now);
  return {
    id: sessionKey(provider, namespace, nativeId), provider, namespace, nativeId,
    name: nativeId.slice(0, 12), nameSource: 'native ID', model: unavailable('Model not reported'), effort: unavailable('Effort not reported'), cwd: null, project: null, branch: null,
    startedAt: null, lastActivityAt: null, parentId: null, forkedFromId: null, archived: false,
    runtime: { reachable: false, loaded: false, attachment: 'unknown', pid: null, processStartedAt: null, observedAt: null },
    state: metric('historical', source, 'runtime', 'derived', 'Transcript only; runtime is not confirmed', now), latestActivity: 'Persisted session',
    usage: unavailable('Usage not reported'), turnUsage: unavailable('Current-turn usage not reported'),
    context: { used: unavailable('Context occupancy not reported'), capacity: unavailable('Context capacity not reported') },
    allowanceIds: [], tools: [], activities: [], trends: [],
    timing: { elapsedMs: unavailable('Start time not reported'), completedTurns: 0, lastTurnMs: unavailable('Turn duration not reported'), averageTurnMs: unavailable('Turn duration not reported'), eta: unavailable('Not enough data yet'), checklist: null },
    edits: unavailable('No attributable edit evidence'), cost: unavailable('Known pricing and complete usage categories are required'), diagnostics: []
  };
}
import type { TaskEvidence, ObserverSnapshot } from './observer.js';
