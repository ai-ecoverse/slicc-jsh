const names = ['Worker', 'SharedWorker', 'BroadcastChannel', 'importScripts', 'postMessage', 'indexedDB', 'caches', 'XMLHttpRequest', 'EventSource', 'fetch', 'WebSocket', 'navigator', 'process', 'require'];
const mine = names.filter((n) => { try { return globalThis[n] !== undefined && globalThis[n] !== null; } catch { return false; } }).join(',');
console.log('script caps', mine); console.log('preload caps same', globalThis.__preCaps === mine);
