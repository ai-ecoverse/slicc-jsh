async function main() {
  await new Promise((r) => setTimeout(r, 100));
  console.log('main finished after the body returned');
}
main().catch((e) => { console.error(e); process.exit(1); });
console.log('body returned');
