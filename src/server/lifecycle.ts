import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export interface BuildIdentity { id: string; builtAt: string }
export interface AppLifecycle {
  buildId: string; instanceId: string; pid: number; startedAt: string; launcherKey: string;
  requestStop(): void;
}
export async function readBuildIdentity(workspace: string): Promise<BuildIdentity> {
  const manifest = JSON.parse(await fs.readFile(path.join(workspace, 'dist/build.json'), 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(manifest.id) || typeof manifest.builtAt !== 'string' || !Number.isFinite(Date.parse(manifest.builtAt))) throw new Error('Production build identity is missing or invalid. Run npm run build.');
  return { id: manifest.id, builtAt: manifest.builtAt };
}
export function createLifecycle(build: BuildIdentity, requestStop: () => void): AppLifecycle {
  return { buildId: build.id, instanceId: randomUUID(), pid: process.pid, startedAt: new Date().toISOString(), launcherKey: randomBytes(32).toString('hex'), requestStop };
}
export function launcherAuthorized(value: unknown, lifecycle: AppLifecycle): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value, 'ascii'), Buffer.from(lifecycle.launcherKey, 'ascii'));
}
export async function writeProcessRecord(workspace: string, port: number, lifecycle: AppLifecycle): Promise<void> {
  const directory = path.join(workspace, '.agent-monitor'); await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'server-process.json');
  const temporary = `${file}.${lifecycle.instanceId}.tmp`;
  const record = { app: 'ykims-agent-monitor', workspace, port, pid: lifecycle.pid, startedAt: lifecycle.startedAt, instanceId: lifecycle.instanceId, buildId: lifecycle.buildId, launcherKey: lifecycle.launcherKey };
  await fs.writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  try { await fs.rename(temporary, file); } catch (e) { await fs.rm(temporary, { force: true }); throw e; }
}
