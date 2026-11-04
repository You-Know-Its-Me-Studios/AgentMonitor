import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserAuthorizationRevision, localFetch } from '../src/client/http.js';
import { observerRequest } from '../src/client/ui-model.js';
import { defaultObserverSettings } from '../src/shared/observer.js';

afterEach(() => vi.unstubAllGlobals());
describe('transparent local browser reauthorization', () => {
  it('reacquires the HttpOnly cookie with GET / after 401, then retries the snapshot once', async () => {
    const initial = browserAuthorizationRevision();
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('{"error":"browser cookie expired"}', { status: 401 }))
      .mockResolvedValueOnce(new Response('<!doctype html><title>Agent Monitor</title>', { status: 200 }))
      .mockResolvedValueOnce(Response.json({ revision: 2, sessions: [] }));
    vi.stubGlobal('fetch', fetch);
    const response = await localFetch('/api/snapshot', { cache: 'no-store' });
    expect(await response.json()).toEqual({ revision: 2, sessions: [] });
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/snapshot', '/', '/api/snapshot']);
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    expect(browserAuthorizationRevision()).toBe(initial + 1);
    // No token is returned to, parsed by, or stored in JavaScript.
    expect(fetch.mock.calls[1][1]?.headers).toBeUndefined();
  });
  it('retries a rejected observer mutation with its original method, body and same-origin cookies', async () => {
    const snapshot = { settings: defaultObserverSettings, selectedSessionId: 'session-a', sessions: {}, capabilities: [] };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('page', { status: 200 }))
      .mockResolvedValueOnce(Response.json(snapshot));
    vi.stubGlobal('fetch', fetch);
    expect(await observerRequest('settings', { enabled: false })).toEqual(snapshot);
    expect(fetch.mock.calls[0][1]).toEqual(fetch.mock.calls[2][1]);
    expect(fetch.mock.calls[2][1]).toMatchObject({ method: 'PATCH', credentials: 'same-origin', body: '{"enabled":false}' });
  });
  it('coalesces concurrent 401 responses into one cookie bootstrap', async () => {
    let release: (() => void) | undefined;
    const bootstrap = new Promise<void>(resolve => { release = resolve; });
    const counts = new Map<string, number>();
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      const url = String(input); counts.set(url, (counts.get(url) ?? 0) + 1);
      if (url === '/') { await bootstrap; return new Response('page'); }
      return counts.get(url) === 1 ? new Response('{}', { status: 401 }) : Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetch);
    const a = localFetch('/api/snapshot'), b = localFetch('/api/observer/refresh', { method: 'POST', body: '{}' });
    await Promise.resolve(); await Promise.resolve(); release!();
    expect((await a).status).toBe(200); expect((await b).status).toBe(200);
    expect(counts.get('/')).toBe(1);
    expect(counts.get('/api/snapshot')).toBe(2); expect(counts.get('/api/observer/refresh')).toBe(2);
  });
  it('does not retry indefinitely or bootstrap on a different failure', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('page'))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    expect((await localFetch('/api/snapshot')).status).toBe(401); expect(fetch).toHaveBeenCalledTimes(3);
    fetch.mockClear(); fetch.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    expect((await localFetch('/api/snapshot')).status).toBe(503); expect(fetch).toHaveBeenCalledOnce();
  });
  it('reports a failed local authorization refresh without making the API request again', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    await expect(localFetch('/api/snapshot')).rejects.toThrow('Local browser authorization refresh failed (403)');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
