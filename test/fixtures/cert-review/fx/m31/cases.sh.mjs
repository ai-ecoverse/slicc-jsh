export default [
  { name: 'handler-throws-exit7', cmd: 'node exit7.js 2>/dev/null; echo rc=$?' },
  { name: 'abort', cmd: 'node -e "process.abort()" 2>/dev/null; echo rc=$?' },
];
