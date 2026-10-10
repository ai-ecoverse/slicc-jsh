/**
 * `sliccy:http`, ported from slicc's
 * `packages/webapp/src/kernel/realm/http-global.ts`: `http.client({ baseUrl,
 * token, headers, retry, timeoutMs })` over the engine's `fetch`.
 */

export class HttpError extends Error {
  constructor(status, statusText, url, body) {
    const detail =
      typeof body === 'string' && body
        ? `: ${body.slice(0, 200)}`
        : body && typeof body === 'object'
          ? `: ${safeJson(body).slice(0, 200)}`
          : '';
    super(`HTTP ${status} ${statusText} ${url}${detail}`);
    this.name = 'HttpError';
    this.status = status;
    this.statusText = statusText;
    this.url = url;
    this.body = body;
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const DEFAULT_BACKOFF_BASE_MS = 500;

function buildUrl(baseUrl, path, params) {
  let url;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) url = path;
  else if (baseUrl) {
    const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  } else url = path;
  if (!params) return url;
  const qs = [];
  const push = (k, v) => qs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) if (item !== undefined && item !== null) push(k, item);
    } else push(k, v);
  }
  if (qs.length === 0) return url;
  return url + (url.includes('?') ? '&' : '?') + qs.join('&');
}

function isJsonContentType(ct) {
  if (!ct) return false;
  const lower = ct.toLowerCase();
  return lower.startsWith('application/json') || /[+/]json(;|$|\s)/.test(lower);
}

function parseRetryAfter(value) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

async function readBody(resp) {
  if (isJsonContentType(resp.headers.get('content-type'))) {
    const text = await resp.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return resp.text();
}

function serializeBody(body, headers) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    (typeof Blob !== 'undefined' && body instanceof Blob) ||
    (typeof FormData !== 'undefined' && body instanceof FormData) ||
    (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ||
    (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream)
  ) {
    return body;
  }
  if (typeof body === 'object') {
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
    return JSON.stringify(body);
  }
  return String(body);
}

export function createHttp({ fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  function makeClient(config = {}) {
    const retryOn = new Set(config.retry?.on ?? []);
    const maxAttempts = Math.max(1, Math.trunc(config.retry?.maxAttempts ?? 1));

    async function request(method, path, opts = {}) {
      if (typeof fetch !== 'function') throw new Error('sliccy:http: fetch is not available');
      const url = buildUrl(config.baseUrl, path, opts.params);
      const headers = { ...(config.headers ?? {}), ...(opts.headers ?? {}) };
      if (config.token) {
        const tok = await config.token({ method, path, url });
        if (tok && !Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) {
          headers.Authorization = `Bearer ${tok}`;
        }
      }
      const body = serializeBody(opts.body, headers);
      const init = { method, headers };
      if (body !== undefined) init.body = body;

      for (let attempt = 0; ; attempt++) {
        const timeoutCtl = config.timeoutMs ? new AbortController() : null;
        const timeoutId = timeoutCtl
          ? setTimeout(() => timeoutCtl.abort(new Error('timeout')), config.timeoutMs)
          : null;
        const signal =
          opts.signal && timeoutCtl
            ? AbortSignal.any([opts.signal, timeoutCtl.signal])
            : (opts.signal ?? timeoutCtl?.signal);
        let resp;
        try {
          resp = await fetch(url, signal ? { ...init, signal } : init);
        } finally {
          if (timeoutId !== null) clearTimeout(timeoutId);
        }
        if (resp.ok) {
          const respBody = await readBody(resp);
          if (opts.raw) {
            return {
              body: respBody,
              headers: Object.fromEntries(resp.headers.entries()),
              status: resp.status,
            };
          }
          return respBody;
        }
        if (attempt + 1 >= maxAttempts || !retryOn.has(resp.status)) {
          const errBody = await readBody(resp).catch(() => null);
          throw new HttpError(resp.status, resp.statusText, url, errBody);
        }
        const retryAfter = parseRetryAfter(resp.headers.get('retry-after'));
        await sleep(retryAfter ?? DEFAULT_BACKOFF_BASE_MS * 2 ** attempt);
      }
    }

    return Object.freeze({
      get: (path, opts) => request('GET', path, opts),
      post: (path, opts) => request('POST', path, opts),
      put: (path, opts) => request('PUT', path, opts),
      patch: (path, opts) => request('PATCH', path, opts),
      delete: (path, opts) => request('DELETE', path, opts),
    });
  }
  return Object.freeze({ client: makeClient, HttpError });
}
