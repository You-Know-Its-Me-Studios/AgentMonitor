let authorizationRevision = 0;
let authorizationRefresh: Promise<void> | null = null;

export function browserAuthorizationRevision(): number { return authorizationRevision; }

/** Reissue the local HttpOnly cookie through the same page bootstrap as navigation. */
async function refreshBrowserAuthorization(): Promise<void> {
  if (authorizationRefresh) return authorizationRefresh;
  authorizationRefresh = (async () => {
    const page = await fetch('/', { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    if (!page.ok) throw new Error(`Local browser authorization refresh failed (${page.status}).`);
    authorizationRevision++;
  })();
  try { await authorizationRefresh; } finally { authorizationRefresh = null; }
}

/** A 401 is rejected before the API handler, so one transparent retry is safe. */
export async function localFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const startedWith = authorizationRevision;
  const init = { ...options, credentials: 'same-origin' as const };
  let response = await fetch(url, init);
  if (response.status !== 401 || !url.startsWith('/api/')) return response;
  // Concurrent rejected requests share one bootstrap instead of racing cookie refreshes.
  if (startedWith === authorizationRevision) await refreshBrowserAuthorization();
  response = await fetch(url, init);
  return response;
}
