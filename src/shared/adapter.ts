import type { Allowance, Diagnostic, Provider, Session } from './types.js';
export interface FileInfo { path: string; size: number; mtimeMs: number; birthtimeMs: number; identity: string; isDirectory: boolean }
export interface SourceIO {
  join(...parts: string[]): string;
  list(path: string): Promise<FileInfo[]>;
  stat(path: string): Promise<FileInfo | null>;
  read(path: string, offset: number, length: number): Promise<Buffer>;
  text(path: string, maxBytes?: number): Promise<string | null>;
}
export interface RecordMeta { offset: number; generation: number; source: string }
export interface IngestResult<T> { state: T; complete: boolean; bytesRead: number; generation: number; errors: number }
export interface CommandResult { stdout: string; stderr: string; code: number | null }
export interface ProcessIdentity { pid: number; startedAt: string; executable: string }
export interface AdapterContext {
  root: string; namespace: string; io: SourceIO; now: string;
  ingest<T>(path: string, initial: () => T, reduce: (state: T, record: any, meta: RecordMeta) => void): Promise<IngestResult<T>>;
  command(executable: string, args: string[], timeoutMs?: number): Promise<CommandResult>;
  processIdentity(pid: number): Promise<ProcessIdentity | null>;
}
export interface AdapterResult { sessions: Session[]; allowances: Allowance[]; diagnostics: Diagnostic[] }
export interface ProviderAdapter { provider: Provider; poll(context: AdapterContext): Promise<AdapterResult>; close?(): Promise<void> }
export interface SourceRoot { provider: Provider; root: string; namespace: string; distro?: string; user?: string; overrideHome?: boolean }
