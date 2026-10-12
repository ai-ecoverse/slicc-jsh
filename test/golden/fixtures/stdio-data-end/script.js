const events = [];
const s = process.stdin;
events.push(`flowing ${s.readableFlowing}`);
s.on('data', (c) => {
  events.push(`data ${Buffer.isBuffer(c)} ${c.toString()}`);
  s.pause();
  events.push(`paused ${s.isPaused()} ${s.readableFlowing}`);
  setTimeout(() => {
    events.push('resume');
    s.resume();
  }, 20);
});
s.on('end', () => events.push('end'));
s.on('close', () => {
  events.push('close');
  console.log(events.join('\n'));
});
