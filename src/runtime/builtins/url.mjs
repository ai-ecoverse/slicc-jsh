/** Minimal url builtin including legacy url.parse. */

function fileURLToPath(url) {
  const str = typeof url === 'string' ? url : url.href;
  if (!str.startsWith('file:')) throw new TypeError('The URL must be of scheme file');
  const parsed = new URL(str);
  if (parsed.hostname !== '' && parsed.hostname !== 'localhost') {
    const err = new TypeError('File URL host must be "localhost" or empty');
    err.code = 'ERR_INVALID_FILE_URL_HOST';
    throw err;
  }
  return decodeURIComponent(parsed.pathname);
}

function pathToFileURL(path) {
  const encoded = path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return new URL(`file://${encoded}`);
}

function parse(urlStr, parseQueryString = false, slashesDenoteHost = false) {
  void slashesDenoteHost;
  try {
    const u = new URL(urlStr);
    const out = {
      protocol: u.protocol,
      slashes: true,
      auth: u.username ? (u.password ? `${u.username}:${u.password}` : u.username) : null,
      host: u.host,
      port: u.port,
      hostname: u.hostname,
      hash: u.hash || null,
      search: u.search || null,
      query: parseQueryString ? Object.fromEntries(u.searchParams) : u.search ? u.search.slice(1) : null,
      pathname: u.pathname,
      path: u.pathname + u.search,
      href: u.href,
    };
    return out;
  } catch {
    return {
      protocol: null,
      slashes: null,
      auth: null,
      host: null,
      port: null,
      hostname: null,
      hash: null,
      search: null,
      query: null,
      pathname: null,
      path: null,
      href: urlStr,
    };
  }
}

export function createUrl() {
  return {
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    fileURLToPath,
    pathToFileURL,
    parse,
  };
}
