for (const n of ['fs', 'natives', 'constants', 'util', 'buffer', 'os', 'tcp_wrap', 'spawn_sync', 'process_wrap', 'pipe_wrap', 'tty_wrap', 'crypto', 'http_parser', 'contextify', 'uv', 'cares_wrap', 'stream_wrap', 'signal_wrap', 'timers', 'zlib', 'v8']) {
  try { const b = process.binding(n); const ks = Object.keys(b); console.log(`binding(${n})`, ks.length, ks.slice(0, 40).join(',')); } catch (e) { console.log(`binding(${n}) throws`, e.code ?? e.name, e.message.slice(0, 60)); }
}
const walk = (o, depth, seen = new Set()) => { if (!o || typeof o !== 'object' && typeof o !== 'function' || seen.has(o) || depth > 3) return []; seen.add(o); const out = []; for (const k of Object.getOwnPropertyNames(o)) { let v; try { v = o[k]; } catch { continue; } if (v && (v === globalThis.postMessage || (typeof Worker !== 'undefined' && v === Worker) || (typeof BroadcastChannel !== 'undefined' && v === BroadcastChannel) || /FileSystem|Worker|SharedArrayBuffer|MessagePort|importScripts|navigator/.test(String(v && v.constructor && v.constructor.name)))) out.push(k); out.push(...walk(v, depth + 1, seen).map((x) => `${k}.${x}`)); } return out; };
const hits = [];
for (const n of ['fs', 'util', 'os', 'tcp_wrap', 'spawn_sync', 'process_wrap', 'contextify', 'natives']) { try { hits.push(...walk(process.binding(n), 0).map((x) => `${n}.${x}`)); } catch {} }
console.log('capability-looking values reachable from bindings:', hits.slice(0, 20).join(' ') || 'none');
const natives = (() => { try { return process.binding('natives'); } catch { return {}; } })();
console.log('natives sample has', ['fs', 'internal/bootstrap/realm', 'slicc', 'jsh'].map((k) => `${k}:${typeof natives[k]}`).join(' '));
