async function main() {
  await null;
  console.log('usage: tool');
  process.exit(0);
}
main().catch((e) => { console.error('error:', e.message); process.exit(1); });
