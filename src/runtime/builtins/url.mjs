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

// What Node 22's pathToFileURL leaves as it is in a path: everything else
// (space, %, #, ?, [], {}, |, ^, ~, `, quotes, controls, non-ASCII) is
// percent-encoded as UTF-8.
const FILE_URL_SAFE = /[A-Za-z0-9\-._/!$&'()*+,;=:@]/;

export function encodeFilePath(path) {
  let out = '';
  for (const ch of path) {
    if (FILE_URL_SAFE.test(ch)) out += ch;
    else for (const b of new TextEncoder().encode(ch)) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function pathToFileURL(path) {
  return new URL(`file://${encodeFilePath(path)}`);
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
