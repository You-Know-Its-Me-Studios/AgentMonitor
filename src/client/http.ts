let authorizationRevision = 0;
let authorizationRefresh: Promise<void> | null = null;
const REQUEST_TIMEOUT_MS = 12000;

async function bounded<T>(run: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal | null): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    cancel = () => { controller.abort(); reject(new Error('Local dashboard request cancelled.')); };
    timer = setTimeout(() => { controller.abort(); reject(new Error('Local dashboard request timed out after 12 seconds. Reconnecting automatically.')); }, REQUEST_TIMEOUT_MS);
    parent?.addEventListener('abort', cancel, { once: true });
    if (parent?.aborted) cancel();
  });
  try { return await Promise.race([run(controller.signal), interrupted]); }
  finally { clearTimeout(timer); parent?.removeEventListener('abort', cancel); }
}

// Consume the body within the deadline too. Resolving fetch's headers alone does
// not bound response.json(), which otherwise can hold the refresh guard forever.
async function readResponse(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, { ...init, signal, credentials: 'same-origin' });
  const body = await response.arrayBuffer();
  return new Response([204, 205, 304].includes(response.status) || init.method === 'HEAD' ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function browserAuthorizationRevision(): number { return authorizationRevision; }

/** Reissue the local HttpOnly cookie through the same page bootstrap as navigation. */
async function refreshBrowserAuthorization(): Promise<void> {
  if (authorizationRefresh) return authorizationRefresh;
  authorizationRefresh = bounded(async signal => {
    const page = await readResponse('/', { method: 'GET', cache: 'no-store' }, signal);
    if (!page.ok) throw new Error(`Local browser authorization refresh failed (${page.status}).`);
    authorizationRevision++;
  });
  try { await authorizationRefresh; } finally { authorizationRefresh = null; }
}

/** A 401 is rejected before the API handler, so one transparent retry is safe. */
export async function localFetch(url: string, options: RequestInit = {}): Promise<Response> {
  return bounded(async signal => {
    const startedWith = authorizationRevision;
    let response = await readResponse(url, options, signal);
    if (response.status !== 401 || !url.startsWith('/api/')) return response;
    // Concurrent rejected requests share one bounded bootstrap instead of racing cookies.
    if (startedWith === authorizationRevision) await refreshBrowserAuthorization();
    response = await readResponse(url, options, signal);
    return response;
  }, options.signal);
}
