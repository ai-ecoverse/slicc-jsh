async function main() {
  await null;
  throw new Error('failed inside main');
}
main().catch((e) => { console.error('error:', e.message); process.exit(1); });
