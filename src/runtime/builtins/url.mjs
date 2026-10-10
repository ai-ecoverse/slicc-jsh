/** Minimal url builtin. */

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

export function createUrl() {
  return {
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    fileURLToPath,
    pathToFileURL,
  };
}
