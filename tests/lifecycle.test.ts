import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/server/app.js';
import { createLifecycle, readBuildIdentity, writeProcessRecord } from '../src/server/lifecycle.js';
import type { Snapshot } from '../src/shared/types.js';
const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of clean.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-monitor-lifecycle-')); clean.push(() => fs.rm(workspace, { recursive: true, force: true }));
  const clientDir = path.join(workspace, 'dist/client'); await fs.mkdir(clientDir, { recursive: true }); await fs.writeFile(path.join(clientDir, 'index.html'), '<title>Agent Monitor</title>');
  const build = { id: 'a'.repeat(64), builtAt: '2026-11-04T01:02:00Z' }; await fs.writeFile(path.join(workspace, 'dist/build.json'), JSON.stringify(build));
  const stop = vi.fn(); const lifecycle = createLifecycle(build, stop);
  const source = new EventEmitter() as EventEmitter & { current: Snapshot }; source.current = { revision: 1, observedAt: build.builtAt, sessions: [], allowances: [], diagnostics: [], collecting: false, build };
  const app = await createApp({ collector: source, port: 4317, workspace, clientDir, lifecycle }); await app.ready(); clean.push(() => app.close());
  return { workspace, app, build, stop, lifecycle };
}
describe('dashboard build identity and private replacement', () => {
  it('reads a content identity and writes only the private owned-instance record', async () => {
    const { workspace, lifecycle, build } = await fixture(); expect(await readBuildIdentity(workspace)).toEqual(build); await writeProcessRecord(workspace, 4317, lifecycle);
    const record = JSON.parse(await fs.readFile(path.join(workspace, '.agent-monitor/server-process.json'), 'utf8'));
    expect(record).toMatchObject({ app: 'ykims-agent-monitor', workspace, buildId: build.id, instanceId: lifecycle.instanceId, pid: process.pid, port: 4317 }); expect(record.launcherKey).toMatch(/^[a-f0-9]{64}$/);
  });
  it('advertises the running build without exposing the private launcher key', async () => {
    const { app, build, lifecycle } = await fixture(); const response = await app.inject({ url: '/api/health', headers: { host: '127.0.0.1:4317' } });
    expect(response.json()).toMatchObject({ buildId: build.id, instanceId: lifecycle.instanceId }); expect(response.body).not.toContain(lifecycle.launcherKey); expect(response.json().launcherKey).toBeUndefined();
  });
  it('cannot stop from browser cookies alone, wrong secrets, or cross-origin requests', async () => {
    const { app, stop, lifecycle } = await fixture(); const page = await app.inject({ url: '/', headers: { host: '127.0.0.1:4317' } }); const cookie = String(page.headers['set-cookie']).split(';')[0];
    for (const key of [undefined, 'wrong', 'b'.repeat(64), 'é'.repeat(64)]) {
      const response = await app.inject({ method: 'POST', url: '/api/internal/stop', headers: { host: '127.0.0.1:4317', cookie, ...(key ? { 'x-agent-monitor-launcher-key': key } : {}) }, payload: { instanceId: lifecycle.instanceId } }); expect(response.statusCode).toBe(401);
    }
    const cross = await app.inject({ method: 'POST', url: '/api/internal/stop', headers: { host: '127.0.0.1:4317', origin: 'https://attacker.example', 'x-agent-monitor-launcher-key': lifecycle.launcherKey }, payload: { instanceId: lifecycle.instanceId } }); expect(cross.statusCode).toBe(403); expect(stop).not.toHaveBeenCalled();
  });
  it('rejects another instance identity and stops only this dashboard after an authorized response', async () => {
    const { app, stop, lifecycle } = await fixture(); const headers = { host: '127.0.0.1:4317', 'x-agent-monitor-launcher-key': lifecycle.launcherKey };
    const stale = await app.inject({ method: 'POST', url: '/api/internal/stop', headers, payload: { instanceId: 'different-old-process' } }); expect(stale.statusCode).toBe(409); expect(stop).not.toHaveBeenCalled();
    const accepted = await app.inject({ method: 'POST', url: '/api/internal/stop', headers, payload: { instanceId: lifecycle.instanceId } }); expect(accepted.statusCode).toBe(202); expect(stop).not.toHaveBeenCalled(); await new Promise(resolve => setTimeout(resolve, 80)); expect(stop).toHaveBeenCalledOnce();
  });
  it('rejects a missing or invalid build manifest rather than claiming the current build', async () => {
    const { workspace } = await fixture(); await fs.writeFile(path.join(workspace, 'dist/build.json'), '{"id":"old","builtAt":"invalid"}'); await expect(readBuildIdentity(workspace)).rejects.toThrow('invalid');
  });
});
