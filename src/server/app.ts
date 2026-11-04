import Fastify from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Snapshot } from '../shared/types.js';
interface SnapshotSource { current: Snapshot; on(event: 'snapshot', listener: (snapshot: Snapshot) => void): unknown; off(event: 'snapshot', listener: (snapshot: Snapshot) => void): unknown }

export const APP_ID = 'ykims-agent-monitor';
export async function createApp(options: { collector: SnapshotSource; port: number; clientDir: string; workspace: string }) {
  const app = Fastify({ logger: false, bodyLimit: 1024, requestTimeout: 10000 });
  const token = randomBytes(32).toString('hex');
  const hosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`, `[::1]:${options.port}`]);
  const cookieName = `agent_monitor_${options.port}`;
  const origins = new Set([...hosts].map(h => `http://${h}`));
  const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Content-Security-Policy', csp).header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('Cross-Origin-Resource-Policy', 'same-origin').header('Cache-Control', 'no-store');
    if (!hosts.has(request.headers.host || '')) return reply.code(403).send({ error: 'Local host required' });
    if (request.headers.origin && !origins.has(request.headers.origin)) return reply.code(403).send({ error: 'Same-origin request required' });
    if (request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: 'Cross-site request rejected' });
    if (request.method !== 'GET' && request.method !== 'HEAD') return reply.code(405).send({ error: 'Read-only dashboard' });
    if (request.url.startsWith('/api/') && request.url !== '/api/health') {
      const cookie = request.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      if (!cookie || !/^[a-f0-9]{64}$/.test(cookie) || !timingSafeEqual(Buffer.from(cookie, 'ascii'), Buffer.from(token, 'ascii'))) return reply.code(401).send({ error: 'Open the dashboard page to authorize this browser' });
    }
  });
  app.get('/api/health', async () => ({ app: APP_ID, workspace: options.workspace, ready: true, collecting: options.collector.current.collecting }));
  app.get('/api/snapshot', async () => options.collector.current);
  app.get('/api/events', async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
    let closed = false;
    const send = (snapshot: Snapshot) => {
      if (closed) return;
      // A slow browser reconnects to a current snapshot instead of buffering unlimited history.
      if (reply.raw.writableLength > 4 * 1024 * 1024) { reply.raw.end(); return; }
      reply.raw.write(`id: ${snapshot.revision}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    };
    send(options.collector.current);
    options.collector.on('snapshot', send);
    const heartbeat = setInterval(() => { if (!closed) reply.raw.write(`event: heartbeat\ndata: ${Date.now()}\n\n`); }, 15000);
    reply.raw.on('close', () => { closed = true; clearInterval(heartbeat); options.collector.off('snapshot', send); });
  });
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.png': 'image/png' };
  const assets = new Map<string, Buffer>();
  // Only pre-enumerated build assets are servable. No request can select an arbitrary path.
  async function load(dir: string, prefix = ''): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const route = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await load(path.join(dir, entry.name), route);
      else if (mime[path.extname(entry.name)]) assets.set(route, await fs.readFile(path.join(dir, entry.name)));
    }
  }
  await load(options.clientDir);
  app.get('/*', async (request, reply) => {
    const url = request.url.split('?')[0];
    const route = url === '/' ? '/index.html' : url;
    if (!assets.has(route)) return reply.code(404).send({ error: 'Not found' });
    if (route === '/index.html') reply.header('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`);
    return reply.type(mime[path.extname(route)] || 'application/octet-stream').send(assets.get(route));
  });
  return app;
}
