const names = ['fetch', 'Request', 'Response', 'Headers', 'FormData', 'Blob', 'File', 'WebSocket', 'EventSource', 'Buffer', 'setTimeout', 'setInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'structuredClone', 'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'AbortController', 'AbortSignal', 'EventTarget', 'Event', 'CustomEvent', 'MessageChannel', 'BroadcastChannel', 'crypto', 'performance', 'navigator', 'atob', 'btoa', 'ReadableStream', 'WritableStream', 'TransformStream', 'CompressionStream', 'DecompressionStream', 'WebAssembly', 'global', 'process', 'require', 'module', 'window', 'document', 'self', 'localStorage', 'Worker', 'XMLHttpRequest', 'importScripts', 'SLICC_VERSION', 'Deno', 'Bun'];
const present = [];
const absent = [];
for (const n of names) (typeof globalThis[n] !== 'undefined' ? present : absent).push(n);
console.log('present:', present.join(' '));
console.log('absent:', absent.join(' '));
console.log('global === globalThis', typeof global !== 'undefined' && global === globalThis);
console.log('versions.jsh', typeof process.versions.jsh);
console.log('SLICC_VERSION', typeof SLICC_VERSION);
