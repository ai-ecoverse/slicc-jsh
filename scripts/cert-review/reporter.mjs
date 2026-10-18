export default async function* jsonl(source) {
  const stacks = new Map();
  for await (const event of source) {
    const d = event.data;
    if (event.type === 'test:start') {
      const stack = stacks.get(d.file) ?? [];
      stack.length = d.nesting;
      stack[d.nesting] = d.name;
      stacks.set(d.file, stack);
      continue;
    }
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const skipped = d.skip !== undefined && d.skip !== false;
    if (d.details?.type === 'suite' && !(skipped && event.type === 'test:pass')) continue;
    const parents = (stacks.get(d.file) ?? []).slice(0, d.nesting);
    const error = d.details?.error;
    yield `${JSON.stringify({
      file: d.file ?? null,
      name: [...parents, d.name].join(' › '),
      status: event.type === 'test:fail' ? 'fail' : skipped ? 'skip' : d.todo ? 'todo' : 'pass',
      ms: Math.round(d.details?.duration_ms ?? 0),
      error: error ? String(error.cause?.message ?? error.message ?? error).slice(0, 600) : undefined,
    })}\n`;
  }
}
