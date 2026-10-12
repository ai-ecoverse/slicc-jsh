async function main() {
  await new Promise((r) => setTimeout(r, 50));
  console.log('main done');
  return 3;
}
return main();
