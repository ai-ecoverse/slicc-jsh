const cli = require('sliccy:cli');
async function main() {
  await null;
  cli.help('Usage: tool <command>');
}
await main().catch((e) => cli.die(e.message, { prefix: 'tool' }));
console.log('after never runs');
