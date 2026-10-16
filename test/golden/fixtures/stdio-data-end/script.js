const events = [];
const s = process.stdin;
events.push(`flowing ${s.readableFlowing}`);
s.on('data', (c) => {
  events.push(`data ${Buffer.isBuffer(c)} ${c.toString()}`);
  s.pause();
  events.push(`paused ${s.isPaused()} ${s.readableFlowing}`);
  // Paused with nothing buffered, the stream still ends (Node emits 'end'
  // once the length is 0, flowing or not). A resume() from a timer raced
  // the read of the EOF, in Node as in jsh: under load it came first (#241).
});
s.on('end', () => events.push('end'));
s.on('close', () => {
  events.push('close');
  console.log(events.join('\n'));
});
