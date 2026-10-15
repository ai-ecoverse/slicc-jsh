(async () => {
  const out = [];
  const t = async (n, f) => { try { out.push(`${n}: ${await f()}`); } catch (e) { out.push(`${n}: threw ${e.code ?? e.name}`); } };
  for (const s of ['node:fs', 'fs', 'node:fs/promises', 'node:child_process', 'node:os', 'node:module', 'node:worker_threads', 'node:vm']) {
    await t(`import(${s})`, async () => { const m = await import(s); return Object.keys(m).length > 0 ? 'module' : 'empty'; });
  }
  await t('import(node:fs).readFileSync(/etc/hosts)', async () => (await import('node:fs')).readFileSync('/etc/hosts').length + ' bytes');
  await t('import(node:fs) === require(fs) default', async () => (await import('node:fs')).default === require('fs'));
  await t('import(node:os).hostname()', async () => typeof (await import('node:os')).hostname());
  await t('import(node:child_process).execSync(id)', async () => String((await import('node:child_process')).execSync('id')).slice(0, 20));
  await t('import(node:module).createRequire(...)(fs) === require(fs)', async () => (await import('node:module')).createRequire(__filename)('fs') === require('fs'));
  await t('process.env.HOST_SECRET', () => String(process.env.HOST_SECRET));
  console.log(out.join('\n'));
})();
