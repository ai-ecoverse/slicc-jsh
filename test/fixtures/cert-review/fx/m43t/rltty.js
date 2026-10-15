const fs = require('fs'), cp = require('child_process');
const [mode, log] = process.argv.slice(2);
if (mode === 'kid') {
  const tag = process.argv[4];
  let tty; try { fs.closeSync(fs.openSync('/dev/tty', 'r+')); tty = 'opened'; } catch (e) { tty = e.code; }
  fs.appendFileSync(`${log}.${tag}`, `${tag} tty=${tty} isatty0=${process.stdin.isTTY ?? false}\n`);
  for (const s of ['SIGINT', 'SIGTSTP', 'SIGHUP']) process.on(s, () => fs.appendFileSync(`${log}.${tag}`, `${tag} got ${s}\n`));
  setTimeout(() => fs.appendFileSync(`${log}.${tag}`, `${tag} done\n`), 3500);
  return;
}
let tty; try { fs.closeSync(fs.openSync('/dev/tty', 'r+')); tty = 'opened'; } catch (e) { tty = e.code; }
for (const t of ['attached', 'detached']) try { fs.unlinkSync(`${log}.${t}`); } catch {}
fs.writeFileSync(log, `parent tty=${tty}\n`);
for (const s of ['SIGINT', 'SIGTSTP']) process.on(s, () => fs.appendFileSync(log, `parent got ${s}\n`));
const a = cp.spawn(process.execPath, [__filename, 'kid', log, 'attached'], { stdio: 'inherit' });
const d = cp.spawn(process.execPath, [__filename, 'kid', log, 'detached'], { detached: true, stdio: 'inherit' });
let n = 0; const done = () => { if (++n === 2) { setTimeout(() => { for (const t of ['attached', 'detached']) { let b = ''; try { b = fs.readFileSync(`${log}.${t}`, 'utf8'); } catch (e) { b = `${t} no log ${e.code}\n`; } fs.appendFileSync(log, b.split('\n').filter(Boolean).sort().join('\n') + '\n'); } fs.appendFileSync(log, ex.sort().join('\n') + '\nparent end\n'); process.exit(0); }, 200); } };
const ex = []; a.on('exit', (c, s) => { ex.push(`attached exit ${c} ${s}`); done(); });
d.on('exit', (c, s) => { ex.push(`detached exit ${c} ${s}`); done(); });
