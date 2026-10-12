async function main() {
  const r = await fetch(`${process.env.COMPARE_HTTP}/slow`);
  console.log('fetched', await r.text());
}
main().catch((e) => { console.error('error:', e.message); process.exit(1); });
console.log('body returned');
