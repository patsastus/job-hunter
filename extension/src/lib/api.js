// Client for the local Job Hunter backend. All calls go through the background worker: a content script
// on an https page cannot call http://jobs.test (mixed content), and a popup closes mid-request.

export class BackendError extends Error {
  // kind: 'offline' (could not connect), 'timeout', or 'http' (the backend answered with an error)
  constructor(kind, message, status) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

function detailOf(body) {
  if (!body || body.detail === undefined) return null;
  return typeof body.detail === 'string' ? body.detail : 'The backend rejected the request.';
}

export function createBackend({ getBaseUrl, fetchFn = (...args) => fetch(...args), timeoutMs = 30000 }) {
  async function request(path, init = {}) {
    const base = (await getBaseUrl()).replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchFn(base + path, { ...init, signal: controller.signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new BackendError('timeout', 'The backend took too long to answer.');
      throw new BackendError('offline', `Cannot reach the backend at ${base}.`);
    } finally {
      clearTimeout(timer);
    }
    let body = null;
    try {
      body = await res.json();
    } catch (e) {
      // not JSON; fall through to the status text
    }
    if (!res.ok) throw new BackendError('http', detailOf(body) || res.statusText || `HTTP ${res.status}`, res.status);
    return body;
  }

  const json = (method, payload) => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  return {
    // Score an ad being viewed. The backend uses the text and drops it; it keeps a text-less `seen` record.
    scorePreview: (job, { force = false } = {}) =>
      request(`/api/score-preview${force ? '?force=true' : ''}`, json('POST', job)),

    // Record an ad as seen without scoring it (needed to reject an ad that has no score yet).
    recordSeen: (job) => request('/api/score-preview?score=false', json('POST', job)),

    // Save: the full capture, which is the only time the ad text is stored.
    save: (job) => request('/api/jobs', json('POST', { ...job, status: 'saved' })),

    // Reject, or undo (status "seen" drops the text a save stored).
    setStatus: (id, status) => request(`/api/jobs/${id}`, json('PATCH', { status })),
  };
}
