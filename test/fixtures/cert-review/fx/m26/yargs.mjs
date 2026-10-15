import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
try { console.log(yargs(hideBin(['node', 'x', '--a', '1'])).parseSync().a); } catch (e) { console.log(e.stack.split('\n').slice(0, 8).join('\n')); }
