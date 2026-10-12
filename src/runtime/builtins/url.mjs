/** encodeFilePath: Node 22's pathToFileURL percent-encoding of a path (the url builtin itself is Node's lib/url.js, src/node-lib). */

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
