import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/app.js';
import { emptySession, type Snapshot } from '../src/shared/types.js';
import { sanitize } from '../src/server/privacy.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-monitor-api-')); roots.push(dir);
  await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html><title>Agent Monitor</title>');
  const emitter = new EventEmitter() as EventEmitter & { current: Snapshot };
  const session = emptySession('codex', 'fixture', 'existing-thread', 'fixture'); session.name = '<img src=x onerror=alert(1)>';
  emitter.current = { revision: 9, observedAt: '2026-11-03T12:00:00Z', sessions: [session], allowances: [], diagnostics: [], collecting: false };
  const app = await createApp({ collector: emitter, port: 4317, clientDir: dir, workspace: dir });
  await app.ready();
  const page = await app.inject({ url: '/', headers: { host: '127.0.0.1:4317' } });
  const cookie = String(page.headers['set-cookie']).split(';')[0];
  return { app, cookie, emitter };
}
describe('loopback API boundary', () => {
  it('issues a transparent HttpOnly same-site browser authorization, preserves untrusted titles as JSON', async () => {
    const { app, cookie } = await fixture();
    try {
      const reply = await app.inject({ url: '/api/snapshot', headers: { host: '127.0.0.1:4317', cookie } });
      expect(reply.statusCode).toBe(200); expect(reply.json().sessions[0].name).toBe('<img src=x onerror=alert(1)>');
      expect(reply.headers['content-type']).toContain('application/json'); expect(reply.headers['content-security-policy']).toContain("script-src 'self'");
    } finally { await app.close(); }
  });
  it('rejects unauthenticated data reads and DNS rebinding hosts', async () => {
    const { app, cookie } = await fixture();
    try {
      expect((await app.inject({ url: '/api/snapshot', headers: { host: '127.0.0.1:4317' } })).statusCode).toBe(401);
      expect((await app.inject({ url: '/api/snapshot', headers: { host: '127.0.0.1:4317', cookie: `agent_monitor_4317=${'é'.repeat(64)}` } })).statusCode).toBe(401);
      expect((await app.inject({ url: '/', headers: { host: 'attacker.example:4317', cookie } })).statusCode).toBe(403);
      expect((await app.inject({ url: '/api/snapshot', headers: { host: 'attacker.example:4317', cookie } })).statusCode).toBe(403);
    } finally { await app.close(); }
  });
  it('rejects cross-origin, cross-site, provider-control, arbitrary file reads and all mutations', async () => {
    const { app, cookie } = await fixture();
    try {
      for (const url of ['/', '/api/snapshot', '/api/events', '/api/health']) {
        expect((await app.inject({ url, headers: { host: '127.0.0.1:4317', cookie, origin: 'https://attacker.example' } })).statusCode).toBe(403);
        expect((await app.inject({ url, headers: { host: '127.0.0.1:4317', cookie, 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
      }
      expect((await app.inject({ method: 'POST', url: '/api/session/resume', headers: { host: '127.0.0.1:4317', cookie } })).statusCode).toBe(405);
      for (const url of ['/api/read?path=C:/Users/Josh/.codex/auth.json', '/src/server/main.ts', '/%2e%2e/package.json']) expect((await app.inject({ url, headers: { host: '127.0.0.1:4317', cookie } })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
  it('accepts only this origin and exposes no permissive CORS', async () => {
    const { app, cookie } = await fixture();
    try {
      const reply = await app.inject({ url: '/api/snapshot', headers: { host: '127.0.0.1:4317', cookie, origin: 'http://127.0.0.1:4317' } });
      expect(reply.statusCode).toBe(200); expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    } finally { await app.close(); }
  });
});
it('redacts recognizable secrets recursively from displayed excerpts', () => {
  expect(sanitize({ title: 'key sk-abcdefghijklmnopqrstuvwxyz12345', detail: 'Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnopqrstuvwxyz' })).toEqual({ title: 'key [redacted]', detail: 'Bearer [redacted]' });
});
