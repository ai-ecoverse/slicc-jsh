const names = ['Worker', 'SharedWorker', 'BroadcastChannel', 'importScripts', 'postMessage', 'indexedDB', 'caches', 'XMLHttpRequest', 'EventSource', 'fetch', 'WebSocket', 'navigator', 'process', 'require'];
globalThis.__preCaps = names.filter((n) => { try { return globalThis[n] !== undefined && globalThis[n] !== null; } catch { return false; } }).join(',');
console.log('preload', 'parent', module.parent && module.parent.id, 'main?', require.main === module, 'id', module.id === require.resolve('./pre.js') || module.id);
